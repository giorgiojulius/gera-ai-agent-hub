/** JSON-RPC/SSE transport and legacy handshake; modern policy is injected without circular imports. */
import { fetchPublicHttps } from "./network-safety";
import {
  isRecord, normalizeServerCapabilities, defaultClientCapabilities, credentialVariants,
  redactMcpText, redactMcpValue, sessionRedactions,
  MCP_MAX_RESPONSE_CHARS, MCP_LATEST_PROTOCOL_VERSION, MCP_SUPPORTED_PROTOCOL_VERSIONS, MCP_MODERN_PROTOCOL_VERSIONS,
  JSON_RPC_INTERNAL_ERROR, JSON_RPC_METHOD_NOT_FOUND,
  McpAuthRejectedError, McpSessionLostError, McpRpcError,
  type JsonRpcId, type JsonRpcError, type JsonRpcMessage, type McpFetch,
  type McpProtocolSession, type McpLeasedCredential, type McpServerRequestReply,
  type McpInitializeOptions, type McpServerCapabilities, type McpServerInfo, type McpWireInfo,
} from "./mcp-protocol-shared";
import { protocolHeaders, credentialHeaders } from "./mcp-headers";
import { discoverModern, requestWithModernInput, wireParams, withModernNegotiation, type McpDiscovery } from "./mcp-modern";
import { openNotificationStream, type McpNotificationStream } from "./mcp-notifications";
export type { McpNotificationStream } from "./mcp-notifications";
export * from "./mcp-protocol-shared";
export { mcpHeaderValue } from "./mcp-headers";
export { modernRequestMeta, sessionWireInfo, isInputRequiredResult, type McpDiscovery } from "./mcp-modern";

export function isRpcResponse(message: JsonRpcMessage): boolean {
  return "result" in message || "error" in message;
}

/** A server → client request: has a method AND an id. */
export function isRpcRequest(message: JsonRpcMessage): message is JsonRpcMessage & { method: string; id: JsonRpcId } {
  return typeof message.method === "string" && message.id !== undefined && message.id !== null && !isRpcResponse(message);
}

/** A notification: has a method, no id. */
export function isRpcNotification(message: JsonRpcMessage): message is JsonRpcMessage & { method: string } {
  return typeof message.method === "string" && (message.id === undefined || message.id === null) && !isRpcResponse(message);
}

function jsonRpcMessages(payload: string): JsonRpcMessage[] {
  const parsed = JSON.parse(payload) as unknown;
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.filter(isRecord).map((value) => value as JsonRpcMessage);
}

/** Splits a complete SSE body into its `data:` payloads (multi-line data joined). */
export function parseSseEvents(text: string): string[] {
  const payloads: string[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const payload = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (payload && payload !== "[DONE]") {
      payloads.push(payload);
    }
  }
  return payloads;
}

/**
 * Parses a whole response body — a JSON value/array or a complete SSE stream —
 * into JSON-RPC frames. Malformed data events are skipped, never fatal.
 */
export function parseJsonRpcPayload(text: string): JsonRpcMessage[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return jsonRpcMessages(trimmed);
  }
  const messages: JsonRpcMessage[] = [];
  for (const payload of parseSseEvents(text)) {
    try {
      messages.push(...jsonRpcMessages(payload));
    } catch {
      // A non-JSON data event (keepalive comment, vendor noise) is not a frame.
    }
  }
  return messages;
}

/**
 * Picks the response for `expectedId` out of a frame list. Keeps compatibility
 * with a few non-conforming stateless servers that omit the id on their only
 * response, but never accepts a mismatched id from another request.
 */
export function selectRpcResponse(messages: JsonRpcMessage[], expectedId: JsonRpcId): JsonRpcMessage | null {
  const responses = messages.filter(isRpcResponse);
  const exact = responses.find((message) => String(message.id) === String(expectedId));
  if (exact) {
    return exact;
  }
  if (responses.length === 1 && (responses[0].id === undefined || responses[0].id === null)) {
    return responses[0];
  }
  return null;
}

function isModern(session: McpProtocolSession): boolean {
  return session.wire === "modern";
}

function requestHeaders(
  session: McpProtocolSession,
  includeVersion: boolean,
  leased: McpLeasedCredential,
  method?: string,
  params?: unknown,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...credentialHeaders(session.headers, leased.headers),
    ...protocolHeaders(session, includeVersion, method, params),
  };
}

