// Projects contracts: handles, @mentions, and — the core promise — that an
// agent's access level maps to exactly the right tool surface (read-only
// GitHub literally has no write tools).
import { describe, expect, it, vi } from "vitest";
import { buildAgentToolset } from "../../../functions/agent-toolset";
import { handleMcpResolve, handleMcpCatalogWrite } from "../../../functions/mcp-routes";
import { createSqlMcpCatalogStore } from "../../../functions/mcp-catalog";
import { mcpAccountFixture } from "./fixtures/mcp-account";

import { normalizeCloudMcpServer } from "../../../functions/mcp-cloud";
import {
  accessForAgentSurface,
  describeAgentAccess,
  ensureUniqueHandle,
  githubToolAllowed,
  normalizeHandle,
  normalizeStoredMcpSelection,
  parseMcpSelectionPatch,
  parseMentions,
  planAgentTools,
  validateScreenWidgets,
  type AgentAccess,
} from "../../../functions/project-shared";

const flags = (github = false, intercom = false, slack = false) => ({
  github,
  intercom,
  slack,
  slackSigning: false,
});

const access = (over: Partial<AgentAccess>): AgentAccess => ({
  web: false,
  github: "off",
  intercom: false,
  slack: false,
  mcp: false,
  ...over,
});

describe("normalizeHandle", () => {
  it("slugs latin names", () => {
    expect(normalizeHandle("Repo Guide")).toBe("repo-guide");
    expect(normalizeHandle("  Support!! Desk ")).toBe("support-desk");
  });

  it("transliterates cyrillic", () => {
    expect(normalizeHandle("Саппорт")).toBe("sapport");
    expect(normalizeHandle("Живой Гид")).toBe("zhivoy-gid");
  });

  it("falls back to 'agent' when nothing survives", () => {
    expect(normalizeHandle("!!! ???")).toBe("agent");
    expect(normalizeHandle("")).toBe("agent");
  });

  it("stays within the handle cap without a trailing dash", () => {
    const handle = normalizeHandle("A very long agent name that keeps going and going");
    expect(handle.length).toBeLessThanOrEqual(24);
    expect(handle.endsWith("-")).toBe(false);
  });
});

describe("ensureUniqueHandle", () => {
  it("keeps a free handle", () => {
    expect(ensureUniqueHandle("guide", new Set(["other"]))).toBe("guide");
  });

  it("appends -2, -3 on collisions", () => {
    expect(ensureUniqueHandle("guide", new Set(["guide"]))).toBe("guide-2");
    expect(ensureUniqueHandle("guide", new Set(["guide", "guide-2"]))).toBe("guide-3");
  });
});

describe("parseMentions", () => {
  it("finds a mention with punctuation after it", () => {
    expect(parseMentions("hey @repo-guide, what is the auth flow?", ["repo-guide"])).toEqual([
      "repo-guide",
    ]);
  });

  it("is case-insensitive and returns lowercase handles", () => {
    expect(parseMentions("Спроси у @Repo-Guide про релиз", ["repo-guide"])).toEqual(["repo-guide"]);
  });

  it("ignores email addresses — @ inside a word is not a mention", () => {
    expect(parseMentions("write to help@support.com please", ["support"])).toEqual([]);
  });

  it("does not match a longer word by a shorter handle", () => {
    expect(parseMentions("ping @support", ["sup"])).toEqual([]);
  });

  it("prefers the longest handle at the same spot", () => {
    expect(parseMentions("ping @support now", ["sup", "support"])).toEqual(["support"]);
  });

  it("dedupes and keeps first-appearance order", () => {
    expect(parseMentions("@b then @a then @b again", ["a", "b"])).toEqual(["b", "a"]);
  });

  it("returns nothing without handles or @", () => {
    expect(parseMentions("no mentions here", ["a"])).toEqual([]);
    expect(parseMentions("@a", [])).toEqual([]);
  });
});

describe("githubToolAllowed", () => {
  it("read level allows inspection tools only", () => {
    expect(githubToolAllowed("read", "get_repo")).toBe(true);
    expect(githubToolAllowed("read", "search_code")).toBe(true);
    expect(githubToolAllowed("read", "get_job_logs")).toBe(true);
    expect(githubToolAllowed("read", "put_file")).toBe(false);
    expect(githubToolAllowed("read", "create_pull")).toBe(false);
    expect(githubToolAllowed("read", "create_branch")).toBe(false);
    expect(githubToolAllowed("read", "delete_file")).toBe(false);
    expect(githubToolAllowed("read", "create_issue")).toBe(false);
  });

  it("write level allows everything, off allows nothing", () => {
    expect(githubToolAllowed("write", "put_file")).toBe(true);
    expect(githubToolAllowed("write", "get_repo")).toBe(true);
    expect(githubToolAllowed("off", "get_repo")).toBe(false);
  });
});

