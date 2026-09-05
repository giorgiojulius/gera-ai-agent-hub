/**
 * Unified MCP toolset resolver — deferred tools (plan Phase 1 acceptance).
 *
 * The fixture emulates Streamable HTTP servers over a stubbed fetch:
 * initialize → notifications/initialized → tools/list → tools/call. It counts
 * handshakes per server so the tests can prove lazy connections and cache
 * reuse, and records every tools/call so the search gate is verifiable.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CloudMcpServer, CloudMcpTool } from "../../../functions/mcp-cloud";
import { cloudMcpServersForAutomation } from "../../../functions/mcp-cloud";
import {
  createMemoryMcpCatalogStore,
  decideMcpToolLoading,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFERRED_AUTO_CONTEXT_SHARE,
  describeMcpMetaCall,
  MCP_CALL_TOOL_NAME,
  MCP_SEARCH_TOOL_NAME,
  NATIVE_TOOLS_PER_SERVER,
  normalizeMcpToolLoading,
  resolveMcpToolset,
  searchMcpTools,
  type McpToolset,
} from "../../../functions/mcp-toolset";
import { mcpSourceUrl } from "../../../functions/research-runner";

afterEach(() => {
  vi.unstubAllGlobals();
});

type FixtureServer = {
  id: string;
  url: string;
  tools: CloudMcpTool[];
  initializes: number;
  calls: Array<{ name: string; arguments: unknown }>;
  /** Respond 401 to every request — an auth-rejected server. */
  reject?: boolean;
  /** Delay every response by this many ms — a slow server the connect budget may leave behind. */
  delayMs?: number;
};

function jsonResponse(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Deterministic tool table: every tool is unique, a few carry searchable facts. */
function makeTools(prefix: string, count: number): CloudMcpTool[] {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = String(index + 1).padStart(2, "0");
    if (index === 6) {
      return {
        name: `${prefix}_schedule_meeting`,
        description: "Create a calendar event and invite people",
        inputSchema: {
          type: "object",
          properties: {
            attendees: { type: "array", items: { type: "string" }, description: "Email addresses to invite" },
            startsAt: { type: "string", description: "ISO start time" },
          },
          required: ["attendees", "startsAt"],
        },
      };
    }
    return {
      name: `${prefix}_tool_${ordinal}`,
      description: `Fixture operation number ${ordinal} on ${prefix}`,
      inputSchema: { type: "object", properties: { input: { type: "string" } } },
    };
  });
}

function fixture(id: string, count: number): FixtureServer {
  return {
    id,
    url: `https://${id}.gera-fixture.dev/mcp`,
    tools: makeTools(id, count),
    initializes: 0,
    calls: [],
  };
}

function cloudServer(server: FixtureServer, disabledTools: string[] = []): CloudMcpServer {
  return {
    id: server.id,
    name: server.id.charAt(0).toUpperCase() + server.id.slice(1),
    kind: "mcp",
    url: server.url,
    headers: {},
    omitMcpHeaders: false,
    disabledTools,
  };
}

function installFixtureFetch(servers: FixtureServer[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const server = servers.find((candidate) => url === candidate.url);
      if (!server) {
        return new Response("not found", { status: 404 });
      }
      if (server.reject) {
        return new Response("nope", { status: 401 });
      }
      if (server.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, server.delayMs));
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        id?: number;
        method?: string;
        params?: { name?: string; arguments?: unknown };
      };
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "initialize") {
        server.initializes += 1;
        return jsonResponse(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: server.id } },
          },
          { "Mcp-Session-Id": `session-${server.id}` },
        );
      }
      if (body.method === "tools/list") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: server.tools } });
      }
      if (body.method === "tools/call") {
        server.calls.push({ name: body.params?.name ?? "", arguments: body.params?.arguments });
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: `${body.params?.name} → ${JSON.stringify(body.params?.arguments ?? {})}` }],
          },
        });
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } });
    }),
  );
}

function mcpFunctionDefs(toolset: McpToolset): string[] {
  return toolset.toolDefs.map((def) => def.function.name).filter((name) => name.startsWith("mcp_"));
}

