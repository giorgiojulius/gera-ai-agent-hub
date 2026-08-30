import { newId } from "@/lib/env";
import { GITHUB_NATIVE_TOOLS, callGitHubNativeTool, resolveGitHubAuth, verifyGitHubNative } from "@/lib/github-native";
import { INTERCOM_NATIVE_TOOLS, callIntercomNativeTool, verifyIntercomToken } from "@/lib/intercom-native";
import { findCatalogEntry } from "@/lib/mcp-catalog";
import { clearOAuthToken, forceRefreshOAuthHeader, oauthAuthHeader } from "@/lib/mcp-oauth";
import { SLACK_NATIVE_TOOLS, callSlackNativeTool, verifySlackToken } from "@/lib/slack-native";
import type { McpAuthMode, McpServerConfig, McpToolInfo, OpenAiTool } from "@/lib/types";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type McpSession = {
  configId: string;
  url: string;
  headers: Record<string, string>;
  usedOAuth: boolean;
  /** Skip custom MCP headers for hosts whose CORS preflight rejects them (Google). */
  omitMcpHeaders: boolean;
  sessionId?: string;
  nextId: number;
};

const sessions = new Map<string, McpSession>();

const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Auth is truly dead — a key or a fresh sign-in is required; not a transient failure. */
export class McpAuthError extends Error {}

/** The server dropped our Mcp-Session-Id (idle expiry) — a reconnect plus one replay is safe. */
export class McpSessionLostError extends Error {
  constructor() {
    super("MCP session expired — reconnecting.");
  }
}

/**
 * Streamable-HTTP session expiry per the MCP spec: servers answer 404 (some
 * 400 with a session complaint) to a request carrying a stale Mcp-Session-Id.
 * Only meaningful once a session id was issued — before that, a 404 simply
 * means the URL is wrong.
 */
export function isSessionLostSignal(status: number, body: string, hasSession: boolean): boolean {
  if (!hasSession) {
    return false;
  }
  if (status === 404) {
    return true;
  }
  return status === 400 && /session/i.test(body);
}

/**
 * JSON-RPC phrasing of the same condition ("Session not found", "session
 * expired", "Invalid session ID"). Deliberately strict — a call that failed
 * this way was never executed, so replaying it after a reconnect cannot
 * double-fire a side effect.
 */
export function isSessionLostRpcMessage(message: string, hasSession: boolean): boolean {
  return (
    hasSession &&
    /session/i.test(message) &&
    /(expired|not found|invalid|unknown|terminated|missing)/i.test(message)
  );
}

const FUNCTIONS_URL = (() => {
  const url = import.meta.env.EXPO_PUBLIC_RORK_FUNCTIONS_URL;
  if (typeof url === "string" && url.trim().length > 0) {
    return url.trim().replace(/\/$/, "");
  }
  return "https://gera-ai-agent-hub-backend.rork.app";
})();

function mcpProxyUrl(target: string): string {
  return `${FUNCTIONS_URL}/mcp-proxy?url=${encodeURIComponent(target)}`;
}

/**
 * Every MCP request goes through the Gera backend relay — never straight from
 * the browser. Most MCP servers omit CORS headers or reject preflights, so
 * direct browser calls fail unpredictably per server; the relay makes them all
 * behave the same and forwards auth headers untouched.
 */
async function mcpFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(mcpProxyUrl(url), init);
}

function parseCustomHeaders(config: McpServerConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!config.headersJson?.trim()) {
    return headers;
  }
  const parsed = JSON.parse(config.headersJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Headers must be a JSON object.");
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") {
      headers[key] = value;
    }
  }
  return headers;
}

/**
 * Resolves the endpoint URL and auth headers for a server, honoring its
 * authMode: "none" sends nothing, "bearer" requires a pasted key, "headers"
 * sends only the custom JSON headers, "oauth" requires a stored sign-in, and
 * "auto" (default) tries key → headers → stored sign-in → open access.
 * Pasted keys follow the catalog's token placement (header, query param, or
 * URL template) when the server comes from the catalog.
 */