/** A JSON-RPC error frame carried on a non-2xx body (400/404 in the stateless revision), if any. */
function rpcErrorFromBody(text: string): JsonRpcError | null {
  try {
    const messages = parseJsonRpcPayload(text);
    const frame = messages.find((message) => message.error !== undefined);
    return frame?.error ?? null;
  } catch {
    return null;
  }
}

/** The credential for one request: leased on demand, or the static session headers (already redacted via `session.redactions`). */
async function leaseCredential(session: McpProtocolSession): Promise<McpLeasedCredential> {
  session.signal?.throwIfAborted();
  if (!session.lease) {
    return { headers: {}, redactions: [] };
  }
  session.signal?.throwIfAborted();
  const credential = await session.lease();
  session.signal?.throwIfAborted();
  return credential;
}

/** Redactions for one request's provider-originated text: session-level values plus the leased credential. */
function requestRedactions(session: McpProtocolSession, leased: McpLeasedCredential): string[] {
  return leased.redactions.length > 0 ? [...sessionRedactions(session), ...leased.redactions] : sessionRedactions(session);
}

function sessionFetch(session: McpProtocolSession): McpFetch {
  return session.fetch ?? ((url, init) => fetchPublicHttps(url, init));
}

function adoptSessionId(session: McpProtocolSession, response: Response): void {
  if (isModern(session)) {
    // The stateless revision has no sessions; a stray header is ignored, never echoed.
    return;
  }
  const sessionHeader = response.headers.get("mcp-session-id");
  if (sessionHeader && sessionHeader !== session.sessionId) {
    session.sessionId = sessionHeader;
    session.redactions = credentialVariants([...(session.redactions ?? []), sessionHeader]);
  }
}

