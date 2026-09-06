// ProjectStore — Durable Object behind /projects/*. Two roles, one class:
//
// 1. The singleton "registry" instance maps member email → project ids, so
//    GET /projects answers without touching every shard.
// 2. Every project lives in its OWN shard (id "proj:<projectId>") holding
//    members (owner / admin / member), scoped agents, Slack-style channels
//    with threads, per-member read marks, and the agent job queue.
//
// Scoped agents are the point: an admin stores project credentials (GitHub
// PAT, Intercom / Slack tokens) server-side and picks an access level — e.g.
// GitHub READ-ONLY gives colleagues a repo reference desk that can inspect
// code, PRs and CI but can never commit or open PRs. Members summon an agent
// by mentioning @handle in a channel; the reply lands in the thread.
//
// Agent runs execute INSIDE this object (same pattern as ChatStore cloud
// automations): the Worker relay fires POST /agent-run via ctx.waitUntil
// right after the triggering message, so the DO does the LLM loop with the
// engine + native connector tools and fills the placeholder row when done.
// Secrets never leave the shard — the client only ever sees set/unset flags.

import { DurableObject } from "cloudflare:workers";

import { capText, DEFAULT_CHAT_MODEL, type EngineMessage, runEngineTurn } from "./agent-engine";
import {
  type AgentToolsetContext,
  type AgentToolsetResult,
  buildAgentToolset,
} from "./agent-toolset";
import { asNum, asStr, isRecord, json, readEmail } from "./chat-shared";
import { handleProjectGitHubValidate, validateProjectGitHubToken } from "./project-github-credentials";
import {
  type DeskContext,
  handleAskGera,
  handleAskStatus,
  handleDeskLink,
  handleDeskSlackRelated,
  handleDeskStats,
  handleDeskStatsClear,
  handleDeskStatsRefresh,
  handleIntercomAction,
  handleIntercomDetails,
  handleIntercomInbox,
  handleIntercomMentionAdmins,
  handleIntercomReply,
  handleIntercomSuggest,
  handleIntercomThread,
  handlePageViewIngest,
  handleScreenChatGet,
  handleScreenChatSend,
  handleScreenDelete,
  handleScreenUpsert,
  handleSuggestRate,
  handleTrackingSetup,
} from "./desk-routes";
import { normalizeMcpWritePolicy } from "./mcp-policy";
import { callIntercomNativeTool } from "./native-intercom";
import {
  buildSlackAppManifest,
  buildSlackInstallState,
  classifySlackConfigToken,
  classifySlackEvent,
  createSlackAppFromManifest,
  exchangeSlackOAuthCode,
  fetchSlackBotIdentity,
  fetchSlackThreadTranscript,
  isSlackConfigAccessFresh,
  isSlackConfigAuthError,
  postSlackThreadReply,
  rotateSlackConfigToken,
  SLACK_INSTALL_STATE_TTL_MS,
  type SlackAppCredentials,
  slackAuthorizeUrl,
  type SlackConfigRotation,
  type SlackInstallResult,
  stripSlackMention,
  updateSlackAppManifest,
  verifySlackInstallState,
  verifySlackSignature,
} from "./native-slack";
import {
  type AgentRow,
  type MemberRow,
  newId,
  parseWidgets,
  type ScreenChatRow,
  type ScreenJobRow,
  type ScreenRow,
  screenWire,
  storedExecutionOutcome,
} from "./project-rows";
import {
  AGENT_HANDLE_LIMIT,
  AGENT_INSTRUCTIONS_LIMIT,
  AGENT_NAME_LIMIT,
  AGENT_RUN_BUDGET_MS,
  type AgentAccess,
  type AgentSecretFlags,
  type AgentSecrets,
  canManageProject,
  CHANNEL_KEEP_MESSAGES,
  CHANNEL_NAME_LIMIT,
  CHANNEL_TOPIC_LIMIT,
  describeAgentAccess,
  ensureUniqueHandle,
  isProjectRole,
  MAX_AGENT_JOBS_PER_MESSAGE,
  MAX_AGENTS,
  MAX_CHANNELS,
  MAX_MEMBERS,
  MEMBER_NAME_LIMIT,
  MESSAGE_BODY_LIMIT,
  MESSAGE_PAGE,
  normalizeHandle,
  normalizeStoredMcpSelection,
  parseMcpSelectionPatch,
  parseMcpWritesPatch,
  parseMentions,
  PROJECT_NAME_LIMIT,
  type ProjectAgentWire,
  type ProjectChannelWire,
  type ProjectMemberWire,
  type ProjectMessageWire,
  type ProjectRole,
  SCREEN_CHAT_CONTEXT_MESSAGES,
  type SlackConfigWire,
  THREAD_CONTEXT_MESSAGES,
  type ThreadStatWire,
} from "./project-shared";
import {
  buildExecutionOutcome,
  EXECUTION_OUTCOME_TOOL_NAME,
  type ExecutionOutcome,
  type ExecutionOutcomeClaim,
  executionOutcomeSlackFooter,
  executionOutcomeSystemPrompt,
  executionOutcomeToolDefinition,
  parseExecutionOutcomeClaim,
  visibleExecutionToolCalls,
} from "./run-protocol";
import {
  createServerSurfSession,
  createSourceLedger,
  executeServerTool,
  type ServerToolContext,
} from "./run-tools";
import {
  describeSecretVaultError,
  fieldsNeedReseal,
  openFields,
  sealFields,
  SecretVault,
  SecretVaultError,
} from "./secret-vault";

type ProjectStoreEnv = {
  EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY?: string;
  RORK_TOOLKIT_SECRET_KEY?: string;
  /** Rork DO router — lets this shard reach account shards (agent MCP resolve). */
  DO?: { fetch(request: Request): Promise<Response> };
};

/** Agent replies may exceed the human message cap, but stay bounded. */
const AGENT_REPLY_LIMIT = 24_000;
const SECRET_VALUE_LIMIT = 400;

/**
 * The credential fields of `agents.secrets` — sealed at rest by the vault.
 * Everything else in the blob (ids, team names, MCP selection) is metadata
 * the agent list needs synchronously and stays readable.
 */
export const AGENT_SECRET_FIELDS = [
  "githubToken",
  "intercomToken",
  "slackToken",
  "slackSigningSecret",
  "slackClientSecret",
] as const;

/** Vault scope binding an agent's sealed fields to that agent row. */
export function agentSecretScope(agentId: string): string {
  return `project-agent:${agentId}`;
}

/** Slack app-manager token pair — both halves sealed at rest. */
const SLACK_CONFIG_SECRET_FIELDS = ["access", "refresh"] as const;

function slackConfigScope(projectId: string): string {
  return `project-slack-config:${projectId}`;
}

/** `meta` key remembering which vault key the last sweep sealed rows under. */
const VAULT_SWEEP_META_KEY = "secret_vault_kid";
const MODEL_ID_LIMIT = 120;
const THREAD_FETCH_LIMIT = 500;
const SOURCES_APPENDIX_CAP = 12;
// Inbound Slack bot: Events API retry dedup horizon + job retention.
const SLACK_EVENT_TTL_MS = 2 * 60 * 60 * 1000;
const SLACK_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const SLACK_THREAD_CONTEXT = 25;
/** Slack chat.postMessage truncates around 40k chars — stay well under. */
const SLACK_REPLY_LIMIT = 11_500;

type ChannelRow = { id: string; name: string; topic: string; created_at: number };
type MessageRow = {
  id: string;
  channel_id: string;
  root_id: string | null;
  author_kind: string;
  author: string;
  author_name: string;
  body: string;
  pending: number;
  outcome: string;
  created_at: number;
  updated_at: number;
};
type JobRow = {
  id: string;
  agent_id: string;
  channel_id: string;
  root_id: string;
  placeholder_id: string;
  prompt_id: string;
  requested_by: string;
  status: string;
};
/**
 * Project-level Slack app-manager connection (the tooling token pair).
 * `refresh` "" means a one-off access token was pasted — it works until it
 * expires but cannot renew. Tokens never leave the shard.
 */
type StoredSlackConfig = {
  access: string;
  refresh: string;
  teamId: string;
  userId: string;
  /** Epoch ms when `access` expires; 0 = unknown. */
  exp: number;
  connectedAt: number;
};

type SlackJobRow = {
  id: string;
  agent_id: string;
  channel: string;
  thread_ts: string;
  event_ts: string;
  user_id: string;
  text: string;
  status: string;
  outcome: string;
};

function normalizeAccess(raw: unknown): AgentAccess {
  const record = isRecord(raw) ? raw : {};
  const github = record.github === "read" || record.github === "write" ? record.github : "off";
  return {
    web: record.web !== false,
    github,
    intercom: record.intercom === true,
    slack: record.slack === true,
    mcp: record.mcp === true,
  };
}

function secretFlags(secrets: AgentSecrets): AgentSecretFlags {
  return {
    github:
      (typeof secrets.githubToken === "string" && secrets.githubToken.length > 0) ||
      Boolean(secrets.githubAccount),
    intercom: typeof secrets.intercomToken === "string" && secrets.intercomToken.length > 0,
    slack: typeof secrets.slackToken === "string" && secrets.slackToken.length > 0,
    slackSigning: typeof secrets.slackSigningSecret === "string" && secrets.slackSigningSecret.length > 0,
  };
}

function parseSecrets(raw: string): AgentSecrets {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    const out: AgentSecrets = {};
    if (typeof parsed.githubToken === "string" && parsed.githubToken.length > 0) {
      out.githubToken = parsed.githubToken;
    }
    if (
      isRecord(parsed.githubAccount) &&
      typeof parsed.githubAccount.owner === "string" &&
      typeof parsed.githubAccount.serverId === "string" &&
      parsed.githubAccount.owner.length > 0 &&
      parsed.githubAccount.serverId.length > 0
    ) {
      out.githubAccount = {
        owner: parsed.githubAccount.owner.trim().toLowerCase(),
        serverId: parsed.githubAccount.serverId.slice(0, 80),
      };
    }
    if (typeof parsed.intercomToken === "string" && parsed.intercomToken.length > 0) {
      out.intercomToken = parsed.intercomToken;
    }
    if (typeof parsed.slackToken === "string" && parsed.slackToken.length > 0) {
      out.slackToken = parsed.slackToken;
    }
    if (typeof parsed.slackSigningSecret === "string" && parsed.slackSigningSecret.length > 0) {
      out.slackSigningSecret = parsed.slackSigningSecret;
    }
    if (typeof parsed.slackAppId === "string" && parsed.slackAppId.length > 0) {
      out.slackAppId = parsed.slackAppId;
    }
    if (typeof parsed.slackClientId === "string" && parsed.slackClientId.length > 0) {
      out.slackClientId = parsed.slackClientId;
    }
    if (typeof parsed.slackClientSecret === "string" && parsed.slackClientSecret.length > 0) {
      out.slackClientSecret = parsed.slackClientSecret;
    }
    if (typeof parsed.slackTeam === "string" && parsed.slackTeam.length > 0) {
      out.slackTeam = parsed.slackTeam;
    }
    const mcpSelection = normalizeStoredMcpSelection(parsed.mcpSelection);
    if (mcpSelection) {
      out.mcpSelection = mcpSelection;
    }
    return out;
  } catch {
    return {};
  }
}