describe("accessForAgentSurface", () => {
  it("keeps authenticated project runs intact but downgrades inbound Slack GitHub writes", () => {
    const full = access({ github: "write", slack: true, mcp: true });
    expect(accessForAgentSurface(full, "project")).toBe(full);
    const slack = accessForAgentSurface(full, "slack");
    expect(slack.github).toBe("read");
    expect(slack.intercom).toBe(false);
    expect(slack.slack).toBe(false);
    expect(slack.mcp).toBe(false);
    const names = planAgentTools(slack, flags(true, true, true)).native.map((tool) => tool.fnName);
    expect(names).not.toContain("github_put_file");
    expect(names.some((name) => name.startsWith("intercom_"))).toBe(false);
    expect(names.some((name) => name.startsWith("slack_"))).toBe(false);
  });
});

describe("planAgentTools", () => {
  it("read-only GitHub exposes inspection tools and zero write tools", () => {
    const plan = planAgentTools(access({ github: "read" }), flags(true));
    const names = plan.native.map((tool) => tool.fnName);
    expect(names).toContain("github_get_repo");
    expect(names).toContain("github_search_code");
    expect(names).toContain("github_list_pulls");
    expect(names).not.toContain("github_put_file");
    expect(names).not.toContain("github_create_pull");
    expect(names).not.toContain("github_create_branch");
    expect(names).not.toContain("github_delete_file");
    expect(plan.missingSecrets).toEqual([]);
  });

  it("write GitHub adds the mutating tools", () => {
    const names = planAgentTools(access({ github: "write" }), flags(true)).native.map(
      (tool) => tool.fnName,
    );
    expect(names).toContain("github_put_file");
    expect(names).toContain("github_create_pull");
  });

  it("enabled access without a stored token arms nothing and reports it", () => {
    const plan = planAgentTools(access({ github: "read", intercom: true }), flags(false, false));
    expect(plan.native).toEqual([]);
    expect(plan.missingSecrets).toEqual(["github", "intercom"]);
  });

  it("intercom and slack arm their full native tables", () => {
    const plan = planAgentTools(access({ intercom: true, slack: true }), flags(false, true, true));
    const names = plan.native.map((tool) => tool.fnName);
    expect(names).toContain("intercom_list_conversations");
    expect(names).toContain("intercom_reply_to_conversation");
    expect(names).toContain("slack_read_messages");
    expect(plan.missingSecrets).toEqual([]);
  });

  it("passes the web flag through", () => {
    expect(planAgentTools(access({ web: true }), flags()).webEnabled).toBe(true);
    expect(planAgentTools(access({}), flags()).webEnabled).toBe(false);
  });

  it("reports the MCP server count only while access is on", () => {
    expect(planAgentTools(access({ mcp: true }), flags(), 2).mcpServerCount).toBe(2);
    expect(planAgentTools(access({}), flags(), 2).mcpServerCount).toBe(0);
  });
});

