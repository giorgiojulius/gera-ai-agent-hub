// Shared contracts for Projects — team workspaces where colleagues get
// scoped agents (e.g. a repo guide that can read GitHub but never write)
// and Slack-style channels with threads.
//
// Platform-neutral on purpose: the web app's unit tests import this module
// directly, so nothing Cloudflare-specific may appear here. The native tool
// tables it imports are plain data + fetch-based callers.

import { normalizeMcpWritePolicy, type McpRunPolicy, type McpToolAllowlist, type McpWritePolicy } from "./mcp-policy";
import { GITHUB_NATIVE_TOOLS } from "./native-github";
import { INTERCOM_NATIVE_TOOLS } from "./native-intercom";
import { SLACK_NATIVE_TOOLS } from "./native-slack";
import type { ExecutionOutcome } from "./run-protocol";

export type ProjectRole = "owner" | "admin" | "member";

export type GithubAccessLevel = "off" | "read" | "write";

/** What one project agent is allowed to touch — the whole point of Projects. */
export type AgentAccess = {
  /** web_search + fetch_url. */
  web: boolean;
  /** "read" = repo reference only (no commits/PRs/issues); "write" = full set. */
  github: GithubAccessLevel;
  intercom: boolean;
  slack: boolean;
  /** Linked MCP servers — refs into the linking admin's connected list. */
  mcp: boolean;
};

/**
 * One linked server — a ref into the linking admin's connected MCP catalog.
 * `tools` is the agent's allowlist on that server (absent = every tool).
 */
export type AgentMcpServerRef = { id: string; name: string; tools?: string[] };

/**
 * The agent's MCP link: server refs resolved through the linking admin's
 * account shard on every run — the same pipeline cloud automations use.
 * Keys and sign-ins stay on that account and never copy into the project.
 * `writes` is the agent's policy for write / destructive tools: "ask" (agents
 * run unattended, so such calls are declined honestly) or "auto" (default).
 */
export type AgentMcpSelection = { owner: string; servers: AgentMcpServerRef[]; writes?: McpWritePolicy };

/** Project-scoped credentials the agent acts with — stored server-side only. */
export type AgentSecrets = {
  githubToken?: string;
  /** Account-shard reference; OAuth grant itself never copies into the project. */
  githubAccount?: { owner: string; serverId: string };
  intercomToken?: string;
  slackToken?: string;
  /** Slack app Signing Secret — turns the agent into a mentionable Slack bot. */
  slackSigningSecret?: string;
  /** Slack app minted from Gera via the manifest API — install credentials. */
  slackAppId?: string;
  slackClientId?: string;
  slackClientSecret?: string;
  /** Workspace name captured on install — a display label, not a credential. */
  slackTeam?: string;
  /** Linked MCP servers — refs only; auth resolves via the owner's account. */
  mcpSelection?: AgentMcpSelection;
};

/** Which secrets exist — what the client is allowed to see. */
export type AgentSecretFlags = {
  github: boolean;
  intercom: boolean;
  slack: boolean;
  slackSigning: boolean;
};

/** Project-level Slack app-manager connection status — never carries tokens. */
export type SlackConfigWire = { team: string; renews: boolean; connectedAt: number };

export type ProjectMemberWire = {
  email: string;
  role: ProjectRole;
  name: string;
  addedAt: number;
};

export type ProjectAgentWire = {
  id: string;
  name: string;
  handle: string;
  emoji: string;
  instructions: string;
  model: string;
  access: AgentAccess;
  secretsSet: AgentSecretFlags;
  /** Linked MCP servers (names + tool allowlists) — resolved via `mcpOwner`'s account. */
  mcpServers: AgentMcpServerRef[];
  /** Whose account the MCP servers resolve through; "" when none linked. */
  mcpOwner: string;
  /** Policy for write / destructive tools on the linked servers. */
  mcpWrites: McpWritePolicy;
  /** Set when the Slack app was created from Gera; `team` fills in on install. */
  slackApp: { appId: string; team: string } | null;
  createdAt: number;
  updatedAt: number;
};

export type ProjectChannelWire = {
  id: string;
  name: string;
  topic: string;
  createdAt: number;
  /** Messages newer than the caller's read mark, authored by someone else. */
  unread: number;
  lastAt: number;
};

export type ProjectMessageWire = {
  id: string;
  channelId: string;
  rootId: string | null;
  kind: "user" | "agent";
  /** Member email or agent id. */
  author: string;
  authorName: string;
  body: string;
  /** True while an agent reply is still being produced. */
  pending: boolean;
  execution?: ExecutionOutcome;
  createdAt: number;
  updatedAt: number;
};

