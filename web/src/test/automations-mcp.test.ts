import { describe, expect, it } from "vitest";

import { cloudMcpReadiness, filterMcpServersByIds, normalizeAutomation } from "@/lib/automations";
import type { McpServerConfig } from "@/lib/types";

function server(partial: Partial<McpServerConfig>): McpServerConfig {
  return {
    id: "srv-1",
    name: "Server",
    url: "https://example.com/mcp",
    headersJson: "",
    enabled: true,
    status: "connected",
    tools: [],
    disabledTools: [],
    ...partial,
  };
}

describe("normalizeAutomation · mcpServerIds", () => {
  it("defaults legacy automations to all servers (null)", () => {
    expect(normalizeAutomation({ id: "a1" }).mcpServerIds).toBeNull();
  });

  it("keeps explicit allow-lists and drops junk entries", () => {
    const parsed = normalizeAutomation({
      id: "a1",
      mcpServerIds: ["github", 7, "notion"] as unknown as string[],
    });
    expect(parsed.mcpServerIds).toEqual(["github", "notion"]);
  });

  it("keeps an empty allow-list (automation runs with zero MCP tools)", () => {
    expect(normalizeAutomation({ id: "a1", mcpServerIds: [] }).mcpServerIds).toEqual([]);
  });
});

describe("normalizeAutomation · skillIds", () => {
  it("defaults legacy automations to all skills (null)", () => {
    expect(normalizeAutomation({ id: "a1" }).skillIds).toBeNull();
  });

  it("keeps explicit allow-lists and drops junk entries", () => {
    const parsed = normalizeAutomation({
      id: "a1",
      skillIds: ["s1", 7, "s2"] as unknown as string[],
    });
    expect(parsed.skillIds).toEqual(["s1", "s2"]);
  });

  it("keeps an empty allow-list (automation runs with zero skills)", () => {
    expect(normalizeAutomation({ id: "a1", skillIds: [] }).skillIds).toEqual([]);
  });
});

describe("filterMcpServersByIds", () => {
  const servers = [
    server({ id: "custom-1", name: "Custom" }),
    server({ id: "row-2", catalogId: "notion", name: "Notion" }),
  ];

  it("null allow-list keeps every server", () => {
    expect(filterMcpServersByIds(servers, null)).toHaveLength(2);
  });

  it("matches by row id and by catalog id", () => {
    expect(filterMcpServersByIds(servers, ["custom-1"]).map((item) => item.id)).toEqual(["custom-1"]);
    expect(filterMcpServersByIds(servers, ["notion"]).map((item) => item.id)).toEqual(["row-2"]);
  });

  it("empty allow-list removes every server", () => {
    expect(filterMcpServersByIds(servers, [])).toHaveLength(0);
  });
});

describe("cloudMcpReadiness", () => {
  it("native connectors with a pasted token are cloud-ready", () => {
    expect(cloudMcpReadiness(server({ id: "github", catalogId: "github", token: "ghp_x" }))).toBe("ready");
    expect(cloudMcpReadiness(server({ id: "slack", catalogId: "slack", token: "xoxb-1" }))).toBe("ready");
    expect(cloudMcpReadiness(server({ id: "intercom", catalogId: "intercom", token: "ic_x" }))).toBe("ready");
  });

  it("native connectors without any credential need auth first", () => {
    expect(cloudMcpReadiness(server({ id: "github", catalogId: "github" }))).toBe("needs-auth");
    expect(cloudMcpReadiness(server({ id: "slack", catalogId: "slack" }))).toBe("needs-auth");
  });

  it("OAuth catalog servers without a sign-in or key need auth", () => {
    expect(cloudMcpReadiness(server({ id: "notion", catalogId: "notion" }))).toBe("needs-auth");
  });

  it("a pasted key makes a key-required catalog server cloud-ready", () => {
    expect(cloudMcpReadiness(server({ id: "datadog", catalogId: "datadog", token: "dd-key" }))).toBe("ready");
  });

  it("key-required catalog servers without credentials stay needs-auth", () => {
    expect(cloudMcpReadiness(server({ id: "datadog", catalogId: "datadog" }))).toBe("needs-auth");
  });

  it("open catalog servers are cloud-ready without keys", () => {
    expect(cloudMcpReadiness(server({ id: "deepwiki", catalogId: "deepwiki" }))).toBe("ready");
    expect(cloudMcpReadiness(server({ id: "context7", catalogId: "context7" }))).toBe("ready");
  });

  it("explicit sign-in mode needs a stored sign-in (none in tests)", () => {
    expect(cloudMcpReadiness(server({ id: "c1", authMode: "oauth", token: "tok" }))).toBe("needs-auth");
  });

  it("custom servers attempt openly unless locked to bearer auth", () => {
    expect(cloudMcpReadiness(server({ id: "c1" }))).toBe("ready");
    expect(cloudMcpReadiness(server({ id: "c1", authMode: "bearer" }))).toBe("needs-auth");
    expect(cloudMcpReadiness(server({ id: "c1", headersJson: '{"X-Key":"v"}' }))).toBe("ready");
  });
});