async function readLimitedText(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (text.length > MCP_MAX_RESPONSE_CHARS) {
      throw new Error("MCP response was too large");
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
      if (text.length > MCP_MAX_RESPONSE_CHARS) {
        throw new Error("MCP response was too large");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function isEventStream(response: Response): boolean {
  return /text\/event-stream/i.test(response.headers.get("content-type") ?? "");
}

/** Delivers one server-originated frame: notifications to the listener, requests to the handler (answered by POST). */
async function dispatchServerFrame(session: McpProtocolSession, message: JsonRpcMessage): Promise<void> {
  if (isRpcNotification(message)) {
    try {
      session.onNotification?.({ method: message.method, params: message.params });
    } catch {
      // A listener fault must never break the transport.
    }
    return;
  }
  if (isRpcRequest(message)) {
    let reply: McpServerRequestReply;
    if (message.method === "ping") {
      reply = { result: {} };
    } else if (session.onServerRequest) {
      try {
        reply = await session.onServerRequest({ id: message.id, method: message.method, params: message.params });
      } catch (error) {
        reply = {
          error: {
            code: JSON_RPC_INTERNAL_ERROR,
            message: redactMcpText(error instanceof Error ? error.message : "client handler failed", sessionRedactions(session)),
          },
        };
      }
    } else {
      reply = { error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `Client does not support ${message.method}` } };
    }
    await mcpRespond(session, message.id, reply).catch(() => undefined);
  }
}

/**
 * Reads the POST response for `expectedId`. SSE bodies are consumed
 * incrementally: notifications and server requests are dispatched the moment
 * their event completes (an `elicitation/create` may wait minutes for the
 * user, so the idle timer pauses while a handler runs), and reading stops as
 * soon as our response lands.
 */
async function readRpcResponse(
  session: McpProtocolSession,
  response: Response,
  expectedId: JsonRpcId,
  idle: { arm: () => void; disarm: () => void },
): Promise<JsonRpcMessage> {
  if (!response.body || !isEventStream(response)) {
    const text = await readLimitedText(response);
    const messages = parseJsonRpcPayload(text);
    for (const message of messages) {
      if (!isRpcResponse(message)) {
        await dispatchServerFrame(session, message);
      }
    }
    const selected = selectRpcResponse(messages, expectedId);
    if (!selected) {
      throw new Error(`no JSON-RPC response for request ${expectedId}`);
    }
    return selected;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  const handleEvent = async (event: string): Promise<JsonRpcMessage | null> => {
    for (const payload of parseSseEvents(`${event}\n\n`)) {
      let messages: JsonRpcMessage[];
      try {
        messages = jsonRpcMessages(payload);
      } catch {
        continue;
      }
      for (const message of messages) {
        if (isRpcResponse(message)) {
          if (String(message.id) === String(expectedId) || message.id === undefined || message.id === null) {
            return message;
          }
          continue; // another request's response on a shared stream — not ours
        }
        idle.disarm();
        try {
          await dispatchServerFrame(session, message);
        } finally {
          idle.arm();
        }
      }
    }
    return null;
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        const last = await handleEvent(buffer);
        if (last) {
          return last;
        }
        throw new Error(`no JSON-RPC response for request ${expectedId}`);
      }
      const piece = decoder.decode(chunk.value, { stream: true });
      total += piece.length;
      if (total > MCP_MAX_RESPONSE_CHARS) {
        throw new Error("MCP response was too large");
      }
      idle.arm();
      buffer += piece;
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const separator = /\r?\n\r?\n/.exec(buffer.slice(boundary))?.[0] ?? "\n\n";
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + separator.length);
        const found = await handleEvent(event);
        if (found) {
          return found;
        }
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Idle-timeout controller: aborts when no bytes arrive for `ms`, pausable while handlers run. */
function idleAbort(ms: number): { signal: AbortSignal; arm: () => void; disarm: () => void; clear: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const arm = (): void => {
    disarm();
    timer = setTimeout(() => controller.abort(new Error("MCP request timed out")), ms);
  };
  return { signal: controller.signal, arm, disarm, clear: disarm };
}

function describeHttpFailure(status: number): string {
  return `HTTP ${status}`;
}

/**
 * Sends one JSON-RPC request and returns its `result`. Errors from the server
 * surface as Error(message) with credentials redacted; 401/403 become
 * McpAuthRejectedError; a stale session (404 with an issued session id) becomes
 * McpSessionLostError.
 */
export function mcpRequest(session: McpProtocolSession, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  return withModernNegotiation(session, () => mcpRequestOnce(session, method, params, timeoutMs));
}

async function mcpRequestOnce(
  session: McpProtocolSession,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  session.nextId += 1;
  const requestId = session.nextId;
  const leased = await leaseCredential(session);
  const idle = idleAbort(timeoutMs);
  idle.arm();
  const sentParams = wireParams(session, params);
  let response: Response;
  try {
    response = await sessionFetch(session)(leased.url ?? session.url, {
      method: "POST",
      headers: requestHeaders(session, method !== "initialize", leased, method, sentParams),
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params: sentParams }),
      signal: session.signal ? AbortSignal.any([session.signal, idle.signal]) : idle.signal,
    });
  } catch (error) {
    idle.clear();
    if (idle.signal.aborted) {
      throw new Error("MCP request timed out");
    }
    throw error;
  }
  try {
    adoptSessionId(session, response);
    if (!response.ok) {
      const body = await readLimitedText(response).catch(() => "");
      if (response.status === 401 || response.status === 403) {
        throw new McpAuthRejectedError(response.status, response.headers.get("www-authenticate"));
      }
      if (session.sessionId && response.status === 404) {
        throw new McpSessionLostError();
      }
      if (session.sessionId && response.status === 400 && /session/i.test(body)) {
        throw new McpSessionLostError();
      }
      // The stateless revision answers protocol faults with a JSON-RPC error on
      // a 400/404 body — keep its code so negotiation can act on it.
      const rpcError = rpcErrorFromBody(body);
      if (rpcError) {
        const redactions = requestRedactions(session, leased);
        throw new McpRpcError(
          redactMcpText(rpcError.message || describeHttpFailure(response.status), redactions),
          rpcError.code,
          redactMcpValue(rpcError.data, redactions),
          response.status,
        );
      }
      throw new Error(describeHttpFailure(response.status));
    }
    let parsed: JsonRpcMessage;
    try {
      parsed = await readRpcResponse(session, response, requestId, idle);
    } catch (error) {
      if (idle.signal.aborted) {
        throw new Error("MCP request timed out");
      }
      if (error instanceof Error && /too large/i.test(error.message)) {
        throw error;
      }
      throw new Error("unexpected response shape");
    }
    const redactions = requestRedactions(session, leased);
    if (parsed.error) {
      const message = parsed.error.message || "MCP request failed";
      throw new McpRpcError(
        redactMcpText(message, redactions),
        parsed.error.code,
        redactMcpValue(parsed.error.data, redactions),
        response.status,
      );
    }
    session.signal?.throwIfAborted();
    // A leased credential is gone after this call — its redaction happens here,
    // deep, so no caller needs to hold the credential to scrub the result.
    return leased.redactions.length > 0 ? redactMcpValue(parsed.result, leased.redactions) : parsed.result;
  } finally {
    idle.clear();
  }
}

/** Sends a notification (no response expected); failures are swallowed — notifications are best effort. */
export async function mcpNotify(session: McpProtocolSession, method: string, params?: unknown): Promise<void> {
  try {
    const leased = await leaseCredential(session);
    const response = await sessionFetch(session)(leased.url ?? session.url, {
      method: "POST",
      headers: requestHeaders(session, true, leased, method, params),
      body: JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }),
      signal: AbortSignal.timeout(6_000),
    });
    adoptSessionId(session, response);
    await response.body?.cancel().catch(() => undefined);
  } catch {
    // best effort
  }
}

