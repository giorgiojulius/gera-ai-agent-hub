/**
 * MCP protocol core — the failure modes and pure helpers the conformance
 * suite (real SDK server) cannot produce: auth rejections, a lost session,
 * oversized bodies, an unsupported revision, elicitation validation, URI
 * templates, annotations / UI-only markers, and the composer trigger parser.
 */
import { describe, expect, it } from "vitest";

import {
  expandUriTemplate,
  isUiOnlyTool,
  MCP_LATEST_PROTOCOL_VERSION,
  McpAuthRejectedError,
  McpSessionLostError,
  mcpInitialize,
  mcpRequest,
  normalizeElicitationRequest,
  normalizeToolAnnotations,
  openMcpNotificationStream,
  parseJsonRpcPayload,
  selectRpcResponse,
  toolAnnotationBadges,
  uriTemplateVariables,
  validateElicitationContent,
  type McpFetch,
  type McpProtocolSession,
} from "../../../functions/mcp-protocol";
import { createRunPauseBoard } from "../../../functions/run-pause";
import { detectComposerMenuTrigger, replaceComposerToken } from "@/lib/mcp-inventory";

function session(fetch: McpFetch, overrides: Partial<McpProtocolSession> = {}): McpProtocolSession {
  return { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer sk-secret-1" }, omitMcpHeaders: false, nextId: 0, fetch, ...overrides };
}

function rpcResult(id: unknown, result: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("mcp-protocol · transport failures", () => {
  it("turns 401/403 into McpAuthRejectedError carrying the WWW-Authenticate challenge, redaction intact", async () => {
    const fetch: McpFetch = async () =>
      new Response("nope sk-secret-1", {
        status: 403,
        headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="repo:write"' },
      });
    const error = await mcpRequest(session(fetch), "tools/call", { name: "x" }, 1_000).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(McpAuthRejectedError);
    expect((error as McpAuthRejectedError).status).toBe(403);
    expect((error as McpAuthRejectedError).wwwAuthenticate).toContain('scope="repo:write"');
    expect((error as Error).message).toMatch(/auth rejected \(403\)/);
    expect((error as Error).message).not.toContain("sk-secret-1");
  });

  it("reports a lost session on 404 (or a session complaint) only after a session id was issued", async () => {
    const lost: McpFetch = async () => new Response("Session not found", { status: 404 });
    await expect(mcpRequest(session(lost, { sessionId: "old" }), "tools/list", {}, 1_000)).rejects.toBeInstanceOf(McpSessionLostError);
    await expect(mcpRequest(session(lost), "tools/list", {}, 1_000)).rejects.toThrow(/HTTP 404/);
    const complaint: McpFetch = async () => new Response("Bad Request: invalid session", { status: 400 });
    await expect(mcpRequest(session(complaint, { sessionId: "old" }), "tools/list", {}, 1_000)).rejects.toBeInstanceOf(McpSessionLostError);
  });

  it("refuses bodies over the response cap instead of buffering them", async () => {
    const huge = `{"jsonrpc":"2.0","id":1,"result":{"text":"${"x".repeat(2_100_000)}"}}`;
    const fetch: McpFetch = async () => new Response(huge, { status: 200, headers: { "Content-Type": "application/json" } });
    await expect(mcpRequest(session(fetch), "tools/list", {}, 1_000)).rejects.toThrow(/too large/);
  });

  it("rejects an initialize answer with an unsupported revision and proposes the latest itself", async () => {
    const seen: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    const fetch: McpFetch = async (_url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      seen.push({ body, headers: new Headers(init.headers) });
      return rpcResult(body.id, { protocolVersion: "2023-01-01", capabilities: {}, serverInfo: { name: "old" } });
    };
    await expect(mcpInitialize(session(fetch))).rejects.toThrow(/unsupported MCP protocol version "2023-01-01"/);
    const params = seen[0].body.params as Record<string, unknown>;
    expect(params.protocolVersion).toBe(MCP_LATEST_PROTOCOL_VERSION);
    expect((params.capabilities as Record<string, unknown>).elicitation).toEqual({ form: {} });
    // The version header is only meaningful once negotiated — initialize goes without it.
    expect(seen[0].headers.get("MCP-Protocol-Version")).toBeNull();
  });

  it("accepts an older supported revision and pins it on the session", async () => {
    const fetch: McpFetch = async (_url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (body.method === "initialize") {
        return rpcResult(body.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "legacy" } }, { "Mcp-Session-Id": "s-1" });
      }
      return new Response(null, { status: 202 });
    };
    const live = session(fetch);
    const result = await mcpInitialize(live);
    expect(result.protocolVersion).toBe("2025-03-26");
    expect(live.protocolVersion).toBe("2025-03-26");
    expect(live.sessionId).toBe("s-1");
    expect(live.redactions).toContain("s-1");
  });

  it("treats a 405 on GET as 'no notification stream' rather than an error", async () => {
    const fetch: McpFetch = async () => new Response("Method Not Allowed", { status: 405 });
    expect(await openMcpNotificationStream(session(fetch, { sessionId: "s" }))).toBeNull();
  });

  it("dispatches notifications and answers server requests found before the response on an SSE stream", async () => {
    const posts: Array<Record<string, unknown>> = [];
    const fetch: McpFetch = async (_url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      if (body.method === "tools/call") {
        const stream = [
          `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`,
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: "srv-1", method: "ping" })}\n\n`,
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "done" }] } })}\n\n`,
        ].join("");
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response(null, { status: 202 });
    };
    const notifications: string[] = [];
    const live = session(fetch, { onNotification: (note) => notifications.push(note.method) });
    const result = await mcpRequest(live, "tools/call", { name: "x" }, 1_000);
    expect(result).toEqual({ content: [{ type: "text", text: "done" }] });
    expect(notifications).toEqual(["notifications/progress"]);
    // The ping was answered with a JSON-RPC result frame POSTed back.
    expect(posts.find((frame) => frame.id === "srv-1" && "result" in frame)).toBeDefined();
  });
});

