import { AuthSessionChangedError, RelayAccessError, relayFetch } from "@/lib/backend";
import { newId } from "@/lib/env";
import { GitHubAuthError } from "@/lib/github-device";
import { GITHUB_NATIVE_TOOLS, callGitHubNativeTool, resolveGitHubAuth, verifyGitHubNative } from "@/lib/github-native";
import {
  INTERCOM_NATIVE_TOOLS,
  callIntercomNativeTool,
  isIntercomCredentialError,
  verifyIntercomToken,
} from "@/lib/intercom-native";
import { findCatalogEntry } from "@/lib/mcp-catalog";
import {
  clearOAuthToken,
  forceRefreshOAuthHeader,
  hasOAuthRefreshToken,
  hasOAuthToken,
  oauthAuthHeader,
  oauthTokenFingerprint,
} from "@/lib/mcp-oauth";
import {
  SLACK_NATIVE_TOOLS,
  callSlackNativeTool,
  isSlackCredentialError,
  verifySlackToken,
} from "@/lib/slack-native";
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
  generation: number;
  configFingerprint: string;
  configUrl: string;
  url: string;
  headers: Record<string, string>;
  usedOAuth: boolean;
  oauthFingerprint?: string;
  protocolVersion: string;
  /** Skip custom MCP headers for hosts whose CORS preflight rejects them (Google). */
  omitMcpHeaders: boolean;
  sessionId?: string;
  nextId: number;
};

const sessions = new Map<string, McpSession>();
let sessionGeneration = 0;

/** Drops every in-memory session/header copy when the signed-in Gera account leaves. */
export function clearMcpSessionCache(): void {
  sessionGeneration += 1;
  sessions.clear();
}

/** Drops one cached handshake when its URL/auth settings or credential changes. */
export function clearMcpServerSession(serverId: string): void {
  sessions.delete(serverId);
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

function shortHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function mcpConfigFingerprint(config: McpServerConfig): string {
  return [
    config.id,
    config.catalogId ?? "",
    config.url.trim(),
    config.authMode ?? "auto",
    shortHash(config.token ?? ""),
    shortHash(config.headersJson ?? ""),
  ].join("|");
}

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
  return status === 404;
}

/**
 * Recognizes common non-standard JSON-RPC session wording for diagnostics.
 * It is deliberately NOT used for automatic tool replay: unlike the MCP
 * HTTP 404 signal, a tool may already have performed a side effect before
 * returning an application-level error.
 */
export function isSessionLostRpcMessage(message: string, hasSession: boolean): boolean {
  return (
    hasSession &&
    /session/i.test(message) &&
    /(expired|not found|invalid|unknown|terminated|missing)/i.test(message)
  );
}

/**
 * Every MCP request goes through the authenticated Gera backend relay — never
 * straight from the browser. Provider Authorization is separated from Gera's
 * own JWT by relayFetch and restored only after the account gate.
 */
async function mcpFetch(url: string, init: RequestInit): Promise<Response> {
  return relayFetch("/mcp-proxy", url, init);
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
    const hadRefreshableGrant = hasOAuthToken(config.id, url) && hasOAuthRefreshToken(config.id);
    const oauth = await oauthAuthHeader(config.id, url);
    if (!oauth) {
      if (hadRefreshableGrant && hasOAuthToken(config.id, url)) {
        throw new Error("Could not refresh this sign-in right now — retry shortly; your session was kept.");
      }
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
    } else if (entry?.tokenHeader) {
      headers[entry.tokenHeader] = token;
    } else if (entry?.tokenQueryParam) {
      const glue = url.includes("?") ? "&" : "?";
      url = `${url}${glue}${entry.tokenQueryParam}=${encodeURIComponent(token)}`;
    } else {
      headers.Authorization = token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
    }
    return { url, headers, usedOAuth: false, omitMcpHeaders };
  }
  if (!headers.Authorization) {
    const hadRefreshableGrant = hasOAuthToken(config.id, url) && hasOAuthRefreshToken(config.id);
    const oauth = await oauthAuthHeader(config.id, url);
    if (oauth) {
      headers.Authorization = oauth;
      return { url, headers, usedOAuth: true, omitMcpHeaders };
    }
    if (hadRefreshableGrant && hasOAuthToken(config.id, url)) {
      throw new Error("Could not refresh this sign-in right now — retry shortly; your session was kept.");
    }
  }
  return { url, headers, usedOAuth: false, omitMcpHeaders };
}