/** Answers a server → client request with a JSON-RPC response frame. */
export async function mcpRespond(session: McpProtocolSession, id: JsonRpcId, reply: McpServerRequestReply): Promise<void> {
  const frame =
    "result" in reply
      ? { jsonrpc: "2.0", id, result: reply.result ?? {} }
      : { jsonrpc: "2.0", id, error: { code: reply.error.code, message: reply.error.message } };
  const leased = await leaseCredential(session);
  const response = await sessionFetch(session)(leased.url ?? session.url, {
    method: "POST",
    headers: requestHeaders(session, true, leased),
    body: JSON.stringify(frame),
    signal: AbortSignal.timeout(10_000),
  });
  adoptSessionId(session, response);
  await response.body?.cancel().catch(() => undefined);
}

/**
 * initialize → notifications/initialized. Proposes the newest revision, accepts
 * any supported one, and pins it on the session so every later request
 * carries the negotiated MCP-Protocol-Version header.
 */
export async function mcpInitialize(
  session: McpProtocolSession,
  options: McpInitializeOptions = {},
): Promise<{ protocolVersion: string; capabilities: McpServerCapabilities; serverInfo: McpServerInfo; instructions?: string }> {
  const result = (await mcpRequest(
    session,
    "initialize",
    {
      protocolVersion: MCP_LATEST_PROTOCOL_VERSION,
      capabilities: { ...defaultClientCapabilities(), ...(options.capabilities ?? {}) },
      clientInfo: options.clientInfo ?? { name: "Gera AI", version: "1.0.0" },
    },
    options.timeoutMs ?? 12_000,
  )) as Record<string, unknown> | null;
  const negotiated = typeof result?.protocolVersion === "string" ? result.protocolVersion : "";
  if (!MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(negotiated)) {
    throw new Error(
      negotiated
        ? `unsupported MCP protocol version "${negotiated}" (Gera speaks ${MCP_SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`
        : "initialize returned no protocol version",
    );
  }
  session.protocolVersion = negotiated;
  session.capabilities = normalizeServerCapabilities(result?.capabilities);
  const rawInfo = isRecord(result?.serverInfo) ? result.serverInfo : {};
  session.serverInfo = {
    name: typeof rawInfo.name === "string" ? rawInfo.name : undefined,
    title: typeof rawInfo.title === "string" ? rawInfo.title : undefined,
    version: typeof rawInfo.version === "string" ? rawInfo.version : undefined,
  };
  session.instructions = typeof result?.instructions === "string" ? result.instructions : undefined;
  session.initialized = true;
  await mcpNotify(session, "notifications/initialized");
  return {
    protocolVersion: negotiated,
    capabilities: session.capabilities,
    serverInfo: session.serverInfo,
    instructions: session.instructions,
  };
}

// ---------------------------------------------------------------------------
// Stateless revision (2026-07-28): discover, negotiation, input rounds.

/** Binds the modern discovery policy to the shared HTTP transport. */
export function mcpDiscover(session: McpProtocolSession, options: { timeoutMs?: number } = {}): Promise<McpDiscovery | null> {
  return discoverModern(session, mcpRequest, options);
}

