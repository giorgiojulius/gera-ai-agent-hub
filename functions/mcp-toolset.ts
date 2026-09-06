// Unified MCP toolset resolver — the ONE place every run kind (interactive
// chat / resume / Julius, cloud automations, project + Slack agents, Deep
// Research) turns its already-resolved connector list into model-facing
// function definitions plus an executor.
//
// Two loading modes for generic MCP servers:
//
// - native: every visible tool becomes its own `mcp_<server>_<tool>` function
//   (the historical behavior) — bounded by soft caps with honest records when
//   a server does not fit;
// - deferred: the model sees two meta functions, `mcp_search_tools` and
//   `mcp_call_tool`. Tool tables come from the account's catalog cache (or a
//   unloaded marker when cold), servers connect only on addressed use,
//   and a tool may only be called after a search returned it in this
//   run. Schemas never reach the prompt until they are needed.
//
// The native GitHub / Slack / Intercom connectors always register inline:
// their static tables are first-party, bounded, and drive UI flows (code
// changes, repo preflight) by function name.
//
// Policy (mcp-policy.ts) sits in front of every call the toolset executes —
// inline function or mcp_call_tool alike: the allowlist decides what the
// model sees, and write / destructive tools pause interactive runs for the
// user's confirmation (background runs decline honestly). Every decision is
// journaled without argument values.
//
// Credentials never appear in records, prompt notes, or search results — the
// tool tables are already redacted by the transport (mcp-cloud.ts).

import { describeStepUp } from "./mcp-auth-challenge";
import { describeMcpWritePolicy, mcpServerAllowed, mcpToolAllowed, OPEN_MCP_POLICY, type McpConfirmationAction, type McpRunPolicy, type McpToolRisk } from "./mcp-policy";
import { CONNECT_BUDGET_MS, RUN_CATALOG_CHARS, CATALOG_TTL_MS, type McpCatalogStore, type McpCatalogEntry } from "./mcp-catalog";
import { createMcpConnections, type McpServerState as ServerState } from "./mcp-lazy-connect";
import { createMcpInteraction } from "./mcp-interaction";
export * from "./mcp-catalog";
export { normalizeCatalogWire } from "./mcp-catalog-wire";
export { ELICITATION_TIMEOUT_MS } from "./mcp-interaction";
import {
  callCloudMcpToolRich,
  cloudMcpFunctionName,
  cloudServerRedactions,
  ensureFreshCloudOAuth,
  forceRefreshCloudOAuthOutcome,
  redactCloudMcpText,
  type BeginCloudOAuthRefresh,
  type CloudMcpServer,
  type CloudMcpSession,
  type CloudMcpTool,
  type CloudOAuthRefreshFailure,
  type RefreshedOAuth,
} from "./mcp-cloud";
import { createCredentialLease, stripCloudMcpCredentials } from "./mcp-credentials";
import { McpSignInRequiredError } from "./mcp-protocol-shared";
import type { McpElicitationAnswer, McpElicitationRequest, McpFetch, McpResultFile } from "./mcp-protocol";
import { callGitHubNativeTool, GITHUB_NATIVE_TOOLS } from "./native-github";
import { callIntercomNativeTool, INTERCOM_NATIVE_TOOLS } from "./native-intercom";
import { callSlackNativeTool, SLACK_NATIVE_TOOLS } from "./native-slack";

// ---------------------------------------------------------------------------
// Shared shapes (moved here from automation-runner.ts; re-exported there).

/** OpenAI-shaped function definition sent to the gateway. */
export type ToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ToolRecord = { name: string; arguments: string; result: string };

/** Dispatch route for one namespaced MCP or native-connector tool. */
export type McpRoute =
  | { type: "mcp"; session: CloudMcpSession; toolName: string; serverName: string; serverId?: string }
  | {
      type: "native";
      kind: "github" | "slack" | "intercom";
      /** Ready credential: full Authorization header for GitHub, raw token otherwise. */
      auth: string;
      toolName: string;
      serverName: string;
      /** Connector id in the account profile (policy approvals key on it; falls back to `kind`). */
      serverId?: string;
    };

export type McpRuntime = {
  toolDefs: ToolDef[];
  routes: Map<string, McpRoute>;
  failures: ToolRecord[];
  summary: string[];
  refreshed: RefreshedOAuth[];
};

export function emptyMcpRuntime(): McpRuntime {
  return { toolDefs: [], routes: new Map(), failures: [], summary: [], refreshed: [] };
}

// ---------------------------------------------------------------------------
// Modes, limits, and the account setting.

/** Account setting: how generic MCP tools reach the model. */
export type McpToolLoadingMode = "auto" | "native" | "deferred";

/** The mode a run actually ended up in. */
export type McpToolsetMode = "native" | "deferred";

export const MCP_TOOL_LOADING_MODES: readonly McpToolLoadingMode[] = ["auto", "native", "deferred"];

/** Parses the synced setting; anything unknown means "auto". */
export function normalizeMcpToolLoading(value: unknown): McpToolLoadingMode {
  return value === "native" || value === "deferred" ? value : "auto";
}

/**
 * Auto flips to deferred when the visible tool schemas would take more than
 * this share of the model's context window. The tool count alone does not
 * matter — forty tiny schemas cost less than three sprawling ones.
 */
export const DEFERRED_AUTO_CONTEXT_SHARE = 0.15;
/** Context window assumed when the gateway catalog did not say. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
/** Soft cap of inline MCP functions per server (native mode only) — the one remaining fuse against a runaway server. */
export const NATIVE_TOOLS_PER_SERVER = 500;
export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 20;
/** Rendered search results never exceed this many characters. */
const SEARCH_RESULT_CHARS = 60_000;
/** Rough tokens-per-character estimate for schema JSON. */
const CHARS_PER_TOKEN = 4;

