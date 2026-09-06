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
import { appendMcpJournal, mcpJournalRow, type McpJournalRow } from "./mcp-journal";
import { accountMcpPolicy } from "./mcp-policy";
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
import {
  handleMcpAuthLease,
  handleMcpCheck,
  handleMcpInventory,
  handleMcpOAuthStart,
  handleMcpPromptGet,
  handleMcpResolve,
  handleMcpCatalogWrite,
  handleMcpResourceRead,
  type McpRouteContext,
} from "./mcp-routes";
import {
  handleBrowserOAuthRefresh,
  handleGitHubDeviceStart,
  handleGitHubDeviceStatus,
  handleOAuthCallback,
  handleOAuthClear,
  handleOAuthComplete,
  handleOAuthRotations,
  handleOAuthStatus,
  handleOAuthStore,
  type McpOAuthRouteContext,
  type OAuthPendingRow,
} from "./mcp-oauth-routes";
import {
  hasMcpServerSecret,
  markOAuthRefreshStarted,
  mcpConfigsWithSecrets,
  oauthGrantState,
  parseServerSecretRow,
  persistCanonicalOAuthGrant,
  profileOAuthTokens,
  readRotation,
  recordOAuthFailure,
  resolveOwnerMcpServers,
  type OAuthStoreContext,
} from "./mcp-oauth-store";
import { ensureOAuthScopeTable } from "./mcp-oauth-scopes";
import { createSqlMcpCatalogStore, normalizeMcpToolLoading } from "./mcp-toolset";
import {
  chainRotationBases,
  cloudMcpServersForAutomation,
  cloudOAuthToken,
  intersectMcpAllowIds,
  overlayOAuthRotations,
  type CloudOAuthToken,
  type OAuthRotation,
  type RefreshedOAuth,
} from "./mcp-cloud";
import { RunManager } from "./run-manager";
import {
  deviceCodeScope,
  GRANT_SECRET_FIELDS,
  OAUTH_PENDING_SECRET_FIELDS,
  oauthPendingScope,
  sealGrantPayload,
  sealRotationValue,
  sealServerSecret,
  SERVER_SECRET_FIELDS,
} from "./secret-rows";
import {
  describeSecretVaultError,
  fieldsNeedReseal,
  isSealedEnvelope,
  sealFields,
  SecretVault,
  SecretVaultError,
  tallySealed,
  type SealedTally,
} from "./secret-vault";
import { CredentialScope, ensureVaultScope } from "./vault-scope";

/** Worker env as visible inside this Durable Object (same bindings). */
type ChatStoreEnv = {
  EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY?: string;
  RORK_TOOLKIT_SECRET_KEY?: string;
  EXPO_PUBLIC_GITHUB_OAUTH_CLIENT_ID?: string;
  STAGING_VERSION?: string;
  /** Durable Object namespace binding — the shard asks the AccessRegistry for its account id through it. */
  DO?: { fetch(request: Request): Promise<Response> };
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

/** KV key remembering which vault key the last sweep sealed this shard under. */
const VAULT_SWEEP_KEY = "secretVaultKid";

/** The listed string fields of a JSON payload, as stored — for tallying, never opened. */
function credentialStrings(payload: string, fields: readonly string[]): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) {
    return [];
  }
  return fields.map((field) => (typeof parsed[field] === "string" ? (parsed[field] as string) : ""));
}