async function buildAuth(
  config: McpServerConfig,
): Promise<{ url: string; headers: Record<string, string>; usedOAuth: boolean; omitMcpHeaders: boolean }> {
  const entry = findCatalogEntry(config.catalogId ?? config.id);
  const omitMcpHeaders = Boolean(entry?.omitMcpHeaders);
  const mode: McpAuthMode = config.authMode ?? "auto";
  let url = config.url.trim();

  if (mode === "none") {
    return { url, headers: {}, usedOAuth: false, omitMcpHeaders };
  }
  if (mode === "oauth") {
    const oauth = await oauthAuthHeader(config.id);
    if (!oauth) {
      throw new McpAuthError("Sign-in required — press Sign in to authorize in the browser.");
    }
    return { url, headers: { Authorization: oauth }, usedOAuth: true, omitMcpHeaders };
  }

  const headers = mode === "bearer" ? {} : parseCustomHeaders(config);
  const token = mode === "headers" ? "" : (config.token?.trim() ?? "");
  if (mode === "bearer" && !token) {
    throw new McpAuthError("Paste a Bearer token first — this server is set to token auth.");
  }
  if (token) {
    if (entry?.tokenUrlTemplate) {
      url = entry.tokenUrlTemplate.replace("{token}", encodeURIComponent(token));
    } else if (entry?.tokenQueryParam) {
      const glue = url.includes("?") ? "&" : "?";
      url = `${url}${glue}${entry.tokenQueryParam}=${encodeURIComponent(token)}`;
    } else {
      headers.Authorization = token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
    }
    return { url, headers, usedOAuth: false, omitMcpHeaders };
  }
  if (!headers.Authorization) {
    const oauth = await oauthAuthHeader(config.id);
    if (oauth) {
      headers.Authorization = oauth;
      return { url, headers, usedOAuth: true, omitMcpHeaders };
    }
  }
  return { url, headers, usedOAuth: false, omitMcpHeaders };
}

function mcpProtocolHeaders(session: McpSession): Record<string, string> {
  if (session.omitMcpHeaders) {
    return {};
  }
  return {
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    ...(session.sessionId ? { "Mcp-Session-Id": session.sessionId } : {}),
  };
}

function parseSseJson(body: string): JsonRpcResponse {
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    return JSON.parse(payload) as JsonRpcResponse;
  }
  return JSON.parse(body) as JsonRpcResponse;
}

async function rpc(session: McpSession, method: string, params?: unknown): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Sessions are cached across turns; re-resolve the header so a token
    // refreshed since connect (or by a parallel call) is actually used.
    if (session.usedOAuth) {
      const header = await oauthAuthHeader(session.configId);
      if (header) {
        session.headers.Authorization = header;
      }
    }

    session.nextId += 1;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: session.nextId,
      method,
      params,
    };

    let response: Response;
    try {
      response = await mcpFetch(session.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...mcpProtocolHeaders(session),
          ...session.headers,
        },
        body: JSON.stringify(request),
      });
    } catch {
      throw new Error("Could not reach the Gera relay. Check your connection and try again.");
    }

    const sessionHeader = response.headers.get("mcp-session-id");
    if (sessionHeader) {
      session.sessionId = sessionHeader;
    }

    const text = await response.text();
    if (!response.ok) {
      if (isSessionLostSignal(response.status, text, Boolean(session.sessionId))) {
        // The server forgot us while idle — drop the cache; callers replay once.
        sessions.delete(session.configId);
        throw new McpSessionLostError();
      }
      if (response.status === 401 || response.status === 403) {
        if (session.usedOAuth && attempt === 0) {
          // The access token may have been revoked before its recorded expiry.
          // Redeem the refresh token once and replay the request.
          const refreshed = await forceRefreshOAuthHeader(session.configId);
          if (refreshed) {
            session.headers.Authorization = refreshed;
            continue;
          }
        }
        if (session.usedOAuth) {
          clearOAuthToken(session.configId);
          sessions.delete(session.configId);
          throw new McpAuthError("Sign-in expired. Press Sign in to authorize again.");
        }
        throw new McpAuthError("This server needs a key or sign-in before it will talk.");
      }
      throw new Error(
        response.status === 502 && text.includes("upstream_unreachable")
          ? "The MCP server did not answer — it may be down or unreachable."
          : `MCP server returned ${response.status}.`,
      );
    }

    let parsed: JsonRpcResponse;
    try {
      parsed = text.trim().startsWith("{") ? (JSON.parse(text) as JsonRpcResponse) : parseSseJson(text);
    } catch {
      throw new Error("MCP server sent an unexpected response.");
    }

    if (parsed.error) {
      const message = parsed.error.message || "MCP request failed.";
      if (isSessionLostRpcMessage(message, Boolean(session.sessionId))) {
        sessions.delete(session.configId);
        throw new McpSessionLostError();
      }
      throw new Error(message);
    }
    return parsed.result;
  }

  throw new Error("MCP request failed after refreshing sign-in.");
}

