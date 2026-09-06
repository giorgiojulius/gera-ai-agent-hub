import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpConnect, mcpRequest, openMcpNotificationStream, McpRpcError, MCP_META_CLIENT_CAPABILITIES, MCP_META_LOG_LEVEL, MCP_MODERN_PROTOCOL_VERSION, type McpProtocolSession, type McpFetch } from "../../../functions/mcp-protocol";
import { pickModernVersion } from "../../../functions/mcp-modern";
import { normalizeCatalogWire } from "../../../functions/mcp-catalog-wire";
import { resolveMcpToolset, createSqlMcpCatalogStore } from "../../../functions/mcp-toolset";
import { handleMcpInventory, handleMcpPromptGet, handleMcpResourceRead } from "../../../functions/mcp-routes";
import { handleMcpCatalogWrite, ownerCatalogGeneration } from "../../../functions/mcp-owner-catalog";
import { createMcpConnections, type McpServerState } from "../../../functions/mcp-lazy-connect";
import { relayMcp, type McpRelayContext } from "../../../functions/mcp-relay";
import { mcpAccountFixture } from "./fixtures/mcp-account";
import type { CloudMcpServer } from "../../../functions/mcp-cloud";

const version = MCP_MODERN_PROTOCOL_VERSION;
const frame = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, data: unknown) => Response.json({ jsonrpc: "2.0", id, error: { code, message: "Protocol refused", data } }, { status: 400 });
const config: CloudMcpServer = { id: "modern", name: "Modern", kind: "mcp", url: "https://modern.fixture.dev/mcp", headers: {}, omitMcpHeaders: false, disabledTools: [] };
const makeSession = (fetch: McpFetch, extra: Partial<McpProtocolSession> = {}): McpProtocolSession => ({ ...config, nextId: 0, fetch, wire: "modern", protocolVersion: version, clientCapabilities: {}, ...extra });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("modern protocol corrections", () => {
  it.each(["server/discover", "tools/list", "tools/call", "prompts/get", "resources/read", "subscriptions/listen"])("%s preserves log metadata and corrects supported nested capabilities once", async (method) => {
    const requests: Record<string, unknown>[] = [];
    const fetch: McpFetch = async (_url, init) => {
      const body = JSON.parse(String(init.body));
      requests.push(body.params);
      expect(new Headers(init.headers).get("Mcp-Session-Id")).toBeNull();
      if (requests.length === 1) return rpcError(body.id, -32021, { requiredCapabilities: { elicitation: { form: {} } } });
      if (method === "subscriptions/listen") return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
      return frame(body.id, { supportedVersions: [version], capabilities: {}, resultType: "complete" });
    };
    const session = makeSession(fetch, { logLevel: "notice", capabilities: { tools: { listChanged: true } }, headers: { "mcp-session-id": "must-not-send", "Mcp-Method": "forged", "X-Key": "keep" } });
    if (method === "subscriptions/listen") { const stream = await openMcpNotificationStream(session); await stream?.done; stream?.close(); }
    else await mcpRequest(session, method, { name: "tool", uri: "file:///x" }, 1_000);
    expect(requests).toHaveLength(2);
    for (const params of requests) expect((params._meta as Record<string, unknown>)[MCP_META_LOG_LEVEL]).toBe("notice");
    expect((requests[1]._meta as Record<string, unknown>)[MCP_META_CLIENT_CAPABILITIES]).toEqual({ elicitation: { form: {} } });
  });
  it.each([{ sampling: {} }, { elicitation: { url: {} } }, { elicitation: { form: { unknown: true } } }])("unsupported requirement %j stays a structured refusal with no legacy fallback", async (required) => {
    const calls: string[] = [];
    const session = makeSession(async (_url, init) => { const body = JSON.parse(String(init.body)); calls.push(body.method); return rpcError(body.id, -32021, { requiredCapabilities: required }); });
    await expect(mcpConnect(session)).rejects.toMatchObject({ rpcCode: -32021, rpcData: { requiredCapabilities: required } });
    expect(calls).toEqual(["server/discover"]);
  });
  it("a second capability refusal is not retried, and version selection uses the newest actual intersection", async () => {
    let calls = 0;
    const session = makeSession(async (_url, init) => { calls += 1; return rpcError(JSON.parse(String(init.body)).id, -32021, { requiredCapabilities: { roots: {} } }); });
    await expect(mcpRequest(session, "tools/list", {}, 1_000)).rejects.toBeInstanceOf(McpRpcError);
    expect(calls).toBe(2);
    expect(pickModernVersion(["2027-04-01", "2026-07-28", "2027-01-01"], ["2026-07-28", "2027-01-01"])).toBe("2027-01-01");
    expect(normalizeCatalogWire({ era: "modern", protocolVersion: "2025-11-25" })).toBeUndefined();
    expect(normalizeCatalogWire({ era: "legacy", protocolVersion: version })).toBeUndefined();
  });
});

