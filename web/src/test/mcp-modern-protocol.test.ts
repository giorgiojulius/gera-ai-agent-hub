/**
 * MCP 2026-07-28 (stateless revision) conformance — the protocol core and the
 * toolset against an in-process server that speaks the new wire exactly as
 * the spec describes: `server/discover` first, `_meta` on every request,
 * `Mcp-Method` / `Mcp-Name` headers, no `initialize`, no `Mcp-Session-Id`,
 * `resultType` on results, `input_required` answered by re-sending the call
 * with `inputResponses` + `requestState`, and `subscriptions/listen` as an
 * SSE response instead of the GET stream. A legacy fixture next to it proves
 * the probe falls back to the initialize handshake and that one run mixes both.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CloudMcpServer, CloudMcpTool } from "../../../functions/mcp-cloud";
import { connectCloudMcp } from "../../../functions/mcp-cloud";
import {
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_META_CLIENT_CAPABILITIES,
  MCP_META_CLIENT_INFO,
  MCP_META_PROTOCOL_VERSION,
  MCP_META_SERVER_INFO,
  MCP_META_SUBSCRIPTION_ID,
  MCP_MODERN_PROTOCOL_VERSION,
  mcpHeaderValue,
  type McpFetch,
} from "../../../functions/mcp-protocol";
import {
  createMemoryMcpCatalogStore,
  MCP_CALL_TOOL_NAME,
  MCP_SEARCH_TOOL_NAME,
  resolveMcpToolset,
} from "../../../functions/mcp-toolset";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Frame = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> };
type Recorded = { method: string; headers: Record<string, string>; body: Frame };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function rpcError(id: number | string | undefined, code: number, message: string, status: number, data?: unknown): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }, status);
}

const TOOLS: CloudMcpTool[] = [
  { name: "list_things", description: "Lists things", inputSchema: { type: "object", properties: {} } },
  { name: "deploy", description: "Deploys to a region after asking which one", inputSchema: { type: "object", properties: {} } },
  { name: "sample", description: "Wants the client to run a model", inputSchema: { type: "object", properties: {} } },
];

/**
 * A stateless 2026-07-28 server behind an injected fetch. Records every
 * request; `strict` enforces the spec's required headers and `_meta` keys and
 * answers protocol faults with the spec's error codes on 400/404.
 */