export class ChatStore extends DurableObject {
  private readonly workerEnv: ChatStoreEnv;
  /** Encrypts every credential row in this shard; keyed by the Worker secret. */
  private readonly vault: SecretVault;
  /** Which subject (storage owner → Rork Auth account) the vault scopes are bound to. */
  private readonly scope = new CredentialScope();
  /** Interactive server-side agent runs (chat / research / Julius). */
  private readonly runs: RunManager;
  /** Credential store seam (mcp-oauth-store.ts): grants, keys, state markers, rotation escrow. */
  private readonly oauthStore: OAuthStoreContext;
  /** Automation occurrences executing in this isolate; absent after a deploy. */
  private readonly liveAutomationRuns = new Set<string>();
  private readonly instanceId = crypto.randomUUID();

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.workerEnv = (env ?? {}) as ChatStoreEnv;
    this.vault = SecretVault.fromEnv(env);
    this.runs = new RunManager(ctx, env, this.scope);
    this.oauthStore = {
      sql: this.ctx.storage.sql,
      storage: this.ctx.storage,
      vault: this.vault,
      subject: (owner) => this.scope.subject(owner),
    };
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
    ensureOAuthScopeTable(this.ctx.storage.sql);
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
        await this.scope.load(this.ctx.storage);
        await this.sealLegacySecrets();
      } catch (error) {
        console.error("account secret sweep failed", error instanceof SecretVaultError ? error.code : "error");
      }
    });
  }

  /**
   * One-time (per vault key) pass over every credential row in this shard:
   * OAuth grants, pasted keys/headers, the pending-flow proofs (PKCE
   * verifier, authorization code, browser nonce, callback challenge), GitHub
   * device codes, and the legacy rotation escrow in KV. Plaintext rows from
   * before the vault and rows sealed under a previous key are re-sealed;
   * poisoned legacy placeholder rows are dropped. Runs under
   * blockConcurrencyWhile, so no request ever observes a plaintext row —
   * which is what lets `open` refuse plaintext outright. A row this key set
   * cannot re-seal is skipped (logged coarse) and stays unreadable rather
   * than aborting the sweep for its neighbours.
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
    let skipped = 0;
    const attempt = async (work: () => Promise<boolean>): Promise<void> => {
      try {
        if (await work()) {
          sealed += 1;
        }
      } catch (error) {
        skipped += 1;
        console.error("account secret row skipped", error instanceof SecretVaultError ? error.code : "error");
      }
    };
    for (const row of sql
      .exec<{ owner_email: string; server_id: string; payload: string }>(
        "SELECT owner_email, server_id, payload FROM mcp_oauth_grants",
      )
      .toArray()) {
      await attempt(async () => {
        const parsed = JSON.parse(row.payload) as unknown;
        const stored = cloudOAuthToken(parsed);
        if (!stored || !(await fieldsNeedReseal(this.vault, stored, GRANT_SECRET_FIELDS))) {
          return false;
        }
        sql.exec(
          "UPDATE mcp_oauth_grants SET payload = ? WHERE owner_email = ? AND server_id = ?",
          await sealGrantPayload(
            this.vault,
            this.scope.subject(row.owner_email),
            row.server_id,
            parsed as CloudOAuthToken & Record<string, unknown>,
          ),
          row.owner_email,
          row.server_id,
        );
        return true;
      });
    }
    for (const row of sql
      .exec<{ owner_email: string; server_id: string; payload: string }>(
        "SELECT owner_email, server_id, payload FROM mcp_server_secrets",
      )
      .toArray()) {
      await attempt(async () => {
        const stored = parseServerSecretRow(this.oauthStore, row.owner_email, row.server_id, row.payload);
        if (!stored || !(await fieldsNeedReseal(this.vault, stored, SERVER_SECRET_FIELDS))) {
          return false; // absent, or a poisoned placeholder row already deleted by the parser
        }
        sql.exec(
          "UPDATE mcp_server_secrets SET payload = ? WHERE owner_email = ? AND server_id = ?",
          await sealServerSecret(this.vault, this.scope.subject(row.owner_email), row.server_id, stored),
          row.owner_email,
          row.server_id,
        );
        return true;
      });
    }
    for (const row of sql
      .exec<Pick<OAuthPendingRow, "owner_email" | "state" | "verifier" | "authorization_code" | "browser_nonce" | "callback_challenge">>(
        `SELECT owner_email, state, verifier, authorization_code, browser_nonce, callback_challenge
         FROM mcp_oauth_pending
         WHERE verifier != '' OR authorization_code != '' OR browser_nonce != '' OR callback_challenge != ''`,
      )
      .toArray()) {
      await attempt(async () => {
        if (!(await fieldsNeedReseal(this.vault, row, OAUTH_PENDING_SECRET_FIELDS))) {
          return false;
        }
        const next = await sealFields(this.vault, row, OAUTH_PENDING_SECRET_FIELDS, oauthPendingScope(this.scope.subject(row.owner_email), row.state));
        sql.exec(
          `UPDATE mcp_oauth_pending
           SET verifier = ?, authorization_code = ?, browser_nonce = ?, callback_challenge = ?
           WHERE owner_email = ? AND state = ?`,
          next.verifier,
          next.authorization_code,
          next.browser_nonce,
          next.callback_challenge,
          row.owner_email,
          row.state,
        );
        return true;
      });
    }
    for (const row of sql
      .exec<{ owner_email: string; flow_id: string; device_code: string }>(
        "SELECT owner_email, flow_id, device_code FROM mcp_github_device_pending WHERE device_code != ''",
      )
      .toArray()) {
      await attempt(async () => {
        if (await this.vault.isCurrent(row.device_code)) {
          return false;
        }
        sql.exec(
          "UPDATE mcp_github_device_pending SET device_code = ? WHERE owner_email = ? AND flow_id = ?",
          await this.vault.reseal(row.device_code, deviceCodeScope(this.scope.subject(row.owner_email), row.flow_id)),
          row.owner_email,
          row.flow_id,
        );
        return true;
      });
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
      await attempt(async () => {
        if (isSealedEnvelope(value) && (await this.vault.isCurrent(value.sealed))) {
          return false;
        }
        await this.ctx.storage.put(key, await sealRotationValue(this.vault, this.scope.subject(owner), serverId, value));
        return true;
      });
    }
    await this.ctx.storage.put(VAULT_SWEEP_KEY, kid);
    if (sealed > 0 || skipped > 0) {
      console.log("account secrets sealed", sealed, "skipped", skipped);
    }
  }

  /**
   * Counts only — the account's own view of its vault: is the key active,
   * has this shard been swept under it, and how many stored credential values
   * are sealed / under the current key / still plaintext. No value is opened
   * and nothing about the key beyond its enabled state leaves the shard.
   */
  private async handleDiagVault(email: string): Promise<Response> {
    const sql = this.ctx.storage.sql;
    const grants: string[] = [];
    for (const row of sql
      .exec<{ payload: string }>("SELECT payload FROM mcp_oauth_grants WHERE owner_email = ?", email)
      .toArray()) {
      grants.push(...credentialStrings(row.payload, GRANT_SECRET_FIELDS));
    }
    const serverSecrets: string[] = [];
    for (const row of sql
      .exec<{ payload: string }>("SELECT payload FROM mcp_server_secrets WHERE owner_email = ?", email)
      .toArray()) {
      serverSecrets.push(...credentialStrings(row.payload, SERVER_SECRET_FIELDS));
    }
    const pending: string[] = [];
    for (const row of sql
      .exec<Pick<OAuthPendingRow, "verifier" | "authorization_code" | "browser_nonce" | "callback_challenge">>(
        "SELECT verifier, authorization_code, browser_nonce, callback_challenge FROM mcp_oauth_pending WHERE owner_email = ?",
        email,
      )
      .toArray()) {
      pending.push(row.verifier, row.authorization_code, row.browser_nonce, row.callback_challenge);
    }
    const deviceCodes = sql
      .exec<{ device_code: string }>("SELECT device_code FROM mcp_github_device_pending WHERE owner_email = ?", email)
      .toArray()
      .map((row) => row.device_code);
    const escrow: string[] = [];
    for (const value of (await this.ctx.storage.list<unknown>({ prefix: `${OAUTH_REF_PREFIX}${email}:` })).values()) {
      escrow.push(isSealedEnvelope(value) ? value.sealed : "plaintext");
    }
    const swept =
      this.vault.enabled && (await this.ctx.storage.get<string>(VAULT_SWEEP_KEY)) === (await this.vault.currentKid());
    const rows: Record<string, SealedTally> = {
      grants: await tallySealed(this.vault, grants),
      serverSecrets: await tallySealed(this.vault, serverSecrets),
      pending: await tallySealed(this.vault, pending),
      deviceCodes: await tallySealed(this.vault, deviceCodes),
      escrow: await tallySealed(this.vault, escrow),
    };
    return json({ vault: this.vault.enabled ? "enabled" : this.vault.disabledReason, swept, rows, ...this.scope.describe() });
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
    // Bind the credential vault to the Rork Auth account on first sight (one-time sweep).
    const scopeGate = await ensureVaultScope(
      {
        sql: this.ctx.storage.sql,
        storage: this.ctx.storage,
        vault: this.vault,
        scope: this.scope,
        blockConcurrencyWhile: (work) => this.ctx.blockConcurrencyWhile(work),
        registry: this.workerEnv.DO,
      },
      request,
      email,
    );
    if (scopeGate) {
      return scopeGate;
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
    // MCP connection, credential and sign-in routes (mcp-routes.ts /
    // mcp-oauth-routes.ts); the state and grant store is mcp-oauth-store.ts.
    if (url.pathname.startsWith("/mcp/")) {
      const mcpResponse = await this.routeMcp(request, url.pathname, email);
      if (mcpResponse) {
        return mcpResponse;
      }
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
    if (request.method === "GET" && url.pathname === "/diag/vault") {
      return this.handleDiagVault(email);
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
    const oauthTokens = await profileOAuthTokens(this.oauthStore, owner);
    const oauthRefPrefix = `${OAUTH_REF_PREFIX}${owner}:`;
    const overrideRows = await this.ctx.storage.list<unknown>({ prefix: oauthRefPrefix });
    const rotations: OAuthRotation[] = [];
    for (const [key, value] of overrideRows) {
      const rotation = await readRotation(this.oauthStore, owner, key.slice(oauthRefPrefix.length), value);
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
      await persistCanonicalOAuthGrant(this.oauthStore, owner, rotated);
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
          (id, outcome) => recordOAuthFailure(this.oauthStore, owner, id, outcome),
          (id) => markOAuthRefreshStarted(this.oauthStore, owner, id),
          createSqlMcpCatalogStore(this.ctx.storage.sql, owner),
          // Per-request credential lease: the grant/key row is opened for each MCP request.
          async (id, { force }) =>
            (await resolveOwnerMcpServers(this.oauthStore, owner, [id], force ? new Set([id]) : new Set()))?.servers.find(
              (server) => server.id === id,
            ) ?? null,
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
      // Policy decisions and declined elicitations of this unattended run go
      // to the account's diagnostics journal (never argument values).
      const journalRows: McpJournalRow[] = (result.journal ?? []).flatMap((entry) => {
        const row = mcpJournalRow(entry, { surface: "automation", label: item.auto.name });
        return row ? [row] : [];
      });
      appendMcpJournal(this.ctx.storage.sql, owner, journalRows);
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
   * Returns a profile payload that is safe to synchronize to browsers. A
   * legacy `mcpOAuth` half (grants older bundles mirrored into the profile) is
   * dropped without being imported: sign-ins are minted only by the
   * server-side flows, and a browser-held token never becomes a vault row.
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
    if ("mcpOAuth" in profile) {
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
              await sealServerSecret(this.vault, this.scope.subject(owner), serverId, {
                ...(token ? { token } : {}),
                ...(headersJson ? { headersJson } : {}),
              }),
              Date.now(),
            );
          }
        }
        const ids = [...new Set([serverId, ...(catalogId && catalogId !== serverId ? [catalogId] : [])])]
          .filter(Boolean);
        const hasSecret = ids.some((id) => hasMcpServerSecret(this.oauthStore, owner, id));
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
          const state = oauthGrantState(this.oauthStore, owner, id);
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
  /**
   * `/mcp/*` dispatch: connection check, worker-internal credential routes,
   * composer menus, the browser sign-in state machine and the GitHub device
   * flow. Null for paths this family does not own.
   */
  private routeMcp(request: Request, pathname: string, email: string): Promise<Response> | Response | null {
    const method = request.method;
    switch (pathname) {
      case "/mcp/oauth-rotations":
        return method === "GET" ? handleOAuthRotations() : null;
      case "/mcp/oauth-start":
        return method === "POST" ? handleMcpOAuthStart(this.mcpRouteContext(), request, email) : null;
      case "/mcp/github-device-start":
        return method === "POST" ? handleGitHubDeviceStart(this.oauthRouteContext(), email) : null;
      case "/mcp/github-device-status":
        return method === "GET" ? handleGitHubDeviceStatus(this.oauthRouteContext(), request, email) : null;
      case "/mcp/oauth-status":
        return method === "GET" ? handleOAuthStatus(this.oauthRouteContext(), request, email) : null;
      case "/mcp/oauth-complete":
        return method === "POST" ? handleOAuthComplete(this.oauthRouteContext(), request, email) : null;
      case "/mcp/oauth-callback":
        return method === "POST" ? handleOAuthCallback(this.oauthRouteContext(), request, email) : null;
      case "/mcp/oauth-store":
        return method === "POST" ? handleOAuthStore() : null;
      case "/mcp/oauth-clear":
        return method === "POST" ? handleOAuthClear(this.oauthRouteContext(), request, email) : null;
      case "/mcp/oauth-refresh":
        return method === "POST" ? handleBrowserOAuthRefresh() : null;
      case "/mcp/check":
        return method === "POST" ? handleMcpCheck(this.oauthStore, request, email) : null;
      case "/mcp/inventory":
        return method === "POST" ? handleMcpInventory(this.mcpRouteContext(), request, email) : null;
      case "/mcp/prompt-get":
        return method === "POST" ? handleMcpPromptGet(this.mcpRouteContext(), request, email) : null;
      case "/mcp/resource-read":
        return method === "POST" ? handleMcpResourceRead(this.mcpRouteContext(), request, email) : null;
      // Internal (worker-only — no public relay forwards these paths): project
      // agents resolve their linked MCP servers through this account.
      case "/mcp/resolve":
        return method === "POST" ? handleMcpResolve(this.oauthStore, request, email) : null;
      case "/mcp/catalog-write":
        return method === "POST" ? handleMcpCatalogWrite(this.oauthStore, request, email) : null;
      case "/mcp/auth-lease":
        return method === "POST" ? handleMcpAuthLease(this.oauthStore, request, email) : null;
      default:
        return null;
    }
  }

  /** Seam for the menu / oauth-start routes (mcp-routes.ts): storage plus server resolution. */
  private mcpRouteContext(): McpRouteContext {
    return {
      sql: this.ctx.storage.sql,
      resolveServers: async (owner, ids) => (await resolveOwnerMcpServers(this.oauthStore, owner, ids, new Set()))?.servers ?? [],
      seal: (plain, scope) => this.vault.seal(plain, scope),
      subject: (owner) => this.scope.subject(owner),
    };
  }

  /** Seam for the sign-in state machine and device flow (mcp-oauth-routes.ts). */
  private oauthRouteContext(): McpOAuthRouteContext {
    return {
      ...this.oauthStore,
      transactionSync: (closure) => this.ctx.storage.transactionSync(closure),
      githubClientId: this.workerEnv.EXPO_PUBLIC_GITHUB_OAUTH_CLIENT_ID ?? "",
    };
  }

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
              ? await sealRotationValue(this.vault, this.scope.subject(owner), row.serverId, row.value)
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
        await mcpConfigsWithSecrets(this.oauthStore, owner, settings.mcpServers),
        intersectMcpAllowIds(settings.mcpServers, agent?.mcpServerIds, auto.mcpServerIds),
        oauthTokens,
      ),
      mcpToolLoading: normalizeMcpToolLoading(settings.mcpToolLoading),
      // "Confirm write tools by default": unattended runs decline write tools honestly.
      mcpPolicy: accountMcpPolicy(settings.confirmWriteTools),
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
