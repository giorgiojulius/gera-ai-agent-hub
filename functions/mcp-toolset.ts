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
//   handshake when the cache is cold), servers connect lazily on the first
//   call, and a tool may only be called after a search returned it in this
//   run. Schemas never reach the prompt until they are needed.
//
// The native GitHub / Slack / Intercom connectors always register inline:
// their static tables are first-party, bounded, and drive UI flows (code
// changes, repo preflight) by function name.
//
// Credentials never appear in records, prompt notes, or search results — the
// tool tables are already redacted by the transport (mcp-cloud.ts).

import type { ChatSql } from "./chat-shared";
import {
  callCloudMcpTool,
  cloudMcpFunctionName,
  cloudServerRedactions,
  connectCloudMcp,
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
  | { type: "mcp"; session: CloudMcpSession; toolName: string; serverName: string }
  | {
      type: "native";
      kind: "github" | "slack" | "intercom";
      /** Ready credential: full Authorization header for GitHub, raw token otherwise. */
      auth: string;
      toolName: string;
      serverName: string;
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

/** Auto flips to deferred above this many visible generic MCP tools. */
export const DEFERRED_AUTO_TOOL_THRESHOLD = 24;
/** …or when the tool schemas would take more than this share of the context window. */
export const DEFERRED_AUTO_CONTEXT_SHARE = 0.08;
/** Context window assumed when the gateway catalog did not say. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
/** Soft cap of inline MCP functions per run (native mode only). */
export const NATIVE_TOOL_CAP = 90;
/** Soft cap of inline MCP functions per server (native mode only). */
export const NATIVE_TOOLS_PER_SERVER = 500;
/** Deferred catalogs list up to this many tools per server. */
export const DEFERRED_TOOLS_PER_SERVER = 5_000;
/** Deferred catalogs refuse servers whose tool JSON exceeds this many characters. */
export const DEFERRED_SCHEMA_CHARS = 6_000_000;
/** Catalog cache freshness window. */
export const CATALOG_TTL_MS = 10 * 60_000;
export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 20;
/** Rendered search results never exceed this many characters. */
const SEARCH_RESULT_CHARS = 60_000;
/** Cloud SQLite rows have a hard size limit; larger catalogs stay uncached. */
const CATALOG_ROW_CHARS = 1_500_000;
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
          "Search the tools of the user's connected MCP servers (deferred loading — their schemas are not preloaded). Full-text over tool names, descriptions and input fields. Returns up to `limit` tool descriptors with complete input schemas plus every server with its tool count. Always search before mcp_call_tool; only tools returned here can be called.",
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
          "Run one MCP tool that mcp_search_tools returned in this conversation. Pass the exact serverId and toolName from the search result and an arguments object matching the tool's inputSchema. The result is the tool's text output.",
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
// Catalog cache.

export type McpCatalogEntry = {
  serverId: string;
  serverName: string;
  /** The full remote table (disabled tools included) — filtering happens per run. */
  tools: CloudMcpTool[];
  fetchedAt: number;
};

export type McpCatalogStore = {
  read(serverId: string): McpCatalogEntry | null;
  write(entry: McpCatalogEntry): void;
  invalidate(serverId: string): void;
};

/** In-memory store — tests and one-off probes. */
export function createMemoryMcpCatalogStore(): McpCatalogStore {
  const entries = new Map<string, McpCatalogEntry>();
  return {
    read: (serverId) => entries.get(serverId) ?? null,
    write: (entry) => {
      entries.set(entry.serverId, entry);
    },
    invalidate: (serverId) => {
      entries.delete(serverId);
    },
  };
}

const CATALOG_TABLE_READY = new WeakSet<object>();

function ensureCatalogTable(sql: ChatSql): void {
  if (CATALOG_TABLE_READY.has(sql)) {
    return;
  }
  sql.exec(`
    CREATE TABLE IF NOT EXISTS mcp_tool_catalog (
      owner_email TEXT NOT NULL,
      server_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_email, server_id)
    )
  `);
  CATALOG_TABLE_READY.add(sql);
}

function normalizeCatalogTools(value: unknown): CloudMcpTool[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const tools: CloudMcpTool[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name) {
      continue;
    }
    tools.push({
      name: raw.name,
      description: typeof raw.description === "string" ? raw.description : raw.name,
      inputSchema: isRecord(raw.inputSchema) ? raw.inputSchema : { type: "object", properties: {} },
    });
  }
  return tools;
}

/**
 * Account-shard catalog table (`mcp_tool_catalog`). Interactive runs live
 * inside the ChatStore and read it directly; `/mcp/check` refreshes it on
 * every Re-check; project agents receive entries through `/mcp/resolve`.
 */
export function createSqlMcpCatalogStore(sql: ChatSql, owner: string): McpCatalogStore {
  ensureCatalogTable(sql);
  return {
    read(serverId) {
      const row = sql
        .exec<{ payload: string; updated_at: number }>(
          "SELECT payload, updated_at FROM mcp_tool_catalog WHERE owner_email = ? AND server_id = ?",
          owner,
          serverId,
        )
        .toArray()[0];
      if (!row) {
        return null;
      }
      try {
        const parsed = JSON.parse(row.payload) as unknown;
        if (!isRecord(parsed)) {
          return null;
        }
        return {
          serverId,
          serverName: typeof parsed.serverName === "string" ? parsed.serverName : serverId,
          tools: normalizeCatalogTools(parsed.tools),
          fetchedAt: row.updated_at,
        };
      } catch {
        return null;
      }
    },
    write(entry) {
      const payload = JSON.stringify({ v: 1, serverName: entry.serverName, tools: entry.tools });
      if (payload.length > CATALOG_ROW_CHARS) {
        return; // oversized tables stay uncached — the run still connects live
      }
      sql.exec(
        "INSERT OR REPLACE INTO mcp_tool_catalog (owner_email, server_id, payload, updated_at) VALUES (?, ?, ?, ?)",
        owner,
        entry.serverId,
        payload,
        entry.fetchedAt,
      );
    },
    invalidate(serverId) {
      sql.exec("DELETE FROM mcp_tool_catalog WHERE owner_email = ? AND server_id = ?", owner, serverId);
    },
  };
}

/** Revives catalog entries shipped over an internal JSON hop (`/mcp/resolve`). */
export function normalizeMcpCatalogEntries(raw: unknown): McpCatalogEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: McpCatalogEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.serverId !== "string" || !item.serverId) {
      continue;
    }
    out.push({
      serverId: item.serverId,
      serverName: typeof item.serverName === "string" && item.serverName ? item.serverName : item.serverId,
      tools: normalizeCatalogTools(item.tools),
      fetchedAt: typeof item.fetchedAt === "number" && Number.isFinite(item.fetchedAt) ? item.fetchedAt : 0,
    });
  }
  return out;
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
 * tools are few and their schemas small; beyond the thresholds the model gets
 * the two meta functions instead of one function per tool.
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
  if (visible.toolCount > DEFERRED_AUTO_TOOL_THRESHOLD || schemaTokens > window * DEFERRED_AUTO_CONTEXT_SHARE) {
    return "deferred";
  }
  return "native";
}