function modernServer(options: { rejectFirstDiscover?: boolean; listenEvents?: string[] } = {}) {
  const url = "https://modern.gera-fixture.dev/mcp";
  const requests: Recorded[] = [];
  let discovers = 0;
  const fetch: McpFetch = async (target, init) => {
    if (target !== url) {
      return new Response("not found", { status: 404 });
    }
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    if (init.method === "GET" || init.method === "DELETE") {
      return new Response("", { status: 405 });
    }
    const body = JSON.parse(String(init.body)) as Frame;
    requests.push({ method: body.method ?? "", headers, body });
    const meta = (body.params?._meta ?? {}) as Record<string, unknown>;
    const version = meta[MCP_META_PROTOCOL_VERSION];
    if (headers["mcp-session-id"]) {
      return rpcError(body.id, -32602, "Mcp-Session-Id is not part of this revision", 400);
    }
    if (headers["mcp-protocol-version"] !== version) {
      return rpcError(body.id, -32020, "Header mismatch", 400);
    }
    if (headers["mcp-method"] !== body.method) {
      return rpcError(body.id, -32020, "Mcp-Method mismatch", 400);
    }
    if (typeof version !== "string" || !(MCP_META_CLIENT_CAPABILITIES in meta)) {
      return rpcError(body.id, -32602, "Missing required _meta", 400);
    }
    if (body.method === "server/discover") {
      discovers += 1;
      if (options.rejectFirstDiscover && discovers === 1) {
        return rpcError(body.id, -32022, "Unsupported protocol version", 400, {
          supported: [MCP_MODERN_PROTOCOL_VERSION],
          requested: version,
        });
      }
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          resultType: "complete",
          supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
          capabilities: { tools: { listChanged: true } },
          _meta: { [MCP_META_SERVER_INFO]: { name: "Modern Things", version: "3.0.0" } },
          instructions: "Be brief.",
          ttlMs: 60_000,
          cacheScope: "public",
        },
      });
    }
    if (version !== MCP_MODERN_PROTOCOL_VERSION) {
      return rpcError(body.id, -32022, "Unsupported protocol version", 400, { supported: [MCP_MODERN_PROTOCOL_VERSION], requested: version });
    }
    if (body.method === "tools/list") {
      return json({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", tools: TOOLS, ttlMs: 0, cacheScope: "private" } });
    }
    if (body.method === "tools/call") {
      const name = String(body.params?.name ?? "");
      if (headers["mcp-name"] !== mcpHeaderValue(name)) {
        return rpcError(body.id, -32020, "Mcp-Name mismatch", 400);
      }
      if (name === "list_things") {
        return json({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", content: [{ type: "text", text: "thing-1, thing-2" }] } });
      }
      if (name === "deploy") {
        const answers = body.params?.inputResponses as Record<string, { action?: string; content?: Record<string, unknown> }> | undefined;
        if (!answers?.region) {
          return json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              resultType: "input_required",
              inputRequests: {
                region: {
                  method: "elicitation/create",
                  params: {
                    mode: "form",
                    message: "Which region should this deploy to?",
                    requestedSchema: { type: "object", properties: { region: { type: "string", enum: ["eu", "us"] } }, required: ["region"] },
                  },
                },
              },
              requestState: "opaque-state-1",
            },
          });
        }
        if (body.params?.requestState !== "opaque-state-1") {
          return rpcError(body.id, -32602, "requestState must be echoed", 400);
        }
        const text = answers.region.action === "accept" ? `deployed to ${String(answers.region.content?.region)}` : `deploy declined (${answers.region.action})`;
        return json({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", content: [{ type: "text", text }] } });
      }
      if (name === "sample") {
        return json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            resultType: "input_required",
            inputRequests: { answer: { method: "sampling/createMessage", params: { messages: [], maxTokens: 10 } } },
          },
        });
      }
      return rpcError(body.id, -32602, `unknown tool ${name}`, 400);
    }
    if (body.method === "subscriptions/listen") {
      const events = [
        { jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { _meta: { [MCP_META_SUBSCRIPTION_ID]: body.id }, notifications: body.params?.notifications } },
        ...(options.listenEvents ?? ["notifications/tools/list_changed"]).map((method) => ({
          jsonrpc: "2.0",
          method,
          params: { _meta: { [MCP_META_SUBSCRIPTION_ID]: body.id } },
        })),
        { jsonrpc: "2.0", id: body.id, result: { resultType: "complete", _meta: { [MCP_META_SUBSCRIPTION_ID]: body.id } } },
      ];
      const stream = events.map((event) => `event: message\ndata: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    // Legacy methods do not exist on this wire.
    return rpcError(body.id, -32601, "Method not found", 404);
  };
  return { url, requests, fetch, discovers: () => discovers };
}

/** A legacy (initialize / session) server behind the same injected fetch. */
function legacyServer() {
  const url = "https://legacy.gera-fixture.dev/mcp";
  const requests: Recorded[] = [];
  let initializes = 0;
  const fetch: McpFetch = async (target, init) => {
    if (target !== url) {
      return new Response("not found", { status: 404 });
    }
    if (init.method === "GET") {
      return new Response("", { status: 405 });
    }
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = JSON.parse(String(init.body)) as Frame;
    requests.push({ method: body.method ?? "", headers, body });
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (body.method === "initialize") {
      initializes += 1;
      return json(
        { jsonrpc: "2.0", id: body.id, result: { protocolVersion: MCP_LATEST_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "Legacy Things" } } },
        200,
      );
    }
    if (body.method === "tools/list") {
      return json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "old_tool", description: "Old but gold", inputSchema: { type: "object", properties: {} } }] } });
    }
    if (body.method === "tools/call") {
      return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "old result" }] } });
    }
    // An older server answers an unknown method with -32601 on a 200 body.
    return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
  };
  return { url, requests, fetch, initializes: () => initializes };
}

function combine(...servers: Array<{ url: string; fetch: McpFetch }>): McpFetch {
  return (target, init) => {
    const server = servers.find((candidate) => candidate.url === target);
    return server ? server.fetch(target, init) : Promise.resolve(new Response("not found", { status: 404 }));
  };
}

function cloud(id: string, url: string): CloudMcpServer {
  return { id, name: id.charAt(0).toUpperCase() + id.slice(1), kind: "mcp", url, headers: {}, omitMcpHeaders: false, disabledTools: [] };
}

describe("MCP 2026-07-28 · stateless wire", () => {
  it("discover → stateless path: _meta and Mcp-Method on every request, no initialize, no session id", async () => {
    const server = modernServer();
    const connection = await connectCloudMcp(cloud("modern", server.url), { fetch: server.fetch, inventory: true });
    expect(connection.session.wire).toBe("modern");
    expect(connection.session.protocolVersion).toBe(MCP_MODERN_PROTOCOL_VERSION);
    expect(connection.session.sessionId).toBeUndefined();
    expect(connection.session.serverInfo).toEqual({ name: "Modern Things", title: undefined, version: "3.0.0" });
    expect(connection.session.instructions).toBe("Be brief.");
    expect(connection.session.capabilities?.tools?.listChanged).toBe(true);
    expect(connection.tools.map((tool) => tool.name)).toEqual(["list_things", "deploy", "sample"]);
    expect(connection.wire).toEqual(expect.objectContaining({ era: "modern", protocolVersion: MCP_MODERN_PROTOCOL_VERSION }));

    expect(server.requests.map((request) => request.method)).toEqual(["server/discover", "tools/list"]);
    expect(server.requests.some((request) => request.method === "initialize" || request.method === "notifications/initialized")).toBe(false);
    for (const request of server.requests) {
      expect(request.headers["mcp-protocol-version"]).toBe(MCP_MODERN_PROTOCOL_VERSION);
      expect(request.headers["mcp-method"]).toBe(request.method);
      expect(request.headers["mcp-session-id"]).toBeUndefined();
      expect(request.headers.accept).toBe("application/json, text/event-stream");
      const meta = request.body.params?._meta as Record<string, unknown>;
      expect(meta[MCP_META_PROTOCOL_VERSION]).toBe(MCP_MODERN_PROTOCOL_VERSION);
      expect(meta[MCP_META_CLIENT_CAPABILITIES]).toEqual({ elicitation: { form: {} } });
      expect(meta[MCP_META_CLIENT_INFO]).toMatchObject({ name: "Gera AI cloud runs" });
    }
  });

  it("retries a -32022 UnsupportedProtocolVersion answer with a version from the server's list", async () => {
    const server = modernServer({ rejectFirstDiscover: true });
    const connection = await connectCloudMcp(cloud("modern", server.url), { fetch: server.fetch });
    expect(connection.session.wire).toBe("modern");
    expect(server.discovers()).toBe(2);
    expect(connection.tools).toHaveLength(3);
  });

  it("falls back to the initialize handshake when the probe meets a legacy server", async () => {
    const server = legacyServer();
    const connection = await connectCloudMcp(cloud("legacy", server.url), { fetch: server.fetch });
    expect(connection.session.wire).toBe("legacy");
    expect(connection.session.protocolVersion).toBe(MCP_LATEST_PROTOCOL_VERSION);
    expect(server.requests.map((request) => request.method)).toEqual(["server/discover", "initialize", "notifications/initialized", "tools/list"]);
    // Legacy requests carry no stateless-only shape.
    for (const request of server.requests.slice(1)) {
      expect(request.headers["mcp-method"]).toBeUndefined();
      expect(request.body.params?._meta).toBeUndefined();
    }
    expect(connection.wire).toEqual(expect.objectContaining({ era: "legacy", protocolVersion: MCP_LATEST_PROTOCOL_VERSION }));
  });

  it("input_required pauses on the elicitation hook and re-sends the call with inputResponses + requestState", async () => {
    const server = modernServer();
    const asked: string[] = [];
    const toolset = await resolveMcpToolset({
      servers: [cloud("modern", server.url)],
      mode: "native",
      surface: "interactive",
      fetch: server.fetch,
      notificationStreams: false,
      elicit: async (request) => {
        asked.push(request.message);
        return { action: "accept", content: { region: "eu" } };
      },
    });
    expect(toolset.mode).toBe("native");
    const outcome = await toolset.execute("mcp_modern_deploy", {});
    expect(outcome.isError).toBeUndefined();
    expect(outcome.text).toBe("deployed to eu");
    expect(asked).toEqual(["Which region should this deploy to?"]);
    const calls = server.requests.filter((request) => request.method === "tools/call");
    expect(calls).toHaveLength(2);
    expect(calls[0].body.params?.inputResponses).toBeUndefined();
    expect(calls[1].body.params).toMatchObject({
      name: "deploy",
      inputResponses: { region: { action: "accept", content: { region: "eu" } } },
      requestState: "opaque-state-1",
    });
    expect(calls[1].body.id).not.toBe(calls[0].body.id);
    expect(calls[1].headers["mcp-name"]).toBe("deploy");
  });

  it("background runs decline input_required honestly, and sampling requests are refused", async () => {
    const server = modernServer();
    const toolset = await resolveMcpToolset({
      servers: [cloud("modern", server.url)],
      mode: "native",
      surface: "background",
      fetch: server.fetch,
      notificationStreams: false,
    });
    const declined = await toolset.execute("mcp_modern_deploy", {});
    expect(declined.text).toBe("deploy declined (decline)");
    expect(toolset.journal.some((entry) => entry.kind === "elicitation_declined")).toBe(true);
    const sampled = await toolset.execute("mcp_modern_sample", {});
    expect(sampled.isError).toBe(true);
    expect(sampled.text).toMatch(/sampling/);
  });

  it("subscriptions/listen replaces the GET stream and its list_changed invalidates the catalog", async () => {
    const server = modernServer();
    const catalog = createMemoryMcpCatalogStore();
    const toolset = await resolveMcpToolset({
      servers: [cloud("modern", server.url)],
      mode: "deferred",
      fetch: server.fetch,
      catalog,
    });
    // The stream is consumed asynchronously; give the fixture's SSE body a tick.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const listen = server.requests.find((request) => request.method === "subscriptions/listen");
    expect(listen).toBeDefined();
    expect(listen?.body.params?.notifications).toEqual({ toolsListChanged: true });
    expect(listen?.headers["mcp-method"]).toBe("subscriptions/listen");
    expect(listen?.body.params?._meta).toMatchObject({ [MCP_META_PROTOCOL_VERSION]: MCP_MODERN_PROTOCOL_VERSION });
    // No legacy GET stream was ever opened (the fixture answers GET with 405 and records nothing).
    expect(server.requests.every((request) => request.method !== "")).toBe(true);
    // The fixture's list_changed arrived on the listen stream: the account cache is dropped …
    expect(catalog.read("modern")).toBeNull();
    // … and the next search re-lists before ranking.
    const before = server.requests.filter((request) => request.method === "tools/list").length;
    const found = JSON.parse((await toolset.execute(MCP_SEARCH_TOOL_NAME, { query: "deploy" })).text) as { matches: Array<{ toolName: string }> };
    expect(found.matches[0]?.toolName).toBe("deploy");
    expect(server.requests.filter((request) => request.method === "tools/list").length).toBe(before + 1);
    expect(catalog.read("modern")?.tools).toHaveLength(3);
    toolset.close();
  });

  it("a cached wire hint skips the probe on the next run; a Re-check probes afresh", async () => {
    const server = modernServer();
    const catalog = createMemoryMcpCatalogStore();
    await resolveMcpToolset({ servers: [cloud("modern", server.url)], mode: "native", fetch: server.fetch, catalog, notificationStreams: false });
    expect(catalog.read("modern")?.wire).toEqual(expect.objectContaining({ era: "modern", protocolVersion: MCP_MODERN_PROTOCOL_VERSION }));
    expect(server.discovers()).toBe(1);

    // Deferred run: the table comes from the cache; the first call connects with the hint — no second probe.
    const deferred = await resolveMcpToolset({ servers: [cloud("modern", server.url)], mode: "deferred", fetch: server.fetch, catalog, notificationStreams: false });
    const found = JSON.parse((await deferred.execute(MCP_SEARCH_TOOL_NAME, { query: "list_things" })).text) as { matches: Array<{ toolName: string }> };
    expect(found.matches[0]?.toolName).toBe("list_things");
    const ran = await deferred.execute(MCP_CALL_TOOL_NAME, { serverId: "modern", toolName: "list_things", arguments: {} });
    expect(ran.text).toBe("thing-1, thing-2");
    expect(server.discovers()).toBe(1);

    // Health check (uncapped) always renegotiates.
    await resolveMcpToolset({ servers: [cloud("modern", server.url)], mode: "native", uncapped: true, fetch: server.fetch, catalog, notificationStreams: false });
    expect(server.discovers()).toBe(2);
  });

  it("one run mixes a stateless server and a legacy server, each on its own wire", async () => {
    const modern = modernServer();
    const legacy = legacyServer();
    const toolset = await resolveMcpToolset({
      servers: [cloud("modern", modern.url), cloud("legacy", legacy.url)],
      mode: "native",
      fetch: combine(modern, legacy),
      notificationStreams: false,
    });
    expect(toolset.failures).toEqual([]);
    const names = toolset.toolDefs.map((def) => def.function.name);
    expect(names).toContain("mcp_modern_list_things");
    expect(names).toContain("mcp_legacy_old_tool");
    expect(toolset.servers.map((info) => [info.id, info.protocolVersion])).toEqual([
      ["modern", MCP_MODERN_PROTOCOL_VERSION],
      ["legacy", MCP_LATEST_PROTOCOL_VERSION],
    ]);
    expect((await toolset.execute("mcp_modern_list_things", {})).text).toBe("thing-1, thing-2");
    expect((await toolset.execute("mcp_legacy_old_tool", {})).text).toBe("old result");
    expect(legacy.initializes()).toBe(1);
  });

  it("wraps non-ASCII Mcp-Name values the way the spec requires", () => {
    expect(mcpHeaderValue("deploy")).toBe("deploy");
    expect(mcpHeaderValue("развернуть")).toMatch(/^=\?base64\?[A-Za-z0-9+/=]+\?=$/);
  });
});