describe("agent MCP link", () => {
  it("twelve saved links reach owner resolve and execute; warmup persists and revoked delegation blocks further leases", async () => {
    const owner = "admin@example.com";
    const refs = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, name: `S${i}` }));
    const patch = parseMcpSelectionPatch(refs);
    if (patch.action !== "set") throw new Error("expected valid selection");
    const saved = JSON.stringify({ owner, servers: patch.servers });
    let liveSelection = normalizeStoredMcpSelection(JSON.parse(saved));
    const remoteConfigs = refs.map((ref) => ({ ...ref, url: `https://${ref.id}.fixture.dev/mcp`, enabled: true, status: "connected", authMode: "none" }));
    const { ctx } = mcpAccountFixture(owner, remoteConfigs);
    const requests: string[][] = [];
    let isAdmin = true;
    const upstream = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const frame = JSON.parse(String(init?.body)) as { id: number; method: string };
      const result = frame.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} } }
        : frame.method === "tools/list" ? { tools: [{ name: "read", description: "read", inputSchema: { type: "object", properties: {} } }] }
        : frame.method === "tools/call" ? { content: [{ type: "text", text: "last server read" }] } : null;
      return frame.method === "notifications/initialized" ? new Response(null, { status: 202 }) : Response.json(result ? { jsonrpc: "2.0", id: frame.id, result } : { jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "unsupported" } });
    });
    vi.stubGlobal("fetch", upstream);
    const agent = { name: "Reader" };
    const context = {
      durable: { fetch: async (request: Request) => {
        expect(decodeURIComponent(request.headers.get("X-Gera-Email") ?? "")).toBe(owner);
        if (new URL(request.url).pathname === "/mcp/catalog-write") return handleMcpCatalogWrite(ctx, request, owner);
        requests.push((await request.clone().json() as { ids: string[] }).ids);
        return handleMcpResolve(ctx, request, owner);
      } },
      waitUntil: (_task: Promise<unknown>) => undefined,
      agentAccess: () => access({ mcp: true }), currentAgent: () => agent,
      revealAgentSecrets: async () => ({ mcpSelection: liveSelection }), secretFlags: () => flags(), canManage: () => isAdmin,
    };
    try {
      const first = await buildAgentToolset(context, agent);
      expect(requests[0]).toEqual(refs.map((ref) => ref.id));
      expect(first.toolset?.servers).toHaveLength(12);
      expect(upstream).not.toHaveBeenCalled();
      await first.toolset?.execute("mcp_search_tools", { serverId: "s11", query: "read" });
      expect(requests.slice(1).every((ids) => ids.length === 1 && ids[0] === "s11")).toBe(true);
      expect(createSqlMcpCatalogStore(ctx.sql, owner).read("s11")?.wire?.protocolVersion).toBe("2025-11-25");
      expect((await first.toolset?.execute("mcp_call_tool", { serverId: "s11", toolName: "read" }))?.text).toBe("last server read");
      first.toolset?.close();
      const warm = await buildAgentToolset(context, agent);
      expect(warm.toolset?.servers.find((server) => server.id === "s11")?.toolCount).toBe(1);
      await warm.toolset?.execute("mcp_search_tools", { serverId: "s11", query: "read" });
      isAdmin = false;
      expect((await warm.toolset?.execute("mcp_call_tool", { serverId: "s11", toolName: "read" }))?.isError).toBe(true);
      warm.toolset?.close();
      isAdmin = true;
      liveSelection = normalizeStoredMcpSelection({ owner, servers: refs.slice(0, 11) });
      const unlinked = await buildAgentToolset(context, agent);
      expect(unlinked.toolset?.servers).toHaveLength(11);
      unlinked.toolset?.close();
    } finally { vi.unstubAllGlobals(); }
  });
  it("keeps the stored link when the patch field is absent", () => {
    expect(parseMcpSelectionPatch(undefined)).toEqual({ action: "keep" });
  });

  it("null and [] unlink", () => {
    expect(parseMcpSelectionPatch(null)).toEqual({ action: "set", servers: [] });
    expect(parseMcpSelectionPatch([])).toEqual({ action: "set", servers: [] });
  });

  it("takes ids + names, dedupes, and falls back to the id as the name", () => {
    expect(
      parseMcpSelectionPatch([
        { id: "linear", name: "Linear" },
        { id: "linear", name: "dup" },
        { id: "notion", name: "   " },
      ]),
    ).toEqual({
      action: "set",
      servers: [
        { id: "linear", name: "Linear" },
        { id: "notion", name: "notion" },
      ],
    });
  });

  it("rejects junk rows and over-limit lists honestly", () => {
    expect(parseMcpSelectionPatch(["junk"])).toEqual({
      action: "error",
      error: "invalid_mcp_selection",
    });
    expect(parseMcpSelectionPatch([{ name: "no id" }])).toEqual({
      action: "error",
      error: "invalid_mcp_selection",
    });
    expect(parseMcpSelectionPatch("junk")).toEqual({
      action: "error",
      error: "invalid_mcp_selection",
    });
    // No per-agent server count: twelve linked servers save and load intact.
    const twelve = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, name: `S${i}` }));
    expect(parseMcpSelectionPatch(twelve)).toEqual({ action: "set", servers: twelve });
    expect(normalizeStoredMcpSelection({ owner: "a@b.c", servers: twelve })?.servers).toHaveLength(12);
  });

  it("normalizeStoredMcpSelection drops junk rows and requires an owner", () => {
    expect(
      normalizeStoredMcpSelection({
        owner: "Admin@Team.dev",
        servers: [{ id: "linear", name: "Linear" }, "junk", { name: "no-id" }],
      }),
    ).toEqual({ owner: "admin@team.dev", servers: [{ id: "linear", name: "Linear" }] });
    expect(normalizeStoredMcpSelection({ owner: "", servers: [{ id: "x" }] })).toBeUndefined();
    expect(normalizeStoredMcpSelection({ owner: "a@b.c", servers: [] })).toBeUndefined();
    expect(normalizeStoredMcpSelection("nope")).toBeUndefined();
  });

  it("describeAgentAccess states the MCP surface honestly", () => {
    const on = access({ mcp: true });
    expect(describeAgentAccess(planAgentTools(on, flags(), 2), on)).toContain("2 configured");
    expect(describeAgentAccess(planAgentTools(on, flags(), 0), on)).toContain("none are configured");
    expect(describeAgentAccess(planAgentTools(access({}), flags()), access({}))).not.toContain(
      "External MCP",
    );
  });
});