// ---------------------------------------------------------------------------
// Native connectors (static tables; no handshake).

const NATIVE_TOOL_TABLES = {
  github: GITHUB_NATIVE_TOOLS,
  slack: SLACK_NATIVE_TOOLS,
  intercom: INTERCOM_NATIVE_TOOLS,
} as const;

/** Arms one native connector from its static tool table. */
function armNativeServer(runtime: McpRuntime, server: CloudMcpServer, cap: number): void {
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
    if (runtime.routes.size >= cap) {
      break;
    }
    if (server.disabledTools.includes(tool.name)) {
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

export type McpToolOutcome = { text: string; isError?: boolean };

export type McpToolsetServerInfo = {
  id: string;
  name: string;
  kind: CloudMcpServer["kind"];
  /** Tools visible to this run (disabled ones excluded); -1 while unknown. */
  toolCount: number;
  deferred: boolean;
  /** Honest reason when the server contributes nothing this run. */
  unavailable?: string;
};

export type McpToolset = McpRuntime & {
  mode: McpToolsetMode;
  /** System-prompt guidance for deferred servers; "" when everything is inline. */
  promptNote: string;
  servers: McpToolsetServerInfo[];
  /** True when this toolset executes `name` (inline route or meta function). */
  owns(name: string): boolean;
  /** Runs an inline or meta tool call; tool failures come back as isError outcomes. */
  execute(name: string, args: Record<string, unknown>): Promise<McpToolOutcome>;
};

export type ResolveMcpToolsetOptions = {
  /** Resolved connectors (auth already attached) — see cloudMcpServersForAutomation. */
  servers: CloudMcpServer[];
  /** Account setting; unknown values behave as "auto". */
  mode?: McpToolLoadingMode;
  /** Interactive surfaces can pause for the user later (Phase 4); background ones cannot. */
  surface?: "interactive" | "background";
  /** Context window of the run's model; unknown → 128k. */
  contextWindowTokens?: number;
  catalog?: McpCatalogStore;
  /** Lift the native soft caps (health checks want the complete table). */
  uncapped?: boolean;
  /** Override the per-run inline cap — callers that already registered other functions pass what is left. */
  nativeCap?: number;
  persist?: (rotation: RefreshedOAuth) => Promise<void>;
  reportFailure?: (serverId: string, outcome: CloudOAuthRefreshFailure) => Promise<void>;
  beginRefresh?: BeginCloudOAuthRefresh;
  /**
   * Project agents: re-resolve a server through the owner's account after an
   * auth-rejected connect (the owner's shard refreshes and persists). When set,
   * grants are never rotated locally.
   */
  reconnect?: (serverId: string) => Promise<CloudMcpServer | null>;
  now?: () => number;
};

type ServerState = {
  server: CloudMcpServer;
  catalog: CloudMcpTool[] | null;
  session: CloudMcpSession | null;
  connecting: Promise<void> | null;
  failure: string | null;
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

function visibleTools(state: ServerState): CloudMcpTool[] {
  if (!state.catalog) {
    return [];
  }
  const disabled = new Set(state.server.disabledTools);
  return state.catalog.filter((tool) => !disabled.has(tool.name));
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
  const nativeCap = options.uncapped
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.floor(options.nativeCap ?? NATIVE_TOOL_CAP));
  const perServerCap = options.uncapped ? Number.POSITIVE_INFINITY : NATIVE_TOOLS_PER_SERVER;

  // 1. Expiring grants refresh before anything connects.
  const unavailable = new Set<string>();
  for (const server of options.servers) {
    if (!server.oauth) {
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
  for (const server of options.servers) {
    if (server.kind === "mcp") {
      continue;
    }
    if (unavailable.has(server.id)) {
      infos.push({ id: server.id, name: server.name, kind: server.kind, toolCount: 0, deferred: false, unavailable: "sign-in must be renewed" });
      continue;
    }
    const before = runtime.routes.size;
    armNativeServer(runtime, server, nativeCap);
    infos.push({ id: server.id, name: server.name, kind: server.kind, toolCount: runtime.routes.size - before, deferred: false });
  }

  // 3. Generic MCP servers.
  const states: ServerState[] = options.servers
    .filter((server) => server.kind === "mcp" && !unavailable.has(server.id))
    .map((server) => {
      const cached = options.catalog?.read(server.id) ?? null;
      const fresh = cached !== null && now() - cached.fetchedAt < CATALOG_TTL_MS;
      return { server, catalog: fresh ? cached.tools : null, session: null, connecting: null, failure: null };
    });

  const connectRaw = async (server: CloudMcpServer): Promise<{ session: CloudMcpSession; tools: CloudMcpTool[] }> =>
    connectCloudMcp(server, { maxTools: DEFERRED_TOOLS_PER_SERVER, includeDisabled: true });

  /** One handshake per server per run; auth rejections get one repair attempt. */
  const connect = (state: ServerState): Promise<void> => {
    if (state.connecting) {
      return state.connecting;
    }
    state.connecting = (async () => {
      const attempt = async (): Promise<{ session: CloudMcpSession; tools: CloudMcpTool[] }> => {
        try {
          return await connectRaw(state.server);
        } catch (error) {
          const message = error instanceof Error ? error.message : "connect failed";
          if (!/auth rejected/i.test(message)) {
            throw error;
          }
          if (options.reconnect) {
            const fresh = await options.reconnect(state.server.id).catch(() => null);
            if (fresh) {
              state.server = fresh;
              return connectRaw(fresh);
            }
            throw error;
          }
          // The recorded expiry may be missing or wrong (no expires_in, revoked
          // early). Redeem the refresh token once and retry — mirrors the
          // browser's 401 replay, so a sleeping sign-in repairs instead of failing.
          if (state.server.oauth?.refreshToken) {
            const outcome = await forceRefreshCloudOAuthOutcome(
              state.server,
              runtime.refreshed,
              options.persist,
              options.beginRefresh,
            ).catch(() => null);
            if (outcome?.ok === false) {
              await options.reportFailure?.(state.server.id, outcome);
            }
            if (outcome?.ok) {
              return connectRaw(state.server);
            }
          }
          throw error;
        }
      };
      try {
        const connection = await attempt();
        state.session = connection.session;
        state.catalog = connection.tools;
        state.failure = null;
        const tableChars = jsonText(connection.tools).length;
        if (tableChars > DEFERRED_SCHEMA_CHARS) {
          state.failure = `publishes ${connection.tools.length} tools whose schemas exceed ${Math.round(DEFERRED_SCHEMA_CHARS / 1_000_000)} MB — too large to search`;
          state.catalog = null;
          return;
        }
        options.catalog?.write({
          serverId: state.server.id,
          serverName: state.server.name,
          tools: connection.tools,
          fetchedAt: now(),
        });
      } catch (error) {
        const raw = error instanceof Error ? error.message : "connect failed";
        state.failure = redactCloudMcpText(raw, cloudServerRedactions(state.server));
      }
    })();
    return state.connecting;
  };

  const connectMissing = (predicate: (state: ServerState) => boolean): Promise<void[]> =>
    Promise.all(states.filter((state) => !state.failure && predicate(state)).map((state) => connect(state)));

  // Auto needs the tables before it can choose; cold caches connect now.
  let mode: McpToolsetMode;
  if (requested === "auto") {
    await connectMissing((state) => state.catalog === null);
    const tools = states.flatMap((state) => visibleTools(state));
    mode = decideMcpToolLoading(
      "auto",
      { toolCount: tools.length, schemaChars: jsonText(tools.map((tool) => tool.inputSchema)).length },
      options.contextWindowTokens,
    );
  } else {
    mode = requested;
  }

  const revealed = new Set<string>();
  const revealKey = (serverId: string, toolName: string): string => `${serverId}\u0000${toolName}`;

  if (mode === "native") {
    await connectMissing((state) => state.session === null);
    for (const state of states) {
      const server = state.server;
      if (state.failure || !state.session) {
        const reason = state.failure ?? "connect failed";
        runtime.failures.push({
          name: "mcp_connect",
          arguments: server.name,
          result: `Could not connect MCP server "${server.name}": ${reason}`,
        });
        infos.push({ id: server.id, name: server.name, kind: "mcp", toolCount: 0, deferred: false, unavailable: reason });
        continue;
      }
      const visible = visibleTools(state);
      let added = 0;
      let skipped = 0;
      for (const tool of visible) {
        if (added >= perServerCap || runtime.routes.size >= nativeCap) {
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
      infos.push({ id: server.id, name: server.name, kind: "mcp", toolCount: added, deferred: false });
      if (skipped > 0) {
        runtime.failures.push({
          name: "mcp_limit",
          arguments: server.name,
          result: `${skipped} of ${visible.length} tools on MCP server "${server.name}" did not fit the native limit (${NATIVE_TOOL_CAP} MCP functions per run, ${NATIVE_TOOLS_PER_SERVER} per server) and are unavailable this run. Switch "MCP tool loading" to Deferred in Settings → Toolkit to make every tool searchable.`,
        });
      }
    }
  } else {
    // Deferred: a searchable table is all the start needs — cold caches
    // connect once; everything else waits for the first call.
    await connectMissing((state) => state.catalog === null);
    for (const state of states) {
      const server = state.server;
      if (state.failure || !state.catalog) {
        const reason = state.failure ?? "connect failed";
        runtime.failures.push({
          name: "mcp_connect",
          arguments: server.name,
          result: `Could not connect MCP server "${server.name}": ${reason}`,
        });
        infos.push({ id: server.id, name: server.name, kind: "mcp", toolCount: 0, deferred: true, unavailable: reason });
        continue;
      }
      const count = visibleTools(state).length;
      runtime.summary.push(`${server.name} (${count} tools · deferred)`);
      infos.push({ id: server.id, name: server.name, kind: "mcp", toolCount: count, deferred: true });
    }
    if (states.some((state) => state.catalog !== null)) {
      runtime.toolDefs.push(...mcpMetaToolDefinitions());
    }
  }

  const deferredInfos = infos.filter((info) => info.deferred && !info.unavailable);
  const promptNote =
    mode === "deferred" && deferredInfos.length > 0
      ? [
          `MCP servers are connected in deferred mode — their tools are NOT listed as functions. Discover them with ${MCP_SEARCH_TOOL_NAME}({ query, serverId?, limit? }) (full-text over names, descriptions and input fields; returns descriptors with complete schemas), then run one with ${MCP_CALL_TOOL_NAME}({ serverId, toolName, arguments }). Only tools a search returned in this conversation can be called.`,
          `Servers: ${deferredInfos.map((info) => `${info.id} "${info.name}" · ${info.toolCount} tools`).join("; ")}.`,
        ].join(" ")
      : "";

  const searchable = (): McpSearchableServer[] =>
    states
      .filter((state) => state.catalog !== null && !state.failure)
      .map((state) => ({ serverId: state.server.id, serverName: state.server.name, tools: visibleTools(state) }));

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

  const runSearch = (args: Record<string, unknown>): McpToolOutcome => {
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
    const scopeId = serverId ? findState(serverId)?.server.id : undefined;
    const hits = searchMcpTools(searchable(), query, { serverId: scopeId, limit });
    for (const hit of hits) {
      revealed.add(revealKey(hit.serverId, hit.tool.name));
    }
    const servers = states.map((state) => ({
      serverId: state.server.id,
      name: state.server.name,
      toolCount: state.catalog ? visibleTools(state).length : 0,
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
              ? "No tools matched. Try other keywords, a broader query, or an empty query to list tools."
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
      shown = [{ ...shown[0], inputSchema: { _note: "schema omitted: too large to render" } }];
      text = render(shown, matches.length - 1);
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
    if (state.failure || !state.catalog) {
      return { text: `MCP server "${server.name}" is unavailable this run: ${state.failure ?? "connect failed"}.`, isError: true };
    }
    if (server.disabledTools.includes(toolName)) {
      return { text: `Tool "${toolName}" on MCP server "${server.name}" is disabled by the user in this server's tool settings.`, isError: true };
    }
    if (!state.catalog.some((tool) => tool.name === toolName)) {
      return { text: `MCP server "${server.name}" has no tool named "${toolName}". Find the exact name with ${MCP_SEARCH_TOOL_NAME} first.`, isError: true };
    }
    if (!revealed.has(revealKey(server.id, toolName))) {
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
    if (!state.session) {
      await connect(state);
      if (state.failure || !state.session) {
        return { text: `MCP tool failed (${server.name}): ${state.failure ?? "connect failed"}`, isError: true };
      }
    }
    try {
      const output = await callCloudMcpTool(state.session, toolName, callArgs);
      return { text: output.trim().length > 0 ? output : "(empty result)" };
    } catch (error) {
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
    owns(name) {
      return runtime.routes.has(name) || (mode === "deferred" && isMcpMetaToolName(name));
    },
    async execute(name, args) {
      const route = runtime.routes.get(name);
      if (route) {
        try {
          const output =
            route.type === "native"
              ? await callNativeConnectorTool(route, args)
              : await callCloudMcpTool(route.session, route.toolName, args);
          return { text: output.trim().length > 0 ? output : "(empty result)" };
        } catch (error) {
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