export const MCP_SEARCH_TOOL_NAME = "mcp_search_tools";
export const MCP_CALL_TOOL_NAME = "mcp_call_tool";

/** The two deferred-mode meta functions. */
export function mcpMetaToolDefinitions(): ToolDef[] {
  return [
    {
      type: "function",
      function: {
        name: MCP_SEARCH_TOOL_NAME,
        description:
          "Search MCP tool names, descriptions and input fields. An unaddressed search reads cached catalogs only and lists unloaded servers honestly. Pass serverId to connect just that server and load its catalog. Returns complete input schemas; only descriptors actually returned can be called.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "What the tool should do or be named (a few keywords work best; empty lists the first tools)",
            },
            serverId: { type: "string", description: "Optional: restrict the search to one server id" },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: SEARCH_MAX_LIMIT,
              description: `Descriptors to return (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT})`,
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: MCP_CALL_TOOL_NAME,
        description:
          "Run a previously revealed MCP tool with exact serverId, toolName and arguments matching its inputSchema. On a cold server the first call only connects that server and returns matching schemas with executed:false; it NEVER executes the tool. Read the schema and call again to execute, subject to policy and confirmation.",
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string", description: "Server id exactly as returned by mcp_search_tools" },
            toolName: { type: "string", description: "Tool name exactly as returned by mcp_search_tools" },
            arguments: {
              type: "object",
              description: "Arguments matching the tool's inputSchema (omit for tools without parameters)",
              additionalProperties: true,
            },
          },
          required: ["serverId", "toolName"],
        },
      },
    },
  ];
}

/** True for the deferred-mode meta functions. */
export function isMcpMetaToolName(name: string): boolean {
  return name === MCP_SEARCH_TOOL_NAME || name === MCP_CALL_TOOL_NAME;
}

// ---------------------------------------------------------------------------
// Search.

export type McpSearchableServer = {
  serverId: string;
  serverName: string;
  tools: CloudMcpTool[];
};

export type McpSearchHit = {
  serverId: string;
  serverName: string;
  tool: CloudMcpTool;
  score: number;
};

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function schemaFields(schema: Record<string, unknown>): { names: string[]; descriptions: string } {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const names: string[] = [];
  const descriptions: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    names.push(key.toLowerCase());
    if (isRecord(value) && typeof value.description === "string") {
      descriptions.push(value.description.toLowerCase());
    }
  }
  return { names, descriptions: descriptions.join(" ") };
}

function scoreTool(server: McpSearchableServer, tool: CloudMcpTool, tokens: string[], phrase: string): number {
  const nameLower = tool.name.toLowerCase();
  const nameTokens = tokenize(tool.name);
  const description = (tool.description ?? "").toLowerCase();
  const descriptionTokens = new Set(tokenize(description));
  const fields = schemaFields(tool.inputSchema);
  const fieldTokens = new Set(fields.names.flatMap((name) => tokenize(name)));
  const serverTokens = new Set(tokenize(`${server.serverId} ${server.serverName}`));
  let score = 0;
  if (nameLower === phrase || nameTokens.join(" ") === tokens.join(" ")) {
    score += 1_000;
  }
  for (const token of tokens) {
    if (nameTokens.includes(token)) {
      score += 120;
    } else if (nameLower.includes(token)) {
      score += 80;
    }
    if (descriptionTokens.has(token)) {
      score += 30;
    } else if (description.includes(token)) {
      score += 15;
    }
    if (fields.names.includes(token) || fieldTokens.has(token)) {
      score += 25;
    } else if (fields.names.some((name) => name.includes(token))) {
      score += 12;
    }
    if (fields.descriptions.includes(token)) {
      score += 5;
    }
    if (serverTokens.has(token)) {
      score += 10;
    }
  }
  if (tokens.length > 1 && (description.includes(phrase) || nameLower.includes(phrase))) {
    score += 40;
  }
  return score;
}

/**
 * Ranks catalog tools for a query: exact name → name token → description →
 * schema field name → field description; a server-name hit nudges its tools
 * up. An empty query lists tools in catalog order.
 */
export function searchMcpTools(
  servers: McpSearchableServer[],
  query: string,
  options: { serverId?: string; limit?: number } = {},
): McpSearchHit[] {
  const limit = Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.floor(options.limit ?? SEARCH_DEFAULT_LIMIT)));
  const tokens = tokenize(query);
  const phrase = tokens.join(" ");
  const scope = options.serverId
    ? servers.filter(
        (server) =>
          server.serverId === options.serverId ||
          server.serverId.toLowerCase() === options.serverId?.toLowerCase() ||
          server.serverName.toLowerCase() === options.serverId?.toLowerCase(),
      )
    : servers;
  const hits: Array<McpSearchHit & { order: number }> = [];
  let order = 0;
  for (const server of scope) {
    for (const tool of server.tools) {
      const score = tokens.length === 0 ? 0 : scoreTool(server, tool, tokens, phrase);
      order += 1;
      if (tokens.length === 0 || score > 0) {
        hits.push({ serverId: server.serverId, serverName: server.serverName, tool, score, order });
      }
    }
  }
  hits.sort((left, right) => right.score - left.score || left.order - right.order);
  return hits.slice(0, limit).map(({ order: _order, ...hit }) => hit);
}

// ---------------------------------------------------------------------------
// Mode decision.

/**
 * Decides the run's loading mode. "auto" prefers native while the visible
 * tool schemas fit comfortably in the model's context window; beyond the
 * share threshold the model gets the two meta functions instead of one
 * function per tool.
 */
