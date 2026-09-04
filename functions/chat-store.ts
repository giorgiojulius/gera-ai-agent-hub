// ChatStore — per-account Durable Object shard (id `acct:<email>`) holding
// ONE account's chat history, profile blob, error journal, and automation
// scheduling. Sharding is what makes the backend scale: every account gets
// its own single-threaded object with its own storage budget, instead of
// every account queueing behind one global object.
//
// The same class still runs the LEGACY singleton (id "global") that held
// all accounts before the sharding rollout. That instance now serves only
// migration plumbing (/export, /owners, /mark-migrated) until the cron
// sweep + lazy first-touch migration drain it; account routes answer 428
// there because it never gets a shard owner mark.
//
// Chats: whole-chat last-write-wins on updatedAt. Deletions travel as
// tombstones so deleting on one device wins over a stale copy on another,
// while a genuinely newer edit resurrects the chat. The protocol is
// want-driven: the client reports what it has (`have`), the server answers
// with what the client is missing (`pull`), what the server is missing
// (`want`), and which chats were deleted elsewhere (`tombstones`). No
// client-side dirty bookkeeping can drift — the next sync always heals.
//
// Profile: settings, agents, automations, MCP servers, and the personal hub
// as ONE blob with whole-blob last-write-wins — same clock discipline.
//
// The Worker entrypoint verifies platform identity + invite before anything
// reaches this object; there is no public route here.
//
// Cloud automations: this platform's Durable Objects cannot set alarms
// (facets), so firing is driven from outside — the legacy global object
// keeps a tiny schedule index (owner → next_due_at) that the Worker's cron
// tick reads; due shards get POST /fire, which claims each run
// (at-most-once via server_runs), executes the LLM loop in-process,
// appends the result to the automation's thread, and reports the next due
// instant back (X-Gera-Next-Due) so the index stays fresh. "Run now" sets
// a force flag and the Worker fires immediately — same claimed pipeline.
import { DurableObject } from "cloudflare:workers";

import {
  runAutomationJob,
  type AutomationRunResult,
  type ClaimJob,
  type SourceRef,
  type ToolRecord,
} from "./automation-runner";
import { buildExecutionOutcome, type ExecutionOutcome } from "./run-protocol";
import {
  automationDue,
  cloudSkillsBlock,
  HOOK_PAYLOAD_STORE_CHARS,
  HOOK_QUEUE_CAP,
  HOOK_QUEUE_PREFIX,
  HOOK_TOKEN_PATTERN,
  HOOKS_INDEX_CAP,
  nextDueAt,
  storedAutomation,
  withHookContext,
  type HookQueue,
  type StoredAutomation,
} from "./automation-schedule";
import {
  handleExport,
  handleHooksResolve,
  handleHooksSet,
  handleImport,
  handleMarkMigrated,
  handleOwners,
  handleOwnerCounts,
  handleOwnerState,
  handleScheduleDue,
  handleScheduleSet,
  type ChatStoreRouteContext,
} from "./chat-migration-routes";
import {
  asNum,
  asStr,
  capStr,
  CHAT_PAYLOAD_LIMIT,
  DELETE_LIMIT,
  DIAG_BATCH_LIMIT,
  DIAG_DETAIL_LIMIT,
  DIAG_LIST_LIMIT,
  DIAG_MESSAGE_LIMIT,
  DIAG_ROWS_LIMIT,
  DIAG_SCOPE_LIMIT,
  FIRE_BUDGET_MS,
  FIRE_MAX_JOBS,
  FORCE_RUN_PREFIX,
  FUTURE_SLACK_MS,
  HAVE_LIMIT,
  HOOKS_HEADER,
  isPlaceholderCredential,
  isRecord,
  isValidId,
  json,
  MAX_CHATS_PER_OWNER,
  NEXT_DUE_HEADER,
  OAUTH_REF_PREFIX,
  PROFILE_PAYLOAD_LIMIT,
  PULL_BYTE_BUDGET,
  PULL_MAX_CHATS,
  PUSH_LIMIT,
  readEmail,
  TITLE_LIMIT,
  TOMBSTONE_TTL_MS,
  TOMBSTONES_LIMIT,
  WANT_LIMIT,
  type ChatMetaRow,
  type ChatRow,
  type DeleteEntry,
  type HaveEntry,
  type PushEntry,
  type TombstoneRow,
} from "./chat-shared";
import { armCloudMcp } from "./automation-runner";
import { githubOAuthFormHeaders } from "./native-github";
import {
  chainRotationBases,
  cloudMcpServersForAutomation,
  cloudOAuthToken,
  cloudOAuthTokens,
  ensureFreshCloudOAuth,
  forceRefreshCloudOAuthOutcome,
  intersectMcpAllowIds,
  normalizeOAuthOverride,
  overlayOAuthRotations,
  redactCloudMcpText,
  type CloudOAuthRefreshFailure,
  type CloudOAuthToken,
  type OAuthRotation,
  type RefreshedOAuth,
} from "./mcp-cloud";
import {
  buildAuthorizationUrl,
  discoverMcpOAuth,
  exchangeAuthorizationCode,
  newOAuthState,
  OAuthCodeExchangeError,
  newPkceVerifier,
  pkceChallenge,
  registerDynamicOAuthClient,
} from "./mcp-oauth-flow";
import { fetchPublicHttps } from "./network-safety";
import { RunManager } from "./run-manager";
import {
  deviceCodeScope,
  GRANT_SECRET_FIELDS,
  OAUTH_PENDING_SECRET_FIELDS,
  oauthPendingFieldScope,
  oauthPendingScope,
  openGrantPayload,
  openRotationValue,
  openServerSecret,
  sealGrantPayload,
  sealRotationValue,
  sealServerSecret,
  SERVER_SECRET_FIELDS,
  type ServerSecret,
} from "./secret-rows";
import {
  describeSecretVaultError,
  fieldsNeedReseal,
  isSealedEnvelope,
  openFields,
  SecretVault,
  SecretVaultError,
} from "./secret-vault";

/** Worker env as visible inside this Durable Object (same bindings). */
type ChatStoreEnv = {
  EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY?: string;
  RORK_TOOLKIT_SECRET_KEY?: string;
  EXPO_PUBLIC_GITHUB_OAUTH_CLIENT_ID?: string;
  STAGING_VERSION?: string;
};

function sameOAuthEndpoint(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    a.hash = "";
    b.hash = "";
    return a.toString().replace(/\/$/, "") === b.toString().replace(/\/$/, "");
  } catch {
    return false;
  }
}

type GitHubDeviceRow = {
  owner_email: string;
  flow_id: string;
  server_id: string;
  device_code: string;
  user_code: string;
  verification_uri: string;
  client_id: string;
  expires_at: number;
  interval_ms: number;
  next_poll_at: number;
  status: string;
  error: string;
  updated_at: number;
};

type AutomationReceiptRow = {
  owner_email: string;
  id: string;
  automation_id: string;
  conversation_id: string;
  name: string;
  agent_id: string;
  model_id: string;
  user_text: string;
  status: string;
  started_at: number;
  finished_at: number;
  error: string;
};

type OAuthPendingRow = {
  owner_email: string;
  state: string;
  server_id: string;
  mcp_url: string;
  token_endpoint: string;
  client_id: string;
  verifier: string;
  redirect_uri: string;
  resource: string;
  issuer: string;
  return_origin: string;
  browser_nonce: string;
  callback_challenge: string;
  authorization_code: string;
  expires_at: number;
  status: string;
  error: string;
  created_at: number;
  updated_at: number;
};

/** KV key remembering which vault key the last sweep sealed this shard under. */
const VAULT_SWEEP_KEY = "secretVaultKid";