describe("catalog wire and lifecycle", () => {
  it("inventory persists wire; calls and partial reads skip discover; uncapped checks and malformed wire probe anew", async () => {
    const owner = "owner@example.com";
    const account = mcpAccountFixture(owner, [{ ...config, enabled: true, status: "connected", authMode: "none", tools: [] }]);
    const methods: string[] = [];
    const fetch: McpFetch = async (_url, init) => {
      const request = JSON.parse(String(init.body)); methods.push(request.method);
      const result = request.method === "server/discover" ? { supportedVersions: [version], capabilities: { tools: {}, prompts: {}, resources: {} } }
        : request.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }, { name: "other", inputSchema: { type: "object" } }] }
        : request.method === "prompts/list" ? { prompts: [{ name: "greet" }] }
        : request.method === "resources/list" ? { resources: [{ uri: "file:///x", name: "x" }] }
        : request.method === "resources/templates/list" ? { resourceTemplates: [] }
        : request.method === "prompts/get" ? { messages: [{ role: "user", content: { type: "text", text: "hello" } }] }
        : request.method === "resources/read" ? { contents: [{ uri: "file:///x", text: "body" }] }
        : { content: [{ type: "text", text: "ok" }] };
      return frame(request.id, result);
    };
    const ctx = { ...account.ctx, fetch, resolveServers: async (requestedOwner: string, ids: string[]) => {
      expect(requestedOwner).toBe(owner);
      return ids.includes(config.id) ? [config] : [];
    } };
    const req = (body: unknown) => new Request("https://gera.test/mcp/inventory", { method: "POST", body: JSON.stringify(body) });
    expect((await handleMcpInventory(ctx, req({ serverId: "modern" }), owner)).status).toBe(200);
    const catalog = createSqlMcpCatalogStore(ctx.sql, owner);
    expect(catalog.read("modern")?.wire?.era).toBe("modern");
    const set = await resolveMcpToolset({ servers: [config], mode: "deferred", fetch, catalog, notificationStreams: false });
    await set.execute("mcp_search_tools", { query: "echo", serverId: "modern" });
    expect((await set.execute("mcp_call_tool", { serverId: "modern", toolName: "echo" })).text).toBe("ok");
    set.close();
    const before = catalog.read("modern");
    expect((await handleMcpPromptGet(ctx, req({ serverId: "modern", name: "greet" }), owner)).status).toBe(200);
    expect((await handleMcpResourceRead(ctx, req({ serverId: "modern", uri: "file:///x" }), owner)).status).toBe(200);
    expect(catalog.read("modern")).toEqual(before);
    expect(methods.filter((method) => method === "server/discover")).toHaveLength(1);
    (await resolveMcpToolset({ servers: [config], mode: "native", uncapped: true, fetch, catalog, notificationStreams: false })).close();
    expect(methods.filter((method) => method === "server/discover")).toHaveLength(2);
    const row = account.rows.get("mcp_tool_catalog")![0];
    const payload = JSON.parse(String(row.payload)); payload.wire = { era: "legacy", protocolVersion: version }; row.payload = JSON.stringify(payload);
    (await resolveMcpToolset({ servers: [config], mode: "native", fetch, catalog, notificationStreams: false })).close();
    expect(methods.filter((method) => method === "server/discover")).toHaveLength(3);
  });
  it("a connector change during hashing cannot publish an old owner catalog", async () => {
    const owner = "owner@example.com";
    const { ctx, rows } = mcpAccountFixture(owner, [{ ...config, enabled: true, status: "connected", authMode: "none" }]);
    const generation = await ownerCatalogGeneration(ctx, owner, "modern");
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => { rows.get("profiles")![0].payload = JSON.stringify({ settings: { mcpServers: [] } }); return digest(...args); });
    const response = await handleMcpCatalogWrite(ctx, new Request("https://gera.test/mcp/catalog-write", { method: "POST", body: JSON.stringify({ generation, entry: { serverId: "modern", serverName: "Modern", tools: [], fetchedAt: Date.now() } }) }), owner);
    expect(response.status).toBe(409);
    expect(createSqlMcpCatalogStore(ctx.sql, owner).read("modern")).toBeNull();
  });
  it("a stale refresh timeout never revives its session or permits a late lease to fetch", async () => {
    const network = vi.fn(async () => frame(1, { tools: [] }));
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const session = makeSession(network, { initialized: true, lease: async () => { await blocked; return { headers: {}, redactions: [] }; } });
    const state: McpServerState = { server: config, lease: { get: session.lease!, repair: async () => false }, catalog: [], session, connecting: null, pending: false, failure: null, leftOut: false, stale: true, stream: null, stepUp: null };
    const connections = createMcpConnections({ options: { servers: [] }, states: [state], now: Date.now, connectBudgetMs: 10, catalogBudgetChars: 1_000,
      repairGrant: async () => false, parkForStepUp: async () => null, serverRequestHandler: () => async () => ({ result: {} }), note: () => undefined });
    await connections.refreshIfStale(state);
    expect(session.signal?.aborted).toBe(true);
    release(); await new Promise((resolve) => setTimeout(resolve, 10));
    expect(network).not.toHaveBeenCalled(); connections.close();
  });
});