export type ThreadStatWire = {
  root: string;
  count: number;
  lastAt: number;
};

export type ProjectOverviewWire = {
  project: { id: string; name: string; createdBy: string; createdAt: number };
  me: { email: string; role: ProjectRole };
  members: ProjectMemberWire[];
  agents: ProjectAgentWire[];
  channels: ProjectChannelWire[];
  screens: ProjectScreenWire[];
};

// --- Screens: admin-composed widget desks ------------------------------------

/**
 * A screen is a focused desk an admin composes from widgets so one job gets
 * one UI — e.g. a support desk: the team's real Intercom inbox in the middle,
 * an AI reference agent docked right, and an escalation target that posts to
 * a project channel.
 */
export type ScreenWidgetKind = "intercom-inbox" | "agent-chat" | "channel-post";

export type ScreenWidgetWire = {
  id: string;
  kind: ScreenWidgetKind;
  /** Powers inbox credentials / the assistant persona. */
  agentId: string | null;
  /** Escalation channel for channel-post. */
  channelId: string | null;
};

export type ProjectScreenWire = {
  id: string;
  name: string;
  emoji: string;
  widgets: ScreenWidgetWire[];
  createdAt: number;
  updatedAt: number;
};

/** One row of a member's PRIVATE assistant chat on a screen. */
export type ScreenChatMessageWire = {
  id: string;
  kind: "user" | "agent";
  authorName: string;
  body: string;
  pending: boolean;
  execution?: ExecutionOutcome;
  createdAt: number;
  updatedAt: number;
};

export type ProjectListEntry = { id: string; name: string; role: ProjectRole };

// --- Caps -------------------------------------------------------------------

export const PROJECT_NAME_LIMIT = 60;
export const CHANNEL_NAME_LIMIT = 40;
export const CHANNEL_TOPIC_LIMIT = 140;
export const AGENT_NAME_LIMIT = 40;
export const AGENT_HANDLE_LIMIT = 24;
export const AGENT_INSTRUCTIONS_LIMIT = 4_000;
export const MESSAGE_BODY_LIMIT = 8_000;
export const MEMBER_NAME_LIMIT = 60;
export const MAX_MEMBERS = 50;
export const MAX_AGENTS = 12;
export const MAX_CHANNELS = 30;
/** Per channel — oldest rows fall off past this. */
export const CHANNEL_KEEP_MESSAGES = 2_000;
/** One /messages page (initial or delta). */
export const MESSAGE_PAGE = 200;
/** Thread transcript handed to an agent run. */
export const THREAD_CONTEXT_MESSAGES = 30;
/** Distinct agents one message can summon. */
export const MAX_AGENT_JOBS_PER_MESSAGE = 3;
/** Wall-clock budget for one channel agent reply. */
export const AGENT_RUN_BUDGET_MS = 110_000;
export const SCREEN_NAME_LIMIT = 60;
export const MAX_SCREENS = 12;
export const MAX_SCREEN_WIDGETS = 6;
/** Per (screen, widget, member) — oldest desk-chat rows fall off past this. */
export const SCREEN_CHAT_KEEP = 200;
/** Prior desk-chat turns handed to one assistant run. */
export const SCREEN_CHAT_CONTEXT_MESSAGES = 24;
export const MAX_AGENT_MCP_SERVERS = 5;
export const AGENT_MCP_NAME_LIMIT = 40;
/** Allowlisted tool names per linked server (deferred catalogs can be large; the editor lists what the check saw). */
export const MAX_AGENT_MCP_TOOLS = 300;
const AGENT_MCP_TOOL_NAME_LIMIT = 120;

export function canManageProject(role: ProjectRole): boolean {
  return role === "owner" || role === "admin";
}

export function isProjectRole(value: unknown): value is ProjectRole {
  return value === "owner" || value === "admin" || value === "member";
}

// --- Handles & mentions -----------------------------------------------------

const RU_TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y",
  ь: "", э: "e", ю: "yu", я: "ya",
};

/** "Repo Guide" → "repo-guide", "Саппорт" → "sapport"; ASCII-only by design. */
export function normalizeHandle(name: string): string {
  const translit = name
    .toLowerCase()
    .split("")
    .map((char) => RU_TRANSLIT[char] ?? char)
    .join("");
  const slug = translit
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, AGENT_HANDLE_LIMIT)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "agent";
}