export type McpConnectOptions = McpInitializeOptions & {
  /** Cached negotiation of an earlier run — skips the probe; a wrong hint is retried with a fresh probe. */
  wireHint?: McpWireInfo;
  /** Probe budget (default 5 s). */
  discoverTimeoutMs?: number;
};

/**
 * Negotiates the wire: `server/discover` first, the legacy initialize
 * handshake when the server does not answer it. A cached hint skips the
 * probe. Returns what the session learned about the server.
 */
export async function mcpConnect(session: McpProtocolSession, options: McpConnectOptions = {}): Promise<McpDiscovery> {
  session.clientInfo = options.clientInfo ?? session.clientInfo ?? { name: "Gera AI", version: "1.0.0" };
  session.clientCapabilities = { ...defaultClientCapabilities(), ...(options.capabilities ?? {}) };
  session.logLevel = options.logLevel ?? session.logLevel;
  const hint = options.wireHint;
  if (hint?.era === "modern" && MCP_MODERN_PROTOCOL_VERSIONS.includes(hint.protocolVersion)) {
    session.wire = "modern";
    session.protocolVersion = hint.protocolVersion;
    session.sessionId = undefined;
    session.capabilities = hint.capabilities ?? {};
    session.serverInfo = hint.serverInfo ?? {};
    session.initialized = true;
    return {
      protocolVersion: hint.protocolVersion,
      capabilities: session.capabilities,
      serverInfo: session.serverInfo,
    };
  }
  if (hint?.era !== "legacy" || !MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(hint.protocolVersion)) {
    const discovered = await mcpDiscover(session, { timeoutMs: options.discoverTimeoutMs });
    if (discovered) {
      return discovered;
    }
  }
  session.wire = "legacy";
  return mcpInitialize(session, options);
}

/** Shared requests with bounded stateless input continuations; legacy results pass through. */
export function mcpRequestWithInput(session: McpProtocolSession, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  return requestWithModernInput(session, method, params, timeoutMs, mcpRequest);
}

export type McpListOptions = {
  /** Stop after this many items. */
  maxItems: number;
  /** Stop after this many pages regardless (a server that loops cursors). */
  maxPages?: number;
  timeoutMs?: number;
  /** Extra params sent with every page (e.g. none today; reserved). */
  params?: Record<string, unknown>;
};

