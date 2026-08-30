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

import {
  capText,
  DEFAULT_CHAT_MODEL,
  runEngineTurn,
  streamGatewayCompletion,
  type EngineMessage,
  type EngineToolDef,
} from "./agent-engine";
import type { McpRoute } from "./automation-runner";
import { asNum, asStr, isRecord, json, readEmail } from "./chat-shared";
import {
  buildGradeMessages,
  buildSuggestMessages,
  parseGradePayload,
  parseSuggestPayload,
  type GradePromptInput,
} from "./desk-intelligence";
import {
  PAGE_VIEW_RETENTION_MS,
  PAGE_VIEWS_PER_CONTACT,
  pageViewContactKeys,
  parsePageViewPayload,
  type DeskPageView,
} from "./desk-pageviews";
import {
  buildSlackThreadBlock,
  matchSlackDiscussions,
  slackPermalink,
  slackThreadActive,
  type DeskSlackMessage,
} from "./desk-slack";
import {
  cloudMcpFunctionName,
  connectCloudMcp,
  normalizeCloudMcpServer,
  type CloudMcpServer,
} from "./mcp-cloud";
import { chatShardId } from "./shard-migration";
import {
  callIntercomNativeTool,
  fetchIntercomConversationDetails,
  fetchIntercomInboxData,
  fetchIntercomThreadData,
  harvestIntercomReplyPairs,
  listIntercomAdmins,
  manageIntercomConversationData,
  postIntercomReplyData,
  type IntercomAdminLite,
  type IntercomInboxState,
} from "./native-intercom";
import {
  buildSlackAppManifest,
  buildSlackInstallState,
  classifySlackConfigToken,
  classifySlackEvent,
  createSlackAppFromManifest,
  exchangeSlackOAuthCode,
  fetchChannelHistoryData,
  fetchSlackBotIdentity,
  fetchSlackThreadTailData,
  fetchSlackThreadTranscript,
  fetchSlackUserNames,
  isSlackConfigAccessFresh,
  isSlackConfigAuthError,
  listBotChannels,
  postSlackThreadReply,
  rotateSlackConfigToken,
  SLACK_INSTALL_STATE_TTL_MS,
  slackAuthorizeUrl,
  stripSlackMention,
  updateSlackAppManifest,
  verifySlackInstallState,
  verifySlackSignature,
  verifySlackToken,
  type SlackAppCredentials,
  type SlackThreadTail,
  type SlackConfigRotation,
  type SlackInstallResult,
} from "./native-slack";
import {
  AGENT_HANDLE_LIMIT,
  AGENT_INSTRUCTIONS_LIMIT,
  AGENT_NAME_LIMIT,
  AGENT_RUN_BUDGET_MS,
  CHANNEL_KEEP_MESSAGES,
  CHANNEL_NAME_LIMIT,
  CHANNEL_TOPIC_LIMIT,
  MAX_AGENT_JOBS_PER_MESSAGE,
  MAX_AGENTS,
  MAX_CHANNELS,
  MAX_MEMBERS,
  MAX_SCREENS,
  MEMBER_NAME_LIMIT,
  MESSAGE_BODY_LIMIT,
  MESSAGE_PAGE,
  PROJECT_NAME_LIMIT,
  SCREEN_CHAT_CONTEXT_MESSAGES,
  SCREEN_CHAT_KEEP,
  SCREEN_NAME_LIMIT,
  THREAD_CONTEXT_MESSAGES,
  canManageProject,
  describeAgentAccess,
  ensureUniqueHandle,
  isProjectRole,
  isScreenWidgetKind,
  normalizeHandle,
  normalizeStoredMcpSelection,
  parseMcpSelectionPatch,
  parseMentions,
  planAgentTools,
  validateScreenWidgets,
  type AgentAccess,
  type AgentMcpSelection,
  type AgentMcpServerRef,
  type AgentSecretFlags,
  type AgentSecrets,
  type AgentToolPlan,
  type ProjectAgentWire,
  type ProjectChannelWire,
  type ProjectMemberWire,
  type ProjectMessageWire,
  type ProjectRole,
  type ProjectScreenWire,
  type ScreenChatMessageWire,
  type ScreenWidgetWire,
  type SlackConfigWire,
  type ThreadStatWire,
} from "./project-shared";
import {
  builtinToolDefs,
  createServerSurfSession,
  createSourceLedger,
  executeServerTool,
  type ServerToolContext,
} from "./run-tools";

type ProjectStoreEnv = {
  EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY?: string;
  RORK_TOOLKIT_SECRET_KEY?: string;
  /** Rork DO router — lets this shard reach account shards (agent MCP resolve). */
  DO?: { fetch(request: Request): Promise<Response> };
};

/** One linked MCP server's connect outcome — a live session or an honest failure. */
type McpConnectAttempt =
  | {
      ref: AgentMcpServerRef;
      server: CloudMcpServer;
      connection: Awaited<ReturnType<typeof connectCloudMcp>>;
    }
  | { ref: AgentMcpServerRef; server?: CloudMcpServer; failure: string };

/** Agent replies may exceed the human message cap, but stay bounded. */
const AGENT_REPLY_LIMIT = 24_000;
const SECRET_VALUE_LIMIT = 400;
const MODEL_ID_LIMIT = 120;
const THREAD_FETCH_LIMIT = 500;
const SOURCES_APPENDIX_CAP = 12;
// Inbound Slack bot: Events API retry dedup horizon + job retention.
const SLACK_EVENT_TTL_MS = 2 * 60 * 60 * 1000;
const SLACK_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const SLACK_THREAD_CONTEXT = 25;
/** Slack chat.postMessage truncates around 40k chars — stay well under. */
const SLACK_REPLY_LIMIT = 11_500;
/** Hard cap on the routed tool surface of one agent run (native + MCP). */
const AGENT_TOOL_CAP = 90;
// Desk intelligence: suggestion cache window, memory caps, grading batch size.
const DESK_SUGGEST_TTL_MS = 15 * 60 * 1000;
const DESK_SUGGESTIONS_KEEP = 300;
const DESK_REPLIES_KEEP = 500;
const DESK_GRADE_BATCH = 12;
/** Reply drafts ride Luna — a fixed fast writer; grading keeps the inbox agent's model. */
const DESK_SUGGEST_MODEL = "openai/gpt-5.6-luna";
const DESK_QUESTION_LIMIT = 600;
// Desk ↔ Slack awareness: channel-pool sync TTL and caps, ask-run windows.
const DESK_SLACK_TTL_MS = 150_000;
const DESK_SLACK_CHANNELS_CAP = 8;
const DESK_SLACK_HISTORY_LIMIT = 40;
const DESK_SLACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DESK_SLACK_RELATED_CAP = 3;
const DESK_SLACK_TAIL_LINES = 8;
const DESK_SLACK_NAMES_CAP = 300;
const DESK_SLACK_POOL_MESSAGES_CAP = 500;
/** A research run younger than this blocks duplicates for the same conversation. */
const DESK_ASK_DEDUP_MS = 10 * 60 * 1000;
/** How long a finished "Ask Gera" answer stays visible on the conversation. */
const DESK_ASK_VISIBLE_MS = 7 * 24 * 60 * 60 * 1000;

type MemberRow = { email: string; role: string; display_name: string; added_at: number };
type AgentRow = {
  id: string;
  name: string;
  handle: string;
  emoji: string;
  instructions: string;
  model: string;
  access: string;
  secrets: string;
  created_at: number;
  updated_at: number;
};
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
type ScreenRow = {
  id: string;
  name: string;
  emoji: string;
  widgets: string;
  created_at: number;
  updated_at: number;
};
type ScreenChatRow = {
  id: string;
  screen_id: string;
  widget_id: string;
  email: string;
  author_kind: string;
  author_name: string;
  body: string;
  pending: number;
  created_at: number;
  updated_at: number;
};
type ScreenJobRow = {
  id: string;
  agent_id: string;
  screen_id: string;
  widget_id: string;
  email: string;
  placeholder_id: string;
  conversation_id: string;
  status: string;
  /** 'chat' = regular assistant turn; 'research' = an "Ask Gera" run. */
  kind: string;
};
type DeskReplyRow = {
  screen_id: string;
  id: string;
  conversation_id: string;
  admin_id: string;
  admin_name: string;
  customer_text: string;
  reply_text: string;
  response_ms: number;
  at: number;
  grade: string;
  grade_reason: string;
};
type DeskSuggestionRow = {
  id: string;
  screen_id: string;
  conversation_id: string;
  text: string;
  verdict: string;
  created_at: number;
};
type DeskLinkRow = {
  admin_id: string;
  email: string;
  admin_name: string;
  admin_email: string;
  linked_at: number;
};
type DeskCoachRow = { admin_id: string; text: string; updated_at: number };
/** Synced Slack pool for one screen — watched channels + recent messages. */
type DeskSlackPoolData = {
  team: string;
  teamUrl: string;
  channels: Array<{ id: string; name: string }>;
  /** Slack user-id → display name captured at sync time. */
  names: Record<string, string>;
  messages: DeskSlackMessage[];
  syncedAt: number;
};
/** One related Slack discussion on the wire (and in the suggest prompt). */
type DeskSlackThreadWire = {
  channelId: string;
  channelName: string;
  rootTs: string;
  permalink: string;
  matchedBy: "conversation" | "email" | "name";
  lastActivityTs: number;
  active: boolean;
  replyCount: number;
  lines: Array<{ author: string; text: string; ts: string }>;
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
};