export function decideMcpToolLoading(
  mode: McpToolLoadingMode,
  visible: { toolCount: number; schemaChars: number },
  contextWindowTokens?: number,
): McpToolsetMode {
  if (mode === "native" || mode === "deferred") {
    return mode;
  }
  if (visible.toolCount === 0) {
    return "native";
  }
  const window =
    typeof contextWindowTokens === "number" && Number.isFinite(contextWindowTokens) && contextWindowTokens > 0
      ? contextWindowTokens
      : DEFAULT_CONTEXT_WINDOW_TOKENS;
  const schemaTokens = visible.schemaChars / CHARS_PER_TOKEN;
  return schemaTokens > window * DEFERRED_AUTO_CONTEXT_SHARE ? "deferred" : "native";
}

// ---------------------------------------------------------------------------
// Native connectors (static tables; no handshake).

const NATIVE_TOOL_TABLES = {
  github: GITHUB_NATIVE_TOOLS,
  slack: SLACK_NATIVE_TOOLS,
  intercom: INTERCOM_NATIVE_TOOLS,
} as const;

/** Arms one native connector from its static tool table (allowlisted tools only). */
function armNativeServer(runtime: McpRuntime, server: CloudMcpServer, policy: McpRunPolicy): void {
  if (server.kind === "mcp") {
    return;
  }
  const credential = server.token ?? server.oauth?.accessToken ?? "";
  if (!credential) {
    return;
  }
  const auth =
    server.kind === "github"
      ? credential.toLowerCase().startsWith("bearer ")
        ? credential
        : `Bearer ${credential}`
      : credential;
  let added = 0;
  for (const tool of NATIVE_TOOL_TABLES[server.kind]) {
    if (server.disabledTools.includes(tool.name) || !mcpToolAllowed(policy, server.id, tool.name)) {
      continue;
    }
    const fnName = cloudMcpFunctionName(server.id, tool.name);
    if (runtime.routes.has(fnName)) {
      continue;
    }
    runtime.routes.set(fnName, {
      type: "native",
      kind: server.kind,
      auth,
      toolName: tool.name,
      serverName: server.name,
      serverId: server.id,
    });
    runtime.toolDefs.push({
      type: "function",
      function: {
        name: fnName,
        description: `[${server.name}] ${tool.description ?? tool.name}`.slice(0, 1_000),
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
      },
    });
    added += 1;
  }
  runtime.summary.push(`${server.name} (${added} tools)`);
}

/** Dispatches one native-connector tool call to its server-side REST port. */
export async function callNativeConnectorTool(
  route: Extract<McpRoute, { type: "native" }>,
  args: Record<string, unknown>,
): Promise<string> {
  const credentials = [route.auth, /^Bearer\s+(.+)$/i.exec(route.auth)?.[1] ?? ""];
  try {
    const output = route.kind === "github"
      ? await callGitHubNativeTool(route.auth, route.toolName, args)
      : route.kind === "slack"
        ? await callSlackNativeTool(route.auth, route.toolName, args)
        : await callIntercomNativeTool(route.auth, route.toolName, args);
    return redactCloudMcpText(output, credentials);
  } catch (error) {
    throw new Error(redactCloudMcpText(
      error instanceof Error ? error.message : "native connector failed",
      credentials,
    ));
  }
}

// ---------------------------------------------------------------------------
// The resolver.

/** An audio part or embedded binary resource of a tool result, as a bounded data URL. */
export type McpToolFile = { name: string; mime: string; dataUrl: string; bytes: number };

export type McpToolOutcome = {
  text: string;
  /** Schema-only cold calls must not be recorded as executed tools or research sources. */
  executed?: false;
  isError?: boolean;
  /** `type: "image"` parts of the result as data URLs (up to 5 / 4 MB per call). */
  images?: string[];
  /** Audio parts and embedded binary resources (up to 4 MB each) as data URLs. */
  files?: McpToolFile[];
};

export type McpToolsetServerInfo = {
  id: string;
  name: string;
  kind: CloudMcpServer["kind"];
  /** Tools visible to this run (disabled ones excluded); -1 while unknown. */
  toolCount: number;
  deferred: boolean;
  /** Honest reason when the server contributes nothing this run. */
  unavailable?: string;
  /** The complete remote table (disabled + UI-only included) — filled by health checks (uncapped). */
  tools?: CloudMcpTool[];
  /** Inventory counts when the handshake listed them (`inventory: true`). */
  promptCount?: number;
  resourceCount?: number;
  /** The protocol revision the conversation actually runs on (health checks show it on the card). */
  protocolVersion?: string;
};

/** An elicitation the toolset asks the surface to answer (interactive runs pause on it). */
export type McpToolsetElicitation = McpElicitationRequest & { serverId: string; serverName: string };

/**
 * Mid-run honest record (elicitation declined, catalog refreshed, step-up,
 * policy decision…) for surfaces that keep a journal. Policy entries name
 * the tool; none of them ever carries an argument value.
 */
export type McpToolsetJournalEntry = {
  kind:
    | "elicitation_declined"
    | "elicitation_timeout"
    | "elicitation_invalid"
    | "catalog_refreshed"
    | "step_up_required"
    | "confirmation_granted"
    | "confirmation_always"
    | "confirmation_declined"
    | "confirmation_timeout"
    | "policy_blocked";
  serverId: string;
  serverName: string;
  detail: string;
  toolName?: string;
};

/** A write / destructive call the policy wants approved — what the confirmation card shows. */
export type McpToolsetConfirmation = {
  serverId: string;
  serverName: string;
  toolName: string;
  risk: Exclude<McpToolRisk, "read">;
  /** What the tool does (its description), capped. */
  description: string;
  /** Redacted, capped JSON preview of the arguments. */
  argumentsPreview: string;
};

export type McpConfirmationAnswer = { action: McpConfirmationAction };