it("relay forwards the shared modern headers without sessions or caller infrastructure headers", async () => {
  const headers = { "MCP-Protocol-Version": version, "Mcp-Method": "tools/call", "Mcp-Name": "echo", "Mcp-Session-Id": "stray", "X-Key": "provider", Cookie: "caller-cookie", "CF-Ray": "caller", "X-Gera-Noise": "caller", "X-Gera-Upstream-Url": config.url };
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
    const forwarded = new Headers(init.headers);
    expect(forwarded.get("Mcp-Session-Id")).toBeNull(); expect(forwarded.get("Cookie")).toBeNull(); expect(forwarded.get("CF-Ray")).toBeNull(); expect(forwarded.get("X-Gera-Noise")).toBeNull();
    expect(forwarded.get("X-Key")).toBe("provider"); expect(forwarded.get("Mcp-Name")).toBe("echo");
    return new Response("{}", { headers });
  }));
  const ctx: McpRelayContext = { corsHeaders: {}, corsJson: (data, status) => Response.json(data, { status }), relayAccessProblem: async () => null,
    durable: { fetch: async () => Response.json({}) }, requireInvitedAccount: async () => ({ storageOwner: "owner", shardId: "owner" }), shardCall: async () => Response.json({}),
  };
  const request = new Request("https://gera.test/mcp-proxy", { method: "POST", headers, body: "{}" });
  const response = await relayMcp(ctx, request, new URL(request.url));
  expect(response.headers.get("Mcp-Method")).toBe("tools/call"); expect(response.headers.get("Mcp-Name")).toBe("echo"); expect(response.headers.get("Mcp-Session-Id")).toBeNull();
});