export class ChatStore extends DurableObject {
  private readonly workerEnv: ChatStoreEnv;
  /** Encrypts every credential row in this shard; keyed by the Worker secret. */
  private readonly vault: SecretVault;
  /** Interactive server-side agent runs (chat / research / Julius). */
  private readonly runs: RunManager;
  /** Automation occurrences executing in this isolate; absent after a deploy. */
  private readonly liveAutomationRuns = new Set<string>();
  private readonly instanceId = crypto.randomUUID();

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.workerEnv = (env ?? {}) as ChatStoreEnv;
    this.vault = SecretVault.fromEnv(env);
    this.runs = new RunManager(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        owner_email TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_email, id)
      )
    `);
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_chats_owner_updated ON chats (owner_email, updated_at DESC)",
    );
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tombstones (
        owner_email TEXT NOT NULL,
        id TEXT NOT NULL,
        deleted_at INTEGER NOT NULL,
        PRIMARY KEY (owner_email, id)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        owner_email TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mcp_server_secrets (
        owner_email TEXT NOT NULL,
        server_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_email, server_id)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_grants (
        owner_email TEXT NOT NULL,
        server_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_email, server_id)
      )
    `);
    // Explicit revocation tombstones stop a stale pre-deploy browser from
    // re-importing a grant after sign-out. A fresh interactive sign-in clears
    // the tombstone deliberately; background legacy migration never does.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_revocations (
        owner_email TEXT NOT NULL,
        server_id TEXT NOT NULL,
        revoked_at INTEGER NOT NULL,
        PRIMARY KEY (owner_email, server_id)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_states (
        owner_email TEXT NOT NULL,
        server_id TEXT NOT NULL,
        state TEXT NOT NULL,
        error_code TEXT NOT NULL DEFAULT '',
        retry_after INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_email, server_id)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
        owner_email TEXT NOT NULL,
        registration_endpoint TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        client_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_email, registration_endpoint, redirect_uri)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_pending (
        owner_email TEXT NOT NULL,
        state TEXT NOT NULL,
        server_id TEXT NOT NULL,
        mcp_url TEXT NOT NULL,
        token_endpoint TEXT NOT NULL,
        client_id TEXT NOT NULL,
        verifier TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        resource TEXT NOT NULL DEFAULT '',
        issuer TEXT NOT NULL,
        return_origin TEXT NOT NULL,
        browser_nonce TEXT NOT NULL,
        callback_challenge TEXT NOT NULL DEFAULT '',
        authorization_code TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_email, state)
      )
    `);
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_oauth_pending_server ON mcp_oauth_pending (owner_email, server_id)",
    );
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mcp_github_device_pending (
        owner_email TEXT NOT NULL,
        flow_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        device_code TEXT NOT NULL,
        user_code TEXT NOT NULL,
        verification_uri TEXT NOT NULL,
        client_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        interval_ms INTEGER NOT NULL,
        next_poll_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_email, flow_id)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS server_runs (
        owner_email TEXT NOT NULL,
        automation_id TEXT NOT NULL,
        last_run_at INTEGER NOT NULL,
        PRIMARY KEY (owner_email, automation_id)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS automation_run_receipts (
        owner_email TEXT NOT NULL,
        id TEXT NOT NULL,
        automation_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        name TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT '',
        model_id TEXT NOT NULL DEFAULT '',
        user_text TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (owner_email, id)
      )
    `);
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_automation_receipts_owner_status ON automation_run_receipts (owner_email, status)",
    );
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS diagnostics (
        owner_email TEXT NOT NULL,
        id TEXT NOT NULL,
        at INTEGER NOT NULL,
        scope TEXT NOT NULL,
        message TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (owner_email, id)
      )
    `);
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_diag_owner_at ON diagnostics (owner_email, at DESC)",
    );
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS diag_meta (
        owner_email TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL,
        cleared_at INTEGER NOT NULL DEFAULT 0
      )
    `);
    // Legacy-global-only ledger: which owners already moved to their shard.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS migrated_owners (
        owner_email TEXT PRIMARY KEY,
        migrated_at INTEGER NOT NULL
      )
    `);
    // Legacy-global-only schedule index: owner → next automation due time.
    // Tiny rows — the cron tick reads it instead of scanning any profiles.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS schedule (
        owner_email TEXT PRIMARY KEY,
        next_due_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_schedule_due ON schedule (next_due_at)",
    );
    // Legacy-global-only webhook registry: token → owner + automation, so
    // the public /hooks/<token> route finds the right shard in one lookup.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS hooks (
        token TEXT PRIMARY KEY,
        owner_email TEXT NOT NULL,
        automation_id TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_hooks_owner ON hooks (owner_email)");
    // Seal pre-vault plaintext (and rows under a rotated-out key) before the
    // first request; a failure here must never brick the shard.
    this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.sealLegacySecrets();
      } catch (error) {
        console.error("account secret sweep failed", error instanceof SecretVaultError ? error.code : "error");
      }
    });
  }

  /**
   * One-time (per vault key) pass over every credential row in this shard:
   * OAuth grants, pasted keys/headers, PKCE verifiers and authorization
   * codes, GitHub device codes, and the legacy rotation escrow in KV.
   * Plaintext rows from before the vault and rows sealed under a previous
   * key are re-sealed; poisoned legacy placeholder rows are dropped.
   */
  private async sealLegacySecrets(): Promise<void> {
    if (!this.vault.enabled) {
      return;
    }
    const kid = await this.vault.currentKid();
    if ((await this.ctx.storage.get<string>(VAULT_SWEEP_KEY)) === kid) {
      return;
    }
    const sql = this.ctx.storage.sql;
    let sealed = 0;
    for (const row of sql
      .exec<{ owner_email: string; server_id: string; payload: string }>(
        "SELECT owner_email, server_id, payload FROM mcp_oauth_grants",
      )
      .toArray()) {
      const token = await openGrantPayload(this.vault, row.owner_email, row.server_id, row.payload);
      if (!token || !(await fieldsNeedReseal(this.vault, cloudOAuthToken(JSON.parse(row.payload)) ?? {}, GRANT_SECRET_FIELDS))) {
        continue;
      }
      sql.exec(
        "UPDATE mcp_oauth_grants SET payload = ? WHERE owner_email = ? AND server_id = ?",
        await sealGrantPayload(this.vault, row.owner_email, row.server_id, {
          ...(JSON.parse(row.payload) as Record<string, unknown>),
          ...token,
        }),
        row.owner_email,
        row.server_id,
      );
      sealed += 1;
    }
    for (const row of sql
      .exec<{ owner_email: string; server_id: string; payload: string }>(
        "SELECT owner_email, server_id, payload FROM mcp_server_secrets",
      )
      .toArray()) {
      const stored = this.parseServerSecretRow(row.owner_email, row.server_id, row.payload);
      if (!stored) {
        continue; // poisoned placeholder row — already deleted by the parser
      }
      if (!(await fieldsNeedReseal(this.vault, stored, SERVER_SECRET_FIELDS))) {
        continue;
      }
      sql.exec(
        "UPDATE mcp_server_secrets SET payload = ? WHERE owner_email = ? AND server_id = ?",
        await sealServerSecret(this.vault, row.owner_email, row.server_id, stored),
        row.owner_email,
        row.server_id,
      );
      sealed += 1;
    }
    for (const row of sql
      .exec<{ owner_email: string; state: string; verifier: string; authorization_code: string }>(
        "SELECT owner_email, state, verifier, authorization_code FROM mcp_oauth_pending WHERE verifier != '' OR authorization_code != ''",
      )
      .toArray()) {
      if (!(await fieldsNeedReseal(this.vault, row, OAUTH_PENDING_SECRET_FIELDS))) {
        continue;
      }
      sql.exec(
        "UPDATE mcp_oauth_pending SET verifier = ?, authorization_code = ? WHERE owner_email = ? AND state = ?",
        await this.vault.reseal(row.verifier, oauthPendingFieldScope(row.owner_email, row.state, "verifier")),
        await this.vault.reseal(
          row.authorization_code,
          oauthPendingFieldScope(row.owner_email, row.state, "authorization_code"),
        ),
        row.owner_email,
        row.state,
      );
      sealed += 1;
    }
    for (const row of sql
      .exec<{ owner_email: string; flow_id: string; device_code: string }>(
        "SELECT owner_email, flow_id, device_code FROM mcp_github_device_pending WHERE device_code != ''",
      )
      .toArray()) {
      if (await this.vault.isCurrent(row.device_code)) {
        continue;
      }
      sql.exec(
        "UPDATE mcp_github_device_pending SET device_code = ? WHERE owner_email = ? AND flow_id = ?",
        await this.vault.reseal(row.device_code, deviceCodeScope(row.owner_email, row.flow_id)),
        row.owner_email,
        row.flow_id,
      );
      sealed += 1;
    }
    const escrow = await this.ctx.storage.list<unknown>({ prefix: OAUTH_REF_PREFIX });
    for (const [key, value] of escrow) {
      const rest = key.slice(OAUTH_REF_PREFIX.length);
      const split = rest.lastIndexOf(":");
      if (split <= 0) {
        continue;
      }
      const owner = rest.slice(0, split);
      const serverId = rest.slice(split + 1);
      if (isSealedEnvelope(value) && (await this.vault.isCurrent(value.sealed))) {
        continue;
      }
      await this.ctx.storage.put(key, await sealRotationValue(this.vault, owner, serverId, value));
      sealed += 1;
    }
    await this.ctx.storage.put(VAULT_SWEEP_KEY, kid);
    if (sealed > 0) {
      console.log("account secrets sealed", sealed);
    }
  }

  /**
   * Parses one `mcp_server_secrets` row as stored (fields still sealed).
   * Returns null — after deleting the row — for a poisoned legacy row where
   * the browser's `gera-account:` marker was stored as a manual token and
   * shadowed the real OAuth grant on every call.
   */
  private parseServerSecretRow(owner: string, serverId: string, payload: string): ServerSecret | null {
    let value: Record<string, unknown>;
    try {
      const parsed = JSON.parse(payload) as unknown;
      value = isRecord(parsed) ? parsed : {};
    } catch {
      return null;
    }
    const rawToken = typeof value.token === "string" ? value.token : "";
    const headersJson = typeof value.headersJson === "string" && value.headersJson ? value.headersJson : "";
    const token = rawToken && (this.vault.isSealed(rawToken) || !isPlaceholderCredential(rawToken)) ? rawToken : "";
    if (rawToken && !token && !headersJson) {
      this.ctx.storage.sql.exec(
        "DELETE FROM mcp_server_secrets WHERE owner_email = ? AND server_id = ?",
        owner,
        serverId,
      );
      return null;
    }
    if (!token && !headersJson) {
      return null;
    }
    return { ...(token ? { token } : {}), ...(headersJson ? { headersJson } : {}) };
  }

  /** Reads a legacy rotation escrow entry; unreadable envelopes count as absent. */
  private async readRotation(owner: string, serverId: string, raw: unknown): Promise<OAuthRotation | null> {
    if (raw === undefined || raw === null) {
      return null;
    }
    try {
      return normalizeOAuthOverride(serverId, await openRotationValue(this.vault, owner, serverId, raw));
    } catch (error) {
      if (error instanceof SecretVaultError) {
        console.error("oauth rotation escrow unreadable", serverId, error.code);
        return null;
      }
      throw error;
    }
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      return await this.route(request);
    } catch (error) {
      if (error instanceof SecretVaultError) {
        // Fail closed and say why: no plaintext credential is ever written
        // because the key is missing, and no sealed one is silently dropped.
        console.error("account store vault", new URL(request.url).pathname, error.code);
        return json({ error: error.code, message: describeSecretVaultError(error) }, 503);
      }
      throw error;
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Internal plumbing, only reachable through the Worker entrypoint (it
    // never forwards arbitrary paths here): migration export/import between
    // the legacy global object and per-account shards.
    if (request.method === "POST" && url.pathname === "/owner-state") {
      return handleOwnerState(this.routeContext(), request);
    }
    if (request.method === "POST" && url.pathname === "/owner-counts") {
      return handleOwnerCounts(this.routeContext(), request);
    }
    if (request.method === "POST" && url.pathname === "/export") {
      return handleExport(this.routeContext(), request);
    }
    if (request.method === "POST" && url.pathname === "/owners") {
      return handleOwners(this.routeContext(), request);
    }
    if (request.method === "POST" && url.pathname === "/mark-migrated") {
      return handleMarkMigrated(this.routeContext(), request);
    }
    if (request.method === "POST" && url.pathname === "/import") {
      return handleImport(this.routeContext(), request);
    }
    if (request.method === "POST" && url.pathname === "/schedule-set") {
      return handleScheduleSet(this.routeContext(), request);
    }
    if (request.method === "POST" && url.pathname === "/schedule-due") {
      return handleScheduleDue(this.routeContext(), request);
    }
    if (request.method === "POST" && url.pathname === "/hooks-set") {
      return handleHooksSet(this.routeContext(), request);
    }
    if (request.method === "POST" && url.pathname === "/hooks-resolve") {
      return handleHooksResolve(this.routeContext(), request);
    }

    const email = readEmail(request);
    if (!email) {
      return json({ error: "sign_in_required" }, 401);
    }
    // Account routes live on per-account shards. A shard answers only after
    // its one-time initialization (migration out of the legacy global
    // object) — the Worker sees 428, migrates, and retries.
    const shardOwner = (await this.ctx.storage.get<string>("shardOwner")) ?? "";
    if (!shardOwner) {
      return json({ error: "shard_uninitialized" }, 428);
    }
    if (shardOwner !== email) {
      return json({ error: "wrong_shard" }, 409);
    }
    if (request.method === "GET" && url.pathname === "/staging/version" && this.workerEnv.STAGING_VERSION) {
      return json({ version: this.workerEnv.STAGING_VERSION, instanceId: this.instanceId });
    }
    // Interactive server-side runs: start / steer / stop / stream / media.
    const runResponse = await this.runs.handle(request, email, url.pathname);
    if (runResponse) {
      return runResponse;
    }
    if (request.method === "POST" && url.pathname === "/sync") {
      return this.handleSync(request, email);
    }
    if (request.method === "GET" && url.pathname === "/mcp/oauth-rotations") {
      return this.handleOAuthRotations(email);
    }
    if (request.method === "POST" && url.pathname === "/mcp/oauth-start") {
      return this.handleOAuthStart(request, email);
    }
    if (request.method === "POST" && url.pathname === "/mcp/github-device-start") {
      return this.handleGitHubDeviceStart(email);
    }
    if (request.method === "GET" && url.pathname === "/mcp/github-device-status") {
      return this.handleGitHubDeviceStatus(request, email);
    }
    if (request.method === "GET" && url.pathname === "/mcp/oauth-status") {
      return this.handleOAuthStatus(request, email);
    }
    if (request.method === "POST" && url.pathname === "/mcp/oauth-complete") {
      return this.handleOAuthComplete(request, email);
    }
    if (request.method === "POST" && url.pathname === "/mcp/oauth-callback") {
      return this.handleOAuthCallback(request, email);
    }
    if (request.method === "POST" && url.pathname === "/mcp/oauth-store") {
      return this.handleOAuthStore(request, email);
    }
    if (request.method === "POST" && url.pathname === "/mcp/oauth-clear") {
      return this.handleOAuthClear(request, email);
    }
    if (request.method === "POST" && url.pathname === "/mcp/check") {
      return this.handleMcpCheck(request, email);
    }
    if (request.method === "POST" && url.pathname === "/mcp/oauth-refresh") {
      return this.handleBrowserOAuthRefresh(request, email);
    }
    // Internal (worker-only — no public relay forwards this path): project
    // agents resolve their linked MCP servers through this account.
    if (request.method === "POST" && url.pathname === "/mcp/resolve") {
      return this.handleMcpResolve(request, email);
    }
    if (request.method === "POST" && url.pathname === "/mcp/auth-lease") {
      return this.handleMcpAuthLease(request, email);
    }
    if (request.method === "POST" && url.pathname === "/run-now") {
      return this.handleRunNow(request, email);
    }
    if (request.method === "POST" && url.pathname === "/hook-fire") {
      return this.handleHookFire(request, email);
    }
    if (request.method === "POST" && url.pathname === "/fire") {
      return this.handleFire(email);
    }
    if (request.method === "POST" && url.pathname === "/diag/append") {
      return this.handleDiagAppend(request, email);
    }
    if (request.method === "GET" && url.pathname === "/diag/list") {
      return this.handleDiagList(email);
    }
    if (request.method === "POST" && url.pathname === "/diag/seen") {
      return this.handleDiagSeen(request, email);
    }
    if (request.method === "POST" && url.pathname === "/diag/clear") {
      return this.handleDiagClear(email);
    }
    return json({ error: "not_found" }, 404);
  }

  private diagMeta(email: string): { seen_at: number; cleared_at: number } {
    const row = this.ctx.storage.sql
      .exec<{ seen_at: number; cleared_at: number }>(
        "SELECT seen_at, cleared_at FROM diag_meta WHERE owner_email = ?",
        email,
      )
      .toArray()[0];
    return { seen_at: row?.seen_at ?? 0, cleared_at: row?.cleared_at ?? 0 };
  }

  /**
   * Appends a batch of client error entries; idempotent per entry id, so a
   * retried upload never duplicates rows. Entries older than the account's
   * clear watermark are dropped — a stale device cannot resurrect a cleared
   * journal.
   */
  private async handleDiagAppend(request: Request, email: string): Promise<Response> {
    let body: { entries?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const now = Date.now();
    const clearedAt = this.diagMeta(email).cleared_at;
    const list = Array.isArray(body.entries) ? body.entries.slice(0, DIAG_BATCH_LIMIT) : [];
    let accepted = 0;
    for (const item of list) {
      if (!isRecord(item) || !isValidId(item.id)) {
        continue;
      }
      const message = capStr(asStr(item.message).trim(), DIAG_MESSAGE_LIMIT);
      if (!message) {
        continue;
      }
      const at = Math.min(asNum(item.at, now), now + FUTURE_SLACK_MS);
      if (at <= clearedAt) {
        continue;
      }
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO diagnostics (owner_email, id, at, scope, message, detail) VALUES (?, ?, ?, ?, ?, ?)",
        email,
        item.id,
        at,
        capStr(asStr(item.scope).trim() || "app", DIAG_SCOPE_LIMIT),
        message,
        capStr(asStr(item.detail), DIAG_DETAIL_LIMIT),
      );
      accepted += 1;
    }
    if (accepted > 0) {
      // Ring semantics: only the newest rows survive.
      this.ctx.storage.sql.exec(
        `DELETE FROM diagnostics WHERE owner_email = ? AND id NOT IN (
          SELECT id FROM diagnostics WHERE owner_email = ? ORDER BY at DESC LIMIT ${DIAG_ROWS_LIMIT}
        )`,
        email,
        email,
      );
    }
    return json({ ok: true, accepted });
  }

  /** Latest journal page plus the account-wide "seen" watermark. */
  private handleDiagList(email: string): Response {
    const rows = this.ctx.storage.sql
      .exec<{ id: string; at: number; scope: string; message: string; detail: string }>(
        `SELECT id, at, scope, message, detail FROM diagnostics WHERE owner_email = ? ORDER BY at DESC LIMIT ${DIAG_LIST_LIMIT}`,
        email,
      )
      .toArray();
    return json({
      entries: rows.map((row) => ({
        id: row.id,
        at: row.at,
        scope: row.scope,
        message: row.message,
        ...(row.detail ? { detail: row.detail } : {}),
      })),
      seenAt: this.diagMeta(email).seen_at,
    });
  }

  /** Advances the "seen" watermark (monotonic — a stale device can't regress it). */
  private async handleDiagSeen(request: Request, email: string): Promise<Response> {
    let body: { at?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      body = {};
    }
    const now = Date.now();
    const requested = Math.min(asNum(body.at, now), now + FUTURE_SLACK_MS);
    const meta = this.diagMeta(email);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO diag_meta (owner_email, seen_at, cleared_at) VALUES (?, ?, ?)",
      email,
      Math.max(meta.seen_at, requested),
      meta.cleared_at,
    );
    return json({ ok: true });
  }

  /** Empties the journal for this account on every device. */
  private handleDiagClear(email: string): Response {
    const now = Date.now();
    const meta = this.diagMeta(email);
    this.ctx.storage.sql.exec("DELETE FROM diagnostics WHERE owner_email = ?", email);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO diag_meta (owner_email, seen_at, cleared_at) VALUES (?, ?, ?)",
      email,
      Math.max(meta.seen_at, now),
      now,
    );
    return json({ ok: true });
  }

  private recoverInterruptedAutomationRuns(owner: string): void {
    const rows = this.ctx.storage.sql
      .exec<AutomationReceiptRow>(
        "SELECT * FROM automation_run_receipts WHERE owner_email = ? AND status = 'running' ORDER BY started_at LIMIT 20",
        owner,
      )
      .toArray();
    for (const row of rows) {
      if (this.liveAutomationRuns.has(row.id)) {
        continue;
      }
      const content = "Cloud automation was interrupted by a server restart after its occurrence was claimed. It was not executed again; run it manually if you want to retry.";
      const execution = buildExecutionOutcome({
        content,
        technicalStatus: "interrupted",
        surface: "automation",
        error: "The server restarted before the claimed automation occurrence reached a terminal commit.",
      });
      const now = Date.now();
      this.ctx.storage.transactionSync(() => {
        this.appendRun(owner, {
          automationId: row.automation_id,
          conversationId: row.conversation_id,
          name: row.name,
          agentId: row.agent_id || null,
          modelId: row.model_id,
          userText: row.user_text,
          assistantText: content,
          toolCalls: [],
          sources: [],
          execution,
          startedAt: row.started_at,
        });
        this.ctx.storage.sql.exec(
          `UPDATE automation_run_receipts
           SET status = 'interrupted', finished_at = ?, error = ?
           WHERE owner_email = ? AND id = ? AND status = 'running'`,
          now,
          "server_restart",
          owner,
          row.id,
        );
      });
      console.log("automation occurrence recovered as interrupted", row.automation_id);
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM automation_run_receipts WHERE owner_email = ? AND status != 'running' AND finished_at < ?",
      owner,
      Date.now() - 7 * 24 * 60 * 60_000,
    );
  }

  private async claimAutomationRun(
    owner: string,
    item: { auto: StoredAutomation; forced: boolean; hook?: HookQueue },
    job: ClaimJob,
    runPrompt: string,
    receiptId: string,
    startedAt: number,
  ): Promise<boolean> {
    let claimed = false;
    this.liveAutomationRuns.add(receiptId);
    try {
      await this.ctx.storage.transaction(async () => {
        claimed = false;
        const active = this.ctx.storage.sql
          .exec<{ id: string }>(
            "SELECT id FROM automation_run_receipts WHERE owner_email = ? AND automation_id = ? AND status = 'running' LIMIT 1",
            owner,
            item.auto.id,
          )
          .toArray()[0];
        if (active && active.id !== receiptId) {
          return;
        }
        const forceKey = `${FORCE_RUN_PREFIX}${item.auto.id}`;
        const hookKey = `${HOOK_QUEUE_PREFIX}${item.auto.id}`;
        const forceValue = item.forced ? await this.ctx.storage.get<number>(forceKey) : undefined;
        if (item.forced && forceValue === undefined) {
          return;
        }
        const currentHook = item.hook ? await this.ctx.storage.get<HookQueue>(hookKey) : undefined;
        const expectedEntries = item.hook?.entries ?? [];
        const hookPrefixMatches =
          !item.hook ||
          (currentHook !== undefined &&
            currentHook.entries.length >= expectedEntries.length &&
            expectedEntries.every(
              (entry, index) => JSON.stringify(currentHook.entries[index]) === JSON.stringify(entry),
            ));
        if (!hookPrefixMatches) {
          return;
        }
        if (item.forced) {
          await this.ctx.storage.delete(forceKey);
        }
        if (item.hook && currentHook) {
          const remaining = currentHook.entries.slice(expectedEntries.length);
          if (remaining.length === 0) {
            await this.ctx.storage.delete(hookKey);
          } else {
            await this.ctx.storage.put(hookKey, { entries: remaining, dropped: currentHook.dropped });
          }
        }
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO automation_run_receipts
            (owner_email, id, automation_id, conversation_id, name, agent_id, model_id, user_text,
             status, started_at, finished_at, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, 0, '')`,
          owner,
          receiptId,
          item.auto.id,
          item.auto.conversationId,
          capStr(item.auto.name, TITLE_LIMIT),
          item.auto.agentId ?? "",
          capStr(job.modelId, 120),
          capStr(runPrompt, 8_000),
          startedAt,
        );
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO server_runs (owner_email, automation_id, last_run_at) VALUES (?, ?, ?)",
          owner,
          item.auto.id,
          startedAt,
        );
        claimed = true;
      });
    } catch (error) {
      this.liveAutomationRuns.delete(receiptId);
      throw error;
    }
    if (!claimed) {
      this.liveAutomationRuns.delete(receiptId);
    }
    return claimed;
  }

  /**
   * Fires due cloud automations for this shard's account. Claims each run
   * first (at-most-once — a duplicate or racing fire can never double-run),
   * executes the LLM loop in-process, appends the result to the automation's
   * thread, and reports the next due instant so the schedule index stays
   * fresh. Called by the Worker: cron tick, exact-time sleeper, or run-now.
   */
  private async handleFire(owner: string): Promise<Response> {
    this.recoverInterruptedAutomationRuns(owner);
    const forced = await this.ctx.storage.list<number>({ prefix: FORCE_RUN_PREFIX });
    const hookQueues = await this.ctx.storage.list<HookQueue>({ prefix: HOOK_QUEUE_PREFIX });
    const profileRow = this.ctx.storage.sql
      .exec<{ payload: string }>("SELECT payload FROM profiles WHERE owner_email = ?", owner)
      .toArray()[0];
    if (!profileRow) {
      for (const key of forced.keys()) {
        await this.ctx.storage.delete(key);
      }
      for (const key of hookQueues.keys()) {
        await this.ctx.storage.delete(key);
      }
      return json({ ran: 0, nextDueAt: 0 }, 200, { [NEXT_DUE_HEADER]: "0", [HOOKS_HEADER]: "[]" });
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(profileRow.payload);
    } catch {
      return json({ ran: 0, nextDueAt: 0 }, 200, { [NEXT_DUE_HEADER]: "0", [HOOKS_HEADER]: "[]" });
    }
    if (!isRecord(parsed) || !isRecord(parsed.settings)) {
      return json({ ran: 0, nextDueAt: 0 }, 200, { [NEXT_DUE_HEADER]: "0", [HOOKS_HEADER]: "[]" });
    }
    const settings = parsed.settings;
    const life = isRecord(parsed.life) ? parsed.life : {};

    // Synced browser sign-ins, overlaid with grants this shard rotated
    // server-side. An override applies while the blob's token is anywhere on
    // its rotation chain; a caught-up blob or a fresh sign-in retires it.
    const oauthTokens = await this.profileOAuthTokens(owner);
    const oauthRefPrefix = `${OAUTH_REF_PREFIX}${owner}:`;
    const overrideRows = await this.ctx.storage.list<unknown>({ prefix: oauthRefPrefix });
    const rotations: OAuthRotation[] = [];
    for (const [key, value] of overrideRows) {
      const rotation = await this.readRotation(owner, key.slice(oauthRefPrefix.length), value);
      if (rotation) {
        rotations.push(rotation);
      } else {
        await this.ctx.storage.delete(key); // malformed — cannot authenticate anything
      }
    }
    const { appliedChains, staleIds } = overlayOAuthRotations(oauthTokens, rotations);
    for (const id of staleIds) {
      await this.ctx.storage.delete(`${oauthRefPrefix}${id}`);
    }
    const persistOAuth = async (rotated: RefreshedOAuth): Promise<void> => {
      await this.persistCanonicalOAuthGrant(owner, rotated);
      const bases = chainRotationBases(appliedChains, rotated);
      appliedChains.set(rotated.serverId, bases);
      oauthTokens[rotated.serverId] = rotated.token;
    };

    const automations = (Array.isArray(settings.automations) ? settings.automations : [])
      .map(storedAutomation)
      .filter((item): item is StoredAutomation => item !== null);

    // Hygiene: drop force flags and claim rows for deleted automations.
    const liveIds = new Set(automations.map((item) => item.id));
    for (const key of [...forced.keys()]) {
      if (!liveIds.has(key.slice(FORCE_RUN_PREFIX.length))) {
        await this.ctx.storage.delete(key);
        forced.delete(key);
      }
    }
    // Webhook-queue hygiene: deliveries for deleted, paused, browser-run, or
    // token-less automations are dropped — pausing cancels pending deliveries.
    const hookEligible = new Set(
      automations
        .filter(
          (item) =>
            item.enabled &&
            item.webhookToken !== null &&
            item.runOn === "server" &&
            item.prompt.trim().length > 0 &&
            item.conversationId.length > 0,
        )
        .map((item) => item.id),
    );
    for (const key of [...hookQueues.keys()]) {
      if (!hookEligible.has(key.slice(HOOK_QUEUE_PREFIX.length))) {
        await this.ctx.storage.delete(key);
        hookQueues.delete(key);
      }
    }
    const lastRuns = this.readLastRuns(owner);
    for (const [id] of lastRuns) {
      if (!liveIds.has(id)) {
        this.ctx.storage.sql.exec(
          "DELETE FROM server_runs WHERE owner_email = ? AND automation_id = ?",
          owner,
          id,
        );
      }
    }

    const serverAutos = automations.filter(
      (item) => item.runOn === "server" && item.prompt.trim().length > 0 && item.conversationId,
    );
    const now = Date.now();
    const due: Array<{ auto: StoredAutomation; forced: boolean; hook?: HookQueue }> = [];
    for (const auto of serverAutos) {
      const queued = hookQueues.get(`${HOOK_QUEUE_PREFIX}${auto.id}`);
      const hook = queued && Array.isArray(queued.entries) && queued.entries.length > 0 ? queued : undefined;
      if (forced.has(`${FORCE_RUN_PREFIX}${auto.id}`)) {
        due.push({ auto, forced: true, hook }); // Manual trigger runs even when paused.
        continue;
      }
      if (!auto.enabled) {
        continue;
      }
      if (hook) {
        due.push({ auto, forced: false, hook }); // Webhook deliveries fire off-schedule.
        continue;
      }
      const base = Math.max(lastRuns.get(auto.id) ?? 0, auto.lastRunAt, auto.createdAt);
      if (automationDue(auto, base, now)) {
        due.push({ auto, forced: false });
      }
    }
    if (due.length === 0) {
      const nextDueAt = await this.nextDueForOwner(owner, profileRow.payload);
      return json({ ran: 0, nextDueAt }, 200, {
        [NEXT_DUE_HEADER]: String(nextDueAt),
        [HOOKS_HEADER]: this.hooksIndexValue(profileRow.payload),
      });
    }

    const authKey =
      this.workerEnv.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY ?? this.workerEnv.RORK_TOOLKIT_SECRET_KEY ?? "";
    if (!authKey) {
      // Without the AI key every run would fail — leave the runs unclaimed
      // and retry once the env has the key, so nothing is silently skipped.
      console.error("automation fire: toolkit key missing in DO env — retrying in 10 minutes");
      const retryAt = now + 600_000;
      return json({ ran: 0, nextDueAt: retryAt, error: "toolkit_key_missing" }, 200, {
        [NEXT_DUE_HEADER]: String(retryAt),
        [HOOKS_HEADER]: this.hooksIndexValue(profileRow.payload),
      });
    }

    const batch = due.slice(0, FIRE_MAX_JOBS);
    const deadlineAt = Date.now() + FIRE_BUDGET_MS;
    let ran = 0;
    for (const item of batch) {
      const startedAt = Date.now();
      const runPrompt = item.hook ? withHookContext(item.auto.prompt, item.hook) : item.auto.prompt;
      const job = await this.buildClaimJob(owner, { ...item.auto, prompt: runPrompt }, settings, life, oauthTokens);
      const receiptId = `automation:${item.auto.id}:${crypto.randomUUID()}`;
      const claimed = await this.claimAutomationRun(owner, item, job, runPrompt, receiptId, startedAt);
      if (!claimed) {
        continue;
      }
      ran += 1;
      let result: AutomationRunResult;
      try {
        result = await runAutomationJob(
          job,
          authKey,
          deadlineAt,
          persistOAuth,
          (id, outcome) => this.recordOAuthFailure(owner, id, outcome),
          (id) => this.markOAuthRefreshStarted(owner, id),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        console.error("automation run failed", item.auto.id, message);
        const content = `⚠️ Cloud run failed: ${message}\n\nThe next scheduled run will try again.`;
        result = {
          content,
          toolCalls: [],
          sources: [],
          execution: buildExecutionOutcome({
            content,
            technicalStatus: "error",
            surface: "automation",
            error: message,
          }),
          refreshedOAuth: [],
        };
      }
      try {
        const terminalStatus = result.execution.status === "error" ? "error" : "done";
        this.ctx.storage.transactionSync(() => {
          this.appendRun(owner, {
            automationId: item.auto.id,
            conversationId: item.auto.conversationId,
            name: item.auto.name,
            agentId: item.auto.agentId,
            modelId: job.modelId,
            userText: runPrompt,
            assistantText: result.content,
            toolCalls: result.toolCalls,
            sources: result.sources,
            execution: result.execution,
            startedAt,
          });
          this.ctx.storage.sql.exec(
            `UPDATE automation_run_receipts
             SET status = ?, finished_at = ?, error = ?
             WHERE owner_email = ? AND id = ? AND status = 'running'`,
            terminalStatus,
            Date.now(),
            terminalStatus === "error" ? "automation_run_failed" : "",
            owner,
            receiptId,
          );
        });
      } catch (error) {
        // Keep the receipt running. A replacement isolate will settle it as
        // interrupted instead of executing this occurrence a second time.
        console.error("automation terminal commit failed", item.auto.id, error instanceof Error ? error.message : "error");
      } finally {
        this.liveAutomationRuns.delete(receiptId);
      }
    }
    const finalNext =
      due.length > batch.length ? Date.now() + 1_000 : await this.nextDueForOwner(owner, profileRow.payload);
    return json({ ran, nextDueAt: finalNext }, 200, {
      [NEXT_DUE_HEADER]: String(finalNext),
      [HOOKS_HEADER]: this.hooksIndexValue(profileRow.payload),
    });
  }

  /**
   * Imports credentials from pre-vault profile blobs, then returns a payload
   * that is safe to synchronize to browsers. Canonical rows and revocation
   * tombstones always outrank stale legacy copies.
   */
  private async prepareProfilePayload(owner: string, payload: string): Promise<string | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return null;
    }
    if (!isRecord(parsed)) {
      return null;
    }
    const profile: Record<string, unknown> = { ...parsed };
    if (isRecord(profile.mcpOAuth)) {
      for (const [serverId, rawToken] of Object.entries(profile.mcpOAuth).slice(0, 40)) {
        const token = cloudOAuthToken(rawToken);
        if (!isValidId(serverId) || !token) {
          continue;
        }
        const revoked = this.ctx.storage.sql
          .exec<{ present: number }>(
            "SELECT 1 AS present FROM mcp_oauth_revocations WHERE owner_email = ? AND server_id = ? LIMIT 1",
            owner,
            serverId,
          )
          .toArray()[0];
        const existing = this.ctx.storage.sql
          .exec<{ present: number }>(
            "SELECT 1 AS present FROM mcp_oauth_grants WHERE owner_email = ? AND server_id = ? LIMIT 1",
            owner,
            serverId,
          )
          .toArray()[0];
        if (revoked || existing) {
          continue;
        }
        let canonical = token;
        const rotationKey = `${OAUTH_REF_PREFIX}${owner}:${serverId}`;
        const rotation = await this.readRotation(owner, serverId, await this.ctx.storage.get<unknown>(rotationKey));
        if (rotation?.bases.includes(token.accessToken)) {
          canonical = rotation.token;
        }
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO mcp_oauth_grants (owner_email, server_id, payload, updated_at) VALUES (?, ?, ?, ?)",
          owner,
          serverId,
          await sealGrantPayload(this.vault, owner, serverId, canonical),
          Date.now(),
        );
        this.markOAuthReady(owner, serverId);
        await this.ctx.storage.delete(rotationKey);
      }
      delete profile.mcpOAuth;
    }
    if (isRecord(profile.settings) && Array.isArray(profile.settings.mcpServers)) {
      const settings = { ...profile.settings };
      const redactedServers: unknown[] = [];
      for (const item of profile.settings.mcpServers) {
        if (!isRecord(item)) {
          redactedServers.push(item);
          continue;
        }
        const server = { ...item };
        const serverId = typeof server.id === "string" && isValidId(server.id) ? server.id : "";
        const catalogId = typeof server.catalogId === "string" && isValidId(server.catalogId)
          ? server.catalogId
          : "";
        const token =
          typeof server.token === "string" && server.token && !isPlaceholderCredential(server.token)
            ? server.token
            : "";
        const headersJson = typeof server.headersJson === "string" && server.headersJson ? server.headersJson : "";
        delete server.token;
        delete server.headersJson;
        if (serverId && (token || headersJson)) {
          const revoked = this.ctx.storage.sql
            .exec<{ present: number }>(
              "SELECT 1 AS present FROM mcp_oauth_revocations WHERE owner_email = ? AND server_id = ? LIMIT 1",
              owner,
              serverId,
            )
            .toArray()[0];
          if (!revoked) {
            this.ctx.storage.sql.exec(
              "INSERT OR IGNORE INTO mcp_server_secrets (owner_email, server_id, payload, updated_at) VALUES (?, ?, ?, ?)",
              owner,
              serverId,
              await sealServerSecret(this.vault, owner, serverId, {
                ...(token ? { token } : {}),
                ...(headersJson ? { headersJson } : {}),
              }),
              Date.now(),
            );
          }
        }
        const ids = [...new Set([serverId, ...(catalogId && catalogId !== serverId ? [catalogId] : [])])]
          .filter(Boolean);
        const hasSecret = ids.some((id) => this.hasMcpServerSecret(owner, id));
        const hasGrant = ids.some((id) => {
          const grant = this.ctx.storage.sql
            .exec<{ present: number }>(
              "SELECT 1 AS present FROM mcp_oauth_grants WHERE owner_email = ? AND server_id = ? LIMIT 1",
              owner,
              id,
            )
            .toArray()[0];
          const revoked = this.ctx.storage.sql
            .exec<{ present: number }>(
              "SELECT 1 AS present FROM mcp_oauth_revocations WHERE owner_email = ? AND server_id = ? LIMIT 1",
              owner,
              id,
            )
            .toArray()[0];
          const state = this.oauthGrantState(owner, id);
          return Boolean(grant && !revoked && state !== "reauth_required" && state !== "step_up_required");
        });
        server.credentialStored = hasSecret || hasGrant;
        redactedServers.push(server);
      }
      settings.mcpServers = redactedServers;
      profile.settings = settings;
    }
    return JSON.stringify(profile);
  }

  /** Overlays server-only keys/headers onto redacted profile connector rows. */
  private async mcpConfigsWithSecrets(owner: string, raw: unknown): Promise<unknown[]> {
    if (!Array.isArray(raw)) return [];
    const out: unknown[] = [];
    for (const item of raw) {
      if (!isRecord(item) || typeof item.id !== "string") {
        out.push(item);
        continue;
      }
      out.push({ ...item, ...(await this.mcpServerSecret(owner, item.id)) });
    }
    return out;
  }

  /** The stored (still sealed) key/header row, healing poisoned legacy rows. */
  private storedMcpServerSecret(owner: string, serverId: string): ServerSecret | null {
    const row = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM mcp_server_secrets WHERE owner_email = ? AND server_id = ?",
        owner,
        serverId,
      )
      .toArray()[0];
    return row ? this.parseServerSecretRow(owner, serverId, row.payload) : null;
  }

  /** Presence only — no key needed, safe inside synchronous profile shaping. */
  private hasMcpServerSecret(owner: string, serverId: string): boolean {
    return this.storedMcpServerSecret(owner, serverId) !== null;
  }

  /** Reads one saved API-key/header pair decrypted; it never leaves the account shard. */
  private async mcpServerSecret(owner: string, serverId: string): Promise<ServerSecret> {
    const stored = this.storedMcpServerSecret(owner, serverId);
    if (!stored) {
      return {};
    }
    return openServerSecret(this.vault, owner, serverId, stored);
  }

  /**
   * All connector ids that resolve to the native GitHub integration for this
   * account: the canonical "github" id plus any profile card whose catalogId
   * points at it. Used to clear stale pasted/legacy tokens after a fresh
   * device-flow sign-in — the auth lease prefers manual secrets, so leaving
   * one behind would shadow the new grant forever.
   */
  private githubConnectorIds(owner: string): string[] {
    const ids = new Set<string>(["github"]);
    const row = this.ctx.storage.sql
      .exec<{ payload: string }>("SELECT payload FROM profiles WHERE owner_email = ?", owner)
      .toArray()[0];
    if (row) {
      try {
        const profile = JSON.parse(row.payload) as Record<string, unknown>;
        const settings = isRecord(profile.settings) ? profile.settings : {};
        const servers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
        for (const item of servers) {
          if (!isRecord(item) || typeof item.id !== "string" || !isValidId(item.id)) {
            continue;
          }
          const catalogId = typeof item.catalogId === "string" ? item.catalogId : "";
          if (item.id === "github" || catalogId === "github") {
            ids.add(item.id);
          }
        }
      } catch {
        // Malformed legacy profile: fall back to the canonical id only.
      }
    }
    return [...ids];
  }

  /**
   * Reads the physically stored OAuth grant for one connector id, honoring
   * revocation tombstones but IGNORING blocked `mcp_oauth_states` rows. A
   * user-initiated health check must be able to try a freshly committed grant
   * even when an older failure left a stale reauth/step-up marker behind —
   * otherwise a successful re-sign-in stays invisible forever.
   */
  private async rawOAuthGrant(owner: string, serverId: string): Promise<CloudOAuthToken | null> {
    const revoked = this.ctx.storage.sql
      .exec<{ present: number }>(
        "SELECT 1 AS present FROM mcp_oauth_revocations WHERE owner_email = ? AND server_id = ? LIMIT 1",
        owner,
        serverId,
      )
      .toArray()[0];
    if (revoked) {
      return null;
    }
    const row = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM mcp_oauth_grants WHERE owner_email = ? AND server_id = ?",
        owner,
        serverId,
      )
      .toArray()[0];
    if (!row) {
      return null;
    }
    return openGrantPayload(this.vault, owner, serverId, row.payload);
  }

  /**
   * Non-secret snapshot of everything that decides whether one id can
   * authenticate: usable grant, raw grant row (even when tombstoned), an
   * active revocation tombstone, a stored manual secret, and the state
   * marker. Powers `server_auth_missing` detail — never token material.
   */
  private oauthDiagnostic(
    owner: string,
    serverId: string,
  ): { id: string; grantPresent: boolean; grantRow: boolean; revoked: boolean; secret: boolean; state: string } {
    const grantRow = this.ctx.storage.sql
      .exec<{ present: number }>(
        "SELECT 1 AS present FROM mcp_oauth_grants WHERE owner_email = ? AND server_id = ? LIMIT 1",
        owner,
        serverId,
      )
      .toArray()[0];
    const revoked = this.ctx.storage.sql
      .exec<{ present: number }>(
        "SELECT 1 AS present FROM mcp_oauth_revocations WHERE owner_email = ? AND server_id = ? LIMIT 1",
        owner,
        serverId,
      )
      .toArray()[0];
    return {
      id: serverId,
      grantPresent: Boolean(grantRow && !revoked),
      grantRow: Boolean(grantRow),
      revoked: Boolean(revoked),
      secret: this.hasMcpServerSecret(owner, serverId),
      state: this.oauthGrantState(owner, serverId),
    };
  }

  private oauthGrantState(owner: string, serverId: string): string {
    return this.ctx.storage.sql
      .exec<{ state: string }>(
        "SELECT state FROM mcp_oauth_states WHERE owner_email = ? AND server_id = ?",
        owner,
        serverId,
      )
      .toArray()[0]?.state ?? "ready";
  }

  private markOAuthReady(owner: string, serverId: string): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO mcp_oauth_states
        (owner_email, server_id, state, error_code, retry_after, updated_at)
       VALUES (?, ?, 'ready', '', 0, ?)`,
      owner,
      serverId,
      Date.now(),
    );
  }

  private async markOAuthRefreshStarted(owner: string, serverId: string): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO mcp_oauth_states
        (owner_email, server_id, state, error_code, retry_after, updated_at)
       VALUES (?, ?, 'refreshing', '', 0, ?)
       ON CONFLICT(owner_email, server_id) DO UPDATE SET
         state = CASE
           WHEN mcp_oauth_states.state = 'refresh_unknown' THEN 'refresh_unknown'
           ELSE 'refreshing'
         END,
         error_code = CASE
           WHEN mcp_oauth_states.state = 'refresh_unknown' THEN mcp_oauth_states.error_code
           ELSE ''
         END,
         retry_after = 0,
         updated_at = excluded.updated_at`,
      owner,
      serverId,
      now,
    );
  }

  private async recordOAuthFailure(
    owner: string,
    serverId: string,
    outcome: CloudOAuthRefreshFailure,
  ): Promise<void> {
    const previousState = this.oauthGrantState(owner, serverId);
    const stepUpCodes = new Set(["interaction_required", "consent_required", "insufficient_scope", "invalid_scope"]);
    const followsUnknownRotation = previousState === "refresh_unknown" && outcome.code === "invalid_grant";
    const state = outcome.transient
      ? outcome.ambiguous ? "refresh_unknown" : "retryable_error"
      : followsUnknownRotation || stepUpCodes.has(outcome.code)
        ? "step_up_required"
        : "reauth_required";
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO mcp_oauth_states
        (owner_email, server_id, state, error_code, retry_after, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      owner,
      serverId,
      state,
      capStr(outcome.code, 120),
      outcome.transient ? Date.now() + 30_000 : 0,
      Date.now(),
    );
  }

  /** Reads OAuth grants from the account shard; legacy profile grants migrate once. */
  private async profileOAuthTokens(owner: string): Promise<Record<string, CloudOAuthToken>> {
    const tokens: Record<string, CloudOAuthToken> = {};
    const profileRow = this.ctx.storage.sql
      .exec<{ payload: string }>("SELECT payload FROM profiles WHERE owner_email = ?", owner)
      .toArray()[0];
    if (profileRow) {
      try {
        const parsed = JSON.parse(profileRow.payload) as unknown;
        Object.assign(tokens, cloudOAuthTokens(isRecord(parsed) ? parsed.mcpOAuth : undefined));
      } catch {
        // A malformed legacy profile cannot authenticate any connector.
      }
    }
    const rows = this.ctx.storage.sql
      .exec<{ server_id: string; payload: string }>(
        "SELECT server_id, payload FROM mcp_oauth_grants WHERE owner_email = ?",
        owner,
      )
      .toArray();
    for (const row of rows) {
      // Sealed at rest; a row this key cannot open authenticates nothing and
      // surfaces as a missing grant rather than a failed request.
      try {
        const token = await openGrantPayload(this.vault, owner, row.server_id, row.payload);
        if (token) {
          tokens[row.server_id] = token;
        }
      } catch (error) {
        if (!(error instanceof SecretVaultError)) throw error;
        console.error("oauth grant unreadable", row.server_id, error.code);
      }
    }
    const revoked = this.ctx.storage.sql
      .exec<{ server_id: string }>(
        "SELECT server_id FROM mcp_oauth_revocations WHERE owner_email = ?",
        owner,
      )
      .toArray();
    for (const row of revoked) {
      delete tokens[row.server_id];
    }
    const blocked = this.ctx.storage.sql
      .exec<{ server_id: string }>(
        "SELECT server_id FROM mcp_oauth_states WHERE owner_email = ? AND state IN ('reauth_required', 'step_up_required')",
        owner,
      )
      .toArray();
    for (const row of blocked) {
      delete tokens[row.server_id];
    }
    return tokens;
  }

  private githubDeviceRow(owner: string, flowId: string): GitHubDeviceRow | undefined {
    return this.ctx.storage.sql
      .exec<GitHubDeviceRow>(
        "SELECT * FROM mcp_github_device_pending WHERE owner_email = ? AND flow_id = ?",
        owner,
        flowId,
      )
      .toArray()[0];
  }

  /** Starts GitHub device authorization while keeping device_code in the shard. */
  private async handleGitHubDeviceStart(owner: string): Promise<Response> {
    const clientId = this.workerEnv.EXPO_PUBLIC_GITHUB_OAUTH_CLIENT_ID?.trim() ?? "";
    if (!clientId) {
      return json({ error: "github_oauth_not_configured" }, 503);
    }
    const response = await fetchPublicHttps("https://github.com/login/device/code", {
      method: "POST",
      headers: githubOAuthFormHeaders(),
      body: new URLSearchParams({
        client_id: clientId,
        scope: "repo read:org read:user user:email gist notifications workflow read:project",
      }).toString(),
      signal: AbortSignal.timeout(12_000),
    });
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const deviceCode = typeof data?.device_code === "string" ? data.device_code : "";
    const userCode = typeof data?.user_code === "string" ? data.user_code : "";
    if (!response.ok || !deviceCode || !userCode) {
      const error = typeof data?.error === "string" ? data.error : `github_device_http_${response.status}`;
      return json({ error }, response.status >= 500 ? 503 : 400);
    }
    const intervalMs = Math.max(5_000, Number(data?.interval ?? 5) * 1_000);
    const expiresAt = Date.now() + Math.max(60, Number(data?.expires_in ?? 900)) * 1_000;
    const verificationUri =
      typeof data?.verification_uri === "string" && data.verification_uri
        ? data.verification_uri
        : "https://github.com/login/device";
    const flowId = newOAuthState();
    this.ctx.storage.sql.exec(
      "DELETE FROM mcp_github_device_pending WHERE owner_email = ? AND (server_id = 'github' OR expires_at < ?)",
      owner,
      Date.now(),
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO mcp_github_device_pending
        (owner_email, flow_id, server_id, device_code, user_code, verification_uri, client_id,
         expires_at, interval_ms, next_poll_at, status, error, created_at, updated_at)
       VALUES (?, ?, 'github', ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?)`,
      owner,
      flowId,
      await this.vault.seal(deviceCode, deviceCodeScope(owner, flowId)),
      userCode,
      verificationUri,
      clientId,
      expiresAt,
      intervalMs,
      Date.now() + intervalMs,
      Date.now(),
      Date.now(),
    );
    return json({ flowId, userCode, verificationUri, intervalMs, expiresAt });
  }

  /** Polls GitHub server-side and commits the resulting grant before success. */
  private async handleGitHubDeviceStatus(request: Request, owner: string): Promise<Response> {
    const flowId = new URL(request.url).searchParams.get("flowId") ?? "";
    const row = this.githubDeviceRow(owner, flowId);
    if (!row) {
      return json({ status: "missing" }, 404);
    }
    if (row.status === "completed") {
      return json({ status: "completed" });
    }
    if (row.status === "polling" && row.updated_at < Date.now() - 30_000) {
      this.ctx.storage.sql.exec(
        "UPDATE mcp_github_device_pending SET status = 'failed', error = 'step_up_required', updated_at = ? WHERE owner_email = ? AND flow_id = ?",
        Date.now(),
        owner,
        flowId,
      );
      return json({ status: "failed", error: "step_up_required" });
    }
    if (row.status === "failed") {
      return json({ status: "failed", error: row.error });
    }
    const now = Date.now();
    if (row.expires_at <= now) {
      this.ctx.storage.sql.exec(
        "UPDATE mcp_github_device_pending SET status = 'failed', error = 'expired_token', updated_at = ? WHERE owner_email = ? AND flow_id = ?",
        now,
        owner,
        flowId,
      );
      return json({ status: "failed", error: "expired_token" });
    }
    if (row.next_poll_at > now || row.status === "polling") {
      return json({ status: "pending", retryAfterMs: Math.max(250, row.next_poll_at - now) });
    }
    this.ctx.storage.sql.exec(
      "UPDATE mcp_github_device_pending SET status = 'polling', next_poll_at = ?, updated_at = ? WHERE owner_email = ? AND flow_id = ? AND status = 'pending'",
      now + row.interval_ms,
      now,
      owner,
      flowId,
    );
    const deviceCode = await this.vault.open(row.device_code, deviceCodeScope(owner, flowId));
    let response: Response;
    try {
      response = await fetchPublicHttps("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: githubOAuthFormHeaders(),
        body: new URLSearchParams({
          client_id: row.client_id,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString(),
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      this.ctx.storage.sql.exec(
        "UPDATE mcp_github_device_pending SET status = 'pending', error = 'temporarily_unavailable', updated_at = ? WHERE owner_email = ? AND flow_id = ?",
        Date.now(),
        owner,
        flowId,
      );
      return json({ status: "pending", retryAfterMs: row.interval_ms }, 503);
    }
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.ok && typeof data?.access_token === "string" && data.access_token) {
      const expiresIn = Number(data.expires_in ?? 0);
      const token: CloudOAuthToken = {
        accessToken: data.access_token,
        refreshToken:
          typeof data.refresh_token === "string" && data.refresh_token
            ? data.refresh_token
            : undefined,
        expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1_000 : undefined,
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        clientId: row.client_id,
        mcpUrl: "https://api.github.com",
      };
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO mcp_oauth_grants (owner_email, server_id, payload, updated_at) VALUES (?, 'github', ?, ?)",
        owner,
        await sealGrantPayload(this.vault, owner, "github", token),
        Date.now(),
      );
      // Latest credential wins: a fresh sign-in supersedes any pasted PAT or
      // legacy-migrated token, which the auth lease would otherwise prefer
      // forever (stale read-only/dead tokens made GitHub look read-only).
      // Clear tombstones and blocked markers for EVERY id this account's
      // GitHub connector can resolve through — an instance-id tombstone or a
      // stale reauth marker must never outlive a successful re-sign-in.
      for (const staleId of this.githubConnectorIds(owner)) {
        this.ctx.storage.sql.exec(
          "DELETE FROM mcp_oauth_revocations WHERE owner_email = ? AND server_id = ?",
          owner,
          staleId,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM mcp_server_secrets WHERE owner_email = ? AND server_id = ?",
          owner,
          staleId,
        );
        this.markOAuthReady(owner, staleId);
      }
      this.ctx.storage.sql.exec(
        "UPDATE mcp_github_device_pending SET status = 'completed', error = '', updated_at = ? WHERE owner_email = ? AND flow_id = ?",
        Date.now(),
        owner,
        flowId,
      );
      return json({ status: "completed" });
    }
    const code = typeof data?.error === "string" ? data.error : `github_device_http_${response.status}`;
    if (code === "authorization_pending" || code === "slow_down") {
      const intervalMs = code === "slow_down" ? row.interval_ms + 5_000 : row.interval_ms;
      this.ctx.storage.sql.exec(
        "UPDATE mcp_github_device_pending SET status = 'pending', interval_ms = ?, next_poll_at = ?, error = '', updated_at = ? WHERE owner_email = ? AND flow_id = ?",
        intervalMs,
        Date.now() + intervalMs,
        Date.now(),
        owner,
        flowId,
      );
      return json({ status: "pending", retryAfterMs: intervalMs });
    }
    this.ctx.storage.sql.exec(
      "UPDATE mcp_github_device_pending SET status = 'failed', error = ?, updated_at = ? WHERE owner_email = ? AND flow_id = ?",
      capStr(code, 180),
      Date.now(),
      owner,
      flowId,
    );
    return json({ status: "failed", error: code }, 400);
  }

  private oauthPending(owner: string, state: string): OAuthPendingRow | undefined {
    return this.ctx.storage.sql
      .exec<OAuthPendingRow>(
        "SELECT * FROM mcp_oauth_pending WHERE owner_email = ? AND state = ?",
        owner,
        state,
      )
      .toArray()[0];
  }

  /** The pending row with its PKCE verifier and authorization code decrypted. */
  private revealOAuthPending(owner: string, row: OAuthPendingRow): Promise<OAuthPendingRow> {
    return openFields(this.vault, row, OAUTH_PENDING_SECRET_FIELDS, oauthPendingScope(owner, row.state));
  }

  private oauthReturnUrl(
    row: OAuthPendingRow,
    status: "confirm" | "complete" | "error" | "replayed",
  ): string {
    const target = new URL("/oauth/callback", row.return_origin);
    target.searchParams.set("state", row.state);
    target.searchParams.set("serverId", row.server_id);
    target.searchParams.set("status", status);
    if (status === "confirm" && row.callback_challenge) {
      target.searchParams.set("challenge", row.callback_challenge);
    }
    if (status === "error" && row.error) {
      target.searchParams.set("error", capStr(row.error, 180));
    }
    return target.toString();
  }

  /** Starts OAuth with PKCE metadata and verifier stored only in this shard. */
  private async handleOAuthStart(request: Request, owner: string): Promise<Response> {
    let body: { server?: unknown; returnOrigin?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const server = isRecord(body.server) ? body.server : null;
    const serverId = server && typeof server.id === "string" ? server.id : "";
    const mcpUrl = server && typeof server.url === "string" ? server.url.trim() : "";
    const returnOrigin = typeof body.returnOrigin === "string" ? body.returnOrigin : "";
    let normalizedReturnOrigin = "";
    try {
      const parsed = new URL(returnOrigin);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
        throw new Error("unsafe origin");
      }
      normalizedReturnOrigin = parsed.origin;
    } catch {
      return json({ error: "invalid_return_origin" }, 400);
    }
    if (!isValidId(serverId) || !mcpUrl || mcpUrl.length > 4_000) {
      return json({ error: "invalid_server" }, 400);
    }
    const callbackUrl = new URL("/mcp/oauth/callback", request.url).toString();
    try {
      const discovery = await discoverMcpOAuth(mcpUrl);
      if (!discovery.registrationEndpoint) {
        return json({ error: "oauth_registration_unsupported" }, 400);
      }
      const cached = this.ctx.storage.sql
        .exec<{ client_id: string; expires_at: number }>(
          `SELECT client_id, expires_at FROM mcp_oauth_clients
           WHERE owner_email = ? AND registration_endpoint = ? AND redirect_uri = ?`,
          owner,
          discovery.registrationEndpoint,
          callbackUrl,
        )
        .toArray()[0];
      let clientId = cached?.client_id ?? "";
      if (!clientId || (cached.expires_at > 0 && cached.expires_at <= Date.now() + 60_000)) {
        const registered = await registerDynamicOAuthClient(discovery.registrationEndpoint, callbackUrl);
        clientId = registered.clientId;
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO mcp_oauth_clients
            (owner_email, registration_endpoint, redirect_uri, client_id, expires_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          owner,
          discovery.registrationEndpoint,
          callbackUrl,
          clientId,
          registered.expiresAt ?? 0,
          Date.now(),
        );
      }
      const state = newOAuthState();
      const browserNonce = newOAuthState();
      const verifier = newPkceVerifier();
      const challenge = await pkceChallenge(verifier);
      const expiresAt = Date.now() + 10 * 60_000;
      // A newer attempt supersedes every older callback for this connector.
      this.ctx.storage.sql.exec(
        "DELETE FROM mcp_oauth_pending WHERE owner_email = ? AND (server_id = ? OR expires_at < ?)",
        owner,
        serverId,
        Date.now(),
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO mcp_oauth_pending
          (owner_email, state, server_id, mcp_url, token_endpoint, client_id, verifier,
           redirect_uri, resource, issuer, return_origin, browser_nonce, callback_challenge,
           authorization_code, expires_at, status, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, 'pending', '', ?, ?)`,
        owner,
        state,
        serverId,
        mcpUrl,
        discovery.tokenEndpoint,
        clientId,
        await this.vault.seal(verifier, oauthPendingFieldScope(owner, state, "verifier")),
        callbackUrl,
        discovery.resource ?? "",
        discovery.issuer,
        normalizedReturnOrigin,
        browserNonce,
        expiresAt,
        Date.now(),
        Date.now(),
      );
      const authorizationUrl = buildAuthorizationUrl({
        discovery,
        clientId,
        redirectUri: callbackUrl,
        state,
        challenge,
      });
      return json({ authorizationUrl, state, browserNonce, expiresAt });
    } catch (error) {
      return json({ error: capStr(error instanceof Error ? error.message : "oauth_start_failed", 300) }, 502);
    }
  }

  /** Browser polling surface: status only, never a provider token or verifier. */
  private handleOAuthStatus(request: Request, owner: string): Response {
    const url = new URL(request.url);
    const state = url.searchParams.get("state") ?? "";
    const row = this.oauthPending(owner, state);
    if (!row) {
      return json({ status: "missing" }, 404);
    }
    if (row.status === "exchanging" && row.updated_at < Date.now() - 30_000) {
      this.ctx.storage.sql.exec(
        "UPDATE mcp_oauth_pending SET status = 'exchange_unknown', error = 'oauth_exchange_interrupted', updated_at = ? WHERE owner_email = ? AND state = ? AND status = 'exchanging'",
        Date.now(),
        owner,
        state,
      );
      return json({ status: "pending", retryable: true, error: "oauth_exchange_interrupted" });
    }
    if (row.expires_at < Date.now() && row.status !== "completed" && row.status !== "failed") {
      this.ctx.storage.sql.exec(
        "UPDATE mcp_oauth_pending SET status = 'failed', error = 'oauth_state_expired', updated_at = ? WHERE owner_email = ? AND state = ?",
        Date.now(),
        owner,
        state,
      );
      return json({ status: "failed", error: "oauth_state_expired" });
    }
    const retryable = row.status === "exchange_retryable" || row.status === "exchange_unknown";
    return json({
      status: row.status === "completed" ? "completed" : row.status === "failed" ? "failed" : "pending",
      ...(row.error && (row.status === "failed" || retryable) ? { error: row.error } : {}),
      ...(retryable ? { retryable: true } : {}),
    });
  }

  /** Provider callback: one-time code exchange + durable grant commit in this actor. */
  private async handleOAuthCallback(request: Request, owner: string): Promise<Response> {
    let body: { state?: unknown; code?: unknown; error?: unknown; issuer?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const state = typeof body.state === "string" ? body.state : "";
    const providerError = typeof body.error === "string" ? capStr(body.error, 180) : "";
    const issuer = typeof body.issuer === "string" ? body.issuer : "";
    const code = typeof body.code === "string" ? body.code : "";
    const row = this.oauthPending(owner, state);
    if (!row) {
      return json({ error: "oauth_state_unknown" }, 404);
    }
    if (row.status === "completed") {
      return json({ ok: true, replayed: true, redirectUrl: this.oauthReturnUrl(row, "complete") });
    }
    if (row.status === "failed") {
      return json({ error: row.error || "oauth_failed", redirectUrl: this.oauthReturnUrl(row, "error") }, 409);
    }
    if (row.expires_at < Date.now()) {
      this.ctx.storage.sql.exec(
        "UPDATE mcp_oauth_pending SET status = 'failed', error = 'oauth_state_expired', updated_at = ? WHERE owner_email = ? AND state = ?",
        Date.now(),
        owner,
        state,
      );
      const expired = this.oauthPending(owner, state) ?? row;
      return json({ error: "oauth_state_expired", redirectUrl: this.oauthReturnUrl(expired, "error") }, 400);
    }
    const replayable = ["awaiting_confirmation", "exchanging", "exchange_retryable", "exchange_unknown"].includes(row.status);
    if (replayable) {
      const stored = await this.revealOAuthPending(owner, row);
      if (
        !providerError &&
        code &&
        code === stored.authorization_code &&
        (!issuer || sameOAuthEndpoint(issuer, row.issuer)) &&
        row.callback_challenge
      ) {
        return json({ ok: true, replayed: true, redirectUrl: this.oauthReturnUrl(row, "confirm") });
      }
      return json({ error: "oauth_callback_replayed", redirectUrl: this.oauthReturnUrl(row, "replayed") }, 409);
    }
    if (row.status !== "pending") {
      return json({ error: "oauth_callback_replayed", redirectUrl: this.oauthReturnUrl(row, "replayed") }, 409);
    }
    if (issuer && !sameOAuthEndpoint(issuer, row.issuer)) {
      this.ctx.storage.sql.exec(
        "UPDATE mcp_oauth_pending SET status = 'failed', error = 'oauth_issuer_mismatch', updated_at = ? WHERE owner_email = ? AND state = ?",
        Date.now(),
        owner,
        state,
      );
      const failed = this.oauthPending(owner, state) ?? row;
      return json({ error: "oauth_issuer_mismatch", redirectUrl: this.oauthReturnUrl(failed, "error") }, 400);
    }
    if (providerError) {
      this.ctx.storage.sql.exec(
        "UPDATE mcp_oauth_pending SET status = 'failed', error = ?, updated_at = ? WHERE owner_email = ? AND state = ?",
        providerError,
        Date.now(),
        owner,
        state,
      );
      const failed = this.oauthPending(owner, state) ?? row;
      return json({ error: "oauth_denied", redirectUrl: this.oauthReturnUrl(failed, "error") }, 400);
    }
    if (!code || code.length > 8_000) {
      return json({ error: "oauth_code_missing" }, 400);
    }
    // The public callback stores the one-time code but does not redeem it.
    // Completion requires two proofs that never travel in the authorization
    // URL together: browserNonce from the initiating app storage and this
    // callback challenge delivered only to the provider-returned popup.
    const callbackChallenge = newOAuthState();
    this.ctx.storage.sql.exec(
      `UPDATE mcp_oauth_pending
       SET status = 'awaiting_confirmation', authorization_code = ?, callback_challenge = ?, updated_at = ?
       WHERE owner_email = ? AND state = ? AND status = 'pending'`,
      await this.vault.seal(code, oauthPendingFieldScope(owner, state, "authorization_code")),
      callbackChallenge,
      Date.now(),
      owner,
      state,
    );
    const awaiting = this.oauthPending(owner, state) ?? row;
    return json({ ok: true, redirectUrl: this.oauthReturnUrl(awaiting, "confirm") });
  }

  /** Authenticated popup confirmation performs the only provider code exchange. */
  private async handleOAuthComplete(request: Request, owner: string): Promise<Response> {
    let body: { state?: unknown; browserNonce?: unknown; callbackChallenge?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const state = typeof body.state === "string" ? body.state : "";
    const browserNonce = typeof body.browserNonce === "string" ? body.browserNonce : "";
    const callbackChallenge =
      typeof body.callbackChallenge === "string" ? body.callbackChallenge : "";
    const row = this.oauthPending(owner, state);
    if (!row) {
      return json({ error: "oauth_state_unknown" }, 404);
    }
    if (row.status === "completed") {
      return json({ ok: true, status: "completed", replayed: true });
    }
    if (row.status === "failed") {
      return json({ error: row.error || "oauth_failed" }, 409);
    }
    const retryableStatus = row.status === "exchange_retryable" || row.status === "exchange_unknown";
    if (row.status === "exchanging" && row.updated_at >= Date.now() - 30_000) {
      return json({ error: "oauth_exchange_busy", retryable: true }, 409);
    }
    if (row.status !== "awaiting_confirmation" && row.status !== "exchanging" && !retryableStatus) {
      return json({ error: "oauth_not_ready" }, 409);
    }
    if (
      row.expires_at < Date.now() ||
      !browserNonce ||
      !callbackChallenge ||
      browserNonce !== row.browser_nonce ||
      callbackChallenge !== row.callback_challenge
    ) {
      return json({ error: row.expires_at < Date.now() ? "oauth_state_expired" : "oauth_confirmation_mismatch" }, 403);
    }
    const priorWasUnknown = row.status === "exchange_unknown" || row.status === "exchanging";
    this.ctx.storage.sql.exec(
      `UPDATE mcp_oauth_pending SET status = 'exchanging', error = '', updated_at = ?
       WHERE owner_email = ? AND state = ? AND status IN ('awaiting_confirmation', 'exchange_retryable', 'exchange_unknown', 'exchanging')`,
      Date.now(),
      owner,
      state,
    );
    try {
      const pending = await this.revealOAuthPending(owner, row);
      const token = await exchangeAuthorizationCode({
        tokenEndpoint: row.token_endpoint,
        clientId: row.client_id,
        code: pending.authorization_code,
        verifier: pending.verifier,
        redirectUri: row.redirect_uri,
        resource: row.resource || undefined,
        mcpUrl: row.mcp_url,
      });
      const committedAt = Date.now();
      // Sealed before the synchronous transaction — no await inside it.
      const sealedGrant = await sealGrantPayload(this.vault, owner, row.server_id, {
        ...token,
        authorizationState: state,
      });
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO mcp_oauth_grants (owner_email, server_id, payload, updated_at) VALUES (?, ?, ?, ?)",
          owner,
          row.server_id,
          sealedGrant,
          committedAt,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM mcp_oauth_revocations WHERE owner_email = ? AND server_id = ?",
          owner,
          row.server_id,
        );
        this.markOAuthReady(owner, row.server_id);
        this.ctx.storage.sql.exec(
          `UPDATE mcp_oauth_pending
           SET status = 'completed', error = '', verifier = '', browser_nonce = '',
               callback_challenge = '', authorization_code = '', updated_at = ?
           WHERE owner_email = ? AND state = ?`,
          committedAt,
          owner,
          state,
        );
      });
      await this.ctx.storage.delete(`${OAUTH_REF_PREFIX}${owner}:${row.server_id}`);
      return json({ ok: true, status: "completed" });
    } catch (error) {
      const exchangeError = error instanceof OAuthCodeExchangeError ? error : null;
      if (!exchangeError || exchangeError.transient) {
        const status = exchangeError?.ambiguous === false ? "exchange_retryable" : "exchange_unknown";
        const code = exchangeError?.code ?? "oauth_exchange_interrupted";
        this.ctx.storage.sql.exec(
          "UPDATE mcp_oauth_pending SET status = ?, error = ?, updated_at = ? WHERE owner_email = ? AND state = ? AND status = 'exchanging'",
          status,
          capStr(code, 180),
          Date.now(),
          owner,
          state,
        );
        return json({ error: code, retryable: true }, 503);
      }
      const code = priorWasUnknown && exchangeError.code === "invalid_grant"
        ? "step_up_required"
        : exchangeError.code;
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          `UPDATE mcp_oauth_pending
           SET status = 'failed', error = ?, verifier = '', browser_nonce = '',
               callback_challenge = '', authorization_code = '', updated_at = ?
           WHERE owner_email = ? AND state = ?`,
          capStr(code, 180),
          Date.now(),
          owner,
          state,
        );
      });
      return json({ error: code }, 400);
    }
  }

  /** Stores a newly authorized or legacy-migrated grant only in the account shard. */
  private async handleOAuthStore(request: Request, owner: string): Promise<Response> {
    let body: { serverId?: unknown; token?: unknown; grants?: unknown; mode?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    if (body.mode === "replace") {
      return json(
        {
          error: "server_owned_oauth_required",
          error_description:
            "Gera was updated — reload this page (Cmd/Ctrl+Shift+R) and start the sign-in again.",
        },
        410,
      );
    }
    const entries: Array<[string, unknown]> = [];
    if (typeof body.serverId === "string") {
      entries.push([body.serverId, body.token]);
    }
    if (isRecord(body.grants)) {
      entries.push(...Object.entries(body.grants));
    }
    let stored = 0;
    const settledIds: string[] = [];
    for (const [serverId, raw] of entries.slice(0, 20)) {
      const token = cloudOAuthToken(raw);
      if (!isValidId(serverId) || !token) {
        continue;
      }
      const revoked = this.ctx.storage.sql
        .exec<{ revoked_at: number }>(
          "SELECT revoked_at FROM mcp_oauth_revocations WHERE owner_email = ? AND server_id = ?",
          owner,
          serverId,
        )
        .toArray()[0];
      const existing = this.ctx.storage.sql
        .exec<{ payload: string }>(
          "SELECT payload FROM mcp_oauth_grants WHERE owner_email = ? AND server_id = ?",
          owner,
          serverId,
        )
        .toArray()[0];
      if (revoked || existing) {
        settledIds.push(serverId);
        continue;
      }
      let canonical = token;
      const rotationKey = `${OAUTH_REF_PREFIX}${owner}:${serverId}`;
      const rotation = await this.readRotation(owner, serverId, await this.ctx.storage.get<unknown>(rotationKey));
      if (rotation?.bases.includes(token.accessToken)) {
        canonical = rotation.token;
      }
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO mcp_oauth_grants (owner_email, server_id, payload, updated_at) VALUES (?, ?, ?, ?)",
        owner,
        serverId,
        await sealGrantPayload(this.vault, owner, serverId, canonical),
        Date.now(),
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM mcp_oauth_revocations WHERE owner_email = ? AND server_id = ?",
        owner,
        serverId,
      );
      this.markOAuthReady(owner, serverId);
      await this.ctx.storage.delete(rotationKey);
      settledIds.push(serverId);
      stored += 1;
    }
    if (settledIds.length > 0) {
      const row = this.ctx.storage.sql
        .exec<{ payload: string }>("SELECT payload FROM profiles WHERE owner_email = ?", owner)
        .toArray()[0];
      if (row) {
        try {
          const profile = JSON.parse(row.payload) as Record<string, unknown>;
          if (isRecord(profile.mcpOAuth)) {
            const legacy = { ...profile.mcpOAuth };
            for (const serverId of settledIds) {
              delete legacy[serverId];
            }
            if (Object.keys(legacy).length > 0) {
              profile.mcpOAuth = legacy;
            } else {
              delete profile.mcpOAuth;
            }
            this.ctx.storage.sql.exec(
              "UPDATE profiles SET payload = ?, updated_at = ? WHERE owner_email = ?",
              JSON.stringify(profile),
              Date.now(),
              owner,
            );
          }
        } catch {
          // Keep a malformed profile untouched; canonical rows are already safe.
        }
      }
      return json({ ok: true, stored, settledIds });
    }
    return json({ error: "invalid_grant" }, 400);
  }

  /** Removes a grant from the server; no browser credential can resurrect it. */
  private async handleOAuthClear(request: Request, owner: string): Promise<Response> {
    let body: { serverId?: unknown; catalogId?: unknown; reason?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const serverId = typeof body.serverId === "string" ? body.serverId : "";
    const catalogId = typeof body.catalogId === "string" ? body.catalogId : "";
    if (!isValidId(serverId) || (catalogId && !isValidId(catalogId))) {
      return json({ error: "invalid_server" }, 400);
    }
    if (body.reason !== "disconnect") {
      // Only an explicit user disconnect may create a durable revocation.
      // Older bundles auto-cleared on a stale/expired BROWSER copy, which
      // tombstoned and destroyed a perfectly fresh server-owned grant — every
      // new GitHub sign-in was poisoned minutes later (server_auth_missing).
      // Automatic housekeeping is a browser-local concern; ack without damage.
      return json({ ok: true, ignored: true });
    }
    const ids = [...new Set([serverId, ...(catalogId && catalogId !== serverId ? [catalogId] : [])])];
    for (const id of ids) {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO mcp_oauth_revocations (owner_email, server_id, revoked_at) VALUES (?, ?, ?)",
        owner,
        id,
        Date.now(),
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM mcp_oauth_grants WHERE owner_email = ? AND server_id = ?",
        owner,
        id,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM mcp_server_secrets WHERE owner_email = ? AND server_id = ?",
        owner,
        id,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM mcp_oauth_states WHERE owner_email = ? AND server_id = ?",
        owner,
        id,
      );
      await this.ctx.storage.delete(`${OAUTH_REF_PREFIX}${owner}:${id}`);
    }
    const row = this.ctx.storage.sql
      .exec<{ payload: string }>("SELECT payload FROM profiles WHERE owner_email = ?", owner)
      .toArray()[0];
    if (row) {
      try {
        const profile = JSON.parse(row.payload) as Record<string, unknown>;
        if (isRecord(profile.mcpOAuth) && ids.some((id) => id in profile.mcpOAuth)) {
          const oauth = { ...profile.mcpOAuth };
          for (const id of ids) {
            delete oauth[id];
          }
          profile.mcpOAuth = oauth;
          this.ctx.storage.sql.exec(
            "UPDATE profiles SET payload = ?, updated_at = ? WHERE owner_email = ?",
            JSON.stringify(profile),
            Date.now(),
            owner,
          );
        }
      } catch {
        // Malformed legacy profile remains unusable.
      }
    }
    return json({ ok: true });
  }

  /** Server-side connection check; credentials, refresh and MCP session stay in this shard. */
  private async handleMcpCheck(request: Request, owner: string): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const rawServer = isRecord(body) && isRecord(body.server) ? body.server : null;
    const serverId = rawServer && typeof rawServer.id === "string" ? rawServer.id : "";
    if (!rawServer || !isValidId(serverId)) {
      return json({ error: "invalid_server" }, 400);
    }
    const secret = {
      token:
        typeof rawServer.token === "string" && !isPlaceholderCredential(rawServer.token)
          ? rawServer.token
          : "",
      headersJson: typeof rawServer.headersJson === "string" ? rawServer.headersJson : "",
    };
    const catalogId = typeof rawServer.catalogId === "string" ? rawServer.catalogId : "";
    if (rawServer.credentialStored === false && !secret.token && !secret.headersJson) {
      this.ctx.storage.sql.exec(
        "DELETE FROM mcp_server_secrets WHERE owner_email = ? AND server_id = ?",
        owner,
        serverId,
      );
    }
    if (secret.token || secret.headersJson) {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO mcp_server_secrets (owner_email, server_id, payload, updated_at) VALUES (?, ?, ?, ?)",
        owner,
        serverId,
        await sealServerSecret(this.vault, owner, serverId, secret),
        Date.now(),
      );
    }
    const storedSecret = await this.mcpServerSecret(owner, serverId);
    const legacyCatalogSecret: ServerSecret =
      catalogId && catalogId !== serverId ? await this.mcpServerSecret(owner, catalogId) : {};
    let resolvedSecret = Object.keys(storedSecret).length > 0 ? storedSecret : legacyCatalogSecret;
    const nativeGithub = (catalogId || serverId) === "github";
    if (nativeGithub && !resolvedSecret.token) {
      // Native GitHub talks REST with a bearer token only. A leftover
      // headers-style secret can neither authenticate it nor should it mask
      // the OAuth grant path.
      resolvedSecret = {};
    }
    const authMode =
      rawServer.authMode === "none" ||
      rawServer.authMode === "bearer" ||
      rawServer.authMode === "headers" ||
      rawServer.authMode === "oauth"
        ? rawServer.authMode
        : "auto";
    const reliesOnOAuth =
      (authMode === "oauth" || authMode === "auto") &&
      !resolvedSecret.token &&
      !resolvedSecret.headersJson;
    // Every id whose grant row can authenticate this card. Device-flow GitHub
    // always commits under the canonical "github" id, so github-native cards
    // resolve it even when their own instance id differs.
    const grantIds = [
      ...new Set([
        serverId,
        ...(catalogId ? [catalogId] : []),
        ...(nativeGithub ? ["github"] : []),
      ]),
    ];
    const storedGrants = new Map<string, CloudOAuthToken>();
    for (const id of grantIds) {
      const grant = await this.rawOAuthGrant(owner, id);
      if (grant) {
        storedGrants.set(id, grant);
      }
    }
    // Fail closed on blocked states only when no grant physically exists. A
    // user-initiated check with a fresh grant must try it: success below
    // clears the stale marker, failure re-records an accurate one.
    const blockedState = reliesOnOAuth && storedGrants.size === 0
      ? grantIds
          .map((id) => this.oauthGrantState(owner, id))
          .find((state) => state === "reauth_required" || state === "step_up_required")
      : undefined;
    if (blockedState) {
      return json({ error: blockedState }, blockedState === "step_up_required" ? 403 : 401);
    }
    const oauthTokens = await this.profileOAuthTokens(owner);
    for (const [id, grant] of storedGrants) {
      if (!oauthTokens[id]) {
        oauthTokens[id] = grant;
      }
    }
    if (!oauthTokens[serverId]) {
      const donor = grantIds.find((id) => Boolean(oauthTokens[id]));
      if (donor) {
        oauthTokens[serverId] = oauthTokens[donor];
      }
    }
    // A health check must always return the complete remote tool table. The
    // account's disabled-tool preferences stay in the profile and are applied
    // when a run arms; filtering here made disabled tools disappear forever.
    const candidate = {
      ...rawServer,
      // Only shard-resolved secrets may authenticate the arm. The browser's
      // raw `token` is either already stored above or a non-credential
      // (`gera-account:*` marker) that would otherwise ride into the request
      // as a fake PAT, shadow the OAuth grant, and fail with GitHub 401.
      token: resolvedSecret.token ?? "",
      headersJson: resolvedSecret.headersJson ?? "",
      disabledTools: [],
      enabled: true,
      status: "connected",
    };
    const servers = cloudMcpServersForAutomation([candidate], [serverId], oauthTokens);
    if (servers.length === 0) {
      // Metadata only — which ids were consulted and why they cannot arm.
      // Never any token material.
      const detail = grantIds.map((id) => this.oauthDiagnostic(owner, id));
      return json({ error: "server_auth_missing", detail }, 400);
    }
    const appliedChains = new Map<string, string[]>();
    const persist = async (rotated: RefreshedOAuth): Promise<void> => {
      await this.persistCanonicalOAuthGrant(owner, rotated);
      const bases = chainRotationBases(appliedChains, rotated);
      appliedChains.set(rotated.serverId, bases);
    };
    try {
      const runtime = await armCloudMcp(
        servers,
        persist,
        (id, outcome) => this.recordOAuthFailure(owner, id, outcome),
        (id) => this.markOAuthRefreshStarted(owner, id),
      );
      if (runtime.failures.length > 0 || runtime.routes.size === 0) {
        // Only a failed arm may surface an auth state — a stale pre-existing
        // marker must never veto a verification that just succeeded.
        const authState = grantIds
          .map((id) => this.oauthGrantState(owner, id))
          .find((state) => state === "reauth_required" || state === "step_up_required");
        if (authState) {
          return json({ error: authState }, authState === "step_up_required" ? 403 : 401);
        }
        const failure = runtime.failures[0]?.result ?? "MCP server returned no tools.";
        return json({ error: failure }, 502);
      }
      if (servers[0]?.oauth) {
        // The grant just proved itself against the live provider: clear any
        // stuck reauth/step-up markers so leases and relays use it again.
        for (const id of grantIds) {
          if (storedGrants.has(id)) {
            this.markOAuthReady(owner, id);
          }
        }
      }
      const tools = [...runtime.routes.entries()].map(([functionName, route]) => {
        const definition = runtime.toolDefs.find((tool) => tool.function.name === functionName);
        return {
          name: route.toolName,
          description: definition?.function.description ?? route.toolName,
          inputSchema: definition?.function.parameters ?? { type: "object", properties: {} },
        };
      });
      const credentialStored = Boolean(
        resolvedSecret.token ||
        resolvedSecret.headersJson ||
        oauthTokens[serverId],
      );
      return json({ tools, identity: `${servers[0].name} · server verified`, credentialStored });
    } catch (error) {
      // An unexpected fault inside the check (a refresh race, a storage error)
      // must not escape as a Durable Object exception: the Worker would report
      // Gera's backend as unavailable and the real cause would never reach the
      // journal. Every credential in scope is redacted first; a health probe
      // is idempotent, so one retry is always safe.
      const armed = servers[0];
      const secrets = [
        ...Object.values(armed?.headers ?? {}),
        armed?.token ?? "",
        resolvedSecret.token ?? "",
        ...Object.values(oauthTokens).flatMap((grant) => [grant.accessToken, grant.refreshToken ?? ""]),
      ];
      const detail = redactCloudMcpText(error instanceof Error ? error.message : "check failed", secrets).slice(0, 300);
      console.error("mcp check failed", serverId, detail);
      return json({ error: "mcp_check_failed", detail, retryable: true }, 502);
    }
  }

  /** Rejects a late refresh when the canonical grant changed while the provider request awaited. */
  private async assertOAuthRotationCurrent(owner: string, rotated: RefreshedOAuth): Promise<void> {
    const tokens = await this.profileOAuthTokens(owner);
    const key = `${OAUTH_REF_PREFIX}${owner}:${rotated.serverId}`;
    const existing = await this.readRotation(owner, rotated.serverId, await this.ctx.storage.get<unknown>(key));
    if (existing) {
      overlayOAuthRotations(tokens, [existing]);
    }
    const currentAccess = tokens[rotated.serverId]?.accessToken;
    if (currentAccess !== rotated.baseAccessToken && currentAccess !== rotated.token.accessToken) {
      throw new Error("stale OAuth refresh result");
    }
  }

  /** Atomically promotes one provider rotation into the SQL source of truth. */
  private async persistCanonicalOAuthGrant(owner: string, rotated: RefreshedOAuth): Promise<void> {
    await this.assertOAuthRotationCurrent(owner, rotated);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO mcp_oauth_grants (owner_email, server_id, payload, updated_at) VALUES (?, ?, ?, ?)",
      owner,
      rotated.serverId,
      await sealGrantPayload(this.vault, owner, rotated.serverId, rotated.token),
      Date.now(),
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM mcp_oauth_revocations WHERE owner_email = ? AND server_id = ?",
      owner,
      rotated.serverId,
    );
    this.markOAuthReady(owner, rotated.serverId);
    await this.ctx.storage.delete(`${OAUTH_REF_PREFIX}${owner}:${rotated.serverId}`);
  }

  /**
   * POST /mcp/oauth-refresh — deployment-safe browser refresh. The provider's
   * rotating response is committed to this account shard before it is returned
   * to the tab. If a publish reload loses that response, the next bundle sends
   * the old base again and receives the durable tip without redeeming twice.
   */
  private async handleBrowserOAuthRefresh(request: Request, owner: string): Promise<Response> {
    let body: { serverId?: unknown; token?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const serverId = typeof body.serverId === "string" ? body.serverId : "";
    const incoming = cloudOAuthToken(body.token);
    if (!isValidId(serverId) || !incoming?.refreshToken || !incoming.tokenEndpoint || !incoming.clientId) {
      return json({ error: "invalid_grant" }, 400);
    }
    const blockedState = this.oauthGrantState(owner, serverId);
    if (blockedState === "reauth_required" || blockedState === "step_up_required") {
      return json({ error: blockedState }, blockedState === "step_up_required" ? 403 : 401);
    }

    const key = `${OAUTH_REF_PREFIX}${owner}:${serverId}`;
    let existing = await this.readRotation(owner, serverId, await this.ctx.storage.get<unknown>(key));
    const profileGrant = (await this.profileOAuthTokens(owner))[serverId];
    if (existing?.bases.includes(incoming.accessToken)) {
      const profileStillOnChain =
        Boolean(profileGrant) &&
        (profileGrant?.accessToken === existing.token.accessToken || existing.bases.includes(profileGrant?.accessToken ?? ""));
      if (!profileStillOnChain) {
        // A sign-out or fresh sign-in in the durable profile outranks a stale
        // tab. Escrow repairs deploy loss, never resurrects a removed account grant.
        return json({ error: "stale_grant" }, 409);
      }
      this.markOAuthReady(owner, serverId);
      return json({ ok: true, credentialStored: true, replayed: true });
    }

    if (
      existing &&
      existing.token.accessToken !== incoming.accessToken &&
      profileGrant?.accessToken === incoming.accessToken
    ) {
      // The durable profile proves this is a fresh sign-in outside the old
      // chain. Retire the obsolete escrow before refreshing the new grant.
      await this.ctx.storage.delete(key);
      existing = null;
    }
    if (profileGrant && profileGrant.accessToken !== incoming.accessToken) {
      return json({ error: "stale_grant" }, 409);
    }

    const appliedChains = new Map<string, string[]>();
    const grant = existing?.token.accessToken === incoming.accessToken ? existing.token : incoming;
    if (existing?.token.accessToken === grant.accessToken) {
      appliedChains.set(serverId, existing.bases);
    }
    const profileAnchor = profileGrant?.accessToken ?? null;
    const server = {
      id: serverId,
      name: serverId,
      kind: "mcp" as const,
      url: grant.mcpUrl ?? grant.tokenEndpoint,
      headers: {},
      omitMcpHeaders: false,
      disabledTools: [],
      oauth: grant,
    };
    const persist = async (rotated: RefreshedOAuth): Promise<void> => {
      const latestProfile = (await this.profileOAuthTokens(owner))[serverId];
      if (
        (profileAnchor !== null && latestProfile?.accessToken !== profileAnchor && latestProfile?.accessToken !== rotated.token.accessToken) ||
        (profileAnchor === null && latestProfile && latestProfile.accessToken !== rotated.baseAccessToken && latestProfile.accessToken !== rotated.token.accessToken)
      ) {
        throw new Error("stale OAuth refresh result");
      }
      const latestOverride = await this.readRotation(owner, serverId, await this.ctx.storage.get<unknown>(key));
      if (latestOverride?.bases.includes(rotated.baseAccessToken)) {
        throw new Error("OAuth refresh already committed");
      }
      if (
        latestOverride &&
        latestOverride.token.accessToken !== rotated.baseAccessToken &&
        latestOverride.token.accessToken !== rotated.token.accessToken
      ) {
        throw new Error("stale OAuth refresh result");
      }
      if (latestOverride) {
        appliedChains.set(serverId, latestOverride.bases);
      }
      const bases = chainRotationBases(appliedChains, rotated);
      await this.persistCanonicalOAuthGrant(owner, rotated);
      appliedChains.set(serverId, bases);
    };

    try {
      const outcome = await refreshCloudOAuthGrant(
        server,
        persist,
        (id) => this.markOAuthRefreshStarted(owner, id),
      );
      if (outcome.ok === false) {
        await this.recordOAuthFailure(owner, serverId, outcome);
        const status = outcome.transient ? (outcome.status === 429 ? 429 : 503) : 400;
        return json(
          { error: outcome.code, transient: outcome.transient },
          status,
        );
      }
      return json({ ok: true, credentialStored: true, replayed: false });
    } catch {
      // A sibling request may have durably committed the shared provider
      // response first. Return that winner; otherwise keep the caller's local
      // grant untouched and let a later retry reconcile it.
      const winner = await this.readRotation(owner, serverId, await this.ctx.storage.get<unknown>(key));
      if (winner?.bases.includes(incoming.accessToken)) {
        this.markOAuthReady(owner, serverId);
        return json({ ok: true, credentialStored: true, replayed: true });
      }
      return json({ error: "refresh_commit_unavailable", transient: true }, 503);
    }
  }

  /**
   * GET /mcp/oauth-rotations — raw rotation overrides for this account. The
   * browser calls this as a last resort before dropping a sign-in whose
   * refresh was rejected: when a server run already rotated the grant while
   * the browser slept, the browser adopts the fresh pair instead of forcing
   * a new sign-in.
   */
  private async handleOAuthRotations(_email: string): Promise<Response> {
    // Compatibility endpoint intentionally returns proof only. Provider grants
    // never leave the account shard in browser-facing responses.
    return json({ rotations: [], serverOwned: true });
  }

  /** Internal Worker-only lease; provider credentials never cross the public response. */
  private async handleMcpAuthLease(request: Request, owner: string): Promise<Response> {
    let body: { serverId?: unknown; catalogId?: unknown; force?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const serverId = typeof body.serverId === "string" ? body.serverId : "";
    const catalogId = typeof body.catalogId === "string" ? body.catalogId : "";
    if (!isValidId(serverId) || (catalogId && !isValidId(catalogId))) {
      return json({ error: "invalid_server" }, 400);
    }
    const nativeGithub = (catalogId || serverId) === "github";
    const ids = [
      ...new Set([
        serverId,
        ...(catalogId && catalogId !== serverId ? [catalogId] : []),
        // Device-flow GitHub commits its grant under the canonical "github"
        // id; instance cards must resolve it regardless of their own id.
        ...(nativeGithub ? ["github"] : []),
      ]),
    ];
    for (const id of ids) {
      const secret = await this.mcpServerSecret(owner, id);
      if (secret.token) {
        const authorization = /^Bearer\s/i.test(secret.token) ? secret.token : `Bearer ${secret.token}`;
        return json({ authorization });
      }
    }
    const storedGrants = new Map<string, CloudOAuthToken>();
    for (const id of ids) {
      const stored = await this.rawOAuthGrant(owner, id);
      if (stored) {
        storedGrants.set(id, stored);
      }
    }
    // A stale blocked marker must never hide a physically present grant: a
    // fresh sign-in is the recovery path and has to be tried. Fail closed on
    // the marker only when no grant exists at all.
    const blockedState = storedGrants.size === 0
      ? ids
          .map((id) => this.oauthGrantState(owner, id))
          .find((state) => state === "reauth_required" || state === "step_up_required")
      : undefined;
    if (blockedState) {
      return json({ error: blockedState }, blockedState === "step_up_required" ? 403 : 401);
    }
    const tokens = await this.profileOAuthTokens(owner);
    for (const [id, stored] of storedGrants) {
      if (!tokens[id]) {
        tokens[id] = stored;
      }
    }
    const grantId = ids.find((id) => Boolean(tokens[id]));
    if (!grantId) {
      // Metadata only — never token material. Tells the caller exactly which
      // ids were consulted and why each one cannot authenticate.
      const detail = ids.map((id) => this.oauthDiagnostic(owner, id));
      return json({ error: "server_auth_missing", detail }, 404);
    }
    const grant = tokens[grantId];
    const server = {
      id: grantId,
      name: grantId,
      kind: "mcp" as const,
      url: grant.mcpUrl ?? grant.tokenEndpoint,
      headers: {},
      omitMcpHeaders: false,
      disabledTools: [],
      oauth: grant,
    };
    const refreshed: RefreshedOAuth[] = [];
    if (body.force === true) {
      const outcome = await forceRefreshCloudOAuthOutcome(
        server,
        refreshed,
        (rotated) => this.persistCanonicalOAuthGrant(owner, rotated),
        (id) => this.markOAuthRefreshStarted(owner, id),
      );
      if (outcome.ok === false) {
        await this.recordOAuthFailure(owner, grantId, outcome);
        return json({ error: outcome.transient ? "retryable_error" : this.oauthGrantState(owner, grantId) }, outcome.transient ? 503 : 401);
      }
    } else {
      const outcome = await ensureFreshCloudOAuth(
        server,
        refreshed,
        (rotated) => this.persistCanonicalOAuthGrant(owner, rotated),
        (id) => this.markOAuthRefreshStarted(owner, id),
      );
      if (outcome?.ok === false) {
        await this.recordOAuthFailure(owner, grantId, outcome);
        return json({ error: outcome.transient ? "retryable_error" : this.oauthGrantState(owner, grantId) }, outcome.transient ? 503 : 401);
      }
    }
    if (storedGrants.has(grantId)) {
      // The grant is durable and just leased successfully — clear any stale
      // reauth/step-up marker so later leases stop tripping over it.
      this.markOAuthReady(owner, grantId);
    }
    return json({ authorization: `Bearer ${server.oauth?.accessToken ?? grant.accessToken}` });
  }

  /**
   * POST /mcp/resolve — internal: resolves this account's connected MCP
   * servers for a project agent run. Body: `{ ids, force? }`. Reuses the
   * exact cloud-automation pipeline (profile blob + rotation overlays);
   * expiring — or force-listed — sign-ins are refreshed here and the rotated
   * pairs persist to this shard, so browsers and later runs adopt them.
   * Returns fully resolved servers; credentials never leave the backend.
   */
  private async handleMcpResolve(request: Request, owner: string): Promise<Response> {
    let body: unknown = null;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_json" }, 400);
    }
    const ids =
      isRecord(body) && Array.isArray(body.ids)
        ? body.ids.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 8)
        : [];
    const force = new Set(
      isRecord(body) && Array.isArray(body.force)
        ? body.force.filter((item): item is string => typeof item === "string")
        : [],
    );
    if (ids.length === 0) {
      return json({ servers: [] });
    }
    const profileRow = this.ctx.storage.sql
      .exec<{ payload: string }>("SELECT payload FROM profiles WHERE owner_email = ?", owner)
      .toArray()[0];
    let parsed: unknown = null;
    if (profileRow) {
      try {
        parsed = JSON.parse(profileRow.payload);
      } catch {
        parsed = null;
      }
    }
    if (!isRecord(parsed) || !isRecord(parsed.settings)) {
      return json({ servers: [] });
    }
    const oauthTokens = await this.profileOAuthTokens(owner);
    const prefix = `${OAUTH_REF_PREFIX}${owner}:`;
    const overrideRows = await this.ctx.storage.list<unknown>({ prefix });
    const rotations: OAuthRotation[] = [];
    for (const [key, value] of overrideRows) {
      const rotation = await this.readRotation(owner, key.slice(prefix.length), value);
      if (rotation) {
        rotations.push(rotation);
      }
    }
    const { appliedChains } = overlayOAuthRotations(oauthTokens, rotations);
    const servers = cloudMcpServersForAutomation(
      await this.mcpConfigsWithSecrets(owner, parsed.settings.mcpServers),
      ids,
      oauthTokens,
    ).filter(
      (server) => server.kind === "mcp",
    );
    const refreshed: RefreshedOAuth[] = [];
    const unavailable = new Set<string>();
    const persistOAuth = async (rotated: RefreshedOAuth): Promise<void> => {
      await this.persistCanonicalOAuthGrant(owner, rotated);
      const bases = chainRotationBases(appliedChains, rotated);
      appliedChains.set(rotated.serverId, bases);
    };
    for (const server of servers) {
      if (!server.oauth) {
        continue;
      }
      const outcome = force.has(server.id)
        ? await forceRefreshCloudOAuthOutcome(
            server,
            refreshed,
            persistOAuth,
            (id) => this.markOAuthRefreshStarted(owner, id),
          )
        : await ensureFreshCloudOAuth(
            server,
            refreshed,
            persistOAuth,
            (id) => this.markOAuthRefreshStarted(owner, id),
          );
      if (outcome?.ok === false) {
        await this.recordOAuthFailure(owner, server.id, outcome);
        if (!outcome.transient || force.has(server.id)) {
          unavailable.add(server.id);
        }
      }
    }
    return json({ servers: servers.filter((server) => !unavailable.has(server.id)) });
  }

  /**
   * Rotation overrides that still apply to the stored profile blob — the
   * sync response carries them so connected browsers adopt server-rotated
   * grants. Dead overrides (blob caught up, server signed out, or replaced
   * by a fresh sign-in) are pruned here, so the common case stays empty and
   * costs one storage list.
   */
  private async pendingOAuthRotations(
    owner: string,
    blobPayload: string | null,
  ): Promise<OAuthRotation[] | undefined> {
    const prefix = `${OAUTH_REF_PREFIX}${owner}:`;
    const rows = await this.ctx.storage.list<unknown>({ prefix });
    if (rows.size === 0) {
      return undefined;
    }
    let payload = blobPayload;
    if (payload === null) {
      const row = this.ctx.storage.sql
        .exec<{ payload: string }>("SELECT payload FROM profiles WHERE owner_email = ?", owner)
        .toArray()[0];
      payload = row?.payload ?? null;
    }
    let parsed: unknown = null;
    if (payload) {
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = null;
      }
    }
    const tokens = cloudOAuthTokens(isRecord(parsed) ? parsed.mcpOAuth : undefined);
    const rotations: OAuthRotation[] = [];
    for (const [key, value] of rows) {
      const rotation = await this.readRotation(owner, key.slice(prefix.length), value);
      if (rotation) {
        rotations.push(rotation);
      } else {
        await this.ctx.storage.delete(key);
      }
    }
    const { appliedChains, staleIds } = overlayOAuthRotations(tokens, rotations);
    for (const id of staleIds) {
      await this.ctx.storage.delete(`${prefix}${id}`);
    }
    const live = rotations.filter((rotation) => appliedChains.has(rotation.serverId));
    return live.length > 0 ? live : undefined;
  }

  /**
   * The earliest next due instant across this account's cloud automations
   * (0 = none). Pending run-now force flags count as due immediately.
   */
  private async nextDueForOwner(owner: string, knownPayload?: string): Promise<number> {
    const pendingForce = await this.ctx.storage.list({ prefix: FORCE_RUN_PREFIX, limit: 1 });
    if (pendingForce.size > 0) {
      return Date.now();
    }
    // Queued webhook deliveries are due immediately — /fire drains them.
    const pendingHooks = await this.ctx.storage.list({ prefix: HOOK_QUEUE_PREFIX, limit: 1 });
    if (pendingHooks.size > 0) {
      return Date.now();
    }
    let payload = knownPayload;
    if (payload === undefined) {
      const row = this.ctx.storage.sql
        .exec<{ payload: string }>("SELECT payload FROM profiles WHERE owner_email = ?", owner)
        .toArray()[0];
      payload = row?.payload;
    }
    // Cheap prefilter before a potentially large JSON.parse.
    if (!payload || !payload.includes('"server"')) {
      return 0;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return 0;
    }
    if (!isRecord(parsed) || !isRecord(parsed.settings)) {
      return 0;
    }
    const serverAutos = (Array.isArray(parsed.settings.automations) ? parsed.settings.automations : [])
      .map(storedAutomation)
      .filter(
        (item): item is StoredAutomation =>
          item !== null &&
          item.runOn === "server" &&
          item.enabled &&
          item.prompt.trim().length > 0 &&
          item.conversationId.length > 0,
      );
    if (serverAutos.length === 0) {
      return 0;
    }
    const lastRuns = this.readLastRuns(owner);
    let next = Number.POSITIVE_INFINITY;
    for (const auto of serverAutos) {
      const base = Math.max(lastRuns.get(auto.id) ?? 0, auto.lastRunAt, auto.createdAt);
      next = Math.min(next, nextDueAt(auto, base));
    }
    return Number.isFinite(next) ? next : 0;
  }

  private readLastRuns(owner: string): Map<string, number> {
    const rows = this.ctx.storage.sql
      .exec<{ automation_id: string; last_run_at: number }>(
        "SELECT automation_id, last_run_at FROM server_runs WHERE owner_email = ?",
        owner,
      )
      .toArray();
    return new Map(rows.map((row) => [row.automation_id, row.last_run_at]));
  }

  /**
   * "Run now": flags one cloud automation and rings the alarm — the run
   * then flows through the exact same claimed pipeline as a scheduled
   * trigger. Works even for paused automations (explicit user intent).
   */
  private async handleRunNow(request: Request, email: string): Promise<Response> {
    let body: { automationId?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const automationId = asStr(body.automationId);
    if (!isValidId(automationId)) {
      return json({ error: "invalid_id" }, 400);
    }
    const row = this.ctx.storage.sql
      .exec<{ payload: string }>("SELECT payload FROM profiles WHERE owner_email = ?", email)
      .toArray()[0];
    if (!row) {
      return json({ error: "no_profile" }, 404);
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      return json({ error: "no_profile" }, 404);
    }
    const settings = isRecord(parsed) && isRecord(parsed.settings) ? parsed.settings : null;
    const autosRaw = settings && Array.isArray(settings.automations) ? settings.automations : [];
    const auto = autosRaw
      .map(storedAutomation)
      .find((item): item is StoredAutomation => item !== null && item.id === automationId);
    if (!auto) {
      return json({ error: "not_found" }, 404);
    }
    if (auto.runOn !== "server") {
      return json({ error: "browser_automation" }, 400);
    }
    if (!auto.prompt.trim() || !auto.conversationId) {
      return json({ error: "not_runnable" }, 400);
    }
    await this.ctx.storage.put(`${FORCE_RUN_PREFIX}${automationId}`, Date.now());
    // No alarms on this platform — the Worker fires /fire right after this
    // returns, and the cron tick rescues the flag if that fire dies.
    return json({ ok: true }, 200, {
      [NEXT_DUE_HEADER]: String(Date.now()),
      [HOOKS_HEADER]: this.hooksIndexValue(row.payload),
    });
  }

  /**
   * POST /hook-fire — one incoming webhook delivery for this account. The
   * Worker resolved the token via the global registry; this re-validates it
   * against the LIVE profile (the registry is only routing — a stale or
   * hijacked row can never fire what the profile does not carry), queues the
   * delivery, and the Worker fires /fire right after. Bursts coalesce: up to
   * HOOK_QUEUE_CAP pending deliveries run as one batch.
   */
  private async handleHookFire(request: Request, email: string): Promise<Response> {
    let body: {
      automationId?: unknown;
      token?: unknown;
      payload?: unknown;
      contentType?: unknown;
      event?: unknown;
      delivery?: unknown;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const automationId = asStr(body.automationId);
    const token = asStr(body.token);
    if (!isValidId(automationId) || !HOOK_TOKEN_PATTERN.test(token)) {
      return json({ error: "unknown_hook" }, 404);
    }
    const row = this.ctx.storage.sql
      .exec<{ payload: string }>("SELECT payload FROM profiles WHERE owner_email = ?", email)
      .toArray()[0];
    if (!row) {
      return json({ error: "unknown_hook" }, 404);
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      return json({ error: "unknown_hook" }, 404);
    }
    const settings = isRecord(parsed) && isRecord(parsed.settings) ? parsed.settings : null;
    const auto = (settings && Array.isArray(settings.automations) ? settings.automations : [])
      .map(storedAutomation)
      .find((item): item is StoredAutomation => item !== null && item.id === automationId);
    if (!auto || auto.webhookToken === null || auto.webhookToken !== token) {
      return json({ error: "unknown_hook" }, 404);
    }
    if (auto.runOn !== "server") {
      return json(
        {
          error: "browser_automation",
          hint: "Switch this automation to cloud runs — webhook deliveries fire on the server.",
        },
        409,
      );
    }
    if (!auto.enabled) {
      return json({ error: "automation_paused" }, 409);
    }
    if (!auto.prompt.trim() || !auto.conversationId) {
      return json({ error: "not_runnable" }, 409);
    }
    const key = `${HOOK_QUEUE_PREFIX}${automationId}`;
    const stored = await this.ctx.storage.get<HookQueue>(key);
    const queue: HookQueue =
      stored && Array.isArray(stored.entries)
        ? { entries: stored.entries, dropped: asNum(stored.dropped, 0) }
        : { entries: [], dropped: 0 };
    queue.entries.push({
      at: Date.now(),
      payload: capStr(asStr(body.payload), HOOK_PAYLOAD_STORE_CHARS),
      contentType: capStr(asStr(body.contentType), 120),
      event: capStr(asStr(body.event), 120),
      delivery: capStr(asStr(body.delivery), 120),
    });
    while (queue.entries.length > HOOK_QUEUE_CAP) {
      queue.entries.shift();
      queue.dropped += 1;
    }
    await this.ctx.storage.put(key, queue);
    console.log("hook queued", automationId, queue.entries.length);
    return json({ ok: true, automation: auto.name, queued: queue.entries.length }, 200, {
      [NEXT_DUE_HEADER]: String(Date.now()),
      [HOOKS_HEADER]: this.hooksIndexValue(row.payload),
    });
  }

  /**
   * JSON rows ([{t,a}]) for the X-Gera-Hooks header — every automation
   * carrying a webhook token, so the Worker keeps the global token registry
   * fresh on the same responses that refresh the schedule index.
   */
  private hooksIndexValue(payload: string | null | undefined): string {
    if (!payload || !payload.includes("wh_")) {
      return "[]";
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return "[]";
    }
    if (!isRecord(parsed) || !isRecord(parsed.settings)) {
      return "[]";
    }
    const rows = (Array.isArray(parsed.settings.automations) ? parsed.settings.automations : [])
      .map(storedAutomation)
      .filter((item): item is StoredAutomation => item !== null && item.webhookToken !== null)
      .slice(0, HOOKS_INDEX_CAP)
      .map((item) => ({ t: item.webhookToken, a: item.id }));
    return JSON.stringify(rows);
  }

  /**
   * The narrow slice of this object the migration/registry route module
   * receives — those handlers live in chat-migration-routes.ts and must not
   * see the rest of the Durable Object.
   */
  private routeContext(): ChatStoreRouteContext {
    return {
      sql: this.ctx.storage.sql,
      diagMeta: (owner: string) => this.diagMeta(owner),
      nextDueForOwner: (owner: string, knownPayload?: string) => this.nextDueForOwner(owner, knownPayload),
      hooksIndexValue: (payload: string | null | undefined) => this.hooksIndexValue(payload),
      markShardInitialized: async (owner: string) => {
        await this.ctx.storage.put("shardOwner", owner);
      },
      shardOwner: async () => (await this.ctx.storage.get<string>("shardOwner")) ?? "",
      hasOwnerStorage: async (owner: string) => {
        const rows = await this.ctx.storage.list({ prefix: `${OAUTH_REF_PREFIX}${owner}:`, limit: 1 });
        return rows.size > 0;
      },
      prepareProfilePayload: (owner: string, payload: string) => this.prepareProfilePayload(owner, payload),
      exportOwnerStorage: async (owner: string) => {
        const prefix = `${OAUTH_REF_PREFIX}${owner}:`;
        const rows = await this.ctx.storage.list<unknown>({ prefix });
        return [...rows.entries()]
          .map(([key, value]) => ({ serverId: key.slice(prefix.length), value }))
          .filter((item) => isValidId(item.serverId));
      },
      importOwnerStorage: async (owner: string, rows: Array<{ serverId: string; value: unknown }>) => {
        for (const row of rows) {
          if (!isValidId(row.serverId)) {
            continue;
          }
          const key = `${OAUTH_REF_PREFIX}${owner}:${row.serverId}`;
          if ((await this.ctx.storage.get(key)) === undefined) {
            // Exported envelopes re-seal under this shard's scope (same owner
            // and server id, so the same key opens them); a keyless shard
            // keeps the row exactly as exported — a move, not a new secret.
            const value = this.vault.enabled
              ? await sealRotationValue(this.vault, owner, row.serverId, row.value)
              : row.value;
            await this.ctx.storage.put(key, value);
          }
        }
      },
    };
  }


  /** Assembles everything the Worker's LLM loop needs for one cloud run. */
  private async buildClaimJob(
    owner: string,
    auto: StoredAutomation,
    settings: Record<string, unknown>,
    life: Record<string, unknown>,
    oauthTokens: Record<string, CloudOAuthToken>,
  ): Promise<ClaimJob> {
    const agents = Array.isArray(settings.agents) ? settings.agents : [];
    const agent = agents.find(
      (item): item is Record<string, unknown> => isRecord(item) && item.id === auto.agentId,
    );

    const personaParts: string[] = [];
    if (agent) {
      const name = asStr(agent.name) || "Agent";
      const tagline = asStr(agent.tagline).trim();
      personaParts.push(`You are "${name}"${tagline ? ` — ${tagline}` : ""}.`);
      if (asStr(agent.systemPrompt).trim()) {
        personaParts.push(asStr(agent.systemPrompt).trim());
      }
    }
    if (asStr(settings.systemPrompt).trim()) {
      personaParts.push(asStr(settings.systemPrompt).trim());
    }
    // Skills: reusable instruction packs synced inside the profile blob —
    // enabled chat-surface ones (narrowed by the agent's allow-list AND the
    // automation's own allow-list) ride into the cloud run's persona,
    // mirroring what browser runs inject.
    const skillsBlock = cloudSkillsBlock(settings.skills, agent, auto.skillIds);
    if (skillsBlock) {
      personaParts.push(skillsBlock);
    }

    // Agent knowledge travels as a capped digest — enough for reference
    // material without blowing the cloud run's context.
    let knowledge = "";
    if (agent && Array.isArray(agent.knowledge) && agent.knowledge.length > 0) {
      const parts: string[] = [];
      let used = 0;
      for (const doc of agent.knowledge) {
        if (!isRecord(doc) || typeof doc.text !== "string" || doc.text.trim().length === 0) {
          continue;
        }
        const slice = doc.text.slice(0, Math.max(0, 6_000 - used));
        if (slice.length === 0) {
          parts.push(`[file: ${asStr(doc.name) || "Document"} — omitted, knowledge digest is full]`);
          continue;
        }
        parts.push(`[file: ${asStr(doc.name) || "Document"}]\n${slice}`);
        used += slice.length;
      }
      if (parts.length > 0) {
        knowledge = `AGENT KNOWLEDGE (digest — cloud runs carry excerpts only):\n${parts.join("\n\n")}`;
      }
    }

    const memories: string[] = [];
    if (life.shareWithAgent !== false && Array.isArray(life.memories)) {
      for (const memory of life.memories.slice(0, 20)) {
        if (isRecord(memory) && typeof memory.text === "string" && memory.text.trim()) {
          memories.push(capStr(memory.text, 200));
        }
      }
    }

    // Thread tail so "summarize what's new since the previous check" works.
    const prior: Array<{ role: "user" | "assistant"; content: string }> = [];
    const chatRow = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM chats WHERE owner_email = ? AND id = ?",
        owner,
        auto.conversationId,
      )
      .toArray()[0];
    if (chatRow) {
      try {
        const chat = JSON.parse(chatRow.payload) as { messages?: unknown };
        const messages = Array.isArray(chat.messages) ? chat.messages : [];
        for (const message of messages.slice(-6)) {
          if (
            isRecord(message) &&
            (message.role === "user" || message.role === "assistant") &&
            typeof message.content === "string" &&
            message.content.trim().length > 0
          ) {
            prior.push({ role: message.role, content: capStr(message.content, 2_000) });
          }
        }
      } catch {
        // corrupted tail — run without context
      }
    }

    const agentModel = agent ? asStr(agent.modelId) : "";
    return {
      owner,
      automationId: auto.id,
      conversationId: auto.conversationId,
      name: auto.name,
      prompt: auto.prompt,
      modelId: agentModel || asStr(settings.modelId) || "spacexai/grok-4.6:xhigh",
      systemPrompt: personaParts.join("\n\n"),
      agentId: auto.agentId,
      memories,
      knowledge,
      prior,
      // Profile and automation allow-lists intersect exactly like browser
      // runs; a cloud schedule can never resurrect GitHub excluded by its profile.
      mcpServers: cloudMcpServersForAutomation(
        await this.mcpConfigsWithSecrets(owner, settings.mcpServers),
        intersectMcpAllowIds(settings.mcpServers, agent?.mcpServerIds, auto.mcpServerIds),
        oauthTokens,
      ),
    };
  }

  /**
   * Appends one finished cloud run to the automation's chat thread — called
   * by alarm() after runAutomationJob returns. Same merge rules as a client
   * push: cap-aware, tombstone-resurrecting, LWW clock bump.
   */
  private appendRun(
    owner: string,
    input: {
      automationId: string;
      conversationId: string;
      name: string;
      agentId: string | null;
      modelId: string;
      userText: string;
      assistantText: string;
      toolCalls: ToolRecord[];
      sources: SourceRef[];
      execution: ExecutionOutcome;
      startedAt: number;
    },
  ): void {
    const conversationId = input.conversationId;
    const automationId = input.automationId;
    if (!isValidId(conversationId) || !isValidId(automationId)) {
      console.error("automation append: invalid ids");
      return;
    }
    const now = Date.now();
    const userText = capStr(input.userText, 8_000);
    const assistantText = capStr(input.assistantText, 300_000) || "(empty reply)";
    const toolCalls = input.toolCalls.slice(0, 24).map((call, index) => ({
      id: `srv_${now}_${index}`,
      name: capStr(call.name || "tool", 60),
      arguments: capStr(call.arguments, 500),
      status: "done" as const,
      result: capStr(call.result, 1_500),
    }));
    // Citation targets gathered by the runner's tool layer — [n] markers in
    // the assistant text link to sources[n-1] in the client UI.
    const sources = input.sources
      .slice(0, 24)
      .map((item) => ({ url: capStr(item.url, 600), title: capStr(item.title, 200) }))
      .filter((item) => item.url.startsWith("http"));

    const existing = this.ctx.storage.sql
      .exec<ChatRow>(
        "SELECT id, title, updated_at, payload FROM chats WHERE owner_email = ? AND id = ?",
        owner,
        conversationId,
      )
      .toArray()[0];

    type LooseChat = {
      id: string;
      title: string;
      modelId: string;
      agentId?: string;
      automationId?: string;
      githubRepo?: string;
      messages: unknown[];
      createdAt: number;
      updatedAt: number;
    };
    let chat: LooseChat | null = null;
    if (existing) {
      try {
        const parsed = JSON.parse(existing.payload) as Partial<LooseChat>;
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.messages)) {
          chat = {
            id: conversationId,
            title: asStr(parsed.title) || existing.title,
            modelId: asStr(parsed.modelId) || input.modelId,
            agentId: typeof parsed.agentId === "string" && parsed.agentId ? parsed.agentId : undefined,
            automationId,
            githubRepo:
              typeof parsed.githubRepo === "string" && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(parsed.githubRepo)
                ? parsed.githubRepo
                : undefined,
            messages: parsed.messages,
            createdAt: asNum(parsed.createdAt, existing.updated_at),
            updatedAt: now,
          };
        }
      } catch {
        chat = null; // corrupted payload — rebuild the thread fresh
      }
    }
    if (!chat) {
      // New thread — respect the per-owner cap the same way pushes do.
      if (!existing) {
        const count = (
          this.ctx.storage.sql
            .exec<{ n: number }>("SELECT COUNT(*) AS n FROM chats WHERE owner_email = ?", owner)
            .toArray()[0] ?? { n: 0 }
        ).n;
        if (count >= MAX_CHATS_PER_OWNER) {
          console.error("automation append: chat cap reached");
          return;
        }
      }
      chat = {
        id: conversationId,
        title: capStr(input.name || "Automation", TITLE_LIMIT),
        modelId: input.modelId,
        agentId: input.agentId || undefined,
        automationId,
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
    }

    const startedAt = input.startedAt;
    chat.messages.push(
      { id: crypto.randomUUID(), role: "user", content: userText, createdAt: startedAt },
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: assistantText,
        createdAt: now,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        execution: input.execution,
        ...(sources.length > 0 ? { sources } : {}),
      },
    );
    // Automation threads grow forever — keep them bounded and under the
    // payload cap by dropping the oldest runs first.
    while (chat.messages.length > 120) {
      chat.messages.shift();
    }
    let payload = JSON.stringify(chat);
    while (payload.length > CHAT_PAYLOAD_LIMIT && chat.messages.length > 2) {
      chat.messages.splice(0, 2);
      payload = JSON.stringify(chat);
    }
    if (payload.length > CHAT_PAYLOAD_LIMIT) {
      console.error("automation append: payload too large");
      return;
    }

    const updatedAt = Math.max(now, (existing?.updated_at ?? 0) + 1);
    chat.updatedAt = updatedAt;
    payload = JSON.stringify(chat);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO chats (owner_email, id, title, payload, updated_at) VALUES (?, ?, ?, ?, ?)",
      owner,
      conversationId,
      chat.title,
      payload,
      updatedAt,
    );
    // A fresh run resurrects a deleted thread — same rule as a newer edit.
    this.ctx.storage.sql.exec(
      "DELETE FROM tombstones WHERE owner_email = ? AND id = ?",
      owner,
      conversationId,
    );
    console.log("automation run appended:", automationId, "→", conversationId);
  }

  private async handleSync(request: Request, email: string): Promise<Response> {
    let body: { have?: unknown; push?: unknown; delete?: unknown; profile?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }

    // Dead runs finalize as honest "interrupted" chats BEFORE sync computes,
    // and threads with a live run are locked against stale overwrites.
    this.runs.sweepStale(email);
    const lockedIds = this.runs.lockedConversationIds(email);

    const now = Date.now();
    const clampTime = (value: number): number =>
      Math.min(Math.max(0, Math.floor(value)), now + FUTURE_SLACK_MS);

    const have: HaveEntry[] = (Array.isArray(body.have) ? body.have : [])
      .filter(
        (item): item is HaveEntry =>
          Boolean(item) &&
          isValidId((item as HaveEntry).id) &&
          typeof (item as HaveEntry).updatedAt === "number",
      )
      .slice(0, HAVE_LIMIT)
      .map((item) => ({ id: item.id, updatedAt: clampTime(item.updatedAt) }));

    const pushes: PushEntry[] = (Array.isArray(body.push) ? body.push : [])
      .filter(
        (item): item is PushEntry =>
          Boolean(item) &&
          isValidId((item as PushEntry).id) &&
          typeof (item as PushEntry).updatedAt === "number" &&
          typeof (item as PushEntry).payload === "string",
      )
      .slice(0, PUSH_LIMIT);

    const deletes: DeleteEntry[] = (Array.isArray(body.delete) ? body.delete : [])
      .filter(
        (item): item is DeleteEntry =>
          Boolean(item) &&
          isValidId((item as DeleteEntry).id) &&
          typeof (item as DeleteEntry).deletedAt === "number",
      )
      .slice(0, DELETE_LIMIT)
      .map((item) => ({ id: item.id, deletedAt: clampTime(item.deletedAt) }));

    // Opportunistic tombstone GC — cheap, keeps the table bounded.
    this.ctx.storage.sql.exec("DELETE FROM tombstones WHERE deleted_at < ?", now - TOMBSTONE_TTL_MS);

    // 1. Deletions first: a delete loses only to a strictly newer edit.
    const deletedNow = new Set<string>();
    const deleteAck: string[] = [];
    const locked: string[] = [];
    for (const item of deletes) {
      if (lockedIds.has(item.id)) {
        locked.push(item.id);
        continue; // the active run owns its seed; retry this tombstone later
      }
      const chat = this.ctx.storage.sql
        .exec<{ updated_at: number }>(
          "SELECT updated_at FROM chats WHERE owner_email = ? AND id = ?",
          email,
          item.id,
        )
        .toArray()[0];
      if (chat && chat.updated_at > item.deletedAt) {
        deleteAck.push(item.id); // consciously overruled by a newer edit
        continue;
      }
      this.ctx.storage.sql.exec("DELETE FROM chats WHERE owner_email = ? AND id = ?", email, item.id);
      const existing = this.ctx.storage.sql
        .exec<{ deleted_at: number }>(
          "SELECT deleted_at FROM tombstones WHERE owner_email = ? AND id = ?",
          email,
          item.id,
        )
        .toArray()[0];
      const deletedAt = Math.max(existing?.deleted_at ?? 0, item.deletedAt);
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO tombstones (owner_email, id, deleted_at) VALUES (?, ?, ?)",
        email,
        item.id,
        deletedAt,
      );
      deletedNow.add(item.id);
      deleteAck.push(item.id);
    }

    // 2. Pushes: upsert only when strictly newer than what's stored.
    const appliedPush = new Set<string>();
    const skipped: string[] = [];
    let ownerCount = (
      this.ctx.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM chats WHERE owner_email = ?", email)
        .toArray()[0] ?? { n: 0 }
    ).n;
    for (const item of pushes) {
      if (lockedIds.has(item.id)) {
        // A live run owns this thread — the client re-offers after it settles.
        locked.push(item.id);
        continue;
      }
      if (item.payload.length > CHAT_PAYLOAD_LIMIT) {
        skipped.push(item.id);
        continue;
      }
      const updatedAt = clampTime(item.updatedAt);
      const tomb = this.ctx.storage.sql
        .exec<{ deleted_at: number }>(
          "SELECT deleted_at FROM tombstones WHERE owner_email = ? AND id = ?",
          email,
          item.id,
        )
        .toArray()[0];
      if (tomb && tomb.deleted_at >= updatedAt) {
        skipped.push(item.id); // Deleted elsewhere later — the tombstone answer removes it locally.
        continue;
      }
      const existing = this.ctx.storage.sql
        .exec<{ updated_at: number }>(
          "SELECT updated_at FROM chats WHERE owner_email = ? AND id = ?",
          email,
          item.id,
        )
        .toArray()[0];
      if (existing && existing.updated_at >= updatedAt) {
        appliedPush.add(item.id); // Server already has this or newer — treat as applied.
        continue;
      }
      if (!existing && ownerCount >= MAX_CHATS_PER_OWNER) {
        skipped.push(item.id);
        continue;
      }
      const title =
        (typeof item.title === "string" ? item.title.replace(/\s+/g, " ").trim().slice(0, TITLE_LIMIT) : "") ||
        "Chat";
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO chats (owner_email, id, title, payload, updated_at) VALUES (?, ?, ?, ?, ?)",
        email,
        item.id,
        title,
        item.payload,
        updatedAt,
      );
      if (!existing) {
        ownerCount += 1;
      }
      if (tomb) {
        this.ctx.storage.sql.exec("DELETE FROM tombstones WHERE owner_email = ? AND id = ?", email, item.id);
      }
      appliedPush.add(item.id);
    }

    // 2b. Profile (settings + agents + automations + MCP + hub): one blob,
    // whole-blob LWW. `payload` present = the client offers its copy;
    // absent = just a clock check. The server answers with its copy when
    // newer, an ack when the client's copy landed (or was already there),
    // or `profileWant` when the client claims newer but sent no payload.
    let profileOut: { updatedAt: number; payload: string } | undefined;
    let profileWant: boolean | undefined;
    let profileAck: number | undefined;
    let profileSkipped: boolean | undefined;
    let profileSeen: string | null = null;
    if (body.profile && typeof body.profile === "object") {
      const raw = body.profile as { updatedAt?: unknown; payload?: unknown };
      const clientAt = typeof raw.updatedAt === "number" ? clampTime(raw.updatedAt) : 0;
      const offeredPayload = typeof raw.payload === "string" ? raw.payload : null;
      const payload = offeredPayload === null ? null : await this.prepareProfilePayload(email, offeredPayload);
      let row = this.ctx.storage.sql
        .exec<{ payload: string; updated_at: number }>(
          "SELECT payload, updated_at FROM profiles WHERE owner_email = ?",
          email,
        )
        .toArray()[0];
      if (row) {
        const safeStored = await this.prepareProfilePayload(email, row.payload);
        if (safeStored === null) {
          // Never return an unparsable historical blob: keep it quarantined
          // until a valid newer client profile replaces it.
          row = undefined;
          profileSkipped = true;
        } else if (safeStored !== row.payload) {
          this.ctx.storage.sql.exec(
            "UPDATE profiles SET payload = ? WHERE owner_email = ? AND updated_at = ?",
            safeStored,
            email,
            row.updated_at,
          );
          row = { ...row, payload: safeStored };
        }
      }
      const serverAt = row?.updated_at ?? 0;
      if (offeredPayload !== null && payload === null) {
        profileSkipped = true;
        profileSeen = row?.payload ?? null;
      } else if (
        row &&
        (serverAt > clientAt || (serverAt === clientAt && payload !== null && row.payload !== payload))
      ) {
        // Equal clocks are ACK-safe only for byte-identical, redacted blobs.
        profileOut = { updatedAt: serverAt, payload: row.payload };
        profileSeen = row.payload;
      } else if (payload !== null) {
        if (payload.length > PROFILE_PAYLOAD_LIMIT) {
          profileSkipped = true;
        } else {
          if (!row || clientAt > serverAt) {
            this.ctx.storage.sql.exec(
              "INSERT OR REPLACE INTO profiles (owner_email, payload, updated_at) VALUES (?, ?, ?)",
              email,
              payload,
              clientAt,
            );
          }
          profileAck = clientAt;
          profileSeen = payload;
          if (payload !== offeredPayload) {
            profileOut = { updatedAt: clientAt, payload };
          }
        }
      } else if (clientAt > serverAt) {
        profileWant = true;
        profileSeen = row?.payload ?? null;
      } else {
        profileSeen = row?.payload ?? null;
      }
    }

    // 3. Answer from post-mutation state. OAuth grants are server-owned and
    // deliberately absent from this browser-facing sync payload.
    const haveMap = new Map<string, number>(have.map((item) => [item.id, item.updatedAt]));
    const metas = this.ctx.storage.sql
      .exec<ChatMetaRow>(
        "SELECT id, updated_at FROM chats WHERE owner_email = ? ORDER BY updated_at DESC",
        email,
      )
      .toArray();
    const serverMap = new Map<string, number>(metas.map((row) => [row.id, row.updated_at]));

    // pull: server-newer (or server-only) chats, newest first, size-capped.
    const pull: Array<{ id: string; title: string; updatedAt: number; payload: string }> = [];
    let pullBytes = 0;
    let more = false;
    for (const meta of metas) {
      if (lockedIds.has(meta.id)) {
        continue; // never pull a thread mid-run — the run stream owns it
      }
      const clientAt = haveMap.get(meta.id);
      if (clientAt !== undefined && clientAt >= meta.updated_at) {
        continue;
      }
      if (appliedPush.has(meta.id)) {
        continue;
      }
      if (pull.length >= PULL_MAX_CHATS || pullBytes >= PULL_BYTE_BUDGET) {
        more = true;
        break;
      }
      const row = this.ctx.storage.sql
        .exec<ChatRow>(
          "SELECT id, title, updated_at, payload FROM chats WHERE owner_email = ? AND id = ?",
          email,
          meta.id,
        )
        .toArray()[0];
      if (!row) {
        continue;
      }
      pull.push({ id: row.id, title: row.title, updatedAt: row.updated_at, payload: row.payload });
      pullBytes += row.payload.length;
    }

    // Tombstones the client must apply, and chats the server wants pushed.
    const tombRows = this.ctx.storage.sql
      .exec<TombstoneRow>("SELECT id, deleted_at FROM tombstones WHERE owner_email = ?", email)
      .toArray();
    const tombMap = new Map<string, number>(tombRows.map((row) => [row.id, row.deleted_at]));

    const tombstones: Array<{ id: string; deletedAt: number }> = [];
    const want: string[] = [];
    for (const item of have) {
      if (appliedPush.has(item.id) || deletedNow.has(item.id) || lockedIds.has(item.id)) {
        continue;
      }
      const tombAt = tombMap.get(item.id);
      if (tombAt !== undefined && tombAt >= item.updatedAt) {
        if (tombstones.length < TOMBSTONES_LIMIT) {
          tombstones.push({ id: item.id, deletedAt: tombAt });
        }
        continue;
      }
      const serverAt = serverMap.get(item.id);
      if ((serverAt === undefined || item.updatedAt > serverAt) && want.length < WANT_LIMIT) {
        want.push(item.id);
      }
    }

    // Keep the schedule index fresh: any sync that carried profile state
    // reports the next due instant to the relay (header → global index).
    const responseHeaders: Record<string, string> = {};
    if (profileSeen !== null) {
      responseHeaders[NEXT_DUE_HEADER] = String(await this.nextDueForOwner(email, profileSeen));
      responseHeaders[HOOKS_HEADER] = this.hooksIndexValue(profileSeen);
    }

    return json(
      {
        pull,
        want,
        tombstones,
        skipped,
        locked,
        deleteAck,
        more,
        profile: profileOut,
        profileWant,
        profileAck,
        profileSkipped,
      },
      200,
      responseHeaders,
    );
  }
}