/** Walks a paginated list method (`tools/list`, `prompts/list`, …) collecting `key` items across cursors. */
export async function mcpListAll(
  session: McpProtocolSession,
  method: string,
  key: string,
  options: McpListOptions,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  const maxPages = Math.max(1, options.maxPages ?? 50);
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < maxPages && items.length < options.maxItems; page += 1) {
    const listed = (await mcpRequest(
      session,
      method,
      { ...(options.params ?? {}), ...(cursor ? { cursor } : {}) },
      options.timeoutMs ?? 12_000,
    )) as Record<string, unknown> | null;
    const pageItems = Array.isArray(listed?.[key]) ? (listed[key] as unknown[]).filter(isRecord) : [];
    items.push(...pageItems.slice(0, options.maxItems - items.length));
    const next = typeof listed?.nextCursor === "string" && listed.nextCursor ? listed.nextCursor : undefined;
    if (!next || seen.has(next)) {
      break;
    }
    seen.add(next);
    cursor = next;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Standalone GET notification stream.

/** Opens a run-owned modern subscription or legacy notification stream. */
export function openMcpNotificationStream(session: McpProtocolSession, options: { connectTimeoutMs?: number } = {}): Promise<McpNotificationStream | null> {
  return openNotificationStream(session, {
    lease: leaseCredential, fetch: sessionFetch, headers: requestHeaders, adoptSessionId, isEventStream, readText: readLimitedText,
    parseEvents: parseSseEvents, parseMessages: jsonRpcMessages, isResponse: isRpcResponse, dispatch: dispatchServerFrame,
  }, options);
}

// ---------------------------------------------------------------------------
// Tools: annotations and MCP Apps markers.

export type McpToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/** Reads the spec's tool annotations; undefined when the server sent none. */
export function normalizeToolAnnotations(value: unknown): McpToolAnnotations | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: McpToolAnnotations = {};
  if (typeof value.title === "string" && value.title.trim()) out.title = value.title.trim().slice(0, 200);
  if (typeof value.readOnlyHint === "boolean") out.readOnlyHint = value.readOnlyHint;
  if (typeof value.destructiveHint === "boolean") out.destructiveHint = value.destructiveHint;
  if (typeof value.idempotentHint === "boolean") out.idempotentHint = value.idempotentHint;
  if (typeof value.openWorldHint === "boolean") out.openWorldHint = value.openWorldHint;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * MCP Apps: a tool that renders its own UI resource is not for the model.
 * Both the current `_meta.ui.resourceUri` and the legacy `_meta["ui/resourceUri"]`
 * markers count.
 */
export function isUiOnlyTool(raw: Record<string, unknown>): boolean {
  const meta = isRecord(raw._meta) ? raw._meta : null;
  if (!meta) {
    return false;
  }
  if (isRecord(meta.ui) && typeof meta.ui.resourceUri === "string" && meta.ui.resourceUri) {
    return true;
  }
  return typeof meta["ui/resourceUri"] === "string" && Boolean(meta["ui/resourceUri"]);
}

/** Human badges for a tool's annotations (McpStudio, confirmations). */
export function toolAnnotationBadges(annotations: McpToolAnnotations | undefined, uiOnly: boolean): string[] {
  const badges: string[] = [];
  if (uiOnly) badges.push("UI-only");
  if (!annotations) return badges;
  if (annotations.readOnlyHint === true) badges.push("read-only");
  if (annotations.destructiveHint === true) badges.push("destructive");
  if (annotations.idempotentHint === true) badges.push("idempotent");
  if (annotations.openWorldHint === true) badges.push("open-world");
  return badges;
}

// ---------------------------------------------------------------------------
// Prompts and resources.

export type McpPromptArgument = { name: string; description?: string; required?: boolean };

export type McpPromptInfo = {
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgument[];
};

export type McpResourceInfo = {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
};

export type McpResourceTemplateInfo = {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
};

const short = (value: unknown, limit: number): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;

export function normalizePromptInfo(raw: unknown): McpPromptInfo | null {
  if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name) {
    return null;
  }
  const args = Array.isArray(raw.arguments)
    ? raw.arguments.flatMap((item): McpPromptArgument[] =>
        isRecord(item) && typeof item.name === "string" && item.name
          ? [{ name: item.name, description: short(item.description, 500), required: item.required === true }]
          : [],
      )
    : undefined;
  return {
    name: raw.name,
    title: short(raw.title, 200),
    description: short(raw.description, 1_000),
    ...(args && args.length > 0 ? { arguments: args } : {}),
  };
}

export function normalizeResourceInfo(raw: unknown): McpResourceInfo | null {
  if (!isRecord(raw) || typeof raw.uri !== "string" || !raw.uri) {
    return null;
  }
  return {
    uri: raw.uri.slice(0, 2_000),
    name: short(raw.name, 200) ?? raw.uri.slice(0, 200),
    title: short(raw.title, 200),
    description: short(raw.description, 1_000),
    mimeType: short(raw.mimeType, 200),
    ...(typeof raw.size === "number" && Number.isFinite(raw.size) ? { size: raw.size } : {}),
  };
}

export function normalizeResourceTemplateInfo(raw: unknown): McpResourceTemplateInfo | null {
  if (!isRecord(raw) || typeof raw.uriTemplate !== "string" || !raw.uriTemplate) {
    return null;
  }
  return {
    uriTemplate: raw.uriTemplate.slice(0, 2_000),
    name: short(raw.name, 200) ?? raw.uriTemplate.slice(0, 200),
    title: short(raw.title, 200),
    description: short(raw.description, 1_000),
    mimeType: short(raw.mimeType, 200),
  };
}