function agentWire(row: AgentRow): ProjectAgentWire {
  const secrets = parseSecrets(row.secrets);
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    emoji: row.emoji,
    instructions: row.instructions,
    model: row.model,
    access: normalizeAccess(JSON.parse(row.access || "{}") as unknown),
    secretsSet: secretFlags(secrets),
    mcpServers: secrets.mcpSelection?.servers ?? [],
    mcpOwner: secrets.mcpSelection?.owner ?? "",
    mcpWrites: normalizeMcpWritePolicy(secrets.mcpSelection?.writes),
    slackApp: secrets.slackAppId ? { appId: secrets.slackAppId, team: secrets.slackTeam ?? "" } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function messageWire(row: MessageRow): ProjectMessageWire {
  const execution = storedExecutionOutcome(row.outcome);
  return {
    id: row.id,
    channelId: row.channel_id,
    rootId: row.root_id,
    kind: row.author_kind === "agent" ? "agent" : "user",
    author: row.author,
    authorName: row.author_name,
    body: row.body,
    pending: row.pending === 1,
    ...(execution ? { execution } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function blockedProjectExecution(options: {
  content: string;
  requester: { id?: string; name?: string };
  unblockRequest: string;
  nextStep: string;
}): ExecutionOutcome {
  return buildExecutionOutcome({
    claim: {
      outcome: "blocked",
      summary: options.content,
      artifacts: [{ kind: "message", label: "Blocked-run report" }],
      handoff: {
        kind: "requester",
        ...(options.requester.id ? { ownerId: options.requester.id } : {}),
        ...(options.requester.name ? { ownerName: options.requester.name } : {}),
        nextStep: options.nextStep,
        unblockRequest: options.unblockRequest,
      },
      significance: { kind: "human_required", summary: options.unblockRequest },
    },
    content: options.content,
    technicalStatus: "done",
    surface: "project",
    requester: options.requester,
  });
}

function failedProjectExecution(content: string, error: string, requester: { id?: string; name?: string }): ExecutionOutcome {
  return buildExecutionOutcome({
    content,
    technicalStatus: "error",
    surface: "project",
    requester,
    error,
  });
}

export class ProjectStore extends DurableObject {
  private readonly workerEnv: ProjectStoreEnv;
  /** Encrypts every credential this shard stores; keyed by the Worker secret. */
  private readonly vault: SecretVault;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.workerEnv = (env ?? {}) as ProjectStoreEnv;
    this.vault = SecretVault.fromEnv(env);
    const sql = this.ctx.storage.sql;
    // Registry tables (used only by the "registry" instance).
    sql.exec(`
      CREATE TABLE IF NOT EXISTS reg_rows (
        email TEXT NOT NULL,
        project_id TEXT NOT NULL,
        role TEXT NOT NULL,
        project_name TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (email, project_id)
      )
    `);
    // Project shard tables.
    sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS members (
        email TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        added_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        handle TEXT NOT NULL,
        emoji TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        access TEXT NOT NULL,
        secrets TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        topic TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        root_id TEXT,
        author_kind TEXT NOT NULL,
        author TEXT NOT NULL,
        author_name TEXT NOT NULL,
        body TEXT NOT NULL,
        pending INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    sql.exec("CREATE INDEX IF NOT EXISTS idx_msg_chan_updated ON messages (channel_id, updated_at)");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_msg_chan_created ON messages (channel_id, created_at)");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_msg_root ON messages (root_id)");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS reads (
        email TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        last_read_at INTEGER NOT NULL,
        PRIMARY KEY (email, channel_id)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        root_id TEXT NOT NULL,
        placeholder_id TEXT NOT NULL,
        prompt_id TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    // Screens: admin-composed widget desks + per-member private assistant chats.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS screens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL DEFAULT '',
        widgets TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS screen_chat (
        id TEXT PRIMARY KEY,
        screen_id TEXT NOT NULL,
        widget_id TEXT NOT NULL,
        email TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        author_name TEXT NOT NULL,
        body TEXT NOT NULL,
        pending INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_screen_chat ON screen_chat (screen_id, widget_id, email, created_at)",
    );
    sql.exec(`
      CREATE TABLE IF NOT EXISTS screen_jobs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        screen_id TEXT NOT NULL,
        widget_id TEXT NOT NULL,
        email TEXT NOT NULL,
        placeholder_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    // "Ask Gera" research runs ride the same queue with kind='research'.
    try {
      sql.exec("ALTER TABLE screen_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'");
    } catch {
      // Column already exists.
    }
    // Desk intelligence: suggestion memory (👍/👎 calibration + per-conversation
    // cache), the harvested log of real teammate replies with LLM grades,
    // Intercom-admin ↔ Gera-member links, and per-teammate coaching notes.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS desk_suggestions (
        id TEXT PRIMARY KEY,
        screen_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        text TEXT NOT NULL,
        verdict TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      )
    `);
    sql.exec("CREATE INDEX IF NOT EXISTS idx_desk_sugg ON desk_suggestions (screen_id, created_at)");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS desk_suggest_cache (
        screen_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        last_part_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (screen_id, conversation_id)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS desk_replies (
        screen_id TEXT NOT NULL,
        id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        admin_id TEXT NOT NULL,
        admin_name TEXT NOT NULL,
        customer_text TEXT NOT NULL,
        reply_text TEXT NOT NULL,
        response_ms INTEGER NOT NULL,
        at INTEGER NOT NULL,
        grade TEXT NOT NULL DEFAULT '',
        grade_reason TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (screen_id, id)
      )
    `);
    sql.exec("CREATE INDEX IF NOT EXISTS idx_desk_replies ON desk_replies (screen_id, at)");
    // Full conversation transcripts backing the grading prompt — refreshed by
    // every "Collect & grade" pass, pruned alongside desk_replies.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS desk_transcripts (
        screen_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        transcript TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (screen_id, conversation_id)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS desk_links (
        admin_id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        admin_name TEXT NOT NULL DEFAULT '',
        admin_email TEXT NOT NULL DEFAULT '',
        linked_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS desk_coach (
        admin_id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS desk_stats_meta (
        screen_id TEXT PRIMARY KEY,
        scanned_conversations INTEGER NOT NULL,
        analyzed_conversations INTEGER NOT NULL,
        range_from INTEGER NOT NULL,
        range_to INTEGER NOT NULL,
        collected_at INTEGER NOT NULL,
        limit_reached INTEGER NOT NULL DEFAULT 0
      )
    `);
    // One-time v2 reset requested for the old shallow (20-conversation) result
    // set. Identity links remain; only harvested analysis is rebuilt.
    const performanceReset = sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'desk_performance_v2_reset'")
      .toArray()[0];
    if (!performanceReset) {
      sql.exec("DELETE FROM desk_replies");
      sql.exec("DELETE FROM desk_transcripts");
      sql.exec("DELETE FROM desk_coach");
      sql.exec("DELETE FROM desk_stats_meta");
      sql.exec("INSERT INTO meta (key, value) VALUES ('desk_performance_v2_reset', '1')");
    }
    // Desk ↔ Slack: per-screen pool of synced channel messages (short TTL).
    sql.exec(`
      CREATE TABLE IF NOT EXISTS desk_slack_pool (
        screen_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    // Desk "Recent page views": first-party beacons from the customer site's
    // pv.js snippet, keyed by identified contact (email / external user id).
    sql.exec(`
      CREATE TABLE IF NOT EXISTS desk_pageviews (
        id TEXT PRIMARY KEY,
        contact_key TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        at INTEGER NOT NULL
      )
    `);
    sql.exec("CREATE INDEX IF NOT EXISTS idx_desk_pv ON desk_pageviews (contact_key, at)");
    // Inbound Slack bot: Events API retry dedup + queued mention runs.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS slack_events (
        event_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS slack_jobs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        event_ts TEXT NOT NULL,
        user_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      )
    `);
    for (const table of ["messages", "screen_chat", "slack_jobs"]) {
      try {
        sql.exec(`ALTER TABLE ${table} ADD COLUMN outcome TEXT NOT NULL DEFAULT ''`);
      } catch {
        // Column already exists.
      }
    }
    // Seal pre-vault plaintext (and rows under a rotated-out key) before the
    // first request; a failure here must never brick the object.
    this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.sealLegacySecrets();
      } catch (error) {
        console.error(
          "project secret sweep failed",
          error instanceof SecretVaultError ? error.code : "error",
        );
      }
    });
  }

  /**
   * One-time (per vault key) pass over every stored credential: plaintext
   * rows from before the vault and rows sealed under a previous key are
   * re-sealed under the current key. Skipped entirely once `meta` records
   * the current key id, so routine wake-ups cost one row read.
   */
  private async sealLegacySecrets(): Promise<void> {
    if (!this.vault.enabled) {
      return;
    }
    const kid = await this.vault.currentKid();
    if (this.metaValue(VAULT_SWEEP_META_KEY) === kid) {
      return;
    }
    const sql = this.ctx.storage.sql;
    const agents = sql.exec<{ id: string; secrets: string }>("SELECT id, secrets FROM agents").toArray();
    let sealed = 0;
    for (const row of agents) {
      const stored = parseSecrets(row.secrets);
      if (!(await fieldsNeedReseal(this.vault, stored, AGENT_SECRET_FIELDS))) {
        continue;
      }
      sql.exec(
        "UPDATE agents SET secrets = ? WHERE id = ?",
        JSON.stringify(await sealFields(this.vault, stored, AGENT_SECRET_FIELDS, agentSecretScope(row.id))),
        row.id,
      );
      sealed += 1;
    }
    const slack = this.loadSlackConfig();
    if (slack && (await fieldsNeedReseal(this.vault, slack, SLACK_CONFIG_SECRET_FIELDS))) {
      await this.saveSlackConfig(slack);
      sealed += 1;
    }
    sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      VAULT_SWEEP_META_KEY,
      kid,
    );
    if (sealed > 0) {
      console.log("project secrets sealed", sealed);
    }
  }

  /** Decrypts an agent's credential fields for use inside this shard only. */
  private revealAgentSecrets(agent: Pick<AgentRow, "id" | "secrets">): Promise<AgentSecrets> {
    return openFields(this.vault, parseSecrets(agent.secrets), AGENT_SECRET_FIELDS, agentSecretScope(agent.id));
  }

  /** Serializes agent secrets for storage with every credential field sealed. */
  private async sealedAgentSecrets(agentId: string, secrets: AgentSecrets): Promise<string> {
    return JSON.stringify(await sealFields(this.vault, secrets, AGENT_SECRET_FIELDS, agentSecretScope(agentId)));
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const email = readEmail(request);
    try {
      // --- Registry instance routes -------------------------------------
      if (request.method === "GET" && path === "/reg/list") {
        return this.regList((url.searchParams.get("email") ?? "").trim().toLowerCase());
      }
      if (request.method === "POST" && path === "/reg/upsert") {
        return this.regUpsert(await request.json());
      }
      if (request.method === "POST" && path === "/reg/drop-project") {
        return this.regDropProject(await request.json());
      }

      // --- Inbound Slack bot (no Gera identity by design — Slack is the
      // caller; authenticity is the per-agent signing secret, verified
      // inside the handler before anything else happens) ------------------
      if (request.method === "POST" && path === "/slack-event") {
        return this.handleSlackEvent(request);
      }
      if (request.method === "POST" && path === "/slack-run") {
        return this.handleSlackRun(await request.json());
      }
      if (request.method === "POST" && path === "/slack-oauth") {
        // Public like /slack-event: the caller is the OAuth callback; the
        // state's HMAC (keyed by the app's client secret) is the identity.
        return this.handleSlackOAuth(await request.json(), url);
      }
      if (request.method === "POST" && path === "/pv-ingest") {
        // Public like /slack-event: the caller is the pv.js snippet on the
        // customer's website; authenticity is the project's write-only
        // tracking key carried in the payload.
        return handlePageViewIngest(this.deskContext(), await request.text());
      }

      // --- Project shard routes ------------------------------------------
      if (!email) {
        return json({ error: "sign_in_required" }, 401);
      }
      if (request.method === "POST" && path === "/init") {
        return this.handleInit(email, await request.json());
      }
      const me = this.loadMember(email);
      if (!this.projectId()) {
        return json({ error: "project_not_found" }, 404);
      }
      if (!me) {
        return json({ error: "not_a_member" }, 403);
      }
      if (request.method === "GET" && path === "/overview") {
        return this.handleOverview(me);
      }
      if (request.method === "GET" && path === "/messages") {
        return this.handleMessages(url);
      }
      if (request.method === "POST" && path === "/message") {
        return this.handleMessagePost(me, await request.json());
      }
      if (request.method === "POST" && path === "/read") {
        return this.handleRead(me, await request.json());
      }
      if (request.method === "POST" && path === "/channels/create") {
        return this.handleChannelCreate(me, await request.json());
      }
      if (request.method === "POST" && path === "/members/add") {
        return this.handleMemberAdd(me, await request.json());
      }
      if (request.method === "POST" && path === "/members/remove") {
        return this.handleMemberRemove(me, await request.json());
      }
      if (request.method === "POST" && path === "/members/role") {
        return this.handleMemberRole(me, await request.json());
      }
      if (request.method === "POST" && path === "/agents/github-validate") {
        return handleProjectGitHubValidate(await request.json(), canManageProject(this.memberRole(me)));
      }
      if (request.method === "POST" && path === "/agents/upsert") {
        return this.handleAgentUpsert(me, await request.json());
      }
      if (request.method === "POST" && path === "/agents/delete") {
        return this.handleAgentDelete(me, await request.json());
      }
      if (request.method === "POST" && path === "/agents/slack-create-app") {
        return this.handleAgentSlackCreateApp(me, await request.json(), url);
      }
      if (request.method === "POST" && path === "/agents/slack-install-url") {
        return this.handleAgentSlackInstallUrl(me, await request.json(), url);
      }
      if (request.method === "POST" && path === "/slack-config") {
        return this.handleSlackConfig(me, await request.json());
      }
      if (request.method === "POST" && path === "/screens/upsert") {
        return handleScreenUpsert(this.deskContext(), me, await request.json());
      }
      if (request.method === "POST" && path === "/screens/delete") {
        return handleScreenDelete(this.deskContext(), me, await request.json());
      }
      if (request.method === "POST" && path === "/intercom/inbox") {
        return handleIntercomInbox(this.deskContext(), await request.json());
      }
      if (request.method === "POST" && path === "/intercom/thread") {
        return handleIntercomThread(this.deskContext(), await request.json());
      }
      if (request.method === "POST" && path === "/intercom/details") {
        return handleIntercomDetails(this.deskContext(), me, await request.json());
      }
      if (request.method === "POST" && path === "/intercom/reply") {
        return handleIntercomReply(this.deskContext(), me, await request.json());
      }
      if (request.method === "POST" && path === "/intercom/mention-admins") {
        return handleIntercomMentionAdmins(this.deskContext(), await request.json());
      }
      if (request.method === "POST" && path === "/intercom/suggest") {
        return handleIntercomSuggest(this.deskContext(), await request.json());
      }
      if (request.method === "POST" && path === "/intercom/suggest/rate") {
        return handleSuggestRate(this.deskContext(), await request.json());
      }
      if (request.method === "POST" && path === "/intercom/action") {
        return handleIntercomAction(this.deskContext(), me, await request.json());
      }
      if (request.method === "POST" && path === "/intercom/ask-gera") {
        return handleAskGera(this.deskContext(), me, await request.json());
      }
      if (request.method === "POST" && path === "/intercom/stats") {
        return handleDeskStats(this.deskContext(), me, await request.json());
      }
      if (request.method === "POST" && path === "/intercom/stats/refresh") {
        return handleDeskStatsRefresh(this.deskContext(), me, await request.json());
      }
      if (request.method === "POST" && path === "/intercom/stats/clear") {
        return handleDeskStatsClear(this.deskContext(), me, await request.json());
      }
      if (request.method === "POST" && path === "/intercom/stats/link") {
        return handleDeskLink(this.deskContext(), me, await request.json());
      }
      if (request.method === "POST" && path === "/intercom/slack-related") {
        return handleDeskSlackRelated(this.deskContext(), await request.json());
      }
      if (request.method === "POST" && path === "/intercom/ask-status") {
        return handleAskStatus(this.deskContext(), await request.json());
      }
      if (request.method === "POST" && path === "/tracking/setup") {
        return handleTrackingSetup(this.deskContext(), me);
      }
      if (request.method === "GET" && path === "/screen-chat") {
        return handleScreenChatGet(this.deskContext(), me, url);
      }
      if (request.method === "POST" && path === "/screen-chat/send") {
        return handleScreenChatSend(this.deskContext(), me, await request.json());
      }
      if (request.method === "POST" && path === "/screen-run") {
        return this.handleScreenRun(await request.json());
      }
      if (request.method === "POST" && path === "/project/rename") {
        return this.handleRename(me, await request.json());
      }
      if (request.method === "POST" && path === "/project/delete") {
        return this.handleDelete(me);
      }
      if (request.method === "POST" && path === "/agent-run") {
        return this.handleAgentRun(await request.json());
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      if (error instanceof SecretVaultError) {
        // Fail closed and say why: no plaintext credential is ever written
        // because the key is missing, and no sealed one is silently dropped.
        console.error("project store vault", path, error.code);
        return json({ error: error.code, message: describeSecretVaultError(error) }, 503);
      }
      console.error("project store failed", path, error instanceof Error ? error.message : "error");
      return json({ error: "internal" }, 500);
    }
  }

  // --- Registry ---------------------------------------------------------

  private regList(email: string): Response {
    if (!email) {
      return json({ error: "sign_in_required" }, 401);
    }
    const rows = this.ctx.storage.sql
      .exec<{ project_id: string; role: string; project_name: string }>(
        "SELECT project_id, role, project_name FROM reg_rows WHERE email = ? ORDER BY updated_at DESC",
        email,
      )
      .toArray();
    return json({
      projects: rows.map((row) => ({
        id: row.project_id,
        name: row.project_name,
        role: isProjectRole(row.role) ? row.role : "member",
      })),
    });
  }

  private regUpsert(body: unknown): Response {
    if (!isRecord(body)) {
      return json({ error: "invalid_body" }, 400);
    }
    const projectId = asStr(body.projectId);
    if (!projectId) {
      return json({ error: "invalid_body" }, 400);
    }
    const now = Date.now();
    const name = asStr(body.name).slice(0, PROJECT_NAME_LIMIT);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    for (const item of rows.slice(0, MAX_MEMBERS)) {
      if (!isRecord(item)) {
        continue;
      }
      const rowEmail = asStr(item.email).trim().toLowerCase();
      const role = isProjectRole(item.role) ? item.role : "member";
      if (!rowEmail) {
        continue;
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO reg_rows (email, project_id, role, project_name, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (email, project_id) DO UPDATE SET role = excluded.role,
           project_name = CASE WHEN excluded.project_name != '' THEN excluded.project_name ELSE reg_rows.project_name END,
           updated_at = excluded.updated_at`,
        rowEmail,
        projectId,
        role,
        name,
        now,
      );
    }
    if (name) {
      this.ctx.storage.sql.exec(
        "UPDATE reg_rows SET project_name = ?, updated_at = ? WHERE project_id = ?",
        name,
        now,
        projectId,
      );
    }
    const drop = Array.isArray(body.drop) ? body.drop : [];
    for (const item of drop.slice(0, MAX_MEMBERS)) {
      const dropEmail = asStr(item).trim().toLowerCase();
      if (dropEmail) {
        this.ctx.storage.sql.exec(
          "DELETE FROM reg_rows WHERE email = ? AND project_id = ?",
          dropEmail,
          projectId,
        );
      }
    }
    return json({ ok: true });
  }

  private regDropProject(body: unknown): Response {
    const projectId = isRecord(body) ? asStr(body.projectId) : "";
    if (!projectId) {
      return json({ error: "invalid_body" }, 400);
    }
    this.ctx.storage.sql.exec("DELETE FROM reg_rows WHERE project_id = ?", projectId);
    return json({ ok: true });
  }

  // --- Project plumbing ---------------------------------------------------

  private metaValue(key: string): string {
    const rows = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
      .toArray();
    return rows[0]?.value ?? "";
  }

  private projectId(): string {
    return this.metaValue("id");
  }

  private loadMember(email: string): MemberRow | null {
    const rows = this.ctx.storage.sql
      .exec<MemberRow>("SELECT email, role, display_name, added_at FROM members WHERE email = ?", email)
      .toArray();
    return rows[0] ?? null;
  }

  private memberRole(member: MemberRow): ProjectRole {
    return isProjectRole(member.role) ? member.role : "member";
  }

  private handleInit(email: string, body: unknown): Response {
    if (!isRecord(body)) {
      return json({ error: "invalid_body" }, 400);
    }
    if (this.projectId()) {
      return json({ error: "already_exists" }, 409);
    }
    const projectId = asStr(body.projectId);
    const name = asStr(body.name).trim().slice(0, PROJECT_NAME_LIMIT);
    if (!projectId || !name) {
      return json({ error: "invalid_body" }, 400);
    }
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT INTO meta (key, value) VALUES ('id', ?)", projectId);
    sql.exec("INSERT INTO meta (key, value) VALUES ('name', ?)", name);
    sql.exec("INSERT INTO meta (key, value) VALUES ('created_by', ?)", email);
    sql.exec("INSERT INTO meta (key, value) VALUES ('created_at', ?)", String(now));
    const ownerName = asStr(body.ownerName).trim().slice(0, MEMBER_NAME_LIMIT);
    sql.exec(
      "INSERT INTO members (email, role, display_name, added_at) VALUES (?, 'owner', ?, ?)",
      email,
      ownerName,
      now,
    );
    sql.exec(
      "INSERT INTO channels (id, name, topic, created_by, created_at) VALUES (?, 'general', '', ?, ?)",
      newId("c"),
      email,
      now,
    );
    return json({ ok: true, id: projectId, name });
  }

  private handleOverview(me: MemberRow): Response {
    const sql = this.ctx.storage.sql;
    const members = sql
      .exec<MemberRow>("SELECT email, role, display_name, added_at FROM members ORDER BY added_at ASC")
      .toArray();
    const agents = sql
      .exec<AgentRow>(
        "SELECT id, name, handle, emoji, instructions, model, access, secrets, created_at, updated_at FROM agents ORDER BY created_at ASC",
      )
      .toArray();
    const channels = sql
      .exec<ChannelRow>("SELECT id, name, topic, created_at FROM channels ORDER BY created_at ASC")
      .toArray();
    const screens = sql
      .exec<ScreenRow>(
        "SELECT id, name, emoji, widgets, created_at, updated_at FROM screens ORDER BY created_at ASC",
      )
      .toArray();
    const reads = new Map<string, number>();
    for (const row of sql
      .exec<{ channel_id: string; last_read_at: number }>(
        "SELECT channel_id, last_read_at FROM reads WHERE email = ?",
        me.email,
      )
      .toArray()) {
      reads.set(row.channel_id, row.last_read_at);
    }
    const channelWires: ProjectChannelWire[] = channels.map((channel) => {
      const mark = reads.get(channel.id) ?? 0;
      const unreadRow = sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND pending = 0 AND author != ? AND created_at > ?",
          channel.id,
          me.email,
          mark,
        )
        .toArray()[0];
      const lastRow = sql
        .exec<{ m: number | null }>(
          "SELECT MAX(created_at) AS m FROM messages WHERE channel_id = ?",
          channel.id,
        )
        .toArray()[0];
      return {
        id: channel.id,
        name: channel.name,
        topic: channel.topic,
        createdAt: channel.created_at,
        unread: unreadRow?.n ?? 0,
        lastAt: lastRow?.m ?? 0,
      };
    });
    const memberWires: ProjectMemberWire[] = members.map((row) => ({
      email: row.email,
      role: this.memberRole(row),
      name: row.display_name,
      addedAt: row.added_at,
    }));
    return json({
      project: {
        id: this.projectId(),
        name: this.metaValue("name"),
        createdBy: this.metaValue("created_by"),
        createdAt: Number(this.metaValue("created_at")) || 0,
      },
      me: { email: me.email, role: this.memberRole(me) },
      members: memberWires,
      agents: agents.map((row) => agentWire(row)),
      channels: channelWires,
      screens: screens.map(screenWire),
      slackConfig: this.slackConfigWire(),
    });
  }

  private channelExists(channelId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ id: string }>("SELECT id FROM channels WHERE id = ?", channelId)
        .toArray().length > 0
    );
  }

  private handleMessages(url: URL): Response {
    const channelId = url.searchParams.get("channel") ?? "";
    if (!channelId || !this.channelExists(channelId)) {
      return json({ error: "channel_not_found" }, 404);
    }
    const sql = this.ctx.storage.sql;
    const root = url.searchParams.get("root") ?? "";
    if (root) {
      const rows = sql
        .exec<MessageRow>(
          `SELECT id, channel_id, root_id, author_kind, author, author_name, body, pending, outcome, created_at, updated_at
           FROM messages WHERE channel_id = ? AND (id = ? OR root_id = ?)
           ORDER BY created_at ASC LIMIT ?`,
          channelId,
          root,
          root,
          THREAD_FETCH_LIMIT,
        )
        .toArray();
      return json({ messages: rows.map(messageWire), threads: [], now: Date.now() });
    }
    const since = Number(url.searchParams.get("since") ?? "0");
    let rows: MessageRow[];
    if (Number.isFinite(since) && since > 0) {
      rows = sql
        .exec<MessageRow>(
          `SELECT id, channel_id, root_id, author_kind, author, author_name, body, pending, outcome, created_at, updated_at
           FROM messages WHERE channel_id = ? AND updated_at > ?
           ORDER BY updated_at ASC LIMIT ?`,
          channelId,
          Math.floor(since),
          MESSAGE_PAGE,
        )
        .toArray();
    } else {
      rows = sql
        .exec<MessageRow>(
          `SELECT id, channel_id, root_id, author_kind, author, author_name, body, pending, outcome, created_at, updated_at
           FROM messages WHERE channel_id = ?
           ORDER BY created_at DESC LIMIT ?`,
          channelId,
          MESSAGE_PAGE,
        )
        .toArray()
        .reverse();
    }
    const threads: ThreadStatWire[] = sql
      .exec<{ root_id: string; n: number; m: number }>(
        `SELECT root_id, COUNT(*) AS n, MAX(created_at) AS m FROM messages
         WHERE channel_id = ? AND root_id IS NOT NULL GROUP BY root_id`,
        channelId,
      )
      .toArray()
      .map((row) => ({ root: row.root_id, count: row.n, lastAt: row.m }));
    return json({ messages: rows.map(messageWire), threads, now: Date.now() });
  }

  private handleMessagePost(me: MemberRow, body: unknown): Response {
    if (!isRecord(body)) {
      return json({ error: "invalid_body" }, 400);
    }
    const channelId = asStr(body.channelId);
    const text = asStr(body.body).trim();
    if (!channelId || !this.channelExists(channelId)) {
      return json({ error: "channel_not_found" }, 404);
    }
    if (text.length === 0 || text.length > MESSAGE_BODY_LIMIT) {
      return json({ error: "invalid_message", limit: MESSAGE_BODY_LIMIT }, 400);
    }
    const sql = this.ctx.storage.sql;
    // Resolve the thread root when replying: replies to a reply join its root.
    let rootId: string | null = null;
    const requestedRoot = asStr(body.rootId);
    if (requestedRoot) {
      const target = sql
        .exec<{ id: string; root_id: string | null; channel_id: string }>(
          "SELECT id, root_id, channel_id FROM messages WHERE id = ?",
          requestedRoot,
        )
        .toArray()[0];
      if (!target || target.channel_id !== channelId) {
        return json({ error: "thread_not_found" }, 404);
      }
      rootId = target.root_id ?? target.id;
    }
    const now = Date.now();
    const messageId = newId("m");
    const authorName = me.display_name || me.email.split("@")[0];
    sql.exec(
      `INSERT INTO messages (id, channel_id, root_id, author_kind, author, author_name, body, pending, created_at, updated_at)
       VALUES (?, ?, ?, 'user', ?, ?, ?, 0, ?, ?)`,
      messageId,
      channelId,
      rootId,
      me.email,
      authorName,
      text,
      now,
      now,
    );

    // @mentions summon project agents; each reply lands in the thread.
    const agents = sql
      .exec<AgentRow>(
        "SELECT id, name, handle, emoji, instructions, model, access, secrets, created_at, updated_at FROM agents",
      )
      .toArray();
    const byHandle = new Map(agents.map((agent) => [agent.handle, agent]));
    const mentioned = parseMentions(text, [...byHandle.keys()]).slice(0, MAX_AGENT_JOBS_PER_MESSAGE);
    const jobs: string[] = [];
    const replyRoot = rootId ?? messageId;
    for (const handle of mentioned) {
      const agent = byHandle.get(handle);
      if (!agent) {
        continue;
      }
      const placeholderId = newId("m");
      const stamp = Date.now();
      sql.exec(
        `INSERT INTO messages (id, channel_id, root_id, author_kind, author, author_name, body, pending, created_at, updated_at)
         VALUES (?, ?, ?, 'agent', ?, ?, '', 1, ?, ?)`,
        placeholderId,
        channelId,
        replyRoot,
        agent.id,
        agent.name,
        stamp,
        stamp,
      );
      const jobId = newId("j");
      sql.exec(
        `INSERT INTO jobs (id, agent_id, channel_id, root_id, placeholder_id, prompt_id, requested_by, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        jobId,
        agent.id,
        channelId,
        replyRoot,
        placeholderId,
        messageId,
        me.email,
        stamp,
      );
      jobs.push(jobId);
    }

    // Bound the channel — oldest rows fall off past the cap.
    sql.exec(
      `DELETE FROM messages WHERE channel_id = ? AND id NOT IN (
         SELECT id FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?
       )`,
      channelId,
      channelId,
      CHANNEL_KEEP_MESSAGES,
    );
    // Posting marks the channel read for the author.
    this.upsertRead(me.email, channelId, now);
    return json({ ok: true, id: messageId, rootId, jobs });
  }

  private upsertRead(email: string, channelId: string, at: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO reads (email, channel_id, last_read_at) VALUES (?, ?, ?)
       ON CONFLICT (email, channel_id) DO UPDATE SET last_read_at = MAX(reads.last_read_at, excluded.last_read_at)`,
      email,
      channelId,
      at,
    );
  }

  private handleRead(me: MemberRow, body: unknown): Response {
    if (!isRecord(body)) {
      return json({ error: "invalid_body" }, 400);
    }
    const channelId = asStr(body.channelId);
    if (!channelId || !this.channelExists(channelId)) {
      return json({ error: "channel_not_found" }, 404);
    }
    const at = Math.min(asNum(body.at, Date.now()), Date.now() + 60_000);
    this.upsertRead(me.email, channelId, at);
    return json({ ok: true });
  }

  private handleChannelCreate(me: MemberRow, body: unknown): Response {
    if (!canManageProject(this.memberRole(me))) {
      return json({ error: "admin_required" }, 403);
    }
    if (!isRecord(body)) {
      return json({ error: "invalid_body" }, 400);
    }
    const name = asStr(body.name)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9а-яё_-]/g, "")
      .slice(0, CHANNEL_NAME_LIMIT);
    if (!name) {
      return json({ error: "invalid_name" }, 400);
    }
    const sql = this.ctx.storage.sql;
    const count = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM channels").toArray()[0]?.n ?? 0;
    if (count >= MAX_CHANNELS) {
      return json({ error: "too_many_channels", limit: MAX_CHANNELS }, 400);
    }
    const exists = sql
      .exec<{ id: string }>("SELECT id FROM channels WHERE name = ?", name)
      .toArray()[0];
    if (exists) {
      return json({ error: "channel_exists" }, 409);
    }
    const id = newId("c");
    const topic = asStr(body.topic).trim().slice(0, CHANNEL_TOPIC_LIMIT);
    sql.exec(
      "INSERT INTO channels (id, name, topic, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      name,
      topic,
      me.email,
      Date.now(),
    );
    return json({ ok: true, id, name, topic });
  }

  private handleMemberAdd(me: MemberRow, body: unknown): Response {
    if (!canManageProject(this.memberRole(me))) {
      return json({ error: "admin_required" }, 403);
    }
    if (!isRecord(body)) {
      return json({ error: "invalid_body" }, 400);
    }
    const email = asStr(body.email).trim().toLowerCase();
    if (!email || !email.includes("@") || email.length > 200) {
      return json({ error: "invalid_email" }, 400);
    }
    const role: ProjectRole = body.role === "admin" ? "admin" : "member";
    const sql = this.ctx.storage.sql;
    if (this.loadMember(email)) {
      return json({ error: "already_member" }, 409);
    }
    const count = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM members").toArray()[0]?.n ?? 0;
    if (count >= MAX_MEMBERS) {
      return json({ error: "too_many_members", limit: MAX_MEMBERS }, 400);
    }
    const name = asStr(body.name).trim().slice(0, MEMBER_NAME_LIMIT);
    sql.exec(
      "INSERT INTO members (email, role, display_name, added_at) VALUES (?, ?, ?, ?)",
      email,
      role,
      name,
      Date.now(),
    );
    return json({ ok: true, email, role });
  }

  private handleMemberRemove(me: MemberRow, body: unknown): Response {
    if (!isRecord(body)) {
      return json({ error: "invalid_body" }, 400);
    }
    const email = asStr(body.email).trim().toLowerCase();
    const target = this.loadMember(email);
    if (!target) {
      return json({ error: "not_a_member" }, 404);
    }
    if (this.memberRole(target) === "owner") {
      return json({ error: "cannot_remove_owner" }, 400);
    }
    const selfLeave = email === me.email;
    if (!selfLeave && !canManageProject(this.memberRole(me))) {
      return json({ error: "admin_required" }, 403);
    }
    this.ctx.storage.sql.exec("DELETE FROM members WHERE email = ?", email);
    this.ctx.storage.sql.exec("DELETE FROM reads WHERE email = ?", email);
    this.revokeMcpSelectionsOwnedBy(email);
    return json({ ok: true, email });
  }

  private handleMemberRole(me: MemberRow, body: unknown): Response {
    if (!canManageProject(this.memberRole(me))) {
      return json({ error: "admin_required" }, 403);
    }
    if (!isRecord(body)) {
      return json({ error: "invalid_body" }, 400);
    }
    const email = asStr(body.email).trim().toLowerCase();
    const role: ProjectRole = body.role === "admin" ? "admin" : "member";
    const target = this.loadMember(email);
    if (!target) {
      return json({ error: "not_a_member" }, 404);
    }
    if (this.memberRole(target) === "owner") {
      return json({ error: "cannot_change_owner" }, 400);
    }
    this.ctx.storage.sql.exec("UPDATE members SET role = ? WHERE email = ?", role, email);
    if (role !== "admin") {
      this.revokeMcpSelectionsOwnedBy(email);
    }
    return json({ ok: true, email, role });
  }

  /** Unlinks account-scoped MCP delegation when its admin loses project authority. */
  private revokeMcpSelectionsOwnedBy(email: string): void {
    const rows = this.ctx.storage.sql
      .exec<{ id: string; secrets: string }>("SELECT id, secrets FROM agents")
      .toArray();
    for (const row of rows) {
      const secrets = parseSecrets(row.secrets);
      if (secrets.mcpSelection?.owner !== email) {
        continue;
      }
      delete secrets.mcpSelection;
      this.ctx.storage.sql.exec(
        "UPDATE agents SET secrets = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(secrets),
        Date.now(),
        row.id,
      );
    }
  }

  private async handleAgentUpsert(me: MemberRow, body: unknown): Promise<Response> {
    if (!canManageProject(this.memberRole(me))) {
      return json({ error: "admin_required" }, 403);
    }
    if (!isRecord(body)) {
      return json({ error: "invalid_body" }, 400);
    }
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const id = asStr(body.id);
    const existing = id
      ? sql
          .exec<AgentRow>(
            "SELECT id, name, handle, emoji, instructions, model, access, secrets, created_at, updated_at FROM agents WHERE id = ?",
            id,
          )
          .toArray()[0]
      : undefined;
    if (id && !existing) {
      return json({ error: "agent_not_found" }, 404);
    }
    if (!existing) {
      const count = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM agents").toArray()[0]?.n ?? 0;
      if (count >= MAX_AGENTS) {
        return json({ error: "too_many_agents", limit: MAX_AGENTS }, 400);
      }
    }
    const name = asStr(body.name).trim().slice(0, AGENT_NAME_LIMIT);
    if (!name) {
      return json({ error: "invalid_name" }, 400);
    }
    const taken = new Set(
      sql
        .exec<{ handle: string; id: string }>("SELECT handle, id FROM agents")
        .toArray()
        .filter((row) => row.id !== existing?.id)
        .map((row) => row.handle),
    );
    const requestedHandle = asStr(body.handle).trim().slice(0, AGENT_HANDLE_LIMIT);
    const handle = ensureUniqueHandle(normalizeHandle(requestedHandle || name), taken);
    const emoji = asStr(body.emoji).slice(0, 8);
    const instructions = asStr(body.instructions).slice(0, AGENT_INSTRUCTIONS_LIMIT);
    const model = asStr(body.model).slice(0, MODEL_ID_LIMIT);
    const access = normalizeAccess(body.access);

    // Secrets: non-empty string replaces, empty string keeps, null clears.
    // Untouched fields stay sealed exactly as stored; only incoming plaintext
    // is sealed on the way in (`sealedAgentSecrets` below).
    const secrets: AgentSecrets = existing ? parseSecrets(existing.secrets) : {};
    const incoming = isRecord(body.secrets) ? body.secrets : {};
    if (typeof incoming.githubToken === "string" && incoming.githubToken.trim()) {
      try { await validateProjectGitHubToken(incoming.githubToken); }
      catch (error) { return json({ error: error instanceof Error ? error.message : "GitHub verification failed" }, 400); }
    }
    // Disconnecting a Gera-created Slack app forgets everything minted with
    // it: the registration, its signing secret, and the installed bot token.
    // Runs first so a manual token pasted in the same save still lands.
    if (incoming.slackApp === null) {
      delete secrets.slackAppId;
      delete secrets.slackClientId;
      delete secrets.slackClientSecret;
      delete secrets.slackTeam;
      delete secrets.slackSigningSecret;
      delete secrets.slackToken;
    }
    const applySecret = (key: keyof AgentSecrets, value: unknown): void => {
      if (value === null) {
        delete secrets[key];
      } else if (typeof value === "string" && value.trim().length > 0) {
        secrets[key] = value.trim().slice(0, SECRET_VALUE_LIMIT);
      }
    };
    applySecret("githubToken", incoming.githubToken);
    if (secrets.githubToken) {
      secrets.githubToken = secrets.githubToken.replace(/^Bearer\s+/i, "");
    }
    if (incoming.githubAccount === null) {
      delete secrets.githubAccount;
    } else if (
      isRecord(incoming.githubAccount) &&
      incoming.githubAccount.owner === me.email &&
      typeof incoming.githubAccount.serverId === "string" &&
      incoming.githubAccount.serverId.length > 0 &&
      incoming.githubAccount.serverId.length <= 80
    ) {
      secrets.githubAccount = { owner: me.email, serverId: incoming.githubAccount.serverId };
      delete secrets.githubToken;
    }
    applySecret("intercomToken", incoming.intercomToken);
    applySecret("slackToken", incoming.slackToken);
    applySecret("slackSigningSecret", incoming.slackSigningSecret);
    // MCP link: the editor sends the full desired selection — ids + names
    // picked from the saving admin's connected servers (same list as chat).
    // Omitted = keep. A non-empty save re-links the selection to this admin.
    const mcpPatch = parseMcpSelectionPatch(incoming.mcpSelection);
    if (mcpPatch.action === "error") {
      return json({ error: mcpPatch.error }, 400);
    }
    // Write policy ("ask" | "auto") for the linked servers; omitted = keep.
    const writesPatch = parseMcpWritesPatch(incoming.mcpWrites);
    if (writesPatch.action === "error") {
      return json({ error: writesPatch.error }, 400);
    }
    if (mcpPatch.action === "set") {
      if (mcpPatch.servers.length > 0) {
        secrets.mcpSelection = {
          owner: me.email,
          servers: mcpPatch.servers,
          ...(secrets.mcpSelection?.writes === "ask" ? { writes: "ask" as const } : {}),
        };
      } else {
        delete secrets.mcpSelection;
      }
    }
    if (writesPatch.action === "set" && secrets.mcpSelection) {
      if (writesPatch.writes === "ask") {
        secrets.mcpSelection.writes = "ask";
      } else {
        delete secrets.mcpSelection.writes;
      }
    }

    const agentId = existing?.id ?? newId("a");
    const sealedSecrets = await this.sealedAgentSecrets(agentId, secrets);
    if (existing) {
      sql.exec(
        `UPDATE agents SET name = ?, handle = ?, emoji = ?, instructions = ?, model = ?, access = ?, secrets = ?, updated_at = ?
         WHERE id = ?`,
        name,
        handle,
        emoji,
        instructions,
        model,
        JSON.stringify(access),
        sealedSecrets,
        now,
        agentId,
      );
    } else {
      sql.exec(
        `INSERT INTO agents (id, name, handle, emoji, instructions, model, access, secrets, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        agentId,
        name,
        handle,
        emoji,
        instructions,
        model,
        JSON.stringify(access),
        sealedSecrets,
        now,
        now,
      );
    }
    const row = sql
      .exec<AgentRow>(
        "SELECT id, name, handle, emoji, instructions, model, access, secrets, created_at, updated_at FROM agents WHERE id = ?",
        agentId,
      )
      .toArray()[0];
    return json({ ok: true, agent: agentWire(row) });
  }

  private handleAgentDelete(me: MemberRow, body: unknown): Response {
    if (!canManageProject(this.memberRole(me))) {
      return json({ error: "admin_required" }, 403);
    }
    const id = isRecord(body) ? asStr(body.id) : "";
    if (!id) {
      return json({ error: "invalid_body" }, 400);
    }
    this.ctx.storage.sql.exec("DELETE FROM agents WHERE id = ?", id);
    return json({ ok: true });
  }

  // --- Create the Slack bot from Gera ---------------------------------------

  /** The Worker origin survives the DO dispatch — public URLs derive from it. */
  private slackInstallRedirect(url: URL): string {
    return `${url.origin}/slack/oauth/callback`;
  }

  private async saveAgentSecrets(agentId: string, secrets: AgentSecrets): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE agents SET secrets = ?, updated_at = ? WHERE id = ?",
      await this.sealedAgentSecrets(agentId, secrets),
      Date.now(),
      agentId,
    );
  }

  // --- Slack app manager (project-level tooling connection) ---------------

  private loadSlackConfig(): StoredSlackConfig | null {
    const raw = this.metaValue("slack_config");
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const access = asStr(parsed.access);
      const refresh = asStr(parsed.refresh);
      if (!access && !refresh) {
        return null;
      }
      return {
        access,
        refresh,
        teamId: asStr(parsed.teamId),
        userId: asStr(parsed.userId),
        exp: typeof parsed.exp === "number" && Number.isFinite(parsed.exp) ? parsed.exp : 0,
        connectedAt:
          typeof parsed.connectedAt === "number" && Number.isFinite(parsed.connectedAt)
            ? parsed.connectedAt
            : 0,
      };
    } catch {
      return null;
    }
  }

  /** Decrypts the stored app-manager pair for a Slack call inside this shard. */
  private revealSlackConfig(config: StoredSlackConfig): Promise<StoredSlackConfig> {
    return openFields(this.vault, config, SLACK_CONFIG_SECRET_FIELDS, slackConfigScope(this.projectId()));
  }

  private async saveSlackConfig(config: StoredSlackConfig | null): Promise<void> {
    const sql = this.ctx.storage.sql;
    if (!config) {
      sql.exec("DELETE FROM meta WHERE key = 'slack_config'");
      return;
    }
    const sealed = await sealFields(this.vault, config, SLACK_CONFIG_SECRET_FIELDS, slackConfigScope(this.projectId()));
    sql.exec(
      "INSERT INTO meta (key, value) VALUES ('slack_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(sealed),
    );
  }

  /** Rotation result → stored pair (keeps the original connect timestamp). */
  private async storeSlackRotation(rotation: SlackConfigRotation): Promise<void> {
    const previous = this.loadSlackConfig();
    await this.saveSlackConfig({
      access: rotation.accessToken,
      refresh: rotation.refreshToken,
      teamId: rotation.teamId || previous?.teamId || "",
      userId: rotation.userId || previous?.userId || "",
      exp: rotation.expiresAt,
      connectedAt: previous?.connectedAt || Date.now(),
    });
  }

  private slackConfigWire(): SlackConfigWire | null {
    const config = this.loadSlackConfig();
    if (!config) {
      return null;
    }
    return { team: config.teamId, renews: config.refresh.length > 0, connectedAt: config.connectedAt };
  }

  /**
   * A usable config access token from the stored connection: reused while
   * fresh, otherwise rotated (persisting the new pair right away — Slack
   * invalidates the old refresh token on every rotate). A dead connection is
   * forgotten so the editor honestly asks to reconnect.
   */
  private async freshSlackConfigToken(): Promise<string | null> {
    const stored = this.loadSlackConfig();
    if (!stored) {
      return null;
    }
    const config = await this.revealSlackConfig(stored);
    if (!config.refresh) {
      return config.access;
    }
    if (config.access && isSlackConfigAccessFresh(config.exp, Date.now())) {
      return config.access;
    }
    let rotation: SlackConfigRotation;
    try {
      rotation = await rotateSlackConfigToken(config.refresh);
    } catch (error) {
      if (isSlackConfigAuthError(error)) {
        await this.saveSlackConfig(null);
      }
      throw error;
    }
    await this.storeSlackRotation(rotation);
    return rotation.accessToken;
  }

  /**
   * POST /slack-config — the project-level Slack app manager (connect once,
   * Runbear-style). The admin pastes the REFRESH token (xoxe-1-…) one time;
   * the shard stores the pair and rotates it automatically, so "Create Slack
   * app" never asks for tokens again. A plain access token is accepted too
   * but cannot renew — honest `renews: false`. `token: null` disconnects.
   * Tokens never reach the client; the wire is { team, renews, connectedAt }.
   */
  private async handleSlackConfig(me: MemberRow, body: unknown): Promise<Response> {
    if (!canManageProject(this.memberRole(me))) {
      return json({ error: "admin_required" }, 403);
    }
    if (!isRecord(body)) {
      return json({ error: "invalid_body" }, 400);
    }
    if (body.token === null) {
      await this.saveSlackConfig(null);
      return json({ ok: true, slackConfig: null });
    }
    const token = asStr(body.token).trim();
    const kind = classifySlackConfigToken(token);
    if (!kind) {
      return json(
        {
          error: "invalid_token",
          message:
            "That doesn't look like an app configuration token. Copy the Refresh Token (xoxe-1-…) from api.slack.com/apps → Your App Configuration Tokens.",
        },
        400,
      );
    }
    if (kind === "access") {
      await this.saveSlackConfig({
        access: token,
        refresh: "",
        teamId: "",
        userId: "",
        exp: 0,
        connectedAt: Date.now(),
      });
      return json({ ok: true, slackConfig: this.slackConfigWire() });
    }
    let rotation: SlackConfigRotation;
    try {
      rotation = await rotateSlackConfigToken(token);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Slack rejected the token.";
      return json({ error: "rotate_failed", message }, 502);
    }
    await this.saveSlackConfig(null);
    await this.storeSlackRotation(rotation);
    return json({ ok: true, slackConfig: this.slackConfigWire() });
  }

  /**
   * POST /agents/slack-create-app — mints a real Slack app for this agent via
   * the manifest API. Two calls on purpose: create WITHOUT event
   * subscriptions (the response carries the signing secret), store the
   * credentials, THEN add the events URL with a manifest update — Slack's
   * URL challenge now verifies against the secret this shard already holds.
   * The config access token comes from the stored project-level connection
   * (rotated on demand); pasting a refresh token connects it on the spot.
   */
  private async handleAgentSlackCreateApp(me: MemberRow, body: unknown, url: URL): Promise<Response> {
    if (!canManageProject(this.memberRole(me))) {
      return json({ error: "admin_required" }, 403);
    }
    if (!isRecord(body)) {
      return json({ error: "invalid_body" }, 400);
    }
    const agent = this.loadAgent(asStr(body.agentId));
    if (!agent) {
      return json({ error: "agent_not_found" }, 404);
    }
    const secrets = parseSecrets(agent.secrets);
    if (secrets.slackAppId) {
      return json(
        { error: "slack_app_exists", message: "This agent already has a Slack app — disconnect it first." },
        400,
      );
    }
    const pasted = asStr(body.configToken).trim();
    let configToken = "";
    if (pasted && classifySlackConfigToken(pasted) === "refresh") {
      // Pasting the refresh token doubles as connecting the app manager.
      try {
        const rotation = await rotateSlackConfigToken(pasted);
        await this.storeSlackRotation(rotation);
        configToken = rotation.accessToken;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Slack rejected the token.";
        return json({ error: "slack_config_failed", message }, 502);
      }
    } else if (pasted) {
      configToken = pasted;
    } else {
      try {
        configToken = (await this.freshSlackConfigToken()) ?? "";
      } catch (error) {
        const message = error instanceof Error ? error.message : "Slack connection failed.";
        return json({ error: "slack_config_failed", message }, 502);
      }
      if (!configToken) {
        return json(
          {
            error: "config_token_required",
            message:
              "Connect Slack app management first — paste the refresh token from api.slack.com/apps.",
          },
          400,
        );
      }
    }
    const projectId = this.projectId();
    const redirectUrl = this.slackInstallRedirect(url);
    const eventsUrl = `${url.origin}/slack/events/${projectId}/${agent.id}`;

    let credentials: SlackAppCredentials;
    try {
      credentials = await createSlackAppFromManifest(
        configToken,
        buildSlackAppManifest({ botName: agent.name, redirectUrl }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Slack did not accept the request.";
      console.error("slack app create failed", agent.id);
      return json({ error: "slack_app_create_failed", message }, 502);
    }
    secrets.slackAppId = credentials.appId;
    secrets.slackClientId = credentials.clientId;
    secrets.slackClientSecret = credentials.clientSecret;
    secrets.slackSigningSecret = credentials.signingSecret;
    delete secrets.slackTeam;
    await this.saveAgentSecrets(agent.id, secrets);

    let warning = "";
    try {
      await updateSlackAppManifest(
        configToken,
        credentials.appId,
        buildSlackAppManifest({ botName: agent.name, redirectUrl, eventsUrl }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      console.error("slack app events wiring failed", agent.id);
      warning = `The app was created, but Event Subscriptions could not be configured: ${message} You can set the Request URL manually at api.slack.com/apps.`;
    }

    const state = await buildSlackInstallState(credentials.clientSecret, {
      projectId,
      agentId: agent.id,
      exp: Date.now() + SLACK_INSTALL_STATE_TTL_MS,
    });
    const row = this.loadAgent(agent.id);
    return json({
      ok: true,
      agent: row ? agentWire(row) : null,
      installUrl: slackAuthorizeUrl(credentials.clientId, redirectUrl, state),
      slackConfig: this.slackConfigWire(),
      ...(warning ? { warning } : {}),
    });
  }

  /** POST /agents/slack-install-url — a fresh signed OAuth install link. */
  private async handleAgentSlackInstallUrl(me: MemberRow, body: unknown, url: URL): Promise<Response> {
    if (!canManageProject(this.memberRole(me))) {
      return json({ error: "admin_required" }, 403);
    }
    const agent = this.loadAgent(isRecord(body) ? asStr(body.agentId) : "");
    if (!agent) {
      return json({ error: "agent_not_found" }, 404);
    }
    const secrets = await this.revealAgentSecrets(agent);
    if (!secrets.slackAppId || !secrets.slackClientId || !secrets.slackClientSecret) {
      return json({ error: "slack_app_missing" }, 400);
    }
    const state = await buildSlackInstallState(secrets.slackClientSecret, {
      projectId: this.projectId(),
      agentId: agent.id,
      exp: Date.now() + SLACK_INSTALL_STATE_TTL_MS,
    });
    return json({
      ok: true,
      url: slackAuthorizeUrl(secrets.slackClientId, this.slackInstallRedirect(url), state),
    });
  }

  /**
   * POST /slack-oauth — the OAuth callback relay. No Gera identity (the tab
   * belongs to Slack's redirect); authenticity is the state's HMAC keyed by
   * the app's client secret, checked against THIS project and agent. On
   * success the bot token lands server-side and Slack access flips on — the
   * whole point of the install.
   */
  private async handleSlackOAuth(body: unknown, url: URL): Promise<Response> {
    if (!this.projectId()) {
      return json({ error: "project_not_found" }, 404);
    }
    if (!isRecord(body)) {
      return json({ error: "invalid_body" }, 400);
    }
    const agent = this.loadAgent(asStr(body.agentId));
    if (!agent) {
      return json({ error: "agent_not_found" }, 404);
    }
    const secrets = await this.revealAgentSecrets(agent);
    if (!secrets.slackClientId || !secrets.slackClientSecret) {
      return json({ error: "slack_app_missing", message: "This agent has no Gera-created Slack app." }, 400);
    }
    const state = await verifySlackInstallState(secrets.slackClientSecret, asStr(body.state));
    if (!state || state.agentId !== agent.id || state.projectId !== this.projectId()) {
      return json(
        { error: "bad_state", message: "The install link is invalid or expired — click Install in Gera again." },
        401,
      );
    }
    let result: SlackInstallResult;
    try {
      result = await exchangeSlackOAuthCode({
        clientId: secrets.slackClientId,
        clientSecret: secrets.slackClientSecret,
        code: asStr(body.code),
        redirectUri: this.slackInstallRedirect(url),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Slack rejected the code exchange.";
      console.error("slack oauth exchange failed", agent.id);
      return json({ error: "exchange_failed", message }, 502);
    }
    secrets.slackToken = result.botToken;
    secrets.slackTeam = result.team;
    const access = normalizeAccess(JSON.parse(agent.access || "{}") as unknown);
    access.slack = true;
    this.ctx.storage.sql.exec(
      "UPDATE agents SET access = ?, secrets = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(access),
      await this.sealedAgentSecrets(agent.id, secrets),
      Date.now(),
      agent.id,
    );
    console.log("slack bot installed for agent", agent.handle);
    return json({ ok: true, team: result.team });
  }

  private handleRename(me: MemberRow, body: unknown): Response {
    if (!canManageProject(this.memberRole(me))) {
      return json({ error: "admin_required" }, 403);
    }
    const name = isRecord(body) ? asStr(body.name).trim().slice(0, PROJECT_NAME_LIMIT) : "";
    if (!name) {
      return json({ error: "invalid_name" }, 400);
    }
    this.ctx.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'name'", name);
    return json({ ok: true, name });
  }

  private handleDelete(me: MemberRow): Response {
    if (this.memberRole(me) !== "owner") {
      return json({ error: "owner_required" }, 403);
    }
    const sql = this.ctx.storage.sql;
    for (const table of [
      "meta",
      "members",
      "agents",
      "channels",
      "messages",
      "reads",
      "jobs",
      "screens",
      "screen_chat",
      "screen_jobs",
      "desk_suggestions",
      "desk_suggest_cache",
      "desk_replies",
      "desk_transcripts",
      "desk_links",
      "desk_coach",
      "desk_stats_meta",
      "desk_slack_pool",
      "desk_pageviews",
    ]) {
      sql.exec(`DELETE FROM ${table}`);
    }
    return json({ ok: true });
  }

  // --- Screens ------------------------------------------------------------

  private loadScreen(id: string): ScreenRow | undefined {
    return this.ctx.storage.sql
      .exec<ScreenRow>(
        "SELECT id, name, emoji, widgets, created_at, updated_at FROM screens WHERE id = ?",
        id,
      )
      .toArray()[0];
  }

  private loadAgent(id: string): AgentRow | undefined {
    return this.ctx.storage.sql
      .exec<AgentRow>(
        "SELECT id, name, handle, emoji, instructions, model, access, secrets, created_at, updated_at FROM agents WHERE id = ?",
        id,
      )
      .toArray()[0];
  }

  /** The inbox widget's agent supplies the Intercom credential for the screen. */
  private async screenIntercomToken(screen: ScreenRow): Promise<{ token: string } | { error: string }> {
    const inbox = parseWidgets(screen.widgets).find((widget) => widget.kind === "intercom-inbox");
    if (!inbox?.agentId) {
      return { error: "This screen has no Intercom inbox widget." };
    }
    const agent = this.loadAgent(inbox.agentId);
    if (!agent) {
      return { error: "The agent powering this inbox was deleted — an admin must re-link the widget." };
    }
    const secrets = await this.revealAgentSecrets(agent);
    if (!secrets.intercomToken) {
      return {
        error: `No Intercom token is stored on @${agent.handle} — an admin must add it in the agent's settings.`,
      };
    }
    return { token: secrets.intercomToken };
  }

  /**
   * The desk's Slack credential: the first screen-widget agent (inbox first)
   * with Slack access AND a bot token. Watched channels = channels that bot
   * is a MEMBER of — inviting the project's bot to a channel in Slack IS the
   * channel selection, and per-project bots keep one workspace serving many
   * Gera projects correctly partitioned.
   */
  private async screenSlackToken(screen: ScreenRow): Promise<{ token: string } | { error: string }> {
    const widgets = parseWidgets(screen.widgets);
    const ordered = [
      ...widgets.filter((widget) => widget.kind === "intercom-inbox"),
      ...widgets.filter((widget) => widget.kind !== "intercom-inbox"),
    ];
    let sawSlackAgent = false;
    for (const widget of ordered) {
      if (!widget.agentId) {
        continue;
      }
      const agent = this.loadAgent(widget.agentId);
      if (!agent) {
        continue;
      }
      const access = normalizeAccess(JSON.parse(agent.access || "{}") as unknown);
      if (!access.slack) {
        continue;
      }
      sawSlackAgent = true;
      const secrets = await this.revealAgentSecrets(agent);
      if (secrets.slackToken) {
        return { token: secrets.slackToken };
      }
    }
    return {
      error: sawSlackAgent
        ? "The screen's Slack agent has no bot token yet — install its Slack app in the agent's settings."
        : "No screen agent has Slack access — enable Slack on the inbox or assistant agent to watch channels.",
    };
  }

  /** Storage, lookups and widget credentials the desk routes (desk-routes.ts) run over. */
  private deskContext(): DeskContext {
    return {
      sql: this.ctx.storage.sql,
      workerEnv: this.workerEnv,
      metaValue: (key) => this.metaValue(key),
      loadMember: (email) => this.loadMember(email),
      memberRole: (member) => this.memberRole(member),
      loadAgent: (id) => this.loadAgent(id),
      loadScreen: (id) => this.loadScreen(id),
      screenIntercomToken: (screen) => this.screenIntercomToken(screen),
      screenSlackToken: (screen) => this.screenSlackToken(screen),
    };
  }

  // --- Agent runs ---------------------------------------------------------

  private async handleAgentRun(body: unknown): Promise<Response> {
    const jobId = isRecord(body) ? asStr(body.jobId) : "";
    if (!jobId) {
      return json({ error: "invalid_body" }, 400);
    }
    const sql = this.ctx.storage.sql;
    const job = sql
      .exec<JobRow>(
        "SELECT id, agent_id, channel_id, root_id, placeholder_id, prompt_id, requested_by, status FROM jobs WHERE id = ?",
        jobId,
      )
      .toArray()[0];
    if (!job) {
      return json({ error: "job_not_found" }, 404);
    }
    if (job.status !== "queued") {
      return json({ ok: true, skipped: true });
    }
    sql.exec("UPDATE jobs SET status = 'running' WHERE id = ?", jobId);
    try {
      const execution = await this.runAgentJob(job);
      sql.exec("UPDATE jobs SET status = ? WHERE id = ?", execution.status, jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "run failed";
      const content = `⚠️ Agent run failed: ${capText(message, 400)}`;
      console.error("project agent run failed", job.agent_id, message);
      this.finishPlaceholder(
        job.placeholder_id,
        content,
        failedProjectExecution(content, message, { id: job.requested_by }),
      );
      sql.exec("UPDATE jobs SET status = 'error' WHERE id = ?", jobId);
    }
    return json({ ok: true });
  }

  private finishPlaceholder(placeholderId: string, text: string, execution: ExecutionOutcome): void {
    this.ctx.storage.sql.exec(
      "UPDATE messages SET body = ?, pending = 0, outcome = ?, updated_at = ? WHERE id = ?",
      capText(text, AGENT_REPLY_LIMIT),
      JSON.stringify(execution),
      Date.now(),
      placeholderId,
    );
  }

  /** What agent-toolset.ts needs from this store: secrets, membership, access, the DO binding. */
  private agentToolsetContext(): AgentToolsetContext<AgentRow> {
    return {
      durable: this.workerEnv.DO,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      agentAccess: (agent) => normalizeAccess(JSON.parse(agent.access || "{}") as unknown),
      currentAgent: (agent) => this.loadAgent(agent.id) ?? null,
      revealAgentSecrets: (agent) => this.revealAgentSecrets(agent),
      secretFlags,
      canManage: (email) => {
        const member = this.loadMember(email);
        return member !== null && canManageProject(this.memberRole(member));
      },
    };
  }

  /** Access + stored secrets → tools, routes and the external-MCP toolset for one run (agent-toolset.ts). */
  private buildAgentToolset(agent: AgentRow, surface: "project" | "slack" = "project"): Promise<AgentToolsetResult> {
    return buildAgentToolset(this.agentToolsetContext(), agent, surface);
  }

  private async runAgentJob(job: JobRow): Promise<ExecutionOutcome> {
    const sql = this.ctx.storage.sql;
    const requesterMember = this.loadMember(job.requested_by);
    const requester = {
      id: job.requested_by,
      name: requesterMember?.display_name || job.requested_by.split("@")[0],
    };
    const agent = this.loadAgent(job.agent_id);
    if (!agent) {
      const content = "This agent was deleted before it could reply.";
      const execution = blockedProjectExecution({
        content,
        requester,
        unblockRequest: "Ask a project admin to restore this agent or mention an existing agent.",
        nextStep: "Restore or replace the deleted project agent.",
      });
      this.finishPlaceholder(job.placeholder_id, content, execution);
      return execution;
    }
    const authKey =
      this.workerEnv.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY ?? this.workerEnv.RORK_TOOLKIT_SECRET_KEY ?? "";
    if (!authKey) {
      const content = "⚠️ The backend has no AI key configured — ask the workspace admin.";
      const execution = blockedProjectExecution({
        content,
        requester,
        unblockRequest: "Ask the workspace admin to configure the backend AI toolkit key.",
        nextStep: "Configure the backend AI toolkit key, then run the request again.",
      });
      this.finishPlaceholder(job.placeholder_id, content, execution);
      return execution;
    }
    const channel = sql
      .exec<ChannelRow>("SELECT id, name, topic, created_at FROM channels WHERE id = ?", job.channel_id)
      .toArray()[0];

    const { tools, routes, plan, access, mcpNote, toolset } = await this.buildAgentToolset(agent);
    try {
    // Thread transcript: root + settled replies, oldest first, capped.
    const threadRows = sql
      .exec<MessageRow>(
        `SELECT id, channel_id, root_id, author_kind, author, author_name, body, pending, outcome, created_at, updated_at
         FROM messages WHERE channel_id = ? AND (id = ? OR root_id = ?) AND pending = 0 AND body != ''
         ORDER BY created_at ASC LIMIT ?`,
        job.channel_id,
        job.root_id,
        job.root_id,
        THREAD_FETCH_LIMIT,
      )
      .toArray()
      .slice(-THREAD_CONTEXT_MESSAGES);
    const transcript = threadRows
      .map(
        (row) =>
          `${row.author_name}${row.author_kind === "agent" ? " (agent)" : ""}: ${capText(row.body, 2_000)}`,
      )
      .join("\n\n");

    const missingNote =
      plan.missingSecrets.length > 0
        ? `\n\nMissing credentials: ${plan.missingSecrets.join(", ")} access is switched on but no token is stored — if the request needs it, say plainly that a project admin must add the credential in the agent's settings.`
        : "";
    const system = [
      `You are "${agent.name}" (@${agent.handle}) — a scoped team agent inside the project "${this.metaValue("name")}". You reply in channel #${channel?.name ?? "general"}${channel?.topic ? ` (topic: ${channel.topic})` : ""}, inside a thread. Everyone in the project can read your reply.`,
      agent.instructions.trim().length > 0 ? `Your role instructions:\n${agent.instructions.trim()}` : "",
      `Access granted to this agent (honest — never claim more):\n${describeAgentAccess(plan, access)}${mcpNote}${missingNote}`,
      executionOutcomeSystemPrompt("tool", "project"),
      [
        "Rules:",
        "- Write one complete reply to the thread. Markdown renders (tables, fenced code, lists).",
        "- Be concise and concrete; lead with the answer.",
        "- You run once per mention with a ~2 minute budget — never promise to keep working; if the task is bigger, deliver what you can and list what remains.",
        "- Never fabricate. If you cannot reach something — a tool errors, a connector or key is missing or expired, a page or repo will not load — say plainly that you can't reach it and why, then continue with what you actually have. Never fill the gap with invented facts, numbers, quotes, links, file contents, or pretended tool results: an honest admission beats confident filler every time.",
        `- Current UTC time: ${new Date().toISOString()}.`,
      ].join("\n"),
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");

    const requesterName = threadRows.length > 0 ? threadRows[threadRows.length - 1].author_name : requester.name;
    const apiMessages: EngineMessage[] = [
      { role: "system", content: system },
      {
        role: "user",
        content: `Thread transcript:\n\n${transcript || "(empty thread)"}\n\n---\nYou were mentioned by ${requesterName} in the latest message above. Reply to the thread now.`,
      },
    ];

    const ledger = createSourceLedger();
    const toolCtx: ServerToolContext = {
      authKey,
      ledger,
      surf: createServerSurfSession(),
      mcpRoutes: routes.size > 0 ? routes : null,
      mcpToolset: toolset,
    };
    let executionClaim: ExecutionOutcomeClaim | null = null;
    const result = await runEngineTurn({
      authKey,
      modelId: agent.model || DEFAULT_CHAT_MODEL,
      apiMessages,
      tools: [...tools, executionOutcomeToolDefinition()],
      executeTool: (name, argsJson) => {
        if (name === EXECUTION_OUTCOME_TOOL_NAME) {
          executionClaim = parseExecutionOutcomeClaim(argsJson);
          return Promise.resolve({
            text: executionClaim
              ? "Execution outcome recorded. Do not repeat the deliverable."
              : "Execution outcome was invalid. Submit it again with every required field.",
            ...(executionClaim ? {} : { isError: true }),
          });
        }
        return executeServerTool(name, argsJson, toolCtx);
      },
      deadlineAt: Date.now() + AGENT_RUN_BUDGET_MS,
      handlers: { onText: () => undefined },
    });

    const sources = ledger.list().slice(0, SOURCES_APPENDIX_CAP);
    const sourcesBlock =
      sources.length > 0
        ? `\n\n---\nSources:\n${sources.map((source, index) => `[${index + 1}] ${source.title === source.url ? source.url : `${source.title} — ${source.url}`}`).join("\n")}`
        : "";
    const content = result.content.trim().length > 0 ? result.content : "(no output)";
    const allowedMemberIds = sql.exec<{ email: string }>("SELECT email FROM members").toArray().map((row) => row.email);
    const execution = buildExecutionOutcome({
      claim: executionClaim,
      content,
      sources,
      toolCalls: visibleExecutionToolCalls(result.toolCalls),
      technicalStatus: result.stopReason === "completed" ? "done" : "interrupted",
      surface: "project",
      requester,
      allowedMemberIds,
      ...(result.stopReason === "completed" ? {} : { error: `Run ended at ${result.stopReason}.` }),
    });
    this.finishPlaceholder(job.placeholder_id, `${content}${sourcesBlock}`, execution);
    return execution;
    } finally { toolset?.close(); }
  }

  // --- Screen assistant runs ----------------------------------------------

  private async handleScreenRun(body: unknown): Promise<Response> {
    const jobId = isRecord(body) ? asStr(body.jobId) : "";
    if (!jobId) {
      return json({ error: "invalid_body" }, 400);
    }
    const sql = this.ctx.storage.sql;
    const job = sql
      .exec<ScreenJobRow>(
        "SELECT id, agent_id, screen_id, widget_id, email, placeholder_id, conversation_id, status, kind FROM screen_jobs WHERE id = ?",
        jobId,
      )
      .toArray()[0];
    if (!job) {
      return json({ error: "job_not_found" }, 404);
    }
    if (job.status !== "queued") {
      return json({ ok: true, skipped: true });
    }
    sql.exec("UPDATE screen_jobs SET status = 'running' WHERE id = ?", jobId);
    try {
      const execution = await this.runScreenJob(job);
      sql.exec("UPDATE screen_jobs SET status = ? WHERE id = ?", execution.status, jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "run failed";
      const content = `⚠️ Assistant run failed: ${capText(message, 400)}`;
      console.error("screen assistant run failed", job.agent_id, message);
      this.finishScreenPlaceholder(
        job.placeholder_id,
        content,
        failedProjectExecution(content, message, { id: job.email, name: job.email.split("@")[0] }),
      );
      sql.exec("UPDATE screen_jobs SET status = 'error' WHERE id = ?", jobId);
    }
    return json({ ok: true });
  }

  private finishScreenPlaceholder(placeholderId: string, text: string, execution: ExecutionOutcome): void {
    this.ctx.storage.sql.exec(
      "UPDATE screen_chat SET body = ?, pending = 0, outcome = ?, updated_at = ? WHERE id = ?",
      capText(text, AGENT_REPLY_LIMIT),
      JSON.stringify(execution),
      Date.now(),
      placeholderId,
    );
  }

  private async runScreenJob(job: ScreenJobRow): Promise<ExecutionOutcome> {
    const sql = this.ctx.storage.sql;
    const member = this.loadMember(job.email);
    const memberName = member?.display_name || job.email.split("@")[0];
    const requester = { id: job.email, name: memberName };
    const agent = this.loadAgent(job.agent_id);
    if (!agent) {
      const content = "This agent was deleted before it could reply.";
      const execution = blockedProjectExecution({
        content,
        requester,
        unblockRequest: "Ask a project admin to restore this assistant or re-link the screen to an existing agent.",
        nextStep: "Restore or replace the deleted screen assistant.",
      });
      this.finishScreenPlaceholder(job.placeholder_id, content, execution);
      return execution;
    }
    const authKey =
      this.workerEnv.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY ?? this.workerEnv.RORK_TOOLKIT_SECRET_KEY ?? "";
    if (!authKey) {
      const content = "⚠️ The backend has no AI key configured — ask the workspace admin.";
      const execution = blockedProjectExecution({
        content,
        requester,
        unblockRequest: "Ask the workspace admin to configure the backend AI toolkit key.",
        nextStep: "Configure the backend AI toolkit key, then run the request again.",
      });
      this.finishScreenPlaceholder(job.placeholder_id, content, execution);
      return execution;
    }
    const screen = this.loadScreen(job.screen_id);

    const { tools, routes, plan, access, mcpNote, toolset } = await this.buildAgentToolset(agent);
    try {
    // Private desk history — settled rows; the fresh member message is last.
    const historyRows = sql
      .exec<ScreenChatRow>(
        `SELECT id, screen_id, widget_id, email, author_kind, author_name, body, pending, outcome, created_at, updated_at
         FROM screen_chat
         WHERE screen_id = ? AND widget_id = ? AND email = ? AND pending = 0 AND body != ''
         ORDER BY created_at DESC LIMIT ?`,
        job.screen_id,
        job.widget_id,
        job.email,
        SCREEN_CHAT_CONTEXT_MESSAGES,
      )
      .toArray()
      .reverse();

    // The open Intercom conversation attaches server-side — an honest live
    // fetch through the screen's own credential, never client-supplied text.
    let attachment = "";
    if (job.conversation_id && screen) {
      const resolved = await this.screenIntercomToken(screen);
      if ("token" in resolved) {
        try {
          attachment = await callIntercomNativeTool(resolved.token, "read_conversation", {
            conversation_id: job.conversation_id,
          });
        } catch (error) {
          attachment = `(Failed to load Intercom conversation #${job.conversation_id}: ${
            error instanceof Error ? error.message : "error"
          })`;
        }
      } else {
        attachment = `(Intercom conversation #${job.conversation_id} could not be attached: ${resolved.error})`;
      }
    }

    const missingNote =
      plan.missingSecrets.length > 0
        ? `\n\nMissing credentials: ${plan.missingSecrets.join(", ")} access is switched on but no token is stored — if the request needs it, say plainly that a project admin must add the credential in the agent's settings.`
        : "";
    const system = [
      `You are "${agent.name}" (@${agent.handle}) — the assistant docked on the screen "${screen?.name ?? "desk"}" in the project "${this.metaValue("name")}". This is a PRIVATE 1:1 chat with ${memberName}; every member has their own copy of this chat.`,
      agent.instructions.trim().length > 0 ? `Your role instructions:\n${agent.instructions.trim()}` : "",
      `Access granted to this agent (honest — never claim more):\n${describeAgentAccess(plan, access)}${mcpNote}${missingNote}`,
      executionOutcomeSystemPrompt("tool", "project"),
      [
        "Rules:",
        "- The member is working a real case on this screen — often the Intercom conversation attached below. Help fast: draft replies, dig into the repo, explain causes.",
        "- Markdown renders. Lead with the answer; keep it tight.",
        "- You run once per message with a ~2 minute budget — never promise to keep working in the background.",
        "- Never fabricate. If you cannot reach something — a tool errors, a connector or key is missing or expired, a page or repo will not load — say plainly that you can't reach it and why, then continue with what you actually have. Never fill the gap with invented facts, numbers, quotes, links, file contents, or pretended tool results: an honest admission beats confident filler every time.",
        `- Current UTC time: ${new Date().toISOString()}.`,
      ].join("\n"),
      job.kind === "research"
        ? [
            'RESEARCH REQUEST ("Ask Gera"): the member forwarded a customer question about product functionality.',
            "- Find the real answer with your tools: repo code/docs first when GitHub access is available, then the web.",
            "- Lead with a support-ready answer the member can paste to the customer — plain words, honest about anything unverified.",
            "- Knowledge base: if you have GitHub WRITE access, save the finding as docs/gera-kb/<short-slug>.md in the most relevant repo via github_put_file (a clear title, the question, the verified answer, source links) and report the exact saved path in your reply. With read-only or no GitHub access, say plainly that no KB page could be written and why.",
          ].join("\n")
        : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");

    const turns: EngineMessage[] = historyRows.map((row) => ({
      role: row.author_kind === "agent" ? ("assistant" as const) : ("user" as const),
      content: capText(row.body, 4_000),
    }));
    if (attachment) {
      const block = `Attached Intercom conversation (fetched live from this screen's inbox):\n\n${capText(attachment, 9_000)}`;
      const last = turns[turns.length - 1];
      if (last && last.role === "user" && typeof last.content === "string") {
        last.content = `${last.content}\n\n---\n${block}`;
      } else {
        turns.push({ role: "user", content: block });
      }
    }
    if (turns.length === 0) {
      turns.push({ role: "user", content: "(empty)" });
    }
    const apiMessages: EngineMessage[] = [{ role: "system", content: system }, ...turns];

    const ledger = createSourceLedger();
    const toolCtx: ServerToolContext = {
      authKey,
      ledger,
      surf: createServerSurfSession(),
      mcpRoutes: routes.size > 0 ? routes : null,
      mcpToolset: toolset,
    };
    let executionClaim: ExecutionOutcomeClaim | null = null;
    const result = await runEngineTurn({
      authKey,
      modelId: agent.model || DEFAULT_CHAT_MODEL,
      apiMessages,
      tools: [...tools, executionOutcomeToolDefinition()],
      executeTool: (name, argsJson) => {
        if (name === EXECUTION_OUTCOME_TOOL_NAME) {
          executionClaim = parseExecutionOutcomeClaim(argsJson);
          return Promise.resolve({
            text: executionClaim
              ? "Execution outcome recorded. Do not repeat the deliverable."
              : "Execution outcome was invalid. Submit it again with every required field.",
            ...(executionClaim ? {} : { isError: true }),
          });
        }
        return executeServerTool(name, argsJson, toolCtx);
      },
      deadlineAt: Date.now() + AGENT_RUN_BUDGET_MS,
      handlers: { onText: () => undefined },
    });

    const sources = ledger.list().slice(0, SOURCES_APPENDIX_CAP);
    const sourcesBlock =
      sources.length > 0
        ? `\n\n---\nSources:\n${sources.map((source, index) => `[${index + 1}] ${source.title === source.url ? source.url : `${source.title} — ${source.url}`}`).join("\n")}`
        : "";
    const content = result.content.trim().length > 0 ? result.content : "(no output)";
    const allowedMemberIds = sql.exec<{ email: string }>("SELECT email FROM members").toArray().map((row) => row.email);
    const execution = buildExecutionOutcome({
      claim: executionClaim,
      content,
      sources,
      toolCalls: visibleExecutionToolCalls(result.toolCalls),
      technicalStatus: result.stopReason === "completed" ? "done" : "interrupted",
      surface: "project",
      requester,
      allowedMemberIds,
      ...(result.stopReason === "completed" ? {} : { error: `Run ended at ${result.stopReason}.` }),
    });
    this.finishScreenPlaceholder(job.placeholder_id, `${content}${sourcesBlock}`, execution);
    return execution;
    } finally { toolset?.close(); }
  }

  // --- Inbound Slack bot runs -----------------------------------------------

  /**
   * POST /slack-event — the raw Events API request forwarded by the Worker.
   * Authenticity: the per-agent Slack signing secret (v0 HMAC over the raw
   * body + 5-minute timestamp window), then event-id dedup against retries.
   */
  private async handleSlackEvent(request: Request): Promise<Response> {
    if (!this.projectId()) {
      return json({ error: "project_not_found" }, 404);
    }
    const agentId = request.headers.get("X-Gera-Slack-Agent") ?? "";
    const agent = agentId ? this.loadAgent(agentId) : undefined;
    if (!agent) {
      return json({ error: "agent_not_found" }, 404);
    }
    const secrets = await this.revealAgentSecrets(agent);
    if (!secrets.slackSigningSecret) {
      // Setup order is honest: save the signing secret first, then paste the
      // URL into Slack — its URL check fails loudly until the secret exists.
      return json({ error: "signing_secret_missing" }, 403);
    }
    const rawBody = await request.text();
    const verified = await verifySlackSignature(
      secrets.slackSigningSecret,
      request.headers.get("X-Slack-Request-Timestamp"),
      rawBody,
      request.headers.get("X-Slack-Signature"),
    );
    if (!verified) {
      return json({ error: "bad_signature" }, 401);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const decision = classifySlackEvent(payload);
    if (decision.kind === "challenge") {
      return json({ challenge: decision.challenge });
    }
    if (decision.kind === "ignore") {
      return json({ ok: true, ignored: decision.reason });
    }
    const access = normalizeAccess(JSON.parse(agent.access || "{}") as unknown);
    if (!access.slack || !secrets.slackToken) {
      // 200 so Slack does not retry forever — there is nothing to run with.
      return json({ ok: true, ignored: access.slack ? "no_bot_token" : "slack_access_off" });
    }
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const seen =
      sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM slack_events WHERE event_id = ?", decision.mention.eventId)
        .toArray()[0]?.n ?? 0;
    if (seen > 0) {
      return json({ ok: true, duplicate: true });
    }
    sql.exec("INSERT INTO slack_events (event_id, created_at) VALUES (?, ?)", decision.mention.eventId, now);
    sql.exec("DELETE FROM slack_events WHERE created_at < ?", now - SLACK_EVENT_TTL_MS);
    sql.exec("DELETE FROM slack_jobs WHERE created_at < ?", now - SLACK_JOB_TTL_MS);
    const jobId = newId("sj");
    sql.exec(
      `INSERT INTO slack_jobs (id, agent_id, channel, thread_ts, event_ts, user_id, text, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      jobId,
      agent.id,
      decision.mention.channel,
      decision.mention.threadTs,
      decision.mention.eventTs,
      decision.mention.userId,
      capText(decision.mention.text, 4_000),
      now,
    );
    console.log("slack mention queued for agent", agent.handle);
    return json({ ok: true, jobs: [jobId] });
  }

  private async handleSlackRun(body: unknown): Promise<Response> {
    const jobId = isRecord(body) ? asStr(body.jobId) : "";
    if (!jobId) {
      return json({ error: "invalid_body" }, 400);
    }
    const sql = this.ctx.storage.sql;
    const job = sql
      .exec<SlackJobRow>(
        "SELECT id, agent_id, channel, thread_ts, event_ts, user_id, text, status, outcome FROM slack_jobs WHERE id = ?",
        jobId,
      )
      .toArray()[0];
    if (!job) {
      return json({ error: "job_not_found" }, 404);
    }
    if (job.status !== "queued") {
      return json({ ok: true, skipped: true });
    }
    sql.exec("UPDATE slack_jobs SET status = 'running' WHERE id = ?", jobId);
    try {
      const execution = await this.runSlackJob(job);
      sql.exec(
        "UPDATE slack_jobs SET status = ?, outcome = ? WHERE id = ?",
        execution.status,
        JSON.stringify(execution),
        jobId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "run failed";
      const content = `⚠️ Agent run failed: ${capText(message, 300)}`;
      const execution = failedProjectExecution(content, message, {
        id: job.user_id,
        name: `<@${job.user_id}>`,
      });
      console.error("slack bot run failed", job.agent_id, message);
      sql.exec(
        "UPDATE slack_jobs SET status = 'error', outcome = ? WHERE id = ?",
        JSON.stringify(execution),
        jobId,
      );
      // Honest failure note into the Slack thread while the token still works.
      const agent = this.loadAgent(job.agent_id);
      const token = agent ? parseSecrets(agent.secrets).slackToken : undefined;
      if (token) {
        try {
          await postSlackThreadReply(
            token,
            job.channel,
            job.thread_ts,
            `${content}\n\n---\n${executionOutcomeSlackFooter(execution)}`,
          );
        } catch {
          // nothing honest left to do — the thread stays silent
        }
      }
    }
    return json({ ok: true });
  }

  private async runSlackJob(job: SlackJobRow): Promise<ExecutionOutcome> {
    const agent = this.loadAgent(job.agent_id);
    if (!agent) {
      throw new Error("This agent was deleted before it could reply.");
    }
    const secrets = parseSecrets(agent.secrets);
    const token = secrets.slackToken;
    if (!token) {
      throw new Error("The Slack bot token was removed from this agent.");
    }
    const authKey =
      this.workerEnv.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY ?? this.workerEnv.RORK_TOOLKIT_SECRET_KEY ?? "";
    if (!authKey) {
      const content = "⚠️ The backend has no AI key configured — ask the workspace admin.";
      const execution = blockedProjectExecution({
        content,
        requester: { id: job.user_id, name: `<@${job.user_id}>` },
        unblockRequest: "Ask the workspace admin to configure the backend AI toolkit key.",
        nextStep: "Configure the backend AI toolkit key, then mention the agent again.",
      });
      await postSlackThreadReply(
        token,
        job.channel,
        job.thread_ts,
        `${content}\n\n---\n${executionOutcomeSlackFooter(execution)}`,
      );
      return execution;
    }
    const { tools, routes, plan, access, mcpNote, toolset } = await this.buildAgentToolset(agent, "slack");
    try {
    // Bot identity — used to strip self-mentions; failures are non-fatal.
    let botUserId = "";
    let workspace = "";
    try {
      const identity = await fetchSlackBotIdentity(token);
      botUserId = identity.userId;
      workspace = identity.team;
    } catch {
      // auth problems will surface on the final post instead
    }

    let transcript = "";
    let transcriptNote = "(No thread context available.)";
    try {
      transcript = await fetchSlackThreadTranscript(token, job.channel, job.thread_ts, SLACK_THREAD_CONTEXT);
    } catch (error) {
      transcriptNote = `(Could not read the Slack thread: ${error instanceof Error ? error.message : "error"})`;
    }
    const mentionText = stripSlackMention(job.text, botUserId) || "(no text beyond the mention)";

    const missingNote =
      plan.missingSecrets.length > 0
        ? `\n\nMissing credentials: ${plan.missingSecrets.join(", ")} access is switched on but no token is stored — if the request needs it, say plainly that a project admin must add the credential in the agent's settings.`
        : "";
    const system = [
      `You are "${agent.name}" (@${agent.handle}) — a scoped team agent of the project "${this.metaValue("name")}". A teammate mentioned you in Slack${workspace ? ` (workspace ${workspace})` : ""}; your reply is posted into that Slack thread automatically.`,
      agent.instructions.trim().length > 0 ? `Your role instructions:\n${agent.instructions.trim()}` : "",
      `Access granted to this agent (honest — never claim more):\n${describeAgentAccess(plan, access)}${mcpNote}${missingNote}`,
      executionOutcomeSystemPrompt("tool", "project"),
      [
        "Rules:",
        "- Slack renders mrkdwn, NOT Markdown: *bold*, _italic_, `code`, ``` blocks, - bullets, <https://url|label> links. No # headings and no tables — use short lines.",
        "- Lead with the answer; keep it compact — it lands in a chat thread.",
        "- Do NOT send the answer via the send_message tool — posting is automatic. Use Slack tools only to look other things up.",
        "- You run once per mention with a ~2 minute budget — never promise to keep working.",
        "- Never fabricate. If you cannot reach something — a tool errors, a connector or key is missing or expired, a page or repo will not load — say plainly that you can't reach it and why, then continue with what you actually have. Never fill the gap with invented facts, numbers, quotes, links, file contents, or pretended tool results: an honest admission beats confident filler every time.",
        `- Current UTC time: ${new Date().toISOString()}.`,
      ].join("\n"),
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");

    const apiMessages: EngineMessage[] = [
      { role: "system", content: system },
      {
        role: "user",
        content: `${transcript ? `Slack thread transcript (oldest first):\n\n${capText(transcript, 8_000)}` : transcriptNote}\n\n---\nYou were mentioned by <@${job.user_id}>: "${mentionText}". Reply to the Slack thread now.`,
      },
    ];

    const ledger = createSourceLedger();
    const toolCtx: ServerToolContext = {
      authKey,
      ledger,
      surf: createServerSurfSession(),
      mcpRoutes: routes.size > 0 ? routes : null,
      mcpToolset: toolset,
    };
    let executionClaim: ExecutionOutcomeClaim | null = null;
    const result = await runEngineTurn({
      authKey,
      modelId: agent.model || DEFAULT_CHAT_MODEL,
      apiMessages,
      tools: [...tools, executionOutcomeToolDefinition()],
      executeTool: (name, argsJson) => {
        if (name === EXECUTION_OUTCOME_TOOL_NAME) {
          executionClaim = parseExecutionOutcomeClaim(argsJson);
          return Promise.resolve({
            text: executionClaim
              ? "Execution outcome recorded. Do not repeat the deliverable."
              : "Execution outcome was invalid. Submit it again with every required field.",
            ...(executionClaim ? {} : { isError: true }),
          });
        }
        return executeServerTool(name, argsJson, toolCtx);
      },
      deadlineAt: Date.now() + AGENT_RUN_BUDGET_MS,
      handlers: { onText: () => undefined },
    });

    const sources = ledger.list().slice(0, SOURCES_APPENDIX_CAP);
    const sourcesBlock =
      sources.length > 0
        ? `\n\n---\nSources:\n${sources.map((source, index) => `[${index + 1}] ${source.title === source.url ? source.url : `${source.title} — ${source.url}`}`).join("\n")}`
        : "";
    const content = result.content.trim().length > 0 ? result.content : "(no output)";
    const execution = buildExecutionOutcome({
      claim: executionClaim,
      content,
      sources,
      toolCalls: visibleExecutionToolCalls(result.toolCalls),
      technicalStatus: result.stopReason === "completed" ? "done" : "interrupted",
      surface: "project",
      requester: { id: job.user_id, name: `<@${job.user_id}>` },
      allowedMemberIds: [],
      ...(result.stopReason === "completed" ? {} : { error: `Run ended at ${result.stopReason}.` }),
    });
    await postSlackThreadReply(
      token,
      job.channel,
      job.thread_ts,
      capText(`${content}${sourcesBlock}\n\n---\n${executionOutcomeSlackFooter(execution)}`, SLACK_REPLY_LIMIT),
    );
    return execution;
    } finally { toolset?.close(); }
  }
}