async function searchResult(toolset: McpToolset, args: Record<string, unknown>) {
  const outcome = await toolset.execute(MCP_SEARCH_TOOL_NAME, args);
  expect(outcome.isError).toBeUndefined();
  return JSON.parse(outcome.text) as {
    servers: Array<{ serverId: string; name: string; toolCount: number; unavailable?: string }>;
    matches: Array<{ serverId: string; toolName: string; description: string; inputSchema: Record<string, unknown> }>;
    note: string;
  };
}

describe("resolveMcpToolset · deferred loading", () => {
  it("(a) three servers × 40 tools whose schemas outgrow a small context window expose exactly two MCP functions", async () => {
    const servers = [fixture("alpha", 40), fixture("beta", 40), fixture("gamma", 40)];
    installFixtureFetch(servers);

    // 120 tiny schemas (~7k chars ≈ 1.7k tokens) are more than 15% of an 8k window.
    const toolset = await resolveMcpToolset({
      servers: servers.map((server) => cloudServer(server)),
      mode: "auto",
      contextWindowTokens: 8_000,
    });

    expect(toolset.mode).toBe("deferred");
    expect(mcpFunctionDefs(toolset)).toEqual([MCP_SEARCH_TOOL_NAME, MCP_CALL_TOOL_NAME]);
    expect(toolset.routes.size).toBe(0);
    expect(toolset.failures).toEqual([]);
    expect(toolset.summary).toEqual(["Alpha (40 tools · deferred)", "Beta (40 tools · deferred)", "Gamma (40 tools · deferred)"]);
    // One line per server, no schemas in the prompt.
    expect(toolset.promptNote).toContain('alpha "Alpha" · 40 tools');
    expect(toolset.promptNote).toContain('gamma "Gamma" · 40 tools');
    expect(toolset.promptNote).not.toContain("inputSchema");
    expect(toolset.promptNote.length).toBeLessThan(1_200);
    // A cold cache needed one handshake per server to learn the tables — no tool ran.
    expect(servers.map((server) => server.initializes)).toEqual([1, 1, 1]);
    expect(servers.flatMap((server) => server.calls)).toEqual([]);
  });

  it("(b) search ranks a description word and a schema field name to the right tool", async () => {
    const servers = [fixture("alpha", 40), fixture("beta", 12)];
    installFixtureFetch(servers);
    const toolset = await resolveMcpToolset({ servers: servers.map((server) => cloudServer(server)), mode: "deferred" });

    const byDescription = await searchResult(toolset, { query: "calendar invite" });
    expect(byDescription.matches[0]).toMatchObject({ serverId: "alpha", toolName: "alpha_schedule_meeting" });
    expect(byDescription.matches[0].inputSchema).toMatchObject({ required: ["attendees", "startsAt"] });
    expect(byDescription.servers).toEqual([
      { serverId: "alpha", name: "Alpha", toolCount: 40 },
      { serverId: "beta", name: "Beta", toolCount: 12 },
    ]);

    const byField = await searchResult(toolset, { query: "attendees", serverId: "beta" });
    expect(byField.matches[0]).toMatchObject({ serverId: "beta", toolName: "beta_schedule_meeting" });
    expect(byField.matches.every((match) => match.serverId === "beta")).toBe(true);

    const byExactName = searchMcpTools(
      [{ serverId: "alpha", serverName: "Alpha", tools: servers[0].tools }],
      "alpha_tool_03",
    );
    expect(byExactName[0]?.tool.name).toBe("alpha_tool_03");
    expect(byExactName[0]?.score).toBeGreaterThan(byExactName[1]?.score ?? 0);

    const limited = await searchResult(toolset, { query: "fixture operation", limit: 3 });
    expect(limited.matches).toHaveLength(3);
    expect(limited.note).toContain("3 tools shown");
  });

  it("(c) a call is refused until a search returned the tool, then connects lazily and runs it", async () => {
    const servers = [fixture("alpha", 30), fixture("beta", 30)];
    installFixtureFetch(servers);
    const catalog = createMemoryMcpCatalogStore();
    const now = 1_800_000_000_000;
    for (const server of servers) {
      catalog.write({ serverId: server.id, serverName: server.id, tools: server.tools, fetchedAt: now - 60_000 });
    }
    const toolset = await resolveMcpToolset({
      servers: servers.map((server) => cloudServer(server)),
      mode: "deferred",
      catalog,
      now: () => now,
    });
    // Fresh catalog: nothing connected at start.
    expect(servers.map((server) => server.initializes)).toEqual([0, 0]);

    const refused = await toolset.execute(MCP_CALL_TOOL_NAME, {
      serverId: "alpha",
      toolName: "alpha_tool_05",
      arguments: { input: "x" },
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(MCP_SEARCH_TOOL_NAME);
    expect(servers[0].calls).toEqual([]);
    expect(servers[0].initializes).toBe(0);

    const found = await searchResult(toolset, { query: "alpha_tool_05" });
    expect(found.matches[0]?.toolName).toBe("alpha_tool_05");

    const ran = await toolset.execute(MCP_CALL_TOOL_NAME, {
      serverId: "alpha",
      toolName: "alpha_tool_05",
      arguments: { input: "x" },
    });
    expect(ran.isError).toBeUndefined();
    expect(ran.text).toBe('alpha_tool_05 → {"input":"x"}');
    // Only the called server connected; the other one is still asleep.
    expect(servers.map((server) => server.initializes)).toEqual([1, 0]);
    expect(servers[0].calls).toEqual([{ name: "alpha_tool_05", arguments: { input: "x" } }]);

    // Stringified arguments (a common model habit) are accepted too.
    const again = await toolset.execute(MCP_CALL_TOOL_NAME, {
      serverId: "Alpha",
      toolName: "alpha_tool_05",
      arguments: '{"input":"y"}',
    });
    expect(again.text).toBe('alpha_tool_05 → {"input":"y"}');
    expect(servers[0].initializes).toBe(1);

    const unknownServer = await toolset.execute(MCP_CALL_TOOL_NAME, { serverId: "zeta", toolName: "x" });
    expect(unknownServer.isError).toBe(true);
    expect(unknownServer.text).toContain("Known servers");
  });

  it("(d) disabled tools are neither searchable nor callable", async () => {
    const servers = [fixture("alpha", 40)];
    installFixtureFetch(servers);
    const toolset = await resolveMcpToolset({
      servers: [cloudServer(servers[0], ["alpha_schedule_meeting", "alpha_tool_01"])],
      mode: "deferred",
    });
    expect(toolset.summary).toEqual(["Alpha (38 tools · deferred)"]);

    const found = await searchResult(toolset, { query: "calendar attendees" });
    expect(found.matches.some((match) => match.toolName === "alpha_schedule_meeting")).toBe(false);
    expect(found.servers[0].toolCount).toBe(38);

    const all = await searchResult(toolset, { query: "", limit: 20 });
    expect(all.matches.map((match) => match.toolName)).not.toContain("alpha_tool_01");

    const call = await toolset.execute(MCP_CALL_TOOL_NAME, {
      serverId: "alpha",
      toolName: "alpha_schedule_meeting",
      arguments: { attendees: ["a@b.c"], startsAt: "2026-09-04T10:00:00Z" },
    });
    expect(call.isError).toBe(true);
    expect(call.text).toContain("disabled by the user");
    expect(servers[0].calls).toEqual([]);
  });

  it("(e) the account setting picks the mode; native has no per-run cap; auto stays native for small schemas", async () => {
    // Twelve servers × 30 tools: every one of the 360 functions reaches the prompt.
    const servers = Array.from({ length: 12 }, (_, index) => fixture(`srv${String(index).padStart(2, "0")}`, 30));
    installFixtureFetch(servers);
    const cloud = servers.map((server) => cloudServer(server));

    const native = await resolveMcpToolset({ servers: cloud, mode: "native" });
    expect(native.mode).toBe("native");
    const nativeNames = mcpFunctionDefs(native);
    expect(nativeNames).toHaveLength(360);
    expect(nativeNames).toContain("mcp_srv00_srv00_tool_01");
    expect(nativeNames).toContain("mcp_srv11_srv11_tool_30");
    expect(nativeNames).not.toContain(MCP_SEARCH_TOOL_NAME);
    expect(native.failures).toEqual([]);
    expect(native.servers.every((info) => info.toolCount === 30 && !info.unavailable)).toBe(true);
    expect(servers.every((server) => server.initializes === 1)).toBe(true);

    const deferred = await resolveMcpToolset({ servers: cloud, mode: "deferred" });
    expect(deferred.mode).toBe("deferred");
    expect(mcpFunctionDefs(deferred)).toEqual([MCP_SEARCH_TOOL_NAME, MCP_CALL_TOOL_NAME]);

    // Forty tools with small schemas stay native under the default 128k window.
    const forty = [fixture("delta", 40)];
    installFixtureFetch(forty);
    const auto = await resolveMcpToolset({ servers: [cloudServer(forty[0])], mode: "auto" });
    expect(auto.mode).toBe("native");
    expect(mcpFunctionDefs(auto)).toHaveLength(40);
    expect(auto.promptNote).toBe("");

    expect(normalizeMcpToolLoading("deferred")).toBe("deferred");
    expect(normalizeMcpToolLoading("native")).toBe("native");
    expect(normalizeMcpToolLoading("whatever")).toBe("auto");
    expect(normalizeMcpToolLoading(undefined)).toBe("auto");
  });

  it("auto weighs only the schema share of the context window — never the tool count", () => {
    expect(DEFERRED_AUTO_CONTEXT_SHARE).toBe(0.15);
    // Many tiny tools stay native: the count alone means nothing.
    expect(decideMcpToolLoading("auto", { toolCount: 40, schemaChars: 2_400 })).toBe("native");
    expect(decideMcpToolLoading("auto", { toolCount: 400, schemaChars: 24_000 })).toBe("native");
    // 12 tools whose schemas take ~20k tokens: over 15% of an assumed 128k window …
    expect(decideMcpToolLoading("auto", { toolCount: 12, schemaChars: 80_000 })).toBe("deferred");
    // … but fine inside a 1M window.
    expect(decideMcpToolLoading("auto", { toolCount: 12, schemaChars: 80_000 }, 1_000_000)).toBe("native");
    // Exactly at the threshold stays native; the first character over flips.
    const thresholdChars = DEFAULT_CONTEXT_WINDOW_TOKENS * DEFERRED_AUTO_CONTEXT_SHARE * 4;
    expect(decideMcpToolLoading("auto", { toolCount: 5, schemaChars: thresholdChars })).toBe("native");
    expect(decideMcpToolLoading("auto", { toolCount: 5, schemaChars: thresholdChars + 4 })).toBe("deferred");
    expect(decideMcpToolLoading("native", { toolCount: 500, schemaChars: 900_000 })).toBe("native");
    expect(decideMcpToolLoading("deferred", { toolCount: 1, schemaChars: 10 })).toBe("deferred");
    expect(decideMcpToolLoading("auto", { toolCount: 0, schemaChars: 0 })).toBe("native");
  });

  it("native keeps only the per-server fuse and names the server it trimmed", async () => {
    const servers = [fixture("huge", NATIVE_TOOLS_PER_SERVER + 20), fixture("tiny", 3)];
    installFixtureFetch(servers);
    const toolset = await resolveMcpToolset({ servers: servers.map((server) => cloudServer(server)), mode: "native" });
    expect(toolset.routes.size).toBe(NATIVE_TOOLS_PER_SERVER + 3);
    const limit = toolset.failures.find((failure) => failure.name === "mcp_limit");
    expect(limit?.arguments).toBe("Huge");
    expect(limit?.result).toContain(`20 of ${NATIVE_TOOLS_PER_SERVER + 20} tools`);
    expect(limit?.result).toContain(`${NATIVE_TOOLS_PER_SERVER} inline functions per server`);
    expect(limit?.result).not.toMatch(/\b90\b/);
    expect(limit?.result).toContain("Deferred");
  });

  it("twenty connected servers all reach the resolver — no per-run server count", () => {
    const raw = Array.from({ length: 20 }, (_, index) => ({
      id: `server-${index}`,
      name: `Server ${index}`,
      url: `https://server-${index}.example.com/mcp`,
      enabled: true,
      status: "connected",
      disabledTools: [],
    }));
    const servers = cloudMcpServersForAutomation(raw, null);
    expect(servers).toHaveLength(20);
    expect(servers.map((server) => server.id)).toEqual(raw.map((server) => server.id));
  });

  it("a slow server does not hold the run past the connect budget, and a later call picks it up", async () => {
    const servers = [fixture("alpha", 10), { ...fixture("slow", 10), delayMs: 400 }];
    installFixtureFetch(servers);

    const startedAt = Date.now();
    const native = await resolveMcpToolset({
      servers: servers.map((server) => cloudServer(server)),
      mode: "native",
      connectBudgetMs: 150,
    });
    expect(Date.now() - startedAt).toBeLessThan(350);
    expect(mcpFunctionDefs(native)).toHaveLength(10);
    expect(mcpFunctionDefs(native).every((name) => name.startsWith("mcp_alpha_"))).toBe(true);
    const late = native.failures.find((failure) => failure.name === "mcp_connect");
    expect(late?.arguments).toBe("Slow");
    expect(late?.result).toContain("connection budget");
    expect(native.servers.find((info) => info.id === "slow")?.unavailable).toContain("connection budget");
    expect(native.servers.find((info) => info.id === "alpha")?.toolCount).toBe(10);

    // Deferred: the budget lapses the same way, but the first search waits for
    // the handshake that kept going in the background and lists the table.
    const again = [fixture("alpha", 10), { ...fixture("slow", 10), delayMs: 400 }];
    installFixtureFetch(again);
    const deferred = await resolveMcpToolset({
      servers: again.map((server) => cloudServer(server)),
      mode: "deferred",
      connectBudgetMs: 150,
    });
    expect(deferred.servers.find((info) => info.id === "slow")?.unavailable).toContain("connection budget");
    const found = await searchResult(deferred, { query: "slow_tool_02" });
    const slow = found.servers.find((server) => server.serverId === "slow");
    expect(slow?.unavailable).toBeUndefined();
    expect(slow?.toolCount).toBe(10);
    expect(found.matches[0]?.toolName).toBe("slow_tool_02");
    const ran = await deferred.execute(MCP_CALL_TOOL_NAME, { serverId: "slow", toolName: "slow_tool_02", arguments: { input: "z" } });
    expect(ran.isError).toBeUndefined();
    expect(again[1].calls).toEqual([{ name: "slow_tool_02", arguments: { input: "z" } }]);
  });

  it("the combined catalog budget leaves later servers out with an honest record that names them", async () => {
    const servers = [fixture("alpha", 40), fixture("beta", 40), fixture("gamma", 40)];
    installFixtureFetch(servers);
    const perServer = JSON.stringify(servers[0].tools).length;
    const toolset = await resolveMcpToolset({
      servers: servers.map((server) => cloudServer(server)),
      mode: "deferred",
      // Room for two tables, not three.
      catalogBudgetChars: perServer * 2 + 100,
    });
    expect(toolset.servers.map((info) => [info.id, info.unavailable === undefined])).toEqual([
      ["alpha", true],
      ["beta", true],
      ["gamma", false],
    ]);
    const limit = toolset.failures.find((failure) => failure.name === "mcp_limit");
    expect(limit?.arguments).toBe("Gamma");
    expect(limit?.result).toContain("left out of this run");
    expect(limit?.result).toContain("combined tool catalogs");
    expect(toolset.failures.some((failure) => failure.name === "mcp_connect")).toBe(false);
    const found = await searchResult(toolset, { query: "gamma_tool_01" });
    expect(found.servers.find((server) => server.serverId === "gamma")?.unavailable).toContain("left out");
    expect(found.matches.every((match) => match.serverId !== "gamma")).toBe(true);
  });

  it("uncapped native mode (health checks) registers every tool and refreshes the catalog cache", async () => {
    const servers = [fixture("alpha", 120)];
    installFixtureFetch(servers);
    const catalog = createMemoryMcpCatalogStore();
    const toolset = await resolveMcpToolset({ servers: [cloudServer(servers[0])], mode: "native", uncapped: true, catalog });
    expect(toolset.routes.size).toBe(120);
    expect(toolset.failures).toEqual([]);
    expect(catalog.read("alpha")?.tools).toHaveLength(120);

    // A run right after the check searches the cache without a handshake.
    const deferred = await resolveMcpToolset({ servers: [cloudServer(servers[0])], mode: "deferred", catalog });
    expect(servers[0].initializes).toBe(1);
    const found = await searchResult(deferred, { query: "calendar" });
    expect(found.matches[0]?.toolName).toBe("alpha_schedule_meeting");
  });

  it("keeps native connectors inline while generic servers defer, and reports a rejected server honestly", async () => {
    const servers = [fixture("alpha", 40), { ...fixture("broken", 3), reject: true }];
    installFixtureFetch(servers);
    const github: CloudMcpServer = {
      id: "github",
      name: "GitHub",
      kind: "github",
      url: "",
      headers: {},
      omitMcpHeaders: false,
      disabledTools: [],
      token: "ghp_fixture",
    };
    const toolset = await resolveMcpToolset({
      servers: [github, cloudServer(servers[0]), cloudServer(servers[1])],
      mode: "deferred",
    });
    const names = toolset.toolDefs.map((def) => def.function.name);
    expect(names).toContain("mcp_github_get_repo");
    expect(names.filter((name) => name.startsWith("mcp_alpha_"))).toEqual([]);
    expect(names).toContain(MCP_SEARCH_TOOL_NAME);
    expect(toolset.owns("mcp_github_get_repo")).toBe(true);
    expect(toolset.owns(MCP_CALL_TOOL_NAME)).toBe(true);
    expect(toolset.owns("web_search")).toBe(false);

    const failure = toolset.failures.find((record) => record.name === "mcp_connect");
    expect(failure?.arguments).toBe("Broken");
    expect(failure?.result).toContain("auth rejected");
    expect(failure?.result).not.toContain("ghp_fixture");
    const broken = toolset.servers.find((server) => server.id === "broken");
    expect(broken?.unavailable).toContain("auth rejected");
    expect(toolset.promptNote).not.toContain("broken");

    const search = await searchResult(toolset, { query: "fixture" });
    expect(search.servers.find((server) => server.serverId === "broken")?.unavailable).toContain("auth rejected");
    const call = await toolset.execute(MCP_CALL_TOOL_NAME, { serverId: "broken", toolName: "broken_tool_01" });
    expect(call.isError).toBe(true);
    expect(call.text).toContain("unavailable this run");
  });
});

describe("MCP meta-call labels and research sources", () => {
  it("names the server and tool for chat rows", () => {
    expect(describeMcpMetaCall(MCP_CALL_TOOL_NAME, '{"serverId":"linear","toolName":"create_issue"}')).toEqual({
      server: "linear",
      detail: "create_issue",
    });
    expect(describeMcpMetaCall(MCP_SEARCH_TOOL_NAME, '{"query":"open issues"}')).toEqual({
      server: "all servers",
      detail: "search “open issues”",
    });
    expect(describeMcpMetaCall("web_search", "{}")).toBeNull();
  });

  it("mints one dossier URL per MCP read, unique across repeats", () => {
    expect(mcpSourceUrl("linear", "list issues", 1)).toBe("mcp://linear/list%20issues");
    expect(mcpSourceUrl("linear", "list issues", 2)).toBe("mcp://linear/list%20issues#2");
  });
});