function newId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

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
    github: typeof secrets.githubToken === "string" && secrets.githubToken.length > 0,
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
    slackApp: secrets.slackAppId ? { appId: secrets.slackAppId, team: secrets.slackTeam ?? "" } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseWidgets(raw: string): ScreenWidgetWire[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: ScreenWidgetWire[] = [];
    for (const item of parsed) {
      if (!isRecord(item) || typeof item.id !== "string" || !isScreenWidgetKind(item.kind)) {
        continue;
      }
      out.push({
        id: item.id,
        kind: item.kind,
        agentId: typeof item.agentId === "string" ? item.agentId : null,
        channelId: typeof item.channelId === "string" ? item.channelId : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function screenWire(row: ScreenRow): ProjectScreenWire {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    widgets: parseWidgets(row.widgets),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function screenChatWire(row: ScreenChatRow): ScreenChatMessageWire {
  return {
    id: row.id,
    kind: row.author_kind === "agent" ? "agent" : "user",
    authorName: row.author_name,
    body: row.body,
    pending: row.pending === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function messageWire(row: MessageRow): ProjectMessageWire {
  return {
    id: row.id,
    channelId: row.channel_id,
    rootId: row.root_id,
    kind: row.author_kind === "agent" ? "agent" : "user",
    author: row.author,
    authorName: row.author_name,
    body: row.body,
    pending: row.pending === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectStore extends DurableObject {
  private readonly workerEnv: ProjectStoreEnv;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.workerEnv = (env ?? {}) as ProjectStoreEnv;
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
        created_at INTEGER NOT NULL
      )
    `);
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
        return this.handlePageViewIngest(await request.text());
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
        return this.handleScreenUpsert(me, await request.json());
      }
      if (request.method === "POST" && path === "/screens/delete") {
        return this.handleScreenDelete(me, await request.json());
      }
      if (request.method === "POST" && path === "/intercom/inbox") {
        return this.handleIntercomInbox(await request.json());
      }
      if (request.method === "POST" && path === "/intercom/thread") {
        return this.handleIntercomThread(await request.json());
      }
      if (request.method === "POST" && path === "/intercom/details") {
        return this.handleIntercomDetails(me, await request.json());
      }
      if (request.method === "POST" && path === "/intercom/reply") {
        return this.handleIntercomReply(me, await request.json());
      }
      if (request.method === "POST" && path === "/intercom/mention-admins") {
        return this.handleIntercomMentionAdmins(await request.json());
      }
      if (request.method === "POST" && path === "/intercom/suggest") {
        return this.handleIntercomSuggest(await request.json());
      }
      if (request.method === "POST" && path === "/intercom/suggest/rate") {
        return this.handleSuggestRate(await request.json());
      }
      if (request.method === "POST" && path === "/intercom/action") {
        return this.handleIntercomAction(me, await request.json());
      }
      if (request.method === "POST" && path === "/intercom/ask-gera") {
        return this.handleAskGera(me, await request.json());
      }
      if (request.method === "POST" && path === "/intercom/stats") {
        return this.handleDeskStats(me, await request.json());
      }
      if (request.method === "POST" && path === "/intercom/stats/refresh") {
        return this.handleDeskStatsRefresh(me, await request.json());
      }
      if (request.method === "POST" && path === "/intercom/stats/link") {
        return this.handleDeskLink(me, await request.json());
      }
      if (request.method === "POST" && path === "/intercom/slack-related") {
        return this.handleDeskSlackRelated(await request.json());
      }
      if (request.method === "POST" && path === "/intercom/ask-status") {
        return this.handleAskStatus(await request.json());
      }
      if (request.method === "POST" && path === "/tracking/setup") {
        return this.handleTrackingSetup(me);
      }
      if (request.method === "GET" && path === "/screen-chat") {
        return this.handleScreenChatGet(me, url);
      }
      if (request.method === "POST" && path === "/screen-chat/send") {
        return this.handleScreenChatSend(me, await request.json());
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
          `SELECT id, channel_id, root_id, author_kind, author, author_name, body, pending, created_at, updated_at
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
          `SELECT id, channel_id, root_id, author_kind, author, author_name, body, pending, created_at, updated_at
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
          `SELECT id, channel_id, root_id, author_kind, author, author_name, body, pending, created_at, updated_at
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
    return json({ ok: true, email, role });
  }

  private handleAgentUpsert(me: MemberRow, body: unknown): Response {
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
    const secrets: AgentSecrets = existing ? parseSecrets(existing.secrets) : {};
    const incoming = isRecord(body.secrets) ? body.secrets : {};
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
    if (mcpPatch.action === "set") {
      if (mcpPatch.servers.length > 0) {
        secrets.mcpSelection = { owner: me.email, servers: mcpPatch.servers };
      } else {
        delete secrets.mcpSelection;
      }
    }

    const agentId = existing?.id ?? newId("a");
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
        JSON.stringify(secrets),
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
        JSON.stringify(secrets),
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

  private saveAgentSecrets(agentId: string, secrets: AgentSecrets): void {
    this.ctx.storage.sql.exec(
      "UPDATE agents SET secrets = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(secrets),
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

  private saveSlackConfig(config: StoredSlackConfig | null): void {
    const sql = this.ctx.storage.sql;
    if (!config) {
      sql.exec("DELETE FROM meta WHERE key = 'slack_config'");
      return;
    }
    sql.exec(
      "INSERT INTO meta (key, value) VALUES ('slack_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(config),
    );
  }

  /** Rotation result → stored pair (keeps the original connect timestamp). */
  private storeSlackRotation(rotation: SlackConfigRotation): void {
    const previous = this.loadSlackConfig();
    this.saveSlackConfig({
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
    const config = this.loadSlackConfig();
    if (!config) {
      return null;
    }
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
        this.saveSlackConfig(null);
      }
      throw error;
    }
    this.storeSlackRotation(rotation);
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
      this.saveSlackConfig(null);
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
      this.saveSlackConfig({
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
    this.saveSlackConfig(null);
    this.storeSlackRotation(rotation);
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
        this.storeSlackRotation(rotation);
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
    this.saveAgentSecrets(agent.id, secrets);

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
    const secrets = parseSecrets(agent.secrets);
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
    const secrets = parseSecrets(agent.secrets);
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
      JSON.stringify(secrets),
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
  private screenIntercomToken(screen: ScreenRow): { token: string } | { error: string } {
    const inbox = parseWidgets(screen.widgets).find((widget) => widget.kind === "intercom-inbox");
    if (!inbox?.agentId) {
      return { error: "This screen has no Intercom inbox widget." };
    }
    const agent = this.loadAgent(inbox.agentId);
    if (!agent) {
      return { error: "The agent powering this inbox was deleted — an admin must re-link the widget." };
    }
    const secrets = parseSecrets(agent.secrets);
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
  private screenSlackToken(screen: ScreenRow): { token: string } | { error: string } {
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
      const secrets = parseSecrets(agent.secrets);
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

  private handleScreenUpsert(me: MemberRow, body: unknown): Response {
    if (!canManageProject(this.memberRole(me))) {
      return json({ error: "admin_required" }, 403);
    }
    if (!isRecord(body)) {
      return json({ error: "invalid_body" }, 400);
    }
    const sql = this.ctx.storage.sql;
    const id = asStr(body.id);
    const existing = id ? this.loadScreen(id) : undefined;
    if (id && !existing) {
      return json({ error: "screen_not_found" }, 404);
    }
    if (!existing) {
      const count = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM screens").toArray()[0]?.n ?? 0;
      if (count >= MAX_SCREENS) {
        return json({ error: "too_many_screens", limit: MAX_SCREENS }, 400);
      }
    }
    const name = asStr(body.name).trim().slice(0, SCREEN_NAME_LIMIT);
    if (!name) {
      return json({ error: "invalid_name" }, 400);
    }
    const emoji = asStr(body.emoji).slice(0, 8);
    const agentIds = new Set(
      sql.exec<{ id: string }>("SELECT id FROM agents").toArray().map((row) => row.id),
    );
    const channelIds = new Set(
      sql.exec<{ id: string }>("SELECT id FROM channels").toArray().map((row) => row.id),
    );
    const checked = validateScreenWidgets(body.widgets, agentIds, channelIds);
    if (!checked.ok) {
      return json({ error: checked.error }, 400);
    }
    const now = Date.now();
    const screenId = existing?.id ?? newId("s");
    if (existing) {
      sql.exec(
        "UPDATE screens SET name = ?, emoji = ?, widgets = ?, updated_at = ? WHERE id = ?",
        name,
        emoji,
        JSON.stringify(checked.widgets),
        now,
        screenId,
      );
    } else {
      sql.exec(
        "INSERT INTO screens (id, name, emoji, widgets, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        screenId,
        name,
        emoji,
        JSON.stringify(checked.widgets),
        now,
        now,
      );
    }
    const row = this.loadScreen(screenId);
    return json({ ok: true, screen: row ? screenWire(row) : null });
  }

  private handleScreenDelete(me: MemberRow, body: unknown): Response {
    if (!canManageProject(this.memberRole(me))) {
      return json({ error: "admin_required" }, 403);
    }
    const id = isRecord(body) ? asStr(body.id) : "";
    if (!id) {
      return json({ error: "invalid_body" }, 400);
    }
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM screens WHERE id = ?", id);
    sql.exec("DELETE FROM screen_chat WHERE screen_id = ?", id);
    sql.exec("DELETE FROM screen_jobs WHERE screen_id = ?", id);
    sql.exec("DELETE FROM desk_suggestions WHERE screen_id = ?", id);
    sql.exec("DELETE FROM desk_suggest_cache WHERE screen_id = ?", id);
    sql.exec("DELETE FROM desk_replies WHERE screen_id = ?", id);
    sql.exec("DELETE FROM desk_transcripts WHERE screen_id = ?", id);
    sql.exec("DELETE FROM desk_slack_pool WHERE screen_id = ?", id);
    return json({ ok: true });
  }

  private async handleIntercomInbox(body: unknown): Promise<Response> {
    const record = isRecord(body) ? body : {};
    const screenId = asStr(record.screenId);
    const stateRaw = asStr(record.state);
    // Intercom's own inbox defaults to open conversations — so does the desk.
    const state: IntercomInboxState =
      stateRaw === "closed" || stateRaw === "snoozed" || stateRaw === "all" ? stateRaw : "open";
    const screen = screenId ? this.loadScreen(screenId) : undefined;
    if (!screen) {
      return json({ error: "screen_not_found" }, 404);
    }
    const resolved = this.screenIntercomToken(screen);
    if ("error" in resolved) {
      return json({ error: resolved.error }, 400);
    }
    try {
      const conversations = await fetchIntercomInboxData(resolved.token, 30, state);
      return json({ conversations, now: Date.now() });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Intercom request failed." }, 502);
    }
  }

  private async handleIntercomThread(body: unknown): Promise<Response> {
    const record = isRecord(body) ? body : {};
    const screenId = asStr(record.screenId);
    const conversationId = asStr(record.conversationId).slice(0, 64);
    const screen = screenId ? this.loadScreen(screenId) : undefined;
    if (!screen) {
      return json({ error: "screen_not_found" }, 404);
    }
    if (!conversationId) {
      return json({ error: "invalid_body" }, 400);
    }
    const resolved = this.screenIntercomToken(screen);
    if ("error" in resolved) {
      return json({ error: resolved.error }, 400);
    }
    try {
      const thread = await fetchIntercomThreadData(resolved.token, conversationId);
      return json({ thread, now: Date.now() });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Intercom request failed." }, 502);
    }
  }

  /** Right-panel payload: assignee/team, tags, contact profile, custom attributes. */
  private async handleIntercomDetails(me: MemberRow, body: unknown): Promise<Response> {
    const record = isRecord(body) ? body : {};
    const screenId = asStr(record.screenId);
    const conversationId = asStr(record.conversationId).slice(0, 64);
    const screen = screenId ? this.loadScreen(screenId) : undefined;
    if (!screen) {
      return json({ error: "screen_not_found" }, 404);
    }
    if (!conversationId) {
      return json({ error: "invalid_body" }, 400);
    }
    const resolved = this.screenIntercomToken(screen);
    if ("error" in resolved) {
      return json({ error: resolved.error }, 400);
    }
    try {
      const details = await fetchIntercomConversationDetails(resolved.token, conversationId);
      // Intercom's API keeps page views private — these are Gera's own
      // first-party views, matched to the contact by email / external id.
      const pageViews = this.contactPageViews(details.contact?.email ?? "", details.contact?.userId ?? "");
      return json({
        details,
        pageViews,
        tracking: this.trackingKey().length > 0,
        viewerIsAdmin: canManageProject(this.memberRole(me)),
        now: Date.now(),
      });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Intercom request failed." }, 502);
    }
  }

  // --- First-party page views ("Recent page views") -------------------------

  /** Write-only key for the public page-view beacon ("" until an admin sets it up). */
  private trackingKey(): string {
    return this.metaValue("pv_key");
  }

  /** Admin-only: returns the beacon key, creating it on first call. */
  private handleTrackingSetup(me: MemberRow): Response {
    if (!canManageProject(this.memberRole(me))) {
      return json({ error: "admin_required" }, 403);
    }
    let key = this.trackingKey();
    if (!key) {
      key = crypto.randomUUID().replace(/-/g, "");
      this.ctx.storage.sql.exec("INSERT INTO meta (key, value) VALUES ('pv_key', ?)", key);
    }
    return json({ key });
  }

  /**
   * Public beacon sink for the pv.js snippet. Rows are written under every
   * identity key (email + external user id) so the desk matches the Intercom
   * contact by either. Retention: 30 days, newest 40 per contact; same-URL
   * repeats within 15s collapse (SPA routers double-fire transitions).
   */
  private handlePageViewIngest(rawBody: string): Response {
    const configured = this.trackingKey();
    if (!configured) {
      return json({ error: "tracking_not_configured" }, 404);
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const payload = parsePageViewPayload(body);
    if (!payload) {
      return json({ error: "invalid_body" }, 400);
    }
    if (payload.key !== configured) {
      return json({ error: "forbidden" }, 403);
    }
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM desk_pageviews WHERE at < ?", Date.now() - PAGE_VIEW_RETENTION_MS);
    let stored = 0;
    for (const contactKey of pageViewContactKeys(payload.email, payload.userId)) {
      let previous = sql
        .exec<{ url: string; at: number }>(
          "SELECT url, at FROM desk_pageviews WHERE contact_key = ? ORDER BY at DESC LIMIT 1",
          contactKey,
        )
        .toArray()[0];
      for (const view of payload.views) {
        if (previous && previous.url === view.url && Math.abs(view.at - previous.at) < 15_000) {
          continue;
        }
        sql.exec(
          "INSERT INTO desk_pageviews (id, contact_key, url, title, at) VALUES (?, ?, ?, ?, ?)",
          newId("pv"),
          contactKey,
          view.url,
          view.title,
          view.at,
        );
        previous = { url: view.url, at: view.at };
        stored += 1;
      }
      sql.exec(
        `DELETE FROM desk_pageviews WHERE contact_key = ? AND id NOT IN (
           SELECT id FROM desk_pageviews WHERE contact_key = ? ORDER BY at DESC LIMIT ?
         )`,
        contactKey,
        contactKey,
        PAGE_VIEWS_PER_CONTACT,
      );
    }
    return json({ ok: true, stored });
  }

  /** Newest tracked views for one contact — matched by email or external id. */
  private contactPageViews(email: string, userId: string): DeskPageView[] {
    const keys = pageViewContactKeys(email, userId);
    if (keys.length === 0) {
      return [];
    }
    const sql = this.ctx.storage.sql;
    const rows = keys.flatMap((contactKey) =>
      sql
        .exec<{ url: string; title: string; at: number }>(
          "SELECT url, title, at FROM desk_pageviews WHERE contact_key = ? ORDER BY at DESC LIMIT 12",
          contactKey,
        )
        .toArray(),
    );
    const seen = new Set<string>();
    return rows
      .sort((a, b) => b.at - a.at)
      .filter((row) => {
        const signature = `${row.at}:${row.url}`;
        if (seen.has(signature)) {
          return false;
        }
        seen.add(signature);
        return true;
      })
      .slice(0, 12)
      .map((row) => ({ url: row.url, title: row.title, at: row.at }));
  }

  private async handleIntercomReply(me: MemberRow, body: unknown): Promise<Response> {
    const record = isRecord(body) ? body : {};
    const screenId = asStr(record.screenId);
    const conversationId = asStr(record.conversationId).slice(0, 64);
    const text = asStr(record.body).trim();
    const asNote = record.note === true;
    // @-mentions ride only with notes — name+id pairs picked in the composer.
    const mentions = (Array.isArray(record.mentions) ? record.mentions : [])
      .filter(isRecord)
      .map((item) => ({ id: asStr(item.id).slice(0, 40), name: asStr(item.name).slice(0, 100) }))
      .filter((item) => item.id.length > 0 && item.name.length > 0)
      .slice(0, 8);
    const screen = screenId ? this.loadScreen(screenId) : undefined;
    if (!screen) {
      return json({ error: "screen_not_found" }, 404);
    }
    if (!conversationId || text.length === 0 || text.length > MESSAGE_BODY_LIMIT) {
      return json({ error: "invalid_body", limit: MESSAGE_BODY_LIMIT }, 400);
    }
    const resolved = this.screenIntercomToken(screen);
    if ("error" in resolved) {
      return json({ error: resolved.error }, 400);
    }
    try {
      const result = await postIntercomReplyData(
        resolved.token,
        conversationId,
        text,
        asNote,
        asNote ? mentions : [],
      );
      console.log("screen intercom", asNote ? "note" : "reply", "by", this.memberRole(me));
      return json({ ok: true, admin: result.admin });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Intercom request failed." }, 502);
    }
  }

  /** Teammate directory for @-mentions in notes — anyone who can write notes sees it. */
  private async handleIntercomMentionAdmins(body: unknown): Promise<Response> {
    const record = isRecord(body) ? body : {};
    const screenId = asStr(record.screenId);
    const screen = screenId ? this.loadScreen(screenId) : undefined;
    if (!screen) {
      return json({ error: "screen_not_found" }, 404);
    }
    const resolved = this.screenIntercomToken(screen);
    if ("error" in resolved) {
      return json({ error: resolved.error }, 400);
    }
    try {
      return json({ admins: await listIntercomAdmins(resolved.token) });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Intercom request failed." }, 502);
    }
  }

  // --- Desk intelligence ----------------------------------------------------
  // Reply suggestions in a live-human voice (calibrated by 👍/👎 votes and the
  // team's own graded replies), snooze/close actions, "Ask Gera" research runs,
  // and human-teammate stats with on-demand LLM grading + coaching. All model
  // output is parsed strictly — unreadable payloads become honest errors.

  private deskAuthKey(): string {
    return this.workerEnv.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY ?? this.workerEnv.RORK_TOOLKIT_SECRET_KEY ?? "";
  }

  /** The inbox widget's agent picks the grading model; suggestions ride DESK_SUGGEST_MODEL. */
  private screenDeskModel(screen: ScreenRow): string {
    const inbox = parseWidgets(screen.widgets).find((widget) => widget.kind === "intercom-inbox");
    const agent = inbox?.agentId ? this.loadAgent(inbox.agentId) : undefined;
    return agent?.model || DEFAULT_CHAT_MODEL;
  }

  /** One plain completion for desk intelligence — no tools; suggestions run low effort, grading medium. */
  private async deskCompletion(
    modelId: string,
    messages: EngineMessage[],
    reasoningEffort: "low" | "medium" = "low",
  ): Promise<string> {
    const authKey = this.deskAuthKey();
    if (!authKey) {
      throw new Error("The backend has no AI key configured — ask the workspace admin.");
    }
    const result = await streamGatewayCompletion({
      authKey,
      modelId,
      reasoningEffort,
      messages,
      tools: [],
      handlers: { onText: () => undefined },
    });
    return result.content;
  }

  private async handleIntercomSuggest(body: unknown): Promise<Response> {
    const record = isRecord(body) ? body : {};
    const screenId = asStr(record.screenId);
    const conversationId = asStr(record.conversationId).slice(0, 64);
    const force = record.force === true;
    const screen = screenId ? this.loadScreen(screenId) : undefined;
    if (!screen) {
      return json({ error: "screen_not_found" }, 404);
    }
    if (!conversationId) {
      return json({ error: "invalid_body" }, 400);
    }
    const resolved = this.screenIntercomToken(screen);
    if ("error" in resolved) {
      return json({ error: resolved.error }, 400);
    }
    const sql = this.ctx.storage.sql;
    try {
      const thread = await fetchIntercomThreadData(resolved.token, conversationId);
      const lastPart = thread.parts[thread.parts.length - 1];
      if (!lastPart) {
        return json({ error: "This conversation has no readable messages to suggest from." }, 400);
      }
      if (!force) {
        const cached = sql
          .exec<{ last_part_id: string; payload: string; created_at: number }>(
            "SELECT last_part_id, payload, created_at FROM desk_suggest_cache WHERE screen_id = ? AND conversation_id = ?",
            screenId,
            conversationId,
          )
          .toArray()[0];
        if (
          cached &&
          cached.last_part_id === lastPart.id &&
          Date.now() - cached.created_at < DESK_SUGGEST_TTL_MS
        ) {
          return json({ ...(JSON.parse(cached.payload) as Record<string, unknown>), cached: true });
        }
      }
      const suggestionCols =
        "SELECT id, screen_id, conversation_id, text, verdict, created_at FROM desk_suggestions";
      const liked = sql
        .exec<DeskSuggestionRow>(
          `${suggestionCols} WHERE screen_id = ? AND verdict = 'up' ORDER BY created_at DESC LIMIT 6`,
          screenId,
        )
        .toArray();
      const disliked = sql
        .exec<DeskSuggestionRow>(
          `${suggestionCols} WHERE screen_id = ? AND verdict = 'down' ORDER BY created_at DESC LIMIT 6`,
          screenId,
        )
        .toArray();
      const teamGood = sql
        .exec<DeskReplyRow>(
          "SELECT screen_id, id, conversation_id, admin_id, admin_name, customer_text, reply_text, response_ms, at, grade, grade_reason FROM desk_replies WHERE screen_id = ? AND grade = 'good' ORDER BY at DESC LIMIT 6",
          screenId,
        )
        .toArray();
      const transcript = thread.parts.slice(-24).map((part) => {
        if (part.note) {
          return `Internal note by ${part.author}: ${capText(part.body, 500)}`;
        }
        if (part.role === "teammate") {
          return `${part.author} (teammate): ${capText(part.body, 500)}`;
        }
        if (part.role === "bot") {
          return `Bot: ${capText(part.body, 400)}`;
        }
        return `Customer (${part.author}): ${capText(part.body, 500)}`;
      });
      // Slack awareness: the team's own discussions about this case ride into
      // the prompt so drafts can wait for (or use) the internal outcome.
      let slackThreads: string[] = [];
      let slackLastTs = 0;
      const slackResolved = this.screenSlackToken(screen);
      if ("token" in slackResolved) {
        try {
          const { threads } = await this.deskSlackThreads(screen, slackResolved.token, {
            conversationId,
            email: thread.email,
            name: thread.author,
          });
          slackThreads = threads.map((item) =>
            buildSlackThreadBlock(
              {
                channelName: item.channelName,
                active: item.active,
                lastActivityTs: item.lastActivityTs,
                lines: item.lines,
              },
              Date.now(),
            ),
          );
          slackLastTs = threads.reduce((max, item) => Math.max(max, item.lastActivityTs), 0);
        } catch {
          // Slack being down must not break reply drafting — drafts go without it.
        }
      }
      const raw = await this.deskCompletion(
        DESK_SUGGEST_MODEL,
        buildSuggestMessages({
          customer: thread.author,
          state: thread.state,
          transcript,
          likedExamples: liked.map((row) => row.text),
          dislikedExamples: disliked.map((row) => row.text),
          teamExamples: teamGood.map((row) => row.reply_text),
          slackThreads,
        }),
      );
      const parsed = parseSuggestPayload(raw);
      if (!parsed) {
        return json({ error: "The model returned an unreadable suggestions payload — try again." }, 502);
      }
      const now = Date.now();
      const suggestions = parsed.replies.map((text) => ({ id: newId("sg"), text: capText(text, 900) }));
      for (const suggestion of suggestions) {
        sql.exec(
          "INSERT INTO desk_suggestions (id, screen_id, conversation_id, text, verdict, created_at) VALUES (?, ?, ?, ?, '', ?)",
          suggestion.id,
          screenId,
          conversationId,
          suggestion.text,
          now,
        );
      }
      sql.exec(
        `DELETE FROM desk_suggestions WHERE screen_id = ? AND id NOT IN (
           SELECT id FROM desk_suggestions WHERE screen_id = ? ORDER BY created_at DESC LIMIT ?
         )`,
        screenId,
        screenId,
        DESK_SUGGESTIONS_KEEP,
      );
      const wire = {
        suggestions,
        action: parsed.action,
        actionReason: parsed.actionReason,
        functionalityQuestion: parsed.functionalityQuestion,
        investigation: parsed.investigation,
        /** Seconds — the latest Slack activity these drafts were generated against. */
        slackLastTs,
        generatedAt: now,
      };
      sql.exec(
        "INSERT OR REPLACE INTO desk_suggest_cache (screen_id, conversation_id, last_part_id, payload, created_at) VALUES (?, ?, ?, ?, ?)",
        screenId,
        conversationId,
        lastPart.id,
        JSON.stringify(wire),
        now,
      );
      return json(wire);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Suggestion run failed." }, 502);
    }
  }

  /** 👍/👎 on one suggestion — the calibration memory future prompts learn from. */
  private handleSuggestRate(body: unknown): Response {
    const record = isRecord(body) ? body : {};
    const screenId = asStr(record.screenId);
    const suggestionId = asStr(record.suggestionId);
    const verdict = record.verdict === "up" || record.verdict === "down" ? record.verdict : "";
    if (!screenId || !suggestionId || !verdict) {
      return json({ error: "invalid_body" }, 400);
    }
    this.ctx.storage.sql.exec(
      "UPDATE desk_suggestions SET verdict = ? WHERE id = ? AND screen_id = ?",
      verdict,
      suggestionId,
      screenId,
    );
    return json({ ok: true });
  }

  /** Cached (short TTL) pool of the watched channels' recent messages for one screen. */
  private async deskSlackPool(screen: ScreenRow, token: string): Promise<DeskSlackPoolData> {
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<{ payload: string; created_at: number }>(
        "SELECT payload, created_at FROM desk_slack_pool WHERE screen_id = ?",
        screen.id,
      )
      .toArray()[0];
    if (row && Date.now() - row.created_at < DESK_SLACK_TTL_MS) {
      try {
        return JSON.parse(row.payload) as DeskSlackPoolData;
      } catch {
        // Corrupt cache — fall through to a fresh sync.
      }
    }
    const [identity, channels, names] = await Promise.all([
      verifySlackToken(token),
      listBotChannels(token),
      fetchSlackUserNames(token),
    ]);
    const watched = channels.slice(0, DESK_SLACK_CHANNELS_CAP);
    const oldest = Math.floor((Date.now() - DESK_SLACK_WINDOW_MS) / 1000);
    const messages: DeskSlackMessage[] = [];
    for (const channel of watched) {
      try {
        const history = await fetchChannelHistoryData(token, channel.id, oldest, DESK_SLACK_HISTORY_LIMIT);
        for (const message of history) {
          messages.push({
            channelId: channel.id,
            channelName: channel.name,
            ts: message.ts,
            threadTs: message.threadTs,
            author: names.get(message.authorId) ?? message.authorId,
            text: message.text,
            replyCount: message.replyCount,
            lastActivityTs: message.lastActivityTs,
          });
        }
      } catch {
        // One unreadable channel (bot kicked mid-sync, archived) must not
        // break the pool — the remaining channels still sync.
      }
    }
    const pool: DeskSlackPoolData = {
      team: identity.team,
      teamUrl: identity.url,
      channels: watched,
      names: Object.fromEntries([...names.entries()].slice(0, DESK_SLACK_NAMES_CAP)),
      messages: messages.slice(0, DESK_SLACK_POOL_MESSAGES_CAP),
      syncedAt: Date.now(),
    };
    sql.exec(
      "INSERT OR REPLACE INTO desk_slack_pool (screen_id, payload, created_at) VALUES (?, ?, ?)",
      screen.id,
      JSON.stringify(pool),
      pool.syncedAt,
    );
    return pool;
  }

  /** Pool → discussions matched to one conversation, with LIVE thread tails. */
  private async deskSlackThreads(
    screen: ScreenRow,
    token: string,
    target: { conversationId: string; email: string; name: string },
  ): Promise<{ pool: DeskSlackPoolData; threads: DeskSlackThreadWire[] }> {
    const pool = await this.deskSlackPool(screen, token);
    const matches = matchSlackDiscussions(
      { conversationId: target.conversationId, customerEmail: target.email, customerName: target.name },
      pool.messages,
      DESK_SLACK_RELATED_CAP,
    );
    const threads: DeskSlackThreadWire[] = [];
    for (const match of matches) {
      let tail: SlackThreadTail;
      try {
        tail = await fetchSlackThreadTailData(token, match.channelId, match.rootTs, DESK_SLACK_TAIL_LINES);
      } catch {
        continue; // Thread deleted or the bot was kicked — skip it honestly.
      }
      const lastActivityTs = Math.max(match.lastActivityTs, tail.lastTs);
      threads.push({
        channelId: match.channelId,
        channelName: match.channelName,
        rootTs: match.rootTs,
        permalink: slackPermalink(pool.teamUrl, match.channelId, match.rootTs),
        matchedBy: match.matchedBy,
        lastActivityTs,
        active: slackThreadActive(lastActivityTs, Date.now()),
        replyCount: tail.replyCount,
        lines: tail.lines.map((line) => ({
          author: pool.names[line.authorId] ?? line.authorId,
          text: capText(line.text, 400),
          ts: line.ts,
        })),
      });
    }
    threads.sort((a, b) => b.lastActivityTs - a.lastActivityTs);
    return { pool, threads };
  }

  /**
   * POST /intercom/slack-related — Slack awareness for one open conversation:
   * the watched channels (= the bot's memberships) and the internal
   * discussions that reference this customer/conversation, with live thread
   * tails. The desk polls this while a conversation is open — "wait, then
   * show the outcome" instead of double-investigating.
   */
  private async handleDeskSlackRelated(body: unknown): Promise<Response> {
    const record = isRecord(body) ? body : {};
    const screenId = asStr(record.screenId);
    const conversationId = asStr(record.conversationId).slice(0, 64);
    const screen = screenId ? this.loadScreen(screenId) : undefined;
    if (!screen) {
      return json({ error: "screen_not_found" }, 404);
    }
    if (!conversationId) {
      return json({ error: "invalid_body" }, 400);
    }
    const slack = this.screenSlackToken(screen);
    if ("error" in slack) {
      // No Slack agent on this screen is a normal setup — quiet null, honest reason.
      return json({ slack: null, reason: slack.error, now: Date.now() });
    }
    const intercom = this.screenIntercomToken(screen);
    if ("error" in intercom) {
      return json({ slack: null, reason: intercom.error, now: Date.now() });
    }
    try {
      const thread = await fetchIntercomThreadData(intercom.token, conversationId);
      const { pool, threads } = await this.deskSlackThreads(screen, slack.token, {
        conversationId,
        email: thread.email,
        name: thread.author,
      });
      return json({
        slack: { team: pool.team, channels: pool.channels, related: threads, syncedAt: pool.syncedAt },
        now: Date.now(),
      });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Slack sync failed." }, 502);
    }
  }

  /** Snooze (until tomorrow) or close the conversation as the connected admin. */
  private async handleIntercomAction(me: MemberRow, body: unknown): Promise<Response> {
    const record = isRecord(body) ? body : {};
    const screenId = asStr(record.screenId);
    const conversationId = asStr(record.conversationId).slice(0, 64);
    const action = record.action === "close" ? "close" : record.action === "snooze" ? "snooze" : null;
    const screen = screenId ? this.loadScreen(screenId) : undefined;
    if (!screen) {
      return json({ error: "screen_not_found" }, 404);
    }
    if (!conversationId || !action) {
      return json({ error: "invalid_body" }, 400);
    }
    const resolved = this.screenIntercomToken(screen);
    if ("error" in resolved) {
      return json({ error: resolved.error }, 400);
    }
    try {
      const snoozedUntil = action === "snooze" ? Math.floor(Date.now() / 1000) + 24 * 3600 : undefined;
      const result = await manageIntercomConversationData(resolved.token, conversationId, action, snoozedUntil);
      console.log("screen intercom", action, "by", this.memberRole(me));
      return json({ ok: true, state: result.state, admin: result.admin, snoozedUntil: snoozedUntil ?? 0 });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Intercom request failed." }, 502);
    }
  }

  /**
   * "Ask Gera" — forwards a customer's functionality question into the member's
   * PRIVATE assistant chat as a research run: the agent digs with its own tools
   * and, given GitHub write access, files a knowledge-base page in the repo.
   */
  private handleAskGera(me: MemberRow, body: unknown): Response {
    if (!isRecord(body)) {
      return json({ error: "invalid_body" }, 400);
    }
    const screenId = asStr(body.screenId);
    const widgetId = asStr(body.widgetId);
    const question = asStr(body.question).trim().slice(0, DESK_QUESTION_LIMIT);
    const conversationId = asStr(body.conversationId).slice(0, 64);
    const screen = screenId ? this.loadScreen(screenId) : undefined;
    if (!screen) {
      return json({ error: "screen_not_found" }, 404);
    }
    const widget = parseWidgets(screen.widgets).find(
      (item) => item.id === widgetId && item.kind === "agent-chat",
    );
    if (!widget?.agentId) {
      return json({ error: "widget_not_found" }, 404);
    }
    const agent = this.loadAgent(widget.agentId);
    if (!agent) {
      return json({ error: "agent_deleted" }, 404);
    }
    if (question.length === 0) {
      return json({ error: "invalid_body" }, 400);
    }
    const sql = this.ctx.storage.sql;
    // An investigation already running for this conversation is never
    // duplicated — the strip shows the running card and waits for the outcome.
    if (conversationId) {
      const running = sql
        .exec<{ id: string }>(
          `SELECT id FROM screen_jobs WHERE screen_id = ? AND conversation_id = ? AND kind = 'research'
             AND status IN ('queued', 'running') AND created_at > ? LIMIT 1`,
          screenId,
          conversationId,
          Date.now() - DESK_ASK_DEDUP_MS,
        )
        .toArray()[0];
      if (running) {
        return json({ ok: true, alreadyRunning: true, jobs: [] });
      }
    }
    const now = Date.now();
    const messageId = newId("m");
    const authorName = me.display_name || me.email.split("@")[0];
    sql.exec(
      `INSERT INTO screen_chat (id, screen_id, widget_id, email, author_kind, author_name, body, pending, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'user', ?, ?, 0, ?, ?)`,
      messageId,
      screenId,
      widgetId,
      me.email,
      authorName,
      `Ask Gera: ${question}`,
      now,
      now,
    );
    const placeholderId = newId("m");
    sql.exec(
      `INSERT INTO screen_chat (id, screen_id, widget_id, email, author_kind, author_name, body, pending, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'agent', ?, '', 1, ?, ?)`,
      placeholderId,
      screenId,
      widgetId,
      me.email,
      agent.name,
      now + 1,
      now + 1,
    );
    const jobId = newId("j");
    sql.exec(
      `INSERT INTO screen_jobs (id, agent_id, screen_id, widget_id, email, placeholder_id, conversation_id, status, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'research', ?)`,
      jobId,
      agent.id,
      screenId,
      widgetId,
      me.email,
      placeholderId,
      conversationId,
      now,
    );
    sql.exec(
      `DELETE FROM screen_chat WHERE screen_id = ? AND widget_id = ? AND email = ? AND id NOT IN (
         SELECT id FROM screen_chat WHERE screen_id = ? AND widget_id = ? AND email = ?
         ORDER BY created_at DESC LIMIT ?
       )`,
      screenId,
      widgetId,
      me.email,
      screenId,
      widgetId,
      me.email,
      SCREEN_CHAT_KEEP,
    );
    return json({ ok: true, id: messageId, jobs: [jobId] });
  }

  /**
   * POST /intercom/ask-status — the latest "Ask Gera" research for one
   * conversation, visible to EVERY member: an investigation someone already
   * started is never duplicated — the desk waits and then shows the outcome.
   */
  private handleAskStatus(body: unknown): Response {
    const record = isRecord(body) ? body : {};
    const screenId = asStr(record.screenId);
    const conversationId = asStr(record.conversationId).slice(0, 64);
    if (!screenId || !conversationId || !this.loadScreen(screenId)) {
      return json({ error: "screen_not_found" }, 404);
    }
    const sql = this.ctx.storage.sql;
    const job = sql
      .exec<ScreenJobRow & { created_at: number }>(
        `SELECT id, agent_id, screen_id, widget_id, email, placeholder_id, conversation_id, status, kind, created_at
         FROM screen_jobs WHERE screen_id = ? AND conversation_id = ? AND kind = 'research'
         ORDER BY created_at DESC LIMIT 1`,
        screenId,
        conversationId,
      )
      .toArray()[0];
    if (!job || Date.now() - job.created_at > DESK_ASK_VISIBLE_MS) {
      return json({ ask: null });
    }
    const placeholder = sql
      .exec<ScreenChatRow>(
        `SELECT id, screen_id, widget_id, email, author_kind, author_name, body, pending, created_at, updated_at
         FROM screen_chat WHERE id = ?`,
        job.placeholder_id,
      )
      .toArray()[0];
    if (!placeholder) {
      // The private chat pruned the rows — nothing readable to show anymore.
      return json({ ask: null });
    }
    // The question row rides exactly 1ms before its placeholder (see handleAskGera).
    const questionRow = sql
      .exec<{ body: string }>(
        "SELECT body FROM screen_chat WHERE screen_id = ? AND widget_id = ? AND email = ? AND author_kind = 'user' AND created_at = ?",
        screenId,
        job.widget_id,
        job.email,
        placeholder.created_at - 1,
      )
      .toArray()[0];
    const member = this.loadMember(job.email);
    const status =
      job.status === "error"
        ? "error"
        : placeholder.pending === 1 || job.status === "queued" || job.status === "running"
          ? "running"
          : "done";
    return json({
      ask: {
        status,
        question: (questionRow?.body ?? "").replace(/^Ask Gera:\s*/i, ""),
        answer: placeholder.pending === 1 ? "" : placeholder.body,
        by: member?.display_name || job.email.split("@")[0],
        at: job.created_at,
      },
    });
  }

  /** Aggregates the harvested reply log into per-teammate performance cards. */
  private deskStatsPayload(me: MemberRow, screen: ScreenRow): Record<string, unknown> {
    const sql = this.ctx.storage.sql;
    const isAdmin = canManageProject(this.memberRole(me));
    const replies = sql
      .exec<DeskReplyRow>(
        "SELECT screen_id, id, conversation_id, admin_id, admin_name, customer_text, reply_text, response_ms, at, grade, grade_reason FROM desk_replies WHERE screen_id = ? ORDER BY at DESC LIMIT ?",
        screen.id,
        DESK_REPLIES_KEEP,
      )
      .toArray();
    const links = new Map(
      sql
        .exec<DeskLinkRow>("SELECT admin_id, email, admin_name, admin_email, linked_at FROM desk_links")
        .toArray()
        .map((row) => [row.admin_id, row]),
    );
    const coach = new Map(
      sql
        .exec<DeskCoachRow>("SELECT admin_id, text, updated_at FROM desk_coach")
        .toArray()
        .map((row) => [row.admin_id, row.text]),
    );
    const byAdmin = new Map<string, DeskReplyRow[]>();
    for (const row of replies) {
      const list = byAdmin.get(row.admin_id) ?? [];
      list.push(row);
      byAdmin.set(row.admin_id, list);
    }
    const teammates = [...byAdmin.entries()]
      .map(([adminId, rows]) => {
        const times = rows
          .map((row) => row.response_ms)
          .filter((ms) => ms > 0)
          .sort((a, b) => a - b);
        const good = rows.filter((row) => row.grade === "good").length;
        const bad = rows.filter((row) => row.grade === "bad").length;
        const link = links.get(adminId);
        return {
          adminId,
          name: rows[0]?.admin_name || link?.admin_name || `Admin #${adminId}`,
          linkedEmail: link?.email ?? "",
          replies: rows.length,
          medianResponseMs: times.length > 0 ? times[Math.floor(times.length / 2)] : 0,
          good,
          bad,
          ungraded: rows.length - good - bad,
          lastAt: rows[0]?.at ?? 0,
          coaching: coach.get(adminId) ?? "",
          examples: rows
            .filter((row) => row.grade !== "")
            .slice(0, 6)
            .map((row) => ({
              customer: row.customer_text,
              reply: row.reply_text,
              grade: row.grade,
              reason: row.grade_reason,
              at: row.at,
              responseMs: row.response_ms,
            })),
        };
      })
      .sort((a, b) => b.replies - a.replies);
    // Members see only their own linked card — grades are a coaching tool,
    // not a public scoreboard; admins see the whole team.
    const visible = isAdmin ? teammates : teammates.filter((teammate) => teammate.linkedEmail === me.email);
    const payload: Record<string, unknown> = {
      isAdmin,
      teammates: visible,
      totalReplies: replies.length,
      ungraded: replies.filter((row) => row.grade === "").length,
      now: Date.now(),
    };
    if (isAdmin) {
      payload.members = sql
        .exec<MemberRow>("SELECT email, role, display_name, added_at FROM members")
        .toArray()
        .map((row) => ({ email: row.email, name: row.display_name || row.email.split("@")[0] }));
    }
    return payload;
  }

  private async handleDeskStats(me: MemberRow, body: unknown): Promise<Response> {
    const record = isRecord(body) ? body : {};
    const screenId = asStr(record.screenId);
    const screen = screenId ? this.loadScreen(screenId) : undefined;
    if (!screen) {
      return json({ error: "screen_not_found" }, 404);
    }
    const payload = this.deskStatsPayload(me, screen);
    if (payload.isAdmin === true) {
      // Admins also get the Intercom teammate directory for manual linking.
      const resolved = this.screenIntercomToken(screen);
      if ("token" in resolved) {
        try {
          payload.intercomAdmins = await listIntercomAdmins(resolved.token);
        } catch {
          payload.intercomAdmins = [];
        }
      } else {
        payload.intercomAdmins = [];
      }
    }
    return json(payload);
  }

  /**
   * Admin-triggered stats pass: harvest the latest teammate replies AND full
   * conversation transcripts from Intercom, auto-link admins to members by
   * matching email, grade up to DESK_GRADE_BATCH ungraded replies in ONE
   * model call — grouped by conversation so every reply is judged inside its
   * whole transcript. On demand only — no cron, no silent background spend.
   */
  private async handleDeskStatsRefresh(me: MemberRow, body: unknown): Promise<Response> {
    if (!canManageProject(this.memberRole(me))) {
      return json({ error: "admin_required" }, 403);
    }
    const record = isRecord(body) ? body : {};
    const screenId = asStr(record.screenId);
    const screen = screenId ? this.loadScreen(screenId) : undefined;
    if (!screen) {
      return json({ error: "screen_not_found" }, 404);
    }
    const resolved = this.screenIntercomToken(screen);
    if ("error" in resolved) {
      return json({ error: resolved.error }, 400);
    }
    const sql = this.ctx.storage.sql;
    try {
      const harvest = await harvestIntercomReplyPairs(resolved.token, 20);
      const pairs = harvest.replies;
      const countRows = (): number =>
        sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM desk_replies WHERE screen_id = ?", screen.id)
          .toArray()[0]?.n ?? 0;
      const before = countRows();
      for (const pair of pairs) {
        sql.exec(
          `INSERT OR IGNORE INTO desk_replies (screen_id, id, conversation_id, admin_id, admin_name, customer_text, reply_text, response_ms, at, grade, grade_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '')`,
          screen.id,
          pair.id,
          pair.conversationId,
          pair.adminId,
          pair.adminName,
          capText(pair.customerText, 600),
          capText(pair.replyText, 900),
          pair.responseMs,
          pair.at,
        );
      }
      const added = countRows() - before;
      // Refresh the grading context: one full transcript per harvested conversation.
      for (const item of harvest.transcripts) {
        sql.exec(
          "INSERT OR REPLACE INTO desk_transcripts (screen_id, conversation_id, transcript, updated_at) VALUES (?, ?, ?, ?)",
          screen.id,
          item.conversationId,
          item.transcript,
          Date.now(),
        );
      }
      sql.exec(
        `DELETE FROM desk_replies WHERE screen_id = ? AND id NOT IN (
           SELECT id FROM desk_replies WHERE screen_id = ? ORDER BY at DESC LIMIT ?
         )`,
        screen.id,
        screen.id,
        DESK_REPLIES_KEEP,
      );
      sql.exec(
        `DELETE FROM desk_transcripts WHERE screen_id = ? AND conversation_id NOT IN (
           SELECT DISTINCT conversation_id FROM desk_replies WHERE screen_id = ?
         )`,
        screen.id,
        screen.id,
      );

      // Auto-link Intercom admins to Gera members when emails match.
      let intercomAdmins: IntercomAdminLite[] = [];
      try {
        intercomAdmins = await listIntercomAdmins(resolved.token);
      } catch {
        intercomAdmins = [];
      }
      const memberEmails = new Set(
        sql.exec<{ email: string }>("SELECT email FROM members").toArray().map((row) => row.email),
      );
      for (const admin of intercomAdmins) {
        const email = admin.email.trim().toLowerCase();
        const existing = sql
          .exec<DeskLinkRow>(
            "SELECT admin_id, email, admin_name, admin_email, linked_at FROM desk_links WHERE admin_id = ?",
            admin.id,
          )
          .toArray()[0];
        if (existing) {
          sql.exec(
            "UPDATE desk_links SET admin_name = ?, admin_email = ? WHERE admin_id = ?",
            admin.name,
            admin.email,
            admin.id,
          );
          continue;
        }
        if (email && memberEmails.has(email)) {
          sql.exec(
            "INSERT INTO desk_links (admin_id, email, admin_name, admin_email, linked_at) VALUES (?, ?, ?, ?, ?)",
            admin.id,
            email,
            admin.name,
            admin.email,
            Date.now(),
          );
        }
      }

      // Grade the newest ungraded replies + refresh coaching — one model call.
      let graded = 0;
      let gradeError = "";
      const ungraded = sql
        .exec<DeskReplyRow>(
          "SELECT screen_id, id, conversation_id, admin_id, admin_name, customer_text, reply_text, response_ms, at, grade, grade_reason FROM desk_replies WHERE screen_id = ? AND grade = '' ORDER BY at DESC LIMIT ?",
          screen.id,
          DESK_GRADE_BATCH,
        )
        .toArray();
      if (ungraded.length > 0) {
        try {
          // Grade every reply INSIDE its conversation: group the batch by
          // conversation and hand the model the full stored transcript.
          const byConversation = new Map<string, DeskReplyRow[]>();
          for (const row of ungraded) {
            const group = byConversation.get(row.conversation_id) ?? [];
            group.push(row);
            byConversation.set(row.conversation_id, group);
          }
          const conversations: GradePromptInput["conversations"] = [];
          const orphans: GradePromptInput["orphans"] = [];
          for (const [conversationId, rows] of byConversation) {
            const ordered = rows.slice().sort((a, b) => a.at - b.at);
            const transcript =
              sql
                .exec<{ transcript: string }>(
                  "SELECT transcript FROM desk_transcripts WHERE screen_id = ? AND conversation_id = ?",
                  screen.id,
                  conversationId,
                )
                .toArray()[0]?.transcript ?? "";
            if (transcript) {
              conversations.push({
                conversationId,
                transcript,
                replies: ordered.map((row) => ({
                  id: row.id,
                  adminId: row.admin_id,
                  adminName: row.admin_name,
                  responseMs: row.response_ms,
                })),
              });
            } else {
              for (const row of ordered) {
                orphans.push({
                  id: row.id,
                  adminId: row.admin_id,
                  adminName: row.admin_name,
                  responseMs: row.response_ms,
                  customerText: row.customer_text,
                  replyText: row.reply_text,
                });
              }
            }
          }
          const raw = await this.deskCompletion(
            this.screenDeskModel(screen),
            buildGradeMessages({ conversations, orphans }),
            "medium",
          );
          const parsed = parseGradePayload(raw);
          if (!parsed) {
            gradeError = "The model returned an unreadable grading payload — run it again.";
          } else {
            const known = new Set(ungraded.map((row) => row.id));
            for (const grade of parsed.grades) {
              if (!known.has(grade.id)) {
                continue;
              }
              sql.exec(
                "UPDATE desk_replies SET grade = ?, grade_reason = ? WHERE screen_id = ? AND id = ?",
                grade.verdict,
                capText(grade.reason, 300),
                screen.id,
                grade.id,
              );
              graded += 1;
            }
            const adminsInBatch = new Set(ungraded.map((row) => row.admin_id));
            for (const entry of parsed.coaching) {
              if (!adminsInBatch.has(entry.adminId)) {
                continue;
              }
              sql.exec(
                "INSERT OR REPLACE INTO desk_coach (admin_id, text, updated_at) VALUES (?, ?, ?)",
                entry.adminId,
                capText(entry.text, 900),
                Date.now(),
              );
            }
          }
        } catch (error) {
          gradeError = error instanceof Error ? error.message : "Grading run failed.";
        }
      }
      const payload = this.deskStatsPayload(me, screen);
      payload.intercomAdmins = intercomAdmins;
      payload.collected = pairs.length;
      payload.added = added;
      payload.graded = graded;
      if (gradeError) {
        payload.gradeError = gradeError;
      }
      return json(payload);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Intercom request failed." }, 502);
    }
  }

  /** Manual Intercom-admin ↔ Gera-member link; empty email unlinks. */
  private handleDeskLink(me: MemberRow, body: unknown): Response {
    if (!canManageProject(this.memberRole(me))) {
      return json({ error: "admin_required" }, 403);
    }
    const record = isRecord(body) ? body : {};
    const adminId = asStr(record.adminId).slice(0, 64);
    const email = asStr(record.email).trim().toLowerCase();
    if (!adminId) {
      return json({ error: "invalid_body" }, 400);
    }
    const sql = this.ctx.storage.sql;
    if (!email) {
      sql.exec("DELETE FROM desk_links WHERE admin_id = ?", adminId);
      return json({ ok: true, linked: false });
    }
    if (!this.loadMember(email)) {
      return json({ error: "not_a_member" }, 400);
    }
    sql.exec(
      "INSERT OR REPLACE INTO desk_links (admin_id, email, admin_name, admin_email, linked_at) VALUES (?, ?, ?, ?, ?)",
      adminId,
      email,
      asStr(record.adminName).slice(0, 120),
      asStr(record.adminEmail).slice(0, 200),
      Date.now(),
    );
    return json({ ok: true, linked: true });
  }

  private handleScreenChatGet(me: MemberRow, url: URL): Response {
    const screenId = url.searchParams.get("screen") ?? "";
    const widgetId = url.searchParams.get("widget") ?? "";
    if (!screenId || !widgetId || !this.loadScreen(screenId)) {
      return json({ error: "screen_not_found" }, 404);
    }
    const rows = this.ctx.storage.sql
      .exec<ScreenChatRow>(
        `SELECT id, screen_id, widget_id, email, author_kind, author_name, body, pending, created_at, updated_at
         FROM screen_chat WHERE screen_id = ? AND widget_id = ? AND email = ?
         ORDER BY created_at DESC LIMIT ?`,
        screenId,
        widgetId,
        me.email,
        SCREEN_CHAT_KEEP,
      )
      .toArray()
      .reverse();
    return json({ messages: rows.map(screenChatWire), now: Date.now() });
  }

  private handleScreenChatSend(me: MemberRow, body: unknown): Response {
    if (!isRecord(body)) {
      return json({ error: "invalid_body" }, 400);
    }
    const screenId = asStr(body.screenId);
    const widgetId = asStr(body.widgetId);
    const text = asStr(body.body).trim();
    const conversationId = asStr(body.conversationId).slice(0, 64);
    const screen = screenId ? this.loadScreen(screenId) : undefined;
    if (!screen) {
      return json({ error: "screen_not_found" }, 404);
    }
    const widget = parseWidgets(screen.widgets).find(
      (item) => item.id === widgetId && item.kind === "agent-chat",
    );
    if (!widget?.agentId) {
      return json({ error: "widget_not_found" }, 404);
    }
    const agent = this.loadAgent(widget.agentId);
    if (!agent) {
      return json({ error: "agent_deleted" }, 404);
    }
    if (text.length === 0 || text.length > MESSAGE_BODY_LIMIT) {
      return json({ error: "invalid_message", limit: MESSAGE_BODY_LIMIT }, 400);
    }
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const messageId = newId("m");
    const authorName = me.display_name || me.email.split("@")[0];
    sql.exec(
      `INSERT INTO screen_chat (id, screen_id, widget_id, email, author_kind, author_name, body, pending, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'user', ?, ?, 0, ?, ?)`,
      messageId,
      screenId,
      widgetId,
      me.email,
      authorName,
      text,
      now,
      now,
    );
    const placeholderId = newId("m");
    sql.exec(
      `INSERT INTO screen_chat (id, screen_id, widget_id, email, author_kind, author_name, body, pending, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'agent', ?, '', 1, ?, ?)`,
      placeholderId,
      screenId,
      widgetId,
      me.email,
      agent.name,
      now + 1,
      now + 1,
    );
    const jobId = newId("j");
    sql.exec(
      `INSERT INTO screen_jobs (id, agent_id, screen_id, widget_id, email, placeholder_id, conversation_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      jobId,
      agent.id,
      screenId,
      widgetId,
      me.email,
      placeholderId,
      conversationId,
      now,
    );
    // Bound the private desk chat — oldest rows fall off past the cap.
    sql.exec(
      `DELETE FROM screen_chat WHERE screen_id = ? AND widget_id = ? AND email = ? AND id NOT IN (
         SELECT id FROM screen_chat WHERE screen_id = ? AND widget_id = ? AND email = ?
         ORDER BY created_at DESC LIMIT ?
       )`,
      screenId,
      widgetId,
      me.email,
      screenId,
      widgetId,
      me.email,
      SCREEN_CHAT_KEEP,
    );
    return json({ ok: true, id: messageId, jobs: [jobId] });
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
      await this.runAgentJob(job);
      sql.exec("UPDATE jobs SET status = 'done' WHERE id = ?", jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "run failed";
      console.error("project agent run failed", job.agent_id, message);
      this.finishPlaceholder(job.placeholder_id, `⚠️ Agent run failed: ${capText(message, 400)}`);
      sql.exec("UPDATE jobs SET status = 'error' WHERE id = ?", jobId);
    }
    return json({ ok: true });
  }

  private finishPlaceholder(placeholderId: string, text: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE messages SET body = ?, pending = 0, updated_at = ? WHERE id = ?",
      capText(text, AGENT_REPLY_LIMIT),
      Date.now(),
      placeholderId,
    );
  }

  /**
   * Access + stored secrets → engine tool defs + native/MCP routes for one
   * run. External MCP servers connect live (in parallel) — `mcpNote` reports
   * per-server status honestly for the system prompt ("" when none).
   */
  private async buildAgentToolset(agent: AgentRow): Promise<{
    tools: EngineToolDef[];
    routes: Map<string, McpRoute>;
    plan: AgentToolPlan;
    access: AgentAccess;
    mcpNote: string;
  }> {
    const access = normalizeAccess(JSON.parse(agent.access || "{}") as unknown);
    const secrets = parseSecrets(agent.secrets);
    const selection = access.mcp ? secrets.mcpSelection : undefined;
    const selectionRefs = selection?.servers ?? [];
    const plan = planAgentTools(access, secretFlags(secrets), selectionRefs.length);
    const tools: EngineToolDef[] = [
      ...builtinToolDefs({
        web_search: plan.webEnabled,
        fetch_url: plan.webEnabled,
        selfsurf: false,
        generate_image: false,
        generate_video: false,
        generate_audio: false,
      }),
    ];
    const routes = new Map<string, McpRoute>();
    for (const planned of plan.native) {
      const token =
        planned.kind === "github"
          ? secrets.githubToken ?? ""
          : planned.kind === "intercom"
            ? secrets.intercomToken ?? ""
            : secrets.slackToken ?? "";
      if (!token) {
        continue;
      }
      routes.set(planned.fnName, {
        type: "native",
        kind: planned.kind,
        auth: planned.kind === "github" ? `Bearer ${token}` : token,
        toolName: planned.toolName,
        serverName: planned.kind,
      });
      tools.push({
        type: "function",
        function: {
          name: planned.fnName,
          description: `[${planned.kind}] ${planned.description}`.slice(0, 1_000),
          parameters: planned.inputSchema,
        },
      });
    }

    let mcpNote = "";
    if (selection && selectionRefs.length > 0) {
      const noteLines: string[] = [];
      const resolved = await this.resolveOwnerMcp(selection);
      if (!resolved.ok) {
        for (const ref of selectionRefs) {
          noteLines.push(
            `- "${ref.name}": unavailable (${capText(resolved.error, 160)}) — its tools are missing this run; say so if they are needed.`,
          );
        }
      } else {
        const byId = new Map(resolved.servers.map((server) => [server.id, server] as const));
        const tryConnect = async (
          ref: AgentMcpServerRef,
          server: CloudMcpServer,
        ): Promise<McpConnectAttempt> => {
          try {
            return { ref, server, connection: await connectCloudMcp(server) };
          } catch (error) {
            return { ref, server, failure: error instanceof Error ? error.message : "connect failed" };
          }
        };
        const attempts = await Promise.all(
          selectionRefs.map(async (ref): Promise<McpConnectAttempt> => {
            const server = byId.get(ref.id);
            if (!server) {
              return {
                ref,
                failure: `not among ${selection.owner}'s connected servers anymore — reconnect it on the MCP page`,
              };
            }
            const first = await tryConnect(ref, server);
            // A rejected sign-in gets one forced refresh through the owner's
            // account (mirrors cloud automations), then a second attempt.
            if ("failure" in first && server.oauth && /auth rejected/i.test(first.failure)) {
              const forced = await this.resolveOwnerMcp(selection, [ref.id]);
              const fresh = forced.ok
                ? forced.servers.find((candidate) => candidate.id === ref.id)
                : undefined;
              if (fresh) {
                return tryConnect(ref, fresh);
              }
            }
            return first;
          }),
        );
        for (const attempt of attempts) {
          if ("failure" in attempt) {
            noteLines.push(
              `- "${attempt.ref.name}": connection FAILED (${capText(attempt.failure, 200)}) — its tools are unavailable this run; say so if they are needed.`,
            );
            continue;
          }
          let added = 0;
          for (const tool of attempt.connection.tools) {
            if (routes.size >= AGENT_TOOL_CAP) {
              break;
            }
            const fnName = cloudMcpFunctionName(attempt.ref.id, tool.name);
            if (routes.has(fnName)) {
              continue;
            }
            routes.set(fnName, {
              type: "mcp",
              session: attempt.connection.session,
              toolName: tool.name,
              serverName: attempt.ref.name,
            });
            tools.push({
              type: "function",
              function: {
                name: fnName,
                description: `[MCP:${attempt.ref.name}] ${tool.description}`.slice(0, 1_000),
                parameters: tool.inputSchema,
              },
            });
            added += 1;
          }
          noteLines.push(
            `- "${attempt.ref.name}": connected — ${added} tools available (mcp_* functions).`,
          );
        }
      }
      mcpNote = `\nExternal MCP servers (linked through ${selection.owner}'s account):\n${noteLines.join("\n")}`;
    }
    return { tools, routes, plan, access, mcpNote };
  }

  /**
   * Resolves the agent's linked MCP servers through the linking admin's
   * account shard — the exact pipeline cloud automations use. Keys and
   * sign-ins stay on that account; expiring sign-ins refresh there, and
   * `force` re-redeems a grant after an auth-rejected connect.
   */
  private async resolveOwnerMcp(
    selection: AgentMcpSelection,
    force?: string[],
  ): Promise<{ ok: true; servers: CloudMcpServer[] } | { ok: false; error: string }> {
    const doBinding = this.workerEnv.DO;
    if (!doBinding) {
      return { ok: false, error: "backend misconfigured — no shard binding" };
    }
    try {
      const headers = new Headers();
      headers.set("X-Rork-DO-Class", "ChatStore");
      headers.set("X-Rork-DO-Id", chatShardId(selection.owner));
      headers.set("X-Gera-Email", encodeURIComponent(selection.owner));
      headers.set("Content-Type", "application/json");
      const response = await doBinding.fetch(
        new Request("https://gera.internal/mcp/resolve", {
          method: "POST",
          headers,
          body: JSON.stringify({
            ids: selection.servers.map((server) => server.id),
            ...(force && force.length > 0 ? { force } : {}),
          }),
        }),
      );
      if (response.status === 428) {
        return { ok: false, error: `${selection.owner}'s account has not synced to the server yet` };
      }
      if (!response.ok) {
        return { ok: false, error: `${selection.owner}'s account shard answered ${response.status}` };
      }
      const data = (await response.json().catch(() => null)) as { servers?: unknown } | null;
      const rawList = data && Array.isArray(data.servers) ? data.servers : [];
      const servers: CloudMcpServer[] = [];
      for (const raw of rawList) {
        const server = normalizeCloudMcpServer(raw);
        if (server) {
          servers.push(server);
        }
      }
      return { ok: true, servers };
    } catch (error) {
      console.error("agent mcp resolve failed:", error instanceof Error ? error.message : "unknown");
      return { ok: false, error: "could not reach the owner's account shard" };
    }
  }

  private async runAgentJob(job: JobRow): Promise<void> {
    const sql = this.ctx.storage.sql;
    const agent = this.loadAgent(job.agent_id);
    if (!agent) {
      this.finishPlaceholder(job.placeholder_id, "This agent was deleted before it could reply.");
      return;
    }
    const authKey =
      this.workerEnv.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY ?? this.workerEnv.RORK_TOOLKIT_SECRET_KEY ?? "";
    if (!authKey) {
      this.finishPlaceholder(job.placeholder_id, "⚠️ The backend has no AI key configured — ask the workspace admin.");
      return;
    }
    const channel = sql
      .exec<ChannelRow>("SELECT id, name, topic, created_at FROM channels WHERE id = ?", job.channel_id)
      .toArray()[0];

    const { tools, routes, plan, access, mcpNote } = await this.buildAgentToolset(agent);

    // Thread transcript: root + settled replies, oldest first, capped.
    const threadRows = sql
      .exec<MessageRow>(
        `SELECT id, channel_id, root_id, author_kind, author, author_name, body, pending, created_at, updated_at
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

    const requester = threadRows.length > 0 ? threadRows[threadRows.length - 1].author_name : job.requested_by;
    const apiMessages: EngineMessage[] = [
      { role: "system", content: system },
      {
        role: "user",
        content: `Thread transcript:\n\n${transcript || "(empty thread)"}\n\n---\nYou were mentioned by ${requester} in the latest message above. Reply to the thread now.`,
      },
    ];

    const ledger = createSourceLedger();
    const toolCtx: ServerToolContext = {
      authKey,
      ledger,
      surf: createServerSurfSession(),
      mcpRoutes: routes.size > 0 ? routes : null,
    };
    const result = await runEngineTurn({
      authKey,
      modelId: agent.model || DEFAULT_CHAT_MODEL,
      apiMessages,
      tools,
      executeTool: (name, argsJson) => executeServerTool(name, argsJson, toolCtx),
      deadlineAt: Date.now() + AGENT_RUN_BUDGET_MS,
      handlers: { onText: () => undefined },
    });

    const sources = ledger.list().slice(0, SOURCES_APPENDIX_CAP);
    const sourcesBlock =
      sources.length > 0
        ? `\n\n---\nSources:\n${sources.map((source, index) => `[${index + 1}] ${source.title === source.url ? source.url : `${source.title} — ${source.url}`}`).join("\n")}`
        : "";
    const content = result.content.trim().length > 0 ? result.content : "(no output)";
    this.finishPlaceholder(job.placeholder_id, `${content}${sourcesBlock}`);
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
      await this.runScreenJob(job);
      sql.exec("UPDATE screen_jobs SET status = 'done' WHERE id = ?", jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "run failed";
      console.error("screen assistant run failed", job.agent_id, message);
      this.finishScreenPlaceholder(job.placeholder_id, `⚠️ Assistant run failed: ${capText(message, 400)}`);
      sql.exec("UPDATE screen_jobs SET status = 'error' WHERE id = ?", jobId);
    }
    return json({ ok: true });
  }

  private finishScreenPlaceholder(placeholderId: string, text: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE screen_chat SET body = ?, pending = 0, updated_at = ? WHERE id = ?",
      capText(text, AGENT_REPLY_LIMIT),
      Date.now(),
      placeholderId,
    );
  }

  private async runScreenJob(job: ScreenJobRow): Promise<void> {
    const sql = this.ctx.storage.sql;
    const agent = this.loadAgent(job.agent_id);
    if (!agent) {
      this.finishScreenPlaceholder(job.placeholder_id, "This agent was deleted before it could reply.");
      return;
    }
    const authKey =
      this.workerEnv.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY ?? this.workerEnv.RORK_TOOLKIT_SECRET_KEY ?? "";
    if (!authKey) {
      this.finishScreenPlaceholder(
        job.placeholder_id,
        "⚠️ The backend has no AI key configured — ask the workspace admin.",
      );
      return;
    }
    const screen = this.loadScreen(job.screen_id);
    const member = this.loadMember(job.email);
    const memberName = member?.display_name || job.email.split("@")[0];

    const { tools, routes, plan, access, mcpNote } = await this.buildAgentToolset(agent);

    // Private desk history — settled rows; the fresh member message is last.
    const historyRows = sql
      .exec<ScreenChatRow>(
        `SELECT id, screen_id, widget_id, email, author_kind, author_name, body, pending, created_at, updated_at
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
      const resolved = this.screenIntercomToken(screen);
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
    };
    const result = await runEngineTurn({
      authKey,
      modelId: agent.model || DEFAULT_CHAT_MODEL,
      apiMessages,
      tools,
      executeTool: (name, argsJson) => executeServerTool(name, argsJson, toolCtx),
      deadlineAt: Date.now() + AGENT_RUN_BUDGET_MS,
      handlers: { onText: () => undefined },
    });

    const sources = ledger.list().slice(0, SOURCES_APPENDIX_CAP);
    const sourcesBlock =
      sources.length > 0
        ? `\n\n---\nSources:\n${sources.map((source, index) => `[${index + 1}] ${source.title === source.url ? source.url : `${source.title} — ${source.url}`}`).join("\n")}`
        : "";
    const content = result.content.trim().length > 0 ? result.content : "(no output)";
    this.finishScreenPlaceholder(job.placeholder_id, `${content}${sourcesBlock}`);
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
    const secrets = parseSecrets(agent.secrets);
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
        "SELECT id, agent_id, channel, thread_ts, event_ts, user_id, text, status FROM slack_jobs WHERE id = ?",
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
      await this.runSlackJob(job);
      sql.exec("UPDATE slack_jobs SET status = 'done' WHERE id = ?", jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "run failed";
      console.error("slack bot run failed", job.agent_id, message);
      sql.exec("UPDATE slack_jobs SET status = 'error' WHERE id = ?", jobId);
      // Honest failure note into the Slack thread while the token still works.
      const agent = this.loadAgent(job.agent_id);
      const token = agent ? parseSecrets(agent.secrets).slackToken : undefined;
      if (token) {
        try {
          await postSlackThreadReply(
            token,
            job.channel,
            job.thread_ts,
            `⚠️ Agent run failed: ${capText(message, 300)}`,
          );
        } catch {
          // nothing honest left to do — the thread stays silent
        }
      }
    }
    return json({ ok: true });
  }

  private async runSlackJob(job: SlackJobRow): Promise<void> {
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
      await postSlackThreadReply(
        token,
        job.channel,
        job.thread_ts,
        "⚠️ The backend has no AI key configured — ask the workspace admin.",
      );
      return;
    }
    const { tools, routes, plan, access, mcpNote } = await this.buildAgentToolset(agent);

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
    };
    const result = await runEngineTurn({
      authKey,
      modelId: agent.model || DEFAULT_CHAT_MODEL,
      apiMessages,
      tools,
      executeTool: (name, argsJson) => executeServerTool(name, argsJson, toolCtx),
      deadlineAt: Date.now() + AGENT_RUN_BUDGET_MS,
      handlers: { onText: () => undefined },
    });

    const sources = ledger.list().slice(0, SOURCES_APPENDIX_CAP);
    const sourcesBlock =
      sources.length > 0
        ? `\n\n---\nSources:\n${sources.map((source, index) => `[${index + 1}] ${source.title === source.url ? source.url : `${source.title} — ${source.url}`}`).join("\n")}`
        : "";
    const content = result.content.trim().length > 0 ? result.content : "(no output)";
    await postSlackThreadReply(
      token,
      job.channel,
      job.thread_ts,
      capText(`${content}${sourcesBlock}`, SLACK_REPLY_LIMIT),
    );
  }
}