describe("mcp-protocol · frames", () => {
  it("parses JSON, batches, and SSE payloads; skips non-JSON data events", () => {
    expect(parseJsonRpcPayload('{"jsonrpc":"2.0","id":1,"result":{}}')).toHaveLength(1);
    expect(parseJsonRpcPayload('[{"id":1,"result":{}},{"method":"x"}]')).toHaveLength(2);
    const sse = 'event: message\ndata: {"id":3,"result":1}\n\ndata: keepalive\n\ndata: {"method":"notifications/x"}\n\n';
    const frames = parseJsonRpcPayload(sse);
    expect(frames.map((frame) => frame.id ?? frame.method)).toEqual([3, "notifications/x"]);
  });

  it("selects the exact id, tolerates a lone id-less response, never a mismatched one", () => {
    expect(selectRpcResponse([{ id: 2, result: "b" }, { id: 1, result: "a" }], 1)?.result).toBe("a");
    expect(selectRpcResponse([{ result: "only" }], 7)?.result).toBe("only");
    expect(selectRpcResponse([{ id: 9, result: "other" }], 7)).toBeNull();
  });
});

describe("mcp-protocol · annotations, UI-only, templates", () => {
  it("normalizes annotations and recognizes both MCP Apps markers", () => {
    expect(normalizeToolAnnotations({ readOnlyHint: true, title: " Echo ", destructiveHint: "yes" })).toEqual({ readOnlyHint: true, title: "Echo" });
    expect(normalizeToolAnnotations({})).toBeUndefined();
    expect(isUiOnlyTool({ _meta: { ui: { resourceUri: "ui://x" } } })).toBe(true);
    expect(isUiOnlyTool({ _meta: { "ui/resourceUri": "ui://x" } })).toBe(true);
    expect(isUiOnlyTool({ _meta: { other: 1 } })).toBe(false);
    expect(toolAnnotationBadges({ readOnlyHint: true, openWorldHint: true }, true)).toEqual(["UI-only", "read-only", "open-world"]);
  });

  it("extracts and expands URI template variables with operator-aware encoding", () => {
    expect(uriTemplateVariables("repo://{owner}/{repo}/file{+path}{?ref,line}")).toEqual(["owner", "repo", "path", "ref", "line"]);
    expect(expandUriTemplate("repo://{owner}/{repo}/file{+path}{?ref}", { owner: "acme", repo: "a b", path: "/src/x.ts", ref: "v1" })).toBe(
      "repo://acme/a%20b/file/src/x.ts?ref=v1",
    );
  });
});