export type McpConnection = {
  tools: McpToolInfo[];
  /** Human-readable proof of what was verified: workspace + admin for native connectors, server name for MCP. */
  identity?: string;
};

export async function connectMcpServer(config: McpServerConfig): Promise<McpConnection> {
  const entry = findCatalogEntry(config.catalogId ?? config.id);
  if (entry?.native === "slack") {
    const token = config.token?.trim();
    if (!token) {
      throw new Error("Paste a Slack Bot token (xoxb-…) or User token (xoxp-…) first.");
    }
    const slack = await verifySlackToken(token);
    return {
      tools: SLACK_NATIVE_TOOLS.map((tool) => ({ ...tool })),
      identity: `${slack.team} — ${slack.user}`,
    };
  }
  if (entry?.native === "intercom") {
    const token = config.token?.trim();
    if (!token) {
      throw new Error("Paste an Intercom Access Token (Developer Hub → Authentication) first.");
    }
    const intercom = await verifyIntercomToken(token);
    return {
      tools: INTERCOM_NATIVE_TOOLS.map((tool) => ({ ...tool })),
      identity: `${intercom.admin.appName} — ${intercom.admin.name} (${intercom.region.toUpperCase()})`,
    };
  }
  if (entry?.native === "github") {
    // Native GitHub: REST API straight from the browser with the device-flow
    // token or a pasted PAT — verifies who the token belongs to on connect.
    const auth = await resolveGitHubAuth(config);
    const verified = await verifyGitHubNative(auth);
    return {
      tools: GITHUB_NATIVE_TOOLS.map((tool) => ({ ...tool })),
      identity: verified.identity,
    };
  }
  const auth = await buildAuth(config);
  const session: McpSession = {
    configId: config.id,
    url: auth.url,
    headers: auth.headers,
    usedOAuth: auth.usedOAuth,
    omitMcpHeaders: auth.omitMcpHeaders,
    nextId: 0,
  };

  const initResult = (await rpc(session, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    clientInfo: { name: "Gera AI", version: "1.0.0" },
  })) as { serverInfo?: { name?: unknown; version?: unknown } } | null;

  try {
    await mcpFetch(session.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...mcpProtocolHeaders(session),
        ...session.headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
  } catch {
    // notification is best-effort
  }

  const listed = (await rpc(session, "tools/list", {})) as { tools?: Array<Record<string, unknown>> };
  const tools: McpToolInfo[] = (listed.tools ?? []).map((tool) => ({
    name: String(tool.name ?? ""),
    description: typeof tool.description === "string" ? tool.description : undefined,
    inputSchema:
      tool.inputSchema && typeof tool.inputSchema === "object"
        ? (tool.inputSchema as Record<string, unknown>)
        : { type: "object", properties: {} },
  })).filter((tool) => tool.name.length > 0);

  sessions.set(config.id, session);
  const info = initResult?.serverInfo;
  const serverName = typeof info?.name === "string" && info.name.trim() ? info.name.trim() : "";
  const serverVersion = typeof info?.version === "string" && info.version.trim() ? ` v${info.version.trim()}` : "";
  return { tools, identity: serverName ? `${serverName}${serverVersion}` : undefined };
}