/** Variable names of an RFC 6570 level-1 URI template (`{var}`; operators are stripped). */
export function uriTemplateVariables(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
    for (const part of match[1].replace(/^[+#./;?&]/, "").split(",")) {
      const name = part.replace(/\*$/, "").replace(/:\d+$/, "").trim();
      if (name && !names.includes(name)) {
        names.push(name);
      }
    }
  }
  return names;
}

/** Expands a level-1 URI template with encoded values (`{+var}` keeps reserved characters). */
export function expandUriTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^{}]+)\}/g, (_whole, expression: string) => {
    const operator = /^[+#./;?&]/.exec(expression)?.[0] ?? "";
    const names = expression
      .slice(operator.length)
      .split(",")
      .map((part) => part.replace(/\*$/, "").replace(/:\d+$/, "").trim());
    const encode = (value: string): string => (operator === "+" || operator === "#" ? encodeURI(value) : encodeURIComponent(value));
    const pieces = names.map((name) => encode(values[name] ?? ""));
    if (operator === "?" ) {
      return `?${names.map((name, index) => `${name}=${pieces[index]}`).join("&")}`;
    }
    if (operator === "&") {
      return `&${names.map((name, index) => `${name}=${pieces[index]}`).join("&")}`;
    }
    if (operator === "#") {
      return `#${pieces.join(",")}`;
    }
    if (operator === ".") {
      return `.${pieces.join(".")}`;
    }
    if (operator === "/") {
      return `/${pieces.join("/")}`;
    }
    if (operator === ";") {
      return `;${names.map((name, index) => `${name}=${pieces[index]}`).join(";")}`;
    }
    return pieces.join(",");
  });
}

// ---------------------------------------------------------------------------
// Elicitation.

export type McpElicitationField = {
  name: string;
  type: "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  required: boolean;
  enum?: string[];
  enumLabels?: string[];
  format?: "email" | "uri" | "date" | "date-time";
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: string | number | boolean;
};

export type McpElicitationRequest = {
  message: string;
  mode: "form" | "url";
  fields: McpElicitationField[];
  /** URL mode: where the server wants the user to go (declined by Gera today). */
  url?: string;
};

export type McpElicitationAction = "accept" | "decline" | "cancel";

export type McpElicitationAnswer = {
  action: McpElicitationAction;
  content?: Record<string, string | number | boolean>;
};

/** Reads `elicitation/create` params into a flat field list the UI can render; null when unusable. */
export function normalizeElicitationRequest(params: unknown): McpElicitationRequest | null {
  if (!isRecord(params) || typeof params.message !== "string") {
    return null;
  }
  const message = params.message.trim().slice(0, 4_000);
  const mode = params.mode === "url" ? "url" : "form";
  if (mode === "url") {
    return { message, mode, fields: [], url: typeof params.url === "string" ? params.url.slice(0, 2_000) : undefined };
  }
  const schema = isRecord(params.requestedSchema) ? params.requestedSchema : null;
  const properties = schema && isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    schema && Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [],
  );
  const fields: McpElicitationField[] = [];
  for (const [name, raw] of Object.entries(properties).slice(0, 40)) {
    if (!isRecord(raw)) {
      continue;
    }
    const type =
      raw.type === "number" || raw.type === "integer" || raw.type === "boolean" || raw.type === "string"
        ? raw.type
        : Array.isArray(raw.enum) || Array.isArray(raw.oneOf)
          ? "string"
          : null;
    if (!type) {
      continue;
    }
    const field: McpElicitationField = {
      name,
      type,
      title: short(raw.title, 200),
      description: short(raw.description, 1_000),
      required: required.has(name),
    };
    if (Array.isArray(raw.enum)) {
      field.enum = raw.enum.filter((item): item is string => typeof item === "string").slice(0, 100);
      if (Array.isArray(raw.enumNames)) {
        field.enumLabels = raw.enumNames.filter((item): item is string => typeof item === "string").slice(0, 100);
      }
    } else if (Array.isArray(raw.oneOf)) {
      // 2025-11-25 titled enums: oneOf [{ const, title }]
      const values: string[] = [];
      const labels: string[] = [];
      for (const option of raw.oneOf) {
        if (isRecord(option) && typeof option.const === "string") {
          values.push(option.const);
          labels.push(typeof option.title === "string" ? option.title : option.const);
        }
      }
      if (values.length > 0) {
        field.enum = values.slice(0, 100);
        field.enumLabels = labels.slice(0, 100);
      }
    }
    if (raw.format === "email" || raw.format === "uri" || raw.format === "date" || raw.format === "date-time") {
      field.format = raw.format;
    }
    if (typeof raw.minLength === "number") field.minLength = raw.minLength;
    if (typeof raw.maxLength === "number") field.maxLength = raw.maxLength;
    if (typeof raw.minimum === "number") field.minimum = raw.minimum;
    if (typeof raw.maximum === "number") field.maximum = raw.maximum;
    if (typeof raw.default === "string" || typeof raw.default === "number" || typeof raw.default === "boolean") {
      field.default = raw.default;
    }
    fields.push(field);
  }
  return { message, mode, fields };
}

