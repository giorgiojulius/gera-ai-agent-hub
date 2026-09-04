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
import {
  createMemoryMcpCatalogStore,
  decideMcpToolLoading,
  DEFERRED_AUTO_TOOL_THRESHOLD,
  describeMcpMetaCall,
  MCP_CALL_TOOL_NAME,
  MCP_SEARCH_TOOL_NAME,
  NATIVE_TOOL_CAP,
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
  it("(a) three servers × 40 tools in auto mode expose exactly two MCP functions", async () => {
    const servers = [fixture("alpha", 40), fixture("beta", 40), fixture("gamma", 40)];
    installFixtureFetch(servers);

    const toolset = await resolveMcpToolset({ servers: servers.map((server) => cloudServer(server)), mode: "auto" });

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

  it("(e) the account setting picks the mode; auto stays native for a small table", async () => {
    const servers = [fixture("alpha", 40), fixture("beta", 40), fixture("gamma", 40)];
    installFixtureFetch(servers);
    const cloud = servers.map((server) => cloudServer(server));

    const native = await resolveMcpToolset({ servers: cloud, mode: "native" });
    expect(native.mode).toBe("native");
    const nativeNames = mcpFunctionDefs(native);
    expect(nativeNames).toHaveLength(NATIVE_TOOL_CAP);
    expect(nativeNames).toContain("mcp_alpha_alpha_tool_01");
    expect(nativeNames).not.toContain(MCP_SEARCH_TOOL_NAME);
    // The third server did not fit the soft cap — an honest record names it.
    const limit = native.failures.find((failure) => failure.name === "mcp_limit");
    expect(limit?.arguments).toBe("Gamma");
    expect(limit?.result).toContain("30 of 40 tools");
    expect(limit?.result).toContain("Deferred");

    const deferred = await resolveMcpToolset({ servers: cloud, mode: "deferred" });
    expect(deferred.mode).toBe("deferred");
    expect(mcpFunctionDefs(deferred)).toEqual([MCP_SEARCH_TOOL_NAME, MCP_CALL_TOOL_NAME]);

    const small = [fixture("delta", 5)];
    installFixtureFetch(small);
    const auto = await resolveMcpToolset({ servers: [cloudServer(small[0])], mode: "auto" });
    expect(auto.mode).toBe("native");
    expect(mcpFunctionDefs(auto)).toHaveLength(5);
    expect(auto.promptNote).toBe("");

    expect(normalizeMcpToolLoading("deferred")).toBe("deferred");
    expect(normalizeMcpToolLoading("native")).toBe("native");
    expect(normalizeMcpToolLoading("whatever")).toBe("auto");
    expect(normalizeMcpToolLoading(undefined)).toBe("auto");
  });

  it("auto weighs the tool count and the schema share of the context window", () => {
    expect(decideMcpToolLoading("auto", { toolCount: DEFERRED_AUTO_TOOL_THRESHOLD, schemaChars: 2_000 })).toBe("native");
    expect(decideMcpToolLoading("auto", { toolCount: DEFERRED_AUTO_TOOL_THRESHOLD + 1, schemaChars: 2_000 })).toBe("deferred");
    // 12 tools whose schemas take ~12.5k tokens: over 8% of an assumed 128k window …
    expect(decideMcpToolLoading("auto", { toolCount: 12, schemaChars: 50_000 })).toBe("deferred");
    // … but fine inside a 1M window.
    expect(decideMcpToolLoading("auto", { toolCount: 12, schemaChars: 50_000 }, 1_000_000)).toBe("native");
    expect(decideMcpToolLoading("native", { toolCount: 500, schemaChars: 900_000 })).toBe("native");
    expect(decideMcpToolLoading("deferred", { toolCount: 1, schemaChars: 10 })).toBe("deferred");
    expect(decideMcpToolLoading("auto", { toolCount: 0, schemaChars: 0 })).toBe("native");
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