function mcpProtocolHeaders(session: McpSession): Record<string, string> {
  if (session.omitMcpHeaders) {
    return {};
  }
  return {
    "MCP-Protocol-Version": session.protocolVersion,
    ...(session.sessionId ? { "Mcp-Session-Id": session.sessionId } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRpcMessages(payload: string): JsonRpcResponse[] {
  const parsed = JSON.parse(payload) as unknown;
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.filter(isRecord).map((value) => value as JsonRpcResponse);
}

/**
 * Streamable HTTP may emit progress/log notifications before the response.
 * Read every SSE event and select the response for this request id instead of
 * accidentally treating the first notification as an empty tool result.
 */
export function parseMcpRpcResponse(body: string, expectedId: number): JsonRpcResponse {
  const trimmed = body.trim();
  let messages: JsonRpcResponse[] = [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    messages = jsonRpcMessages(trimmed);
  } else {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const payload = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!payload || payload === "[DONE]") {
        continue;
      }
      messages.push(...jsonRpcMessages(payload));
    }
  }
  const responses = messages.filter((message) => "result" in message || "error" in message);
  const exact = responses.find((message) => String(message.id) === String(expectedId));
  if (exact) {
    return exact;
  }
  // Keep compatibility with a few non-conforming stateless servers that omit
  // an id, but never accept a mismatched id from another request.
  if (responses.length === 1 && responses[0].id === undefined) {
    return responses[0];
  }
  throw new Error(`no JSON-RPC response for request ${expectedId}`);
}

const MAX_MCP_RESPONSE_CHARS = 2_000_000;
const MCP_CONNECT_TIMEOUT_MS = 15_000;
const MCP_CALL_TIMEOUT_MS = 45_000;

async function readLimitedResponseText(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (text.length > MAX_MCP_RESPONSE_CHARS) {
      throw new Error("MCP response was too large.");
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        text += decoder.decode();
        return text;
      }
      text += decoder.decode(chunk.value, { stream: true });
      if (text.length > MAX_MCP_RESPONSE_CHARS) {
        throw new Error("MCP response was too large.");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Stops reading a long-lived SSE connection as soon as our JSON-RPC result arrives. */
async function readMcpRpcResponse(response: Response, expectedId: number): Promise<JsonRpcResponse> {
  if (!response.body) {
    return parseMcpRpcResponse(await readLimitedResponseText(response), expectedId);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        text += decoder.decode();
        return parseMcpRpcResponse(text, expectedId);
      }
      text += decoder.decode(chunk.value, { stream: true });
      if (text.length > MAX_MCP_RESPONSE_CHARS) {
        throw new Error("MCP response was too large.");
      }
      try {
        return parseMcpRpcResponse(text, expectedId);
      } catch {
        // The matching JSON/SSE event is not complete yet.
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function rpc(session: McpSession, method: string, params?: unknown): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Sessions are cached across turns; re-resolve the header so a token
    // refreshed since connect (or by a parallel call) is actually used.
    if (session.usedOAuth) {
      const before = oauthTokenFingerprint(session.configId);
      if (session.oauthFingerprint && before !== session.oauthFingerprint) {
        sessions.delete(session.configId);
        throw new McpSessionLostError();
      }
      const header = await oauthAuthHeader(session.configId, session.configUrl);
      if (!header) {
        sessions.delete(session.configId);
        throw new McpAuthError("Sign-in is missing or expired — authorize this server again.");
      }
      session.headers.Authorization = header;
      session.oauthFingerprint = oauthTokenFingerprint(session.configId);
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
        signal: AbortSignal.timeout(method === "tools/call" || method === "resources/read" ? MCP_CALL_TIMEOUT_MS : MCP_CONNECT_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof RelayAccessError || error instanceof AuthSessionChangedError) {
        throw error;
      }
      throw new Error("Could not reach the Gera relay. Check your connection and try again.");
    }

    const sessionHeader = response.headers.get("mcp-session-id");
    if (sessionHeader) {
      session.sessionId = sessionHeader;
    }

    if (!response.ok) {
      const text = await readLimitedResponseText(response);
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
          sessions.delete(session.configId);
          if (hasOAuthToken(session.configId, session.configUrl) && hasOAuthRefreshToken(session.configId)) {
            // The provider/relay may be temporarily unavailable. The rejected
            // access token cannot be used now, but its refresh grant may repair
            // the next attempt; deleting it here caused needless re-logins.
            throw new Error("Could not refresh this sign-in right now — retry shortly; your session was kept.");
          }
          clearOAuthToken(session.configId);
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
      parsed = await readMcpRpcResponse(response, request.id);
    } catch (error) {
      if (error instanceof Error && /too large/i.test(error.message)) {
        throw error;
      }
      throw new Error("MCP server sent an unexpected response.");
    }

    if (parsed.error) {
      throw new Error(parsed.error.message || "MCP request failed.");
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
    try {
      const slack = await verifySlackToken(token);
      return {
        tools: SLACK_NATIVE_TOOLS.map((tool) => ({ ...tool })),
        identity: `${slack.team} — ${slack.user}`,
      };
    } catch (error) {
      if (isSlackCredentialError(error)) {
        throw new McpAuthError(error instanceof Error ? error.message : "Slack sign-in expired.");
      }
      throw error;
    }
  }
  if (entry?.native === "intercom") {
    const token = config.token?.trim();
    if (!token) {
      throw new Error("Paste an Intercom Access Token (Developer Hub → Authentication) first.");
    }
    try {
      const intercom = await verifyIntercomToken(token);
      return {
        tools: INTERCOM_NATIVE_TOOLS.map((tool) => ({ ...tool })),
        identity: `${intercom.admin.appName} — ${intercom.admin.name} (${intercom.region.toUpperCase()})`,
      };
    } catch (error) {
      if (isIntercomCredentialError(error)) {
        throw new McpAuthError(error instanceof Error ? error.message : "Intercom sign-in expired.");
      }
      throw error;
    }
  }
  if (entry?.native === "github") {
    // Native GitHub: REST API straight from the browser with the device-flow
    // token or a pasted PAT — verifies who the token belongs to on connect.
    try {
      const auth = await resolveGitHubAuth(config);
      const verified = await verifyGitHubNative(auth);
      return {
        tools: GITHUB_NATIVE_TOOLS.map((tool) => ({ ...tool })),
        identity: verified.identity,
      };
    } catch (error) {
      if (error instanceof GitHubAuthError && !config.token?.trim()) {
        // GitHub can revoke an access token before its recorded expiry. Mirror
        // generic MCP: force one refresh for either the instance or stable
        // catalog grant, then verify the replacement before declaring it dead.
        const oauthIds = [config.id];
        if (config.catalogId && config.catalogId !== config.id) {
          oauthIds.push(config.catalogId);
        }
        for (const oauthId of oauthIds) {
          if (!hasOAuthRefreshToken(oauthId)) {
            continue;
          }
          const refreshed = await forceRefreshOAuthHeader(oauthId);
          if (refreshed) {
            const verified = await verifyGitHubNative(refreshed);
            return {
              tools: GITHUB_NATIVE_TOOLS.map((tool) => ({ ...tool })),
              identity: verified.identity,
            };
          }
          if (hasOAuthToken(oauthId) && hasOAuthRefreshToken(oauthId)) {
            throw new Error("Could not refresh GitHub sign-in right now — retry shortly; your session was kept.");
          }
        }
      }
      if (error instanceof GitHubAuthError) {
        throw new McpAuthError(error.message);
      }
      throw error;
    }
  }
  const generation = sessionGeneration;
  const auth = await buildAuth(config);
  const session: McpSession = {
    configId: config.id,
    generation,
    configFingerprint: mcpConfigFingerprint(config),
    configUrl: config.url.trim(),
    url: auth.url,
    headers: auth.headers,
    usedOAuth: auth.usedOAuth,
    oauthFingerprint: auth.usedOAuth ? oauthTokenFingerprint(config.id) : undefined,
    protocolVersion: MCP_PROTOCOL_VERSION,
    omitMcpHeaders: auth.omitMcpHeaders,
    nextId: 0,
  };

  const initResult = (await rpc(session, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "Gera AI", version: "1.0.0" },
  })) as { protocolVersion?: unknown; serverInfo?: { name?: unknown; version?: unknown } } | null;
  if (typeof initResult?.protocolVersion === "string" && /^\d{4}-\d{2}-\d{2}$/.test(initResult.protocolVersion)) {
    session.protocolVersion = initResult.protocolVersion;
  }

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
      signal: AbortSignal.timeout(6_000),
    });
  } catch {
    // notification is best-effort
  }

  const rawTools: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20 && rawTools.length < 500; page += 1) {
    const listed = (await rpc(session, "tools/list", cursor ? { cursor } : {})) as {
      tools?: Array<Record<string, unknown>>;
      nextCursor?: unknown;
    };
    rawTools.push(...(listed.tools ?? []).slice(0, 500 - rawTools.length));
    cursor = typeof listed.nextCursor === "string" && listed.nextCursor ? listed.nextCursor : undefined;
    if (!cursor) {
      break;
    }
  }
  const tools: McpToolInfo[] = rawTools.map((tool) => ({
    name: String(tool.name ?? ""),
    description: typeof tool.description === "string" ? tool.description : undefined,
    inputSchema:
      tool.inputSchema && typeof tool.inputSchema === "object"
        ? (tool.inputSchema as Record<string, unknown>)
        : { type: "object", properties: {} },
  })).filter((tool) => tool.name.length > 0);

  if (generation !== sessionGeneration) {
    throw new Error("The signed-in account changed while MCP was connecting.");
  }
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
  if (
    session &&
    (session.generation !== sessionGeneration || session.configFingerprint !== mcpConfigFingerprint(config))
  ) {
    sessions.delete(config.id);
    session = undefined;
  }
  if (!session) {
    await connectMcpServer(config);
    session = sessions.get(config.id);
  }
  if (!session) {
    throw new Error("MCP server is not connected.");
  }

  try {
    const result = await rpc(session, "tools/call", { name, arguments: args ?? {} });
    return renderMcpResultWithResources(session, result);
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
    return renderMcpResultWithResources(fresh, result);
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

export function mcpFunctionName(serverId: string, toolName: string): string {
  const serverPart = safeName(serverId, "server");
  const toolPart = safeName(toolName, "tool");
  const base = `mcp_${serverPart}_${toolPart}`;
  const normalizedChanged =
    serverPart !== serverId.toLowerCase() ||
    toolPart !== toolName.toLowerCase() ||
    serverId !== serverId.toLowerCase() ||
    toolName !== toolName.toLowerCase();
  if (!normalizedChanged && base.length <= 64) {
    return base;
  }
  const suffix = shortHash(`${serverId}\u0000${toolName}`).slice(0, 7);
  return `${base.slice(0, 63 - suffix.length)}_${suffix}`;
}

export function findServerForTool(servers: McpServerConfig[], functionName: string): {
  server: McpServerConfig;
  toolName: string;
} | null {
  if (!functionName.startsWith("mcp_")) {
    return null;
  }
  for (const server of servers) {
    if (!server.enabled || server.status !== "connected") {
      continue;
    }
    const tool = (nativeToolTable(server) ?? server.tools).find(
      (item) =>
        !server.disabledTools.includes(item.name) &&
        mcpFunctionName(server.id, item.name) === functionName,
    );
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

function safeName(value: string, fallback: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || fallback;
}

const MAX_RESOURCE_LINK_READS = 4;

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function resourceHeading(resource: Record<string, unknown>): string {
  const uri = typeof resource.uri === "string" ? resource.uri : "resource";
  const mime = typeof resource.mimeType === "string" && resource.mimeType ? ` · ${resource.mimeType}` : "";
  return `[Resource ${uri}${mime}]`;
}

function stringifyResource(resource: Record<string, unknown>): string {
  const heading = resourceHeading(resource);
  if (typeof resource.text === "string") {
    return `${heading}\n${resource.text}`;
  }
  if (typeof resource.blob === "string") {
    return `${heading}\n[Binary data omitted · ${resource.blob.length} base64 chars]`;
  }
  return heading;
}

function stringifyContentPart(part: unknown): string {
  if (!isRecord(part)) {
    return jsonText(part);
  }
  if (typeof part.text === "string") {
    return part.text;
  }
  if (part.type === "resource" && isRecord(part.resource)) {
    return stringifyResource(part.resource);
  }
  if (part.type === "resource_link" && typeof part.uri === "string") {
    const label = typeof part.name === "string" && part.name ? `${part.name} · ` : "";
    return `[Resource link ${label}${part.uri}]`;
  }
  if ((part.type === "image" || part.type === "audio") && typeof part.data === "string") {
    const mime = typeof part.mimeType === "string" && part.mimeType ? ` · ${part.mimeType}` : "";
    return `[${part.type} content omitted${mime} · ${part.data.length} base64 chars]`;
  }
  return jsonText(part);
}

/** Flattens text, embedded resources, and structured MCP results for the model. */
export function stringifyMcpResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (!isRecord(result)) {
    return jsonText(result);
  }
  const pieces = Array.isArray(result.content)
    ? result.content.map(stringifyContentPart).filter((part) => part.length > 0)
    : [];
  if (result.structuredContent !== undefined) {
    pieces.push(`[Structured content]\n${jsonText(result.structuredContent)}`);
  }
  const text = pieces.join("\n");
  return result.isError === true ? `Tool reported an error${text ? `:\n${text}` : "."}` : text;
}

function resourceLinks(result: unknown): string[] {
  if (!isRecord(result) || result.isError === true || !Array.isArray(result.content)) {
    return [];
  }
  const links: string[] = [];
  for (const part of result.content) {
    if (isRecord(part) && part.type === "resource_link" && typeof part.uri === "string" && part.uri) {
      if (!links.includes(part.uri)) {
        links.push(part.uri);
      }
    }
  }
  return links.slice(0, MAX_RESOURCE_LINK_READS);
}

function stringifyResourceReadResult(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.contents)) {
    return jsonText(result);
  }
  return result.contents
    .map((content) => (isRecord(content) ? stringifyResource(content) : jsonText(content)))
    .filter((content) => content.length > 0)
    .join("\n");
}

const MAX_MCP_RENDER_CHARS = 300_000;

async function renderMcpResultWithResources(session: McpSession, result: unknown): Promise<string> {
  const rendered = stringifyMcpResult(result);
  if (isRecord(result) && result.isError === true) {
    throw new Error(rendered || "MCP tool reported an error.");
  }
  const pieces = [rendered];
  for (const uri of resourceLinks(result)) {
    try {
      const resource = await rpc(session, "resources/read", { uri });
      const text = stringifyResourceReadResult(resource);
      if (text) {
        pieces.push(text);
      }
    } catch (error) {
      pieces.push(`[Could not read resource ${uri}: ${error instanceof Error ? error.message : "unknown error"}]`);
    }
  }
  const output = pieces.filter((piece) => piece.length > 0).join("\n\n");
  return output.length > MAX_MCP_RENDER_CHARS
    ? `${output.slice(0, MAX_MCP_RENDER_CHARS)}\n… [MCP result truncated]`
    : output;
}