describe("mcp-protocol · elicitation", () => {
  const request = normalizeElicitationRequest({
    message: "Deploy where?",
    requestedSchema: {
      type: "object",
      properties: {
        region: { type: "string", enum: ["eu", "us"], title: "Region" },
        count: { type: "integer", minimum: 1, maximum: 3 },
        email: { type: "string", format: "email" },
        confirm: { type: "boolean", default: false },
        tier: { oneOf: [{ const: "gold", title: "Gold" }, { const: "silver", title: "Silver" }] },
      },
      required: ["region", "count"],
    },
  });

  it("flattens requestedSchema into fields (enums, titled oneOf, formats, bounds)", () => {
    expect(request?.mode).toBe("form");
    expect(request?.fields.map((field) => field.name)).toEqual(["region", "count", "email", "confirm", "tier"]);
    expect(request?.fields[0].enum).toEqual(["eu", "us"]);
    expect(request?.fields[4].enum).toEqual(["gold", "silver"]);
    expect(request?.fields[4].enumLabels).toEqual(["Gold", "Silver"]);
    expect(request?.fields[1].required).toBe(true);
    expect(normalizeElicitationRequest({ message: "go", mode: "url", url: "https://x" })?.mode).toBe("url");
    expect(normalizeElicitationRequest({ nope: 1 })).toBeNull();
  });

  it("validates and coerces form values, naming every violation without echoing values", () => {
    const ok = validateElicitationContent(request!, { region: "eu", count: "2", email: "a@b.co", confirm: "true", tier: "gold" });
    expect(ok).toEqual({ ok: true, content: { region: "eu", count: 2, email: "a@b.co", confirm: true, tier: "gold" } });
    const bad = validateElicitationContent(request!, { region: "mars", count: 9, email: "not-an-email" });
    expect(bad.ok).toBe(false);
    if (bad.ok === false) {
      expect(bad.errors).toEqual([
        "Region must be one of the offered options",
        "count must be at most 3",
        "email must be an email address",
      ]);
      expect(bad.errors.join(" ")).not.toContain("mars");
    }
    const missing = validateElicitationContent(request!, {});
    expect(missing.ok === false && missing.errors).toEqual(["Region is required", "count is required"]);
  });
});

describe("run pause board", () => {
  it("resolves accept with validated content, rejects invalid answers, cancels on timeout and cancelAll", async () => {
    const board = createRunPauseBoard({ newId: () => "p1" });
    const changes: number[] = [];
    board.subscribe(() => changes.push(board.pending().length));
    const pending = board.request(
      { kind: "elicitation", serverId: "s", serverName: "S", message: "m", fields: [{ name: "n", type: "integer", required: true }] },
      60_000,
    );
    expect(board.pending().map((item) => item.id)).toEqual(["p1"]);
    expect(board.answer("nope", { action: "accept" })).toEqual({ ok: false, error: "not_found" });
    expect(board.answer("p1", { action: "maybe" })).toEqual({ ok: false, error: "invalid_action" });
    expect(board.answer("p1", { action: "accept", content: { n: "x" } })).toEqual({ ok: false, error: "invalid_answer", errors: ["n must be a number"] });
    expect(board.answer("p1", { action: "accept", content: { n: "4" } })).toEqual({ ok: true });
    expect(await pending).toEqual({ action: "accept", content: { n: 4 } });
    expect(changes).toEqual([1, 0]);

    const timed = createRunPauseBoard();
    const late = timed.request({ kind: "elicitation", serverId: "s", serverName: "S", message: "m", fields: [] }, 1_000);
    expect(await late).toEqual({ action: "cancel" });

    const stopped = createRunPauseBoard();
    const open = stopped.request({ kind: "elicitation", serverId: "s", serverName: "S", message: "m", fields: [] }, 60_000);
    stopped.cancelAll();
    expect(await open).toEqual({ action: "cancel" });
    expect(stopped.pending()).toEqual([]);
  });
});

describe("composer MCP menu triggers", () => {
  it("opens on a leading or whitespace-preceded / or @ at the caret and replaces the token", () => {
    expect(detectComposerMenuTrigger("/expl", 5)).toEqual({ kind: "prompt", query: "expl", start: 0, end: 5 });
    expect(detectComposerMenuTrigger("see @READ", 9)).toEqual({ kind: "resource", query: "READ", start: 4, end: 9 });
    expect(detectComposerMenuTrigger("path/to/file", 12)).toBeNull();
    expect(detectComposerMenuTrigger("mail me@x.io", 12)).toBeNull();
    expect(detectComposerMenuTrigger("/expl and more", 5)?.query).toBe("expl");
    const trigger = detectComposerMenuTrigger("see @READ now", 9)!;
    expect(replaceComposerToken("see @READ now", trigger, "@deepwiki/wiki://x")).toEqual({
      value: "see @deepwiki/wiki://x now",
      caret: "see @deepwiki/wiki://x".length,
    });
    expect(replaceComposerToken("/expl", detectComposerMenuTrigger("/expl", 5)!, "Explain it").value).toBe("Explain it ");
  });
});