/** Appends -2, -3… until the handle is free among `taken`. */
export function ensureUniqueHandle(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    return base;
  }
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`.slice(0, AGENT_HANDLE_LIMIT + 3);
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  return `${base}-${Date.now() % 1000}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds @handle mentions in a message body. Handles are ASCII slugs, so the
 * boundary rule is simple: the char before "@" must not be alphanumeric and
 * the char after the handle must not extend it. Returns unique handles in
 * first-appearance order, case-insensitive.
 */
export function parseMentions(body: string, handles: string[]): string[] {
  if (handles.length === 0 || !body.includes("@")) {
    return [];
  }
  const sorted = [...handles].filter((h) => h.length > 0).sort((a, b) => b.length - a.length);
  if (sorted.length === 0) {
    return [];
  }
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9-])@(${sorted.map(escapeRegExp).join("|")})(?![A-Za-z0-9-])`,
    "gi",
  );
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(pattern)) {
    const handle = match[2].toLowerCase();
    if (!seen.has(handle)) {
      seen.add(handle);
      found.push(handle);
    }
  }
  return found;
}

// --- Linked MCP servers per agent ---------------------------------------------

/** Allowlist of one ref: an array of tool names (deduplicated, bounded) or absent for "every tool". */
function mcpToolAllowlistFrom(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const tools: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (tools.length >= MAX_AGENT_MCP_TOOLS) {
      break;
    }
    const name = (typeof item === "string" ? item : "").trim().slice(0, AGENT_MCP_TOOL_NAME_LIMIT);
    if (name && !seen.has(name)) {
      seen.add(name);
      tools.push(name);
    }
  }
  return tools;
}

function mcpServerRefFrom(item: unknown): AgentMcpServerRef | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  const record = item as Record<string, unknown>;
  const id = (typeof record.id === "string" ? record.id : "").trim().slice(0, 80);
  if (!id) {
    return null;
  }
  const name =
    (typeof record.name === "string" ? record.name : "").trim().slice(0, AGENT_MCP_NAME_LIMIT) || id;
  const tools = mcpToolAllowlistFrom(record.tools);
  return tools ? { id, name, tools } : { id, name };
}

/** Tolerant parse of the stored MCP link (unknown JSON → clean selection). */
export function normalizeStoredMcpSelection(raw: unknown): AgentMcpSelection | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const owner = (typeof record.owner === "string" ? record.owner : "").trim().toLowerCase();
  if (!owner || !Array.isArray(record.servers)) {
    return undefined;
  }
  const servers: AgentMcpServerRef[] = [];
  const seen = new Set<string>();
  for (const item of record.servers) {
    if (servers.length >= MAX_AGENT_MCP_SERVERS) {
      break;
    }
    const ref = mcpServerRefFrom(item);
    if (ref && !seen.has(ref.id)) {
      seen.add(ref.id);
      servers.push(ref);
    }
  }
  if (servers.length === 0) {
    return undefined;
  }
  return record.writes === "ask" ? { owner, servers, writes: "ask" } : { owner, servers };
}

/**
 * The run policy of a linked selection: every linked server with its tool
 * allowlist (absent = all tools), plus the agent's write policy. Servers
 * outside the selection never reach the run anyway.
 */
export function agentMcpPolicy(selection: AgentMcpSelection | undefined): McpRunPolicy {
  if (!selection) {
    return { allow: null, writes: "auto" };
  }
  const allow: McpToolAllowlist = {};
  for (const ref of selection.servers) {
    allow[ref.id] = ref.tools ? [...ref.tools] : null;
  }
  return { allow, writes: normalizeMcpWritePolicy(selection.writes) };
}

export type McpWritesPatch =
  | { action: "keep" }
  | { action: "set"; writes: McpWritePolicy }
  | { action: "error"; error: "invalid_mcp_writes" };

/** The editor's write-policy field: omitted keeps the stored value; "ask" | "auto" sets it. */
export function parseMcpWritesPatch(raw: unknown): McpWritesPatch {
  if (raw === undefined) {
    return { action: "keep" };
  }
  if (raw === "ask" || raw === "auto") {
    return { action: "set", writes: raw };
  }
  return { action: "error", error: "invalid_mcp_writes" };
}

export type McpSelectionPatch =
  | { action: "keep" }
  | { action: "set"; servers: AgentMcpServerRef[] }
  | { action: "error"; error: "too_many_mcp_servers" | "invalid_mcp_selection" };

/**
 * The editor sends the full desired selection — ids + names picked from the
 * saving admin's connected servers (same list as chat). Omitting the field
 * keeps the stored link untouched; null or [] unlinks. Every non-empty save
 * re-links the selection to the saving admin's account.
 */
export function parseMcpSelectionPatch(raw: unknown): McpSelectionPatch {
  if (raw === undefined) {
    return { action: "keep" };
  }
  if (raw === null) {
    return { action: "set", servers: [] };
  }
  if (!Array.isArray(raw)) {
    return { action: "error", error: "invalid_mcp_selection" };
  }
  if (raw.length > MAX_AGENT_MCP_SERVERS) {
    return { action: "error", error: "too_many_mcp_servers" };
  }
  const servers: AgentMcpServerRef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const ref = mcpServerRefFrom(item);
    if (!ref) {
      return { action: "error", error: "invalid_mcp_selection" };
    }
    if (seen.has(ref.id)) {
      continue;
    }
    seen.add(ref.id);
    servers.push(ref);
  }
  return { action: "set", servers };
}

// --- Screen widget validation -------------------------------------------------

export function isScreenWidgetKind(value: unknown): value is ScreenWidgetKind {
  return value === "intercom-inbox" || value === "agent-chat" || value === "channel-post";
}

export type ScreenWidgetsValidation =
  | { ok: true; widgets: ScreenWidgetWire[] }
  | { ok: false; error: string };

/**
 * Validates a screen's widget list against the project's live agents and
 * channels. Widget ids derive from kind + reference (with a numeric suffix on
 * duplicates) so members' private desk chats survive unrelated screen edits.
 */
export function validateScreenWidgets(
  raw: unknown,
  agentIds: ReadonlySet<string>,
  channelIds: ReadonlySet<string>,
): ScreenWidgetsValidation {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "screen_needs_widgets" };
  }
  if (raw.length > MAX_SCREEN_WIDGETS) {
    return { ok: false, error: "too_many_widgets" };
  }
  const widgets: ScreenWidgetWire[] = [];
  const usedIds = new Set<string>();
  let inboxCount = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "invalid_widget" };
    }
    const record = item as Record<string, unknown>;
    if (!isScreenWidgetKind(record.kind)) {
      return { ok: false, error: "invalid_widget_kind" };
    }
    const kind = record.kind;
    const agentId = typeof record.agentId === "string" ? record.agentId : "";
    const channelId = typeof record.channelId === "string" ? record.channelId : "";
    if ((kind === "intercom-inbox" || kind === "agent-chat") && (!agentId || !agentIds.has(agentId))) {
      return { ok: false, error: "widget_agent_missing" };
    }
    if (kind === "channel-post" && (!channelId || !channelIds.has(channelId))) {
      return { ok: false, error: "widget_channel_missing" };
    }
    if (kind === "intercom-inbox") {
      inboxCount += 1;
      if (inboxCount > 1) {
        return { ok: false, error: "one_inbox_per_screen" };
      }
    }
    const base = `${kind}:${kind === "channel-post" ? channelId : agentId}`;
    let id = base;
    for (let n = 2; usedIds.has(id); n += 1) {
      id = `${base}:${n}`;
    }
    usedIds.add(id);
    widgets.push({
      id,
      kind,
      agentId: kind === "channel-post" ? null : agentId,
      channelId: kind === "channel-post" ? channelId : null,
    });
  }
  return { ok: true, widgets };
}

// --- Access → tools ---------------------------------------------------------

/**
 * The GitHub tools a "read" agent may use — reference and inspection only.
 * Everything else in GITHUB_NATIVE_TOOLS mutates the repo (branches, files,
 * PRs, issues) and needs the "write" level.
 */
export const GITHUB_READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  "whoami",
  "list_my_repos",
  "search_repositories",
  "get_repo",
  "get_contents",
  "get_file_tree",
  "get_readme",
  "list_commits",
  "search_code",
  "search_issues",
  "list_issues",
  "list_pulls",
  "get_pull",
  "get_pull_files",
  "get_commit",
  "compare_commits",
  "list_workflow_runs",
  "list_run_jobs",
  "get_job_logs",
  "list_run_artifacts",
  "list_releases",
  "list_branches",
  "list_deployments",
]);

export function githubToolAllowed(level: GithubAccessLevel, toolName: string): boolean {
  if (level === "off") {
    return false;
  }
  if (level === "write") {
    return true;
  }
  return GITHUB_READ_TOOL_NAMES.has(toolName);
}

/**
 * Slack channel membership is not project membership. Inbound mentions may
 * inspect GitHub, but native repository writes and generic MCP (whose tools
 * have no trustworthy read/write classification) stay inside authenticated Gera.
 */
export function accessForAgentSurface(access: AgentAccess, surface: "project" | "slack"): AgentAccess {
  if (surface !== "slack") {
    return access;
  }
  return {
    ...access,
    github: access.github === "write" ? "read" : access.github,
    intercom: false,
    slack: false,
    mcp: false,
  };
}

export type PlannedNativeTool = {
  kind: "github" | "intercom" | "slack";
  /** Function name exposed to the model, e.g. "github_get_repo". */
  fnName: string;
  /** Raw connector tool name, e.g. "get_repo". */
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type NativeToolRow = { name: string; description?: string; inputSchema?: Record<string, unknown> };

function planKind(
  kind: PlannedNativeTool["kind"],
  table: NativeToolRow[],
  filter: (name: string) => boolean,
): PlannedNativeTool[] {
  return table
    .filter((tool) => filter(tool.name))
    .map((tool) => ({
      kind,
      fnName: `${kind}_${tool.name}`,
      toolName: tool.name,
      description: tool.description ?? tool.name,
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    }));
}

export type AgentToolPlan = {
  native: PlannedNativeTool[];
  /** Access switched on without a stored credential — surfaced honestly. */
  missingSecrets: Array<"github" | "intercom" | "slack">;
  webEnabled: boolean;
  /** Configured external MCP servers this run will try to connect (0 when access is off). */
  mcpServerCount: number;
};

/** Access + stored secrets → the exact tool surface one agent run gets. */
export function planAgentTools(
  access: AgentAccess,
  secretsSet: AgentSecretFlags,
  mcpServerCount = 0,
): AgentToolPlan {
  const native: PlannedNativeTool[] = [];
  const missing: Array<"github" | "intercom" | "slack"> = [];
  if (access.github !== "off") {
    if (secretsSet.github) {
      native.push(
        ...planKind("github", GITHUB_NATIVE_TOOLS, (name) => githubToolAllowed(access.github, name)),
      );
    } else {
      missing.push("github");
    }
  }
  if (access.intercom) {
    if (secretsSet.intercom) {
      native.push(...planKind("intercom", INTERCOM_NATIVE_TOOLS, () => true));
    } else {
      missing.push("intercom");
    }
  }
  if (access.slack) {
    if (secretsSet.slack) {
      native.push(...planKind("slack", SLACK_NATIVE_TOOLS, () => true));
    } else {
      missing.push("slack");
    }
  }
  return {
    native,
    missingSecrets: missing,
    webEnabled: access.web,
    mcpServerCount: access.mcp ? mcpServerCount : 0,
  };
}

/** Honest capability statement for the agent's system prompt. */
export function describeAgentAccess(plan: AgentToolPlan, access: AgentAccess): string {
  const lines: string[] = [];
  lines.push(
    plan.webEnabled
      ? "- Web: web_search and fetch_url are available — verify facts instead of guessing."
      : "- Web access is OFF for this agent. Do not claim you searched the web.",
  );
  if (access.github === "off") {
    lines.push("- GitHub: no access.");
  } else if (!plan.native.some((tool) => tool.kind === "github")) {
    lines.push("- GitHub: enabled but NO credential is stored — say so plainly if asked about repos.");
  } else if (access.github === "read") {
    lines.push(
      "- GitHub: READ-ONLY (github_* tools). You can inspect repos, files, commits, PRs, issues, CI — you CANNOT create branches, commit, open PRs, or write issues. If asked to change code, explain you are read-only and describe what a change would involve instead.",
    );
  } else {
    lines.push(
      "- GitHub: full access (github_* tools), including branches, file commits, PRs and issues. Only perform writes the request clearly asks for.",
    );
  }
  if (access.intercom) {
    lines.push(
      plan.native.some((tool) => tool.kind === "intercom")
        ? "- Intercom: intercom_* tools work on the team's real inbox — read freely; only send replies the request clearly asks for."
        : "- Intercom: enabled but NO credential is stored — say so plainly.",
    );
  }
  if (access.slack) {
    lines.push(
      plan.native.some((tool) => tool.kind === "slack")
        ? "- Slack: slack_* tools work on the team's real workspace — only post messages the request clearly asks for."
        : "- Slack: enabled but NO credential is stored — say so plainly.",
    );
  }
  if (access.mcp) {
    lines.push(
      plan.mcpServerCount > 0
        ? `- External MCP servers: ${plan.mcpServerCount} configured — their tools appear as mcp_* functions; this run's live connection status follows below.`
        : "- External MCP servers: enabled but none are configured yet — say so plainly if external tools are needed.",
    );
  }
  return lines.join("\n");
}
