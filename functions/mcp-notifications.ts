import { McpAuthRejectedError, McpRpcError, redactMcpText, redactMcpValue, MCP_MAX_RESPONSE_CHARS, type JsonRpcMessage, type McpProtocolSession, type McpLeasedCredential, type McpFetch } from "./mcp-protocol-shared";
import { protocolHeaders, credentialHeaders } from "./mcp-headers";
import { listenFilter, wireParams, withModernNegotiation } from "./mcp-modern";

export type McpNotificationStream = { close: () => void; done: Promise<void> };
type StreamTransport = {
  lease(session: McpProtocolSession): Promise<McpLeasedCredential>;
  fetch(session: McpProtocolSession): McpFetch;
  headers(session: McpProtocolSession, includeVersion: boolean, lease: McpLeasedCredential, method?: string, params?: unknown): Record<string, string>;
  adoptSessionId(session: McpProtocolSession, response: Response): void;
  isEventStream(response: Response): boolean;
  readText(response: Response): Promise<string>;
  parseEvents(text: string): string[];
  parseMessages(text: string): JsonRpcMessage[];
  isResponse(message: JsonRpcMessage): boolean;
  dispatch(session: McpProtocolSession, message: JsonRpcMessage): Promise<void>;
};
/** Run-owned notification lifecycle; modern POST policy and legacy GET share the SSE reader. */
export async function openNotificationStream(session: McpProtocolSession, io: StreamTransport, options: { connectTimeoutMs?: number } = {}): Promise<McpNotificationStream | null> {
  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(new Error("MCP notification stream timed out")), Math.max(1_000, options.connectTimeoutMs ?? 8_000));
  let response: Response;
  try {
    if (session.wire === "modern") {
      const filter = listenFilter(session);
      if (Object.keys(filter).length === 0) { clearTimeout(connectTimer); return null; }
      response = await withModernNegotiation(session, async () => {
        const leased = await io.lease(session);
        controller.signal.throwIfAborted();
        session.nextId += 1;
        const params = wireParams(session, { notifications: filter });
        const res = await io.fetch(session)(leased.url ?? session.url, {
          method: "POST", headers: io.headers(session, true, leased, "subscriptions/listen", params),
          body: JSON.stringify({ jsonrpc: "2.0", id: session.nextId, method: "subscriptions/listen", params }),
          signal: session.signal ? AbortSignal.any([session.signal, controller.signal]) : controller.signal,
        });
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) { await res.body?.cancel(); throw new McpAuthRejectedError(res.status, res.headers.get("www-authenticate")); }
          const text = await io.readText(res);
          let frames: JsonRpcMessage[] = [];
          try { frames = io.parseMessages(text); } catch { /* Non-RPC servers can simply omit subscriptions. */ }
          const error = frames.find((frame) => frame.error)?.error;
          if (error) throw new McpRpcError(redactMcpText(error.message ?? "Subscription refused", leased.redactions), error.code, redactMcpValue(error.data, leased.redactions), res.status);
        }
        return res;
      });
    } else {
      const leased = await io.lease(session);
      controller.signal.throwIfAborted();
      response = await io.fetch(session)(leased.url ?? session.url, {
        method: "GET", headers: { Accept: "text/event-stream", ...credentialHeaders(session.headers, leased.headers), ...protocolHeaders(session, true) },
        signal: session.signal ? AbortSignal.any([session.signal, controller.signal]) : controller.signal,
      });
    }
  } catch (error) {
    clearTimeout(connectTimer);
    if (error instanceof McpAuthRejectedError || error instanceof McpRpcError) throw error;
    return null;
  }
  clearTimeout(connectTimer);
  if (!response.ok || !response.body || !io.isEventStream(response)) { await response.body?.cancel().catch(() => undefined); return null; }
  io.adoptSessionId(session, response);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > MCP_MAX_RESPONSE_CHARS) return;
        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary >= 0) {
          const separator = /\r?\n\r?\n/.exec(buffer.slice(boundary))?.[0] ?? "\n\n";
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + separator.length);
          for (const payload of io.parseEvents(`${event}\n\n`)) {
            let messages: JsonRpcMessage[] = [];
            try { messages = io.parseMessages(payload); } catch { continue; }
            for (const message of messages) {
              if (io.isResponse(message)) { if (session.wire === "modern") return; continue; }
              await io.dispatch(session, message);
            }
          }
          boundary = buffer.search(/\r?\n\r?\n/);
        }
      }
    } catch { /* Stream closed locally or by the server. */ }
    finally { await reader.cancel().catch(() => undefined); }
  })();
  return { close: () => { controller.abort(); void reader.cancel().catch(() => undefined); }, done };
}