/**
 * Validates an accept payload against the request's fields. Unknown keys are
 * dropped, primitives coerced from form strings, and every violation is named
 * so the card can show it; values themselves are never included in errors.
 */
export function validateElicitationContent(
  request: McpElicitationRequest,
  content: unknown,
): { ok: true; content: Record<string, string | number | boolean> } | { ok: false; errors: string[] } {
  const input = isRecord(content) ? content : {};
  const out: Record<string, string | number | boolean> = {};
  const errors: string[] = [];
  for (const field of request.fields) {
    const raw = input[field.name];
    const missing = raw === undefined || raw === null || raw === "";
    if (missing) {
      if (field.required) {
        errors.push(`${field.title ?? field.name} is required`);
      }
      continue;
    }
    if (field.type === "boolean") {
      if (typeof raw === "boolean") {
        out[field.name] = raw;
      } else if (raw === "true" || raw === "false") {
        out[field.name] = raw === "true";
      } else {
        errors.push(`${field.title ?? field.name} must be true or false`);
      }
      continue;
    }
    if (field.type === "number" || field.type === "integer") {
      const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
      if (!Number.isFinite(value)) {
        errors.push(`${field.title ?? field.name} must be a number`);
        continue;
      }
      if (field.type === "integer" && !Number.isInteger(value)) {
        errors.push(`${field.title ?? field.name} must be a whole number`);
        continue;
      }
      if (field.minimum !== undefined && value < field.minimum) {
        errors.push(`${field.title ?? field.name} must be at least ${field.minimum}`);
        continue;
      }
      if (field.maximum !== undefined && value > field.maximum) {
        errors.push(`${field.title ?? field.name} must be at most ${field.maximum}`);
        continue;
      }
      out[field.name] = value;
      continue;
    }
    const text = typeof raw === "string" ? raw : String(raw);
    if (field.enum && !field.enum.includes(text)) {
      errors.push(`${field.title ?? field.name} must be one of the offered options`);
      continue;
    }
    if (field.minLength !== undefined && text.length < field.minLength) {
      errors.push(`${field.title ?? field.name} must be at least ${field.minLength} characters`);
      continue;
    }
    if (field.maxLength !== undefined && text.length > field.maxLength) {
      errors.push(`${field.title ?? field.name} must be at most ${field.maxLength} characters`);
      continue;
    }
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      errors.push(`${field.title ?? field.name} must be an email address`);
      continue;
    }
    if (field.format === "uri" && !/^[a-z][a-z0-9+.-]*:/i.test(text)) {
      errors.push(`${field.title ?? field.name} must be a URI`);
      continue;
    }
    if (field.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      errors.push(`${field.title ?? field.name} must be a date (YYYY-MM-DD)`);
      continue;
    }
    if (field.format === "date-time" && Number.isNaN(Date.parse(text))) {
      errors.push(`${field.title ?? field.name} must be a date-time`);
      continue;
    }
    out[field.name] = text;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, content: out };
}

// ---------------------------------------------------------------------------
// Result flattening for the model.

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
export function stringifyMcpToolResult(result: unknown): string {
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

/** `resource_link` URIs of a successful result, deduplicated, capped. */
export function mcpResourceLinks(result: unknown, max: number): string[] {
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
  return links.slice(0, max);
}

/** Flattens a `resources/read` result. */
export function stringifyMcpResourceRead(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.contents)) {
    return jsonText(result);
  }
  return result.contents
    .map((content) => (isRecord(content) ? stringifyResource(content) : jsonText(content)))
    .filter((content) => content.length > 0)
    .join("\n");
}

/** Text of a `prompts/get` message part (embedded resources flattened, media described). */
export function stringifyMcpPromptContent(content: unknown): string {
  return stringifyContentPart(content);
}

// ---------------------------------------------------------------------------
// Binary parts of a tool result (images, audio, blobs) — bounded, as data URLs.

/** Images shipped per tool call; the rest is described in text. */
export { MCP_MEDIA_MAX_IMAGES, MCP_MEDIA_MAX_BYTES, extractMcpResultMedia, type McpResultImage, type McpResultFile, type McpResultMedia } from "./mcp-result-media";