export async function callMcpTool(config: McpServerConfig, name: string, args: unknown): Promise<string> {
  const entry = findCatalogEntry(config.catalogId ?? config.id);
  if (entry?.native === "slack") {
    const token = config.token?.trim();
    if (!token) {
      throw new Error("Slack token is missing. Add it in Connections and press Connect.");
    }
    return callSlackNativeTool(token, name, args);
  }
  if (entry?.native === "intercom") {
    const token = config.token?.trim();
    if (!token) {
      throw new Error("Intercom token is missing. Add it in Connections and press Connect.");
    }
    return callIntercomNativeTool(token, name, args);
  }
  if (entry?.native === "github") {
    const auth = await resolveGitHubAuth(config);
    return callGitHubNativeTool(auth, name, args);
  }
  let session = sessions.get(config.id);
  if (!session) {
    await connectMcpServer(config);
    session = sessions.get(config.id);
  }
  if (!session) {
    throw new Error("MCP server is not connected.");
  }

  try {
    const result = await rpc(session, "tools/call", { name, arguments: args ?? {} });
    return stringifyMcpResult(result);
  } catch (error) {
    if (!(error instanceof McpSessionLostError)) {
      throw error;
    }
    // Idle servers expire sessions; "connect once and forget" means the user
    // never notices. Re-handshake with the stored auth and replay the call
    // exactly once — the failed call never executed, so nothing double-fires.
    await connectMcpServer(config);
    const fresh = sessions.get(config.id);
    if (!fresh) {
      throw new Error("MCP server is not connected.");
    }
    const result = await rpc(fresh, "tools/call", { name, arguments: args ?? {} });
    return stringifyMcpResult(result);
  }
}

/**
 * Native connectors' tool tables are code, not handshake state — serve them
 * live so newly shipped tools appear without a reconnect. Stored server.tools
 * still applies to real MCP servers (their list comes from the handshake).
 */
function nativeToolTable(server: Pick<McpServerConfig, "id" | "catalogId">): McpToolInfo[] | null {
  const entry = findCatalogEntry(server.catalogId ?? server.id);
  if (entry?.native === "slack") {
    return SLACK_NATIVE_TOOLS;
  }
  if (entry?.native === "intercom") {
    return INTERCOM_NATIVE_TOOLS;
  }
  if (entry?.native === "github") {
    return GITHUB_NATIVE_TOOLS;
  }
  return null;
}

export function mcpToolsToOpenAi(servers: McpServerConfig[]): OpenAiTool[] {
  const tools: OpenAiTool[] = [];
  for (const server of servers) {
    if (!server.enabled || server.status !== "connected") {
      continue;
    }
    for (const tool of nativeToolTable(server) ?? server.tools) {
      if (server.disabledTools.includes(tool.name)) {
        continue;
      }
      tools.push({
        type: "function",
        function: {
          name: mcpFunctionName(server.id, tool.name),
          description: `[MCP:${server.name}] ${tool.description ?? tool.name}`,
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
        },
      });
    }
  }
  return tools;
}

function compactId(id: string): string {
  return id.replace(/-/g, "");
}

export function mcpFunctionName(serverId: string, toolName: string): string {
  return `mcp_${compactId(serverId)}_${safeName(toolName)}`.slice(0, 64);
}

export function findServerForTool(servers: McpServerConfig[], functionName: string): {
  server: McpServerConfig;
  toolName: string;
} | null {
  if (!functionName.startsWith("mcp_")) {
    return null;
  }
  const rest = functionName.slice(4);
  for (const server of servers) {
    if (!server.enabled) {
      continue;
    }
    const prefix = `${compactId(server.id)}_`;
    if (!rest.startsWith(prefix) && !rest.startsWith(compactId(server.id))) {
      continue;
    }
    const toolPart = rest.startsWith(prefix) ? rest.slice(prefix.length) : "";
    const tool = (nativeToolTable(server) ?? server.tools).find((item) => {
      const safe = safeName(item.name);
      return safe === toolPart || safe.startsWith(toolPart) || toolPart.startsWith(safe) || item.name === toolPart;
    });
    if (tool) {
      return { server, toolName: tool.name };
    }
  }
  return null;
}

export function newMcpServer(): McpServerConfig {
  return {
    id: newId(),
    name: "MCP server",
    url: "",
    headersJson: "",
    enabled: true,
    status: "idle",
    tools: [],
    disabledTools: [],
  };
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "server";
}

function stringifyMcpResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (result && typeof result === "object" && "content" in (result as Record<string, unknown>)) {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (part && typeof part === "object" && "text" in part) {
            return String((part as { text: unknown }).text);
          }
          return JSON.stringify(part);
        })
        .join("\n");
    }
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