describe("normalizeCloudMcpServer", () => {
  it("revives a resolved server and keeps only string headers", () => {
    expect(
      normalizeCloudMcpServer({
        id: "linear",
        name: "Linear",
        kind: "mcp",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer x", bad: 5 },
        omitMcpHeaders: false,
        disabledTools: ["noisy", 7],
        oauth: { accessToken: "at", tokenEndpoint: "https://t", clientId: "c" },
      }),
    ).toEqual({
      id: "linear",
      name: "Linear",
      kind: "mcp",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer x" },
      omitMcpHeaders: false,
      disabledTools: ["noisy"],
      oauth: { accessToken: "at", tokenEndpoint: "https://t", clientId: "c" },
    });
  });

  it("rejects native kinds, http urls and junk", () => {
    expect(normalizeCloudMcpServer({ id: "gh", kind: "github", url: "https://x" })).toBeNull();
    expect(normalizeCloudMcpServer({ id: "a", kind: "mcp", url: "http://insecure" })).toBeNull();
    expect(normalizeCloudMcpServer({ kind: "mcp", url: "https://ok.dev" })).toBeNull();
    expect(normalizeCloudMcpServer("junk")).toBeNull();
  });
});

describe("validateScreenWidgets", () => {
  const agents = new Set(["a1", "a2"]);
  const channels = new Set(["c1"]);

  it("accepts the support-desk recipe and derives stable ids", () => {
    const result = validateScreenWidgets(
      [
        { kind: "intercom-inbox", agentId: "a1" },
        { kind: "agent-chat", agentId: "a2" },
        { kind: "channel-post", channelId: "c1" },
      ],
      agents,
      channels,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.widgets.map((widget) => widget.id)).toEqual([
        "intercom-inbox:a1",
        "agent-chat:a2",
        "channel-post:c1",
      ]);
      expect(result.widgets[0].channelId).toBeNull();
      expect(result.widgets[2].agentId).toBeNull();
    }
  });

  it("suffixes duplicate widget ids so each stays unique", () => {
    const result = validateScreenWidgets(
      [
        { kind: "agent-chat", agentId: "a1" },
        { kind: "agent-chat", agentId: "a1" },
      ],
      agents,
      channels,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.widgets.map((widget) => widget.id)).toEqual([
        "agent-chat:a1",
        "agent-chat:a1:2",
      ]);
    }
  });

  it("rejects empty lists, unknown kinds and dangling references", () => {
    expect(validateScreenWidgets([], agents, channels)).toEqual({
      ok: false,
      error: "screen_needs_widgets",
    });
    expect(
      validateScreenWidgets([{ kind: "weather", agentId: "a1" }], agents, channels),
    ).toEqual({ ok: false, error: "invalid_widget_kind" });
    expect(
      validateScreenWidgets([{ kind: "agent-chat", agentId: "ghost" }], agents, channels),
    ).toEqual({ ok: false, error: "widget_agent_missing" });
    expect(
      validateScreenWidgets([{ kind: "intercom-inbox" }], agents, channels),
    ).toEqual({ ok: false, error: "widget_agent_missing" });
    expect(
      validateScreenWidgets([{ kind: "channel-post", channelId: "ghost" }], agents, channels),
    ).toEqual({ ok: false, error: "widget_channel_missing" });
  });

  it("allows at most one Intercom inbox per screen", () => {
    const result = validateScreenWidgets(
      [
        { kind: "intercom-inbox", agentId: "a1" },
        { kind: "intercom-inbox", agentId: "a2" },
      ],
      agents,
      channels,
    );
    expect(result).toEqual({ ok: false, error: "one_inbox_per_screen" });
  });

  it("caps the widget count", () => {
    const many = Array.from({ length: 7 }, () => ({ kind: "agent-chat", agentId: "a1" }));
    expect(validateScreenWidgets(many, agents, channels)).toEqual({
      ok: false,
      error: "too_many_widgets",
    });
  });
});

describe("describeAgentAccess", () => {
  it("states read-only limits plainly", () => {
    const level = access({ github: "read", web: true });
    const text = describeAgentAccess(planAgentTools(level, flags(true)), level);
    expect(text).toContain("READ-ONLY");
    expect(text).toContain("CANNOT");
  });

  it("admits a missing credential instead of pretending", () => {
    const level = access({ intercom: true });
    const text = describeAgentAccess(planAgentTools(level, flags()), level);
    expect(text).toContain("NO credential");
  });
});