export type McpToolset = McpRuntime & {
  mode: McpToolsetMode;
  /** System-prompt guidance for deferred servers; "" when everything is inline. */
  promptNote: string;
  servers: McpToolsetServerInfo[];
  /** True when this toolset executes `name` (inline route or meta function). */
  owns(name: string): boolean;
  /** Runs an inline or meta tool call; tool failures come back as isError outcomes. */
  execute(name: string, args: Record<string, unknown>): Promise<McpToolOutcome>;
  /** Closes notification streams — call when the run settles. */
  close(): void;
  /** Mid-run records (background surfaces append them to their summaries). */
  journal: McpToolsetJournalEntry[];
};

export type ResolveMcpToolsetOptions = {
  /** Optional modern request log level; no logging is requested by default. */
  logLevel?: import("./mcp-protocol-shared").McpLogLevel;
  /** Resolved connectors (auth already attached) — see cloudMcpServersForAutomation. */
  servers: CloudMcpServer[];
  /** Account setting; unknown values behave as "auto". */
  mode?: McpToolLoadingMode;
  /** Interactive surfaces pause for the user (elicitation, confirmations); background ones decline honestly. */
  surface?: "interactive" | "background";
  /** Allowlist + write policy for this run; absent = everything visible, everything auto-runs. */
  policy?: McpRunPolicy;
  /**
   * Interactive surfaces approve write / destructive calls by pausing the run
   * on a confirmation card; without a handler such calls are declined and
   * journaled (background runs).
   */
  confirm?: (request: McpToolsetConfirmation) => Promise<McpConfirmationAnswer>;
  /** Context window of the run's model; unknown → 128k. */
  contextWindowTokens?: number;
  catalog?: McpCatalogStore;
  /** Project runs write redacted full catalogs back to the owner, before publishing them locally. */
  persistCatalog?: (entry: McpCatalogEntry, signal: AbortSignal) => Promise<void>;
  /** Lift the per-server native cap and the run budgets (health checks want the complete table). */
  uncapped?: boolean;
  /** Wall-clock budget for the run's parallel handshakes (default CONNECT_BUDGET_MS; tests shorten it). */
  connectBudgetMs?: number;
  /** Combined tool-table budget of the run in JSON characters (default RUN_CATALOG_CHARS; tests shrink it). */
  catalogBudgetChars?: number;
  persist?: (rotation: RefreshedOAuth) => Promise<void>;
  reportFailure?: (serverId: string, outcome: CloudOAuthRefreshFailure) => Promise<void>;
  beginRefresh?: BeginCloudOAuthRefresh;
  /**
   * Project agents: re-resolve a server through the owner's account after an
   * auth-rejected connect (the owner's shard refreshes and persists). When set,
   * grants are never rotated locally.
   */
  reconnect?: (serverId: string) => Promise<CloudMcpServer | null>;
  /**
   * Per-request credential source: re-resolves one server with freshly opened
   * credentials (vault rows read per call, an expiring grant refreshed and
   * persisted inside; `force` re-redeems after an auth rejection). When set,
   * no credential material is retained between requests.
   */
  credentials?: (serverId: string, options: { force: boolean }) => Promise<CloudMcpServer | null>;
  now?: () => number;
  /** Injected transport for conformance tests; production keeps the public-HTTPS guard. */
  fetch?: McpFetch;
  /**
   * Interactive surfaces answer `elicitation/create` by pausing the run for
   * the user; without a handler every elicitation is declined honestly.
   */
  elicit?: (request: McpToolsetElicitation) => Promise<McpElicitationAnswer>;
  /** Receives mid-run journal entries as they happen. */
  onJournal?: (entry: McpToolsetJournalEntry) => void;
  /** Open the GET notification stream for list_changed (default true; health checks pass false). */
  notificationStreams?: boolean;
  /** Also list prompts/resources during the handshake and cache them (health checks). */
  inventory?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Tools the model may see: disabled, UI-only, and non-allowlisted tools are excluded. */
function visibleTools(state: ServerState, policy: McpRunPolicy): CloudMcpTool[] {
  if (!state.catalog) {
    return [];
  }
  const disabled = new Set(state.server.disabledTools);
  return state.catalog.filter(
    (tool) => !disabled.has(tool.name) && tool.uiOnly !== true && mcpToolAllowed(policy, state.server.id, tool.name),
  );
}

/** A tool result with its binary parts as an outcome: text for the model, media for the surface. */
function richOutcome(result: { text: string; media: { images: Array<{ dataUrl: string }>; files: McpResultFile[] } }): McpToolOutcome {
  return {
    text: result.text.trim().length > 0 ? result.text : "(empty result)",
    ...(result.media.images.length > 0 ? { images: result.media.images.map((image) => image.dataUrl) } : {}),
    ...(result.media.files.length > 0
      ? { files: result.media.files.map((file) => ({ name: file.name, mime: file.mimeType, dataUrl: file.dataUrl, bytes: file.bytes })) }
      : {}),
  };
}

/**
 * Builds the toolset for one run. Expiring synced sign-ins refresh first,
 * native connectors register from their static tables, and generic MCP servers
 * either connect and register inline (native) or become searchable through the
 * two meta functions (deferred). Failures never throw — they surface as honest
 * records the caller shows in the thread.
 */
export async function resolveMcpToolset(options: ResolveMcpToolsetOptions): Promise<McpToolset> {
  const now = options.now ?? (() => Date.now());
  const runtime = emptyMcpRuntime();
  const requested = normalizeMcpToolLoading(options.mode);
  const perServerCap = options.uncapped ? Number.POSITIVE_INFINITY : NATIVE_TOOLS_PER_SERVER;
  const catalogBudgetChars = options.uncapped ? Number.POSITIVE_INFINITY : Math.max(0, options.catalogBudgetChars ?? RUN_CATALOG_CHARS);
  const connectBudgetMs = Math.max(0, options.connectBudgetMs ?? CONNECT_BUDGET_MS);
  const policy = options.policy ?? OPEN_MCP_POLICY;
  // Servers outside a set allowlist take no part in the run at all.
  const servers = options.servers.filter((server) => mcpServerAllowed(policy, server.id));

  // Native connectors remain inline. Generic grants are refreshed only when their lease is used.
  const unavailable = new Set<string>();
  for (const server of servers) {
    if (server.kind === "mcp" || !server.oauth) {
      continue;
    }
    try {
      const outcome = await ensureFreshCloudOAuth(server, runtime.refreshed, options.persist, options.beginRefresh);
      if (outcome?.ok === false) {
        await options.reportFailure?.(server.id, outcome);
        if (!outcome.transient) {
          unavailable.add(server.id);
          runtime.failures.push({
            name: "mcp_auth",
            arguments: server.name,
            result: `Could not authenticate MCP server "${server.name}": sign-in must be renewed.`,
          });
        }
      }
    } catch {
      // keep the synced token — a real auth failure surfaces honestly below
    }
  }

  // 2. Native connectors: static tables, inline in every mode.
  const infos: McpToolsetServerInfo[] = [];
  for (const server of servers) {
    if (server.kind === "mcp") {
      continue;
    }
    if (unavailable.has(server.id)) {
      infos.push({ id: server.id, name: server.name, kind: server.kind, toolCount: 0, deferred: false, unavailable: "sign-in must be renewed" });
      continue;
    }
    const before = runtime.routes.size;
    armNativeServer(runtime, server, policy);
    infos.push({ id: server.id, name: server.name, kind: server.kind, toolCount: runtime.routes.size - before, deferred: false });
  }

  // 3. Generic MCP servers. Credential material leaves the shared objects here:
  // each state keeps a stripped server plus a lease that opens the credential
  // per request (through `credentials`) or holds it privately for the run.
  const repairGrant = async (server: CloudMcpServer): Promise<boolean> => {
    const outcome = await forceRefreshCloudOAuthOutcome(server, runtime.refreshed, options.persist, options.beginRefresh).catch(() => null);
    if (outcome?.ok === false) {
      await options.reportFailure?.(server.id, outcome);
    }
    return outcome?.ok === true;
  };
  const beforeUse = async (server: CloudMcpServer): Promise<void> => {
    const outcome = await ensureFreshCloudOAuth(server, runtime.refreshed, options.persist, options.beginRefresh);
    if (outcome?.ok === false) {
      await options.reportFailure?.(server.id, outcome);
      if (!outcome.transient) throw new McpSignInRequiredError();
    }
  };
  const states: ServerState[] = servers
    .filter((server) => server.kind === "mcp" && !unavailable.has(server.id))
    .map((server) => {
      const cached = options.catalog?.read(server.id) ?? null;
      const fresh = cached !== null && now() >= cached.fetchedAt && now() - cached.fetchedAt < CATALOG_TTL_MS;
      const credentials = options.credentials;
      const lease = createCredentialLease(server, {
        ...(credentials ? { resolve: (force: boolean) => credentials(server.id, { force }) } : { repairGrant, beforeUse }),
      });
      return {
        server: stripCloudMcpCredentials(server),
        lease,
        catalog: fresh ? cached.tools : null,
        session: null,
        connecting: null,
        pending: false,
        failure: null,
        leftOut: false,
        stale: false,
        stream: null,
        stepUp: null,
        ...(fresh && cached.prompts ? { promptCount: cached.prompts.length, resourceCount: cached.resources?.length ?? 0 } : {}),
        ...(fresh && cached.wire ? { wireHint: cached.wire } : {}),
      };
    });

  const { journal, note, gate, parkForStepUp, serverRequestHandler } = createMcpInteraction(options, policy);

  const { connect, refreshIfStale, connectMissing, awaitLate, enforceCatalogBudget, close, isClosed } = createMcpConnections({
    options, states, now, connectBudgetMs, catalogBudgetChars, repairGrant, parkForStepUp, serverRequestHandler, note,
  });

  // A cold auto run cannot price unseen schemas without violating lazy startup.
  let mode: McpToolsetMode;
  if (requested === "auto") {
    const cold = states.some((state) => state.catalog === null);
    enforceCatalogBudget();
    const tools = states.flatMap((state) => visibleTools(state, policy));
    mode = cold ? "deferred" : decideMcpToolLoading(
      "auto", { toolCount: tools.length, schemaChars: jsonText(tools.map((tool) => tool.inputSchema)).length }, options.contextWindowTokens,
    );
  } else {
    mode = requested;
  }

  const revealed = new Map<string, string>();
  const schemaKey = (tool: CloudMcpTool): string => jsonText([tool.inputSchema, tool.annotations ?? {}, tool.uiOnly === true]);
  const revealKey = (serverId: string, toolName: string): string => `${serverId}\u0000${toolName}`;

  /** Honest record + info row for a server that contributes nothing this run. */
  const recordUnavailable = (state: ServerState, deferred: boolean): void => {
    const server = state.server;
    const reason = state.failure ?? "connect failed";
    runtime.failures.push(
      state.leftOut
        ? { name: "mcp_limit", arguments: server.name, result: `MCP server "${server.name}" was ${reason}` }
        : { name: state.authFailure ? "mcp_auth" : "mcp_connect", arguments: server.name, result: `Could not connect MCP server "${server.name}": ${reason}` },
    );
    infos.push({ id: server.id, name: server.name, kind: "mcp", toolCount: 0, deferred, unavailable: reason });
  };

  if (mode === "native") {
    await connectMissing((state) => state.session === null);
    enforceCatalogBudget();
    for (const state of states) {
      const server = state.server;
      if (state.failure || !state.session) {
        recordUnavailable(state, false);
        continue;
      }
      const visible = visibleTools(state, policy);
      let added = 0;
      let skipped = 0;
      for (const tool of visible) {
        if (added >= perServerCap) {
          skipped += 1;
          continue;
        }
        const fnName = cloudMcpFunctionName(server.id, tool.name);
        if (runtime.routes.has(fnName)) {
          continue;
        }
        runtime.routes.set(fnName, {
          type: "mcp",
          session: state.session,
          toolName: tool.name,
          serverName: server.name,
          serverId: server.id,
        });
        runtime.toolDefs.push({
          type: "function",
          function: {
            name: fnName,
            description: `[MCP:${server.name}] ${tool.description}`.slice(0, 1_000),
            parameters: tool.inputSchema,
          },
        });
        added += 1;
      }
      runtime.summary.push(`${server.name} (${added} tools)`);
      infos.push({
        id: server.id,
        name: server.name,
        kind: "mcp",
        toolCount: added,
        deferred: false,
        // Health checks (uncapped) want the complete remote table — disabled and
        // UI-only tools included, so McpStudio can show every switch and badge.
        ...(options.uncapped ? { tools: state.catalog ?? [] } : {}),
        ...(state.promptCount !== undefined ? { promptCount: state.promptCount, resourceCount: state.resourceCount ?? 0 } : {}),
        ...(state.session.protocolVersion ? { protocolVersion: state.session.protocolVersion } : {}),
      });
      if (skipped > 0) {
        runtime.failures.push({
          name: "mcp_limit",
          arguments: server.name,
          result: `${skipped} of ${visible.length} tools on MCP server "${server.name}" did not fit the native per-server limit (${NATIVE_TOOLS_PER_SERVER} inline functions per server) and are unavailable this run. Switch "MCP tool loading" to Deferred in Settings → Toolkit to make every tool searchable.`,
        });
      }
    }
  } else {
    // Deferred startup is cache-only: no upstream requests, refreshes, or subscriptions.
    enforceCatalogBudget();
    for (const state of states) {
      const server = state.server;
      if (state.failure) {
        recordUnavailable(state, true);
        continue;
      }
      const count = state.catalog === null ? -1 : visibleTools(state, policy).length;
      runtime.summary.push(`${server.name} (${count < 0 ? "catalog not loaded" : `${count} tools`} · deferred)`);
      const wireVersion = state.session?.protocolVersion ?? state.wireHint?.protocolVersion;
      infos.push({
        id: server.id,
        name: server.name,
        kind: "mcp",
        toolCount: count,
        deferred: true,
        ...(state.promptCount !== undefined ? { promptCount: state.promptCount, resourceCount: state.resourceCount ?? 0 } : {}),
        ...(wireVersion ? { protocolVersion: wireVersion } : {}),
      });
    }
    if (states.some((state) => !state.failure)) {
      runtime.toolDefs.push(...mcpMetaToolDefinitions());
    }
  }

  const deferredInfos = infos.filter((info) => info.deferred && !info.unavailable);
  const deferredNote =
    mode === "deferred" && deferredInfos.length > 0
      ? [
          `MCP tools use deferred loading. An unaddressed ${MCP_SEARCH_TOOL_NAME} reads cached catalogs only. For an unloaded server, pass its serverId to search: only that server connects. A cold ${MCP_CALL_TOOL_NAME} returns a schema with executed:false, not a tool result; call again after reading the schema. Only complete schemas returned in this run can be called.`,
          `Servers: ${deferredInfos.map((info) => `${info.id} "${info.name}" · ${info.toolCount < 0 ? "catalog not loaded" : `${info.toolCount} tools`}`).join("; ")}.`,
        ].join(" ")
      : "";
  // The model learns what a confirmation means for it only when something is armed.
  const policyNote = infos.some((info) => !info.unavailable && info.toolCount !== 0)
    ? describeMcpWritePolicy(policy.writes, Boolean(options.confirm))
    : "";
  const promptNote = [deferredNote, policyNote].filter(Boolean).join(" ");

  const searchable = (): McpSearchableServer[] =>
    states
      .filter((state) => state.catalog !== null && !state.failure && !state.stale && !state.pending)
      .map((state) => ({ serverId: state.server.id, serverName: state.server.name, tools: visibleTools(state, policy) }));

  const findState = (serverId: string): ServerState | undefined => {
    const wanted = serverId.trim();
    if (!wanted) {
      return undefined;
    }
    return (
      states.find((state) => state.server.id === wanted) ??
      states.find(
        (state) =>
          state.server.id.toLowerCase() === wanted.toLowerCase() ||
          state.server.name.toLowerCase() === wanted.toLowerCase(),
      )
    );
  };

  const serverList = (): string =>
    states.map((state) => `${state.server.id} ("${state.server.name}")`).join(", ") || "none";

  const syncInfos = (): void => {
    for (const state of states) {
      const info = infos.find((item) => item.id === state.server.id);
      if (info) {
        info.toolCount = state.catalog === null || state.stale ? -1 : visibleTools(state, policy).length;
        info.unavailable = state.failure ?? undefined;
        info.protocolVersion = state.session?.protocolVersion ?? state.wireHint?.protocolVersion;
        info.promptCount = state.promptCount;
        info.resourceCount = state.resourceCount;
      }
      if (state.failure && !runtime.failures.some((item) => item.arguments === state.server.name)) {
        runtime.failures.push({ name: state.leftOut ? "mcp_limit" : state.authFailure ? "mcp_auth" : "mcp_connect", arguments: state.server.name, result: `MCP server "${state.server.name}": ${state.failure}` });
      }
    }
  };
  const runSearch = async (args: Record<string, unknown>): Promise<McpToolOutcome> => {
    const query = typeof args.query === "string" ? args.query : "";
    const serverId = typeof args.serverId === "string" && args.serverId.trim() ? args.serverId.trim() : undefined;
    const limitRaw = Number(args.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : SEARCH_DEFAULT_LIMIT;
    if (serverId && !findState(serverId)) {
      return {
        text: `No MCP server "${serverId}" is connected in this run. Known servers: ${serverList()}.`,
        isError: true,
      };
    }
    const addressed = serverId ? findState(serverId) : undefined;
    if (addressed) {
      await awaitLate(addressed);
      if (addressed.catalog === null && !addressed.failure) await connect(addressed);
      await refreshIfStale(addressed);
    }
    if (isClosed()) return { text: "This MCP run has closed.", isError: true };
    syncInfos();
    const hits = searchMcpTools(searchable(), query, { serverId: addressed?.server.id, limit });
    const servers = states.map((state) => ({
      serverId: state.server.id,
      name: state.server.name,
      toolCount: state.catalog && !state.stale && !state.pending ? visibleTools(state, policy).length : -1,
      ...(!state.catalog || state.stale || state.pending ? { catalogStatus: state.pending ? "loading" : "unloaded" } : {}),
      ...(state.failure ? { unavailable: state.failure } : {}),
    }));
    const matches = hits.map((hit) => ({
      serverId: hit.serverId,
      toolName: hit.tool.name,
      description: hit.tool.description,
      inputSchema: hit.tool.inputSchema,
    }));
    const render = (shown: typeof matches, omitted: number): string =>
      JSON.stringify(
        {
          query,
          servers,
          matches: shown,
          note:
            shown.length === 0
              ? "No tools matched in loaded catalogs. For unloaded/stale catalogs, search with serverId to connect only that server; otherwise try other keywords."
              : `${shown.length} tool${shown.length === 1 ? "" : "s"} shown${omitted > 0 ? ` (${omitted} more matched but did not fit)` : ""}. Call ${MCP_CALL_TOOL_NAME} with the exact serverId and toolName.`,
        },
        null,
        1,
      );
    let shown = matches;
    let text = render(shown, 0);
    while (text.length > SEARCH_RESULT_CHARS && shown.length > 1) {
      shown = shown.slice(0, -1);
      text = render(shown, matches.length - shown.length);
    }
    if (text.length > SEARCH_RESULT_CHARS && shown.length === 1) {
      shown = [];
      text = render(shown, matches.length);
    }
    // Never reveal an omitted descriptor or a truncated schema.
    for (const match of shown) {
      const hit = hits.find((item) => item.serverId === match.serverId && item.tool.name === match.toolName);
      if (hit) revealed.set(revealKey(hit.serverId, hit.tool.name), schemaKey(hit.tool));
    }
    return { text };
  };

  const runCall = async (args: Record<string, unknown>): Promise<McpToolOutcome> => {
    const serverId = typeof args.serverId === "string" ? args.serverId.trim() : "";
    const toolName = typeof args.toolName === "string" ? args.toolName.trim() : "";
    if (!serverId || !toolName) {
      return { text: `${MCP_CALL_TOOL_NAME} needs serverId and toolName exactly as ${MCP_SEARCH_TOOL_NAME} returned them.`, isError: true };
    }
    const state = findState(serverId);
    if (!state) {
      return { text: `No MCP server "${serverId}" is connected in this run. Known servers: ${serverList()}.`, isError: true };
    }
    const server = state.server;
    if (state.catalog === null && !state.failure) {
      const found = await runSearch({ query: toolName, serverId: server.id, limit: 1 });
      if (found.isError) return found;
      if (state.failure) return { text: `MCP server "${server.name}" is unavailable this run: ${state.failure}.`, isError: true };
      return { ...found, executed: false, text: JSON.stringify({ executed: false, note: "Tool not executed. Read the returned schema, then call again.", discovery: JSON.parse(found.text) as unknown }) };
    }
    await awaitLate(state);
    await refreshIfStale(state);
    syncInfos();
    if (state.failure || !state.catalog) {
      return { text: `MCP server "${server.name}" is unavailable this run: ${state.failure ?? "connect failed"}.`, isError: true };
    }
    if (server.disabledTools.includes(toolName)) {
      return { text: `Tool "${toolName}" on MCP server "${server.name}" is disabled by the user in this server's tool settings.`, isError: true };
    }
    const catalogTool = state.catalog.find((tool) => tool.name === toolName);
    if (!catalogTool) {
      return { text: `MCP server "${server.name}" has no tool named "${toolName}". Find the exact name with ${MCP_SEARCH_TOOL_NAME} first.`, isError: true };
    }
    if (!mcpToolAllowed(policy, server.id, toolName)) {
      note({ kind: "policy_blocked", serverId: server.id, serverName: server.name, toolName, detail: "Not run: the tool is not in this agent's allowlist." });
      return {
        text: `Tool "${toolName}" on "${server.name}" is not allowed by this agent's MCP policy (the tool is not in this agent's allowlist). Do not retry it.`,
        isError: true,
      };
    }
    if (catalogTool.uiOnly) {
      return {
        text: `Tool "${toolName}" on MCP server "${server.name}" is UI-only (an MCP App that renders its own interface) and cannot be run by the model.`,
        isError: true,
      };
    }
    if (revealed.get(revealKey(server.id, toolName)) !== schemaKey(catalogTool)) {
      return {
        text: `Tool "${toolName}" on "${server.name}" was not returned by ${MCP_SEARCH_TOOL_NAME} in this conversation. Search for it first so its input schema is known, then call it with the exact serverId and toolName.`,
        isError: true,
      };
    }
    let callArgs: Record<string, unknown> = {};
    if (isRecord(args.arguments)) {
      callArgs = args.arguments;
    } else if (typeof args.arguments === "string" && args.arguments.trim()) {
      try {
        const parsed = JSON.parse(args.arguments) as unknown;
        callArgs = isRecord(parsed) ? parsed : {};
      } catch {
        return { text: `"arguments" must be a JSON object matching the tool's inputSchema.`, isError: true };
      }
    }
    // The policy decides before the server is even contacted.
    const refused = await gate(server, catalogTool, undefined, callArgs, cloudServerRedactions(server));
    if (refused) {
      return refused;
    }
    if (!state.session) {
      await connect(state);
      syncInfos();
      if (state.failure || !state.session) {
        return { text: `MCP tool failed (${server.name}): ${state.failure ?? "connect failed"}`, isError: true };
      }
      const current = visibleTools(state, policy).find((tool) => tool.name === toolName);
      if (!current || schemaKey(current) !== schemaKey(catalogTool)) {
        revealed.delete(revealKey(server.id, toolName));
        return { text: "The tool or its schema changed while connecting. Search it again before execution.", isError: true, executed: false };
      }
    }
    if (isClosed()) return { text: "This MCP run has closed.", isError: true };
    try {
      return richOutcome(await callCloudMcpToolRich(state.session, toolName, callArgs));
    } catch (error) {
      const stepUp = await parkForStepUp(state, error);
      if (stepUp) {
        return { text: stepUp, isError: true };
      }
      return {
        text: `MCP tool failed (${server.name}): ${error instanceof Error ? error.message : "unknown error"}`,
        isError: true,
      };
    }
  };

  const toolset: McpToolset = {
    ...runtime,
    mode,
    promptNote,
    servers: infos,
    journal,
    close,
    owns(name) {
      return runtime.routes.has(name) || (mode === "deferred" && isMcpMetaToolName(name));
    },
    async execute(name, args) {
      if (isClosed()) return { text: "This MCP run has closed.", isError: true };
      const route = runtime.routes.get(name);
      if (route) {
        const state = route.type === "mcp" ? states.find((item) => item.server.id === route.serverId) : undefined;
        if (state?.stepUp) {
          // Parked after insufficient_scope — the same token would fail again.
          return { text: state.failure ?? describeStepUp(route.serverName, state.stepUp.scopes), isError: true };
        }
        // Policy gate: inline functions go through the same door as mcp_call_tool.
        const refused =
          route.type === "native"
            ? await gate(
                { id: route.serverId ?? route.kind, name: route.serverName },
                { name: route.toolName },
                route.kind,
                args,
                [route.auth],
              )
            : await gate(
                { id: route.serverId ?? "", name: route.serverName },
                state?.catalog?.find((tool) => tool.name === route.toolName) ?? { name: route.toolName },
                undefined,
                args,
                state ? cloudServerRedactions(state.server) : [],
              );
        if (refused) {
          return refused;
        }
        try {
          if (route.type === "native") {
            const output = await callNativeConnectorTool(route, args);
            return { text: output.trim().length > 0 ? output : "(empty result)" };
          }
          return richOutcome(await callCloudMcpToolRich(route.session, route.toolName, args));
        } catch (error) {
          const stepUp = state ? await parkForStepUp(state, error) : null;
          if (stepUp) {
            return { text: stepUp, isError: true };
          }
          return {
            text: `MCP tool failed (${route.serverName}): ${error instanceof Error ? error.message : "unknown error"}`,
            isError: true,
          };
        }
      }
      if (mode === "deferred" && name === MCP_SEARCH_TOOL_NAME) {
        if (states.length === 0) {
          return { text: "No MCP servers are connected in this run.", isError: true };
        }
        return runSearch(args);
      }
      if (mode === "deferred" && name === MCP_CALL_TOOL_NAME) {
        if (states.length === 0) {
          return { text: "No MCP servers are connected in this run.", isError: true };
        }
        return runCall(args);
      }
      return { text: `Tool "${name}" is not part of this run's MCP toolset.`, isError: true };
    },
  };
  return toolset;
}

/** A toolset with nothing armed — runs without connectors. */
export function idleToolset(): McpToolset {
  return {
    ...emptyMcpRuntime(),
    mode: "native",
    promptNote: "",
    servers: [],
    journal: [],
    close: () => undefined,
    owns: () => false,
    execute: async (name) => ({ text: `Tool "${name}" is not part of this run's MCP toolset.`, isError: true }),
  };
}

/**
 * Historical entry point: arms everything inline (native mode) with the run
 * soft caps. Health checks and tests keep calling it; new consumers use
 * resolveMcpToolset directly.
 */
export function armCloudMcp(
  servers: CloudMcpServer[],
  persist?: (rotation: RefreshedOAuth) => Promise<void>,
  reportFailure?: (serverId: string, outcome: CloudOAuthRefreshFailure) => Promise<void>,
  beginRefresh?: BeginCloudOAuthRefresh,
): Promise<McpToolset> {
  return resolveMcpToolset({ servers, mode: "native", persist, reportFailure, beginRefresh });
}

/** Human label for a chat row: "MCP · server · tool" for the meta functions. */
export function describeMcpMetaCall(name: string, argumentsJson: string): { server: string; detail: string } | null {
  if (!isMcpMetaToolName(name)) {
    return null;
  }
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as unknown;
    args = isRecord(parsed) ? parsed : {};
  } catch {
    args = {};
  }
  if (name === MCP_SEARCH_TOOL_NAME) {
    const query = typeof args.query === "string" ? args.query : "";
    const server = typeof args.serverId === "string" ? args.serverId : "";
    return { server: server || "all servers", detail: query ? `search “${query.slice(0, 60)}”` : "search" };
  }
  return {
    server: typeof args.serverId === "string" ? args.serverId : "?",
    detail: typeof args.toolName === "string" ? args.toolName : "…",
  };
}
