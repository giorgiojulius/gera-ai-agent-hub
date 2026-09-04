/**
 * Phase 4 — policies and confirmations. The allowlist decides what the model
 * sees (inline functions, search results, mcp_call_tool); write / destructive
 * tools pause interactive runs for a confirmation and are declined honestly
 * on background surfaces; read-only tools always run; "Always allow in this
 * chat" sticks for the rest of the run and rides in through the run config;
 * every decision is journaled without argument values.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CloudMcpServer } from "../../../functions/mcp-cloud";
import { mcpJournalRow } from "../../../functions/mcp-journal";
import {
  CONFIRMATION_TIMEOUT_MS,
  accountMcpPolicy,
  classifyMcpToolRisk,
  describeMcpWritePolicy,
  mcpPolicyVerdict,
  normalizeMcpApprovals,
  previewToolArguments,
} from "../../../functions/mcp-policy";
import type { McpFetch } from "../../../functions/mcp-protocol";
import {
  createMemoryMcpCatalogStore,
  MCP_CALL_TOOL_NAME,
  MCP_SEARCH_TOOL_NAME,
  resolveMcpToolset,
  type McpToolsetConfirmation,
} from "../../../functions/mcp-toolset";
import {
  agentMcpPolicy,
  normalizeStoredMcpSelection,
  parseMcpSelectionPatch,
  parseMcpWritesPatch,
} from "../../../functions/project-shared";
import { createRunPauseBoard } from "../../../functions/run-pause";

// ---------------------------------------------------------------------------
// Fixtures

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** A Streamable HTTP server with one read-only, one unannotated (write) and one destructive tool. */
function thingsServer(): { fetch: McpFetch; calls: () => string[]; methods: () => string[] } {
  const methods: string[] = [];
  const called: string[] = [];
  const fetch: McpFetch = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { id?: number; method: string; params?: { name?: string } };
    methods.push(body.method);
    const reply = (result: unknown): Response =>
      json({ jsonrpc: "2.0", id: body.id, result }, 200, { "Mcp-Session-Id": "sess-1" });
    switch (body.method) {
      case "initialize":
        return reply({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "things", version: "1" } });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        return reply({
          tools: [
            {
              name: "read_thing",
              description: "Reads a thing",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
            {
              name: "write_thing",
              description: "Writes a thing",
              inputSchema: { type: "object", properties: { title: { type: "string" }, apiToken: { type: "string" } } },
            },
            {
              name: "delete_thing",
              description: "Deletes a thing",
              inputSchema: { type: "object", properties: {} },
              annotations: { destructiveHint: true },
            },
          ],
        });
      case "tools/call":
        called.push(body.params?.name ?? "?");
        return reply({ content: [{ type: "text", text: `ok ${body.params?.name ?? "?"}` }] });
      default:
        return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no" } });
    }
  };
  return { fetch, calls: () => called, methods: () => methods };
}

function server(id = "things", name = "Things"): CloudMcpServer {
  return { id, name, kind: "mcp", url: `https://mcp.${id}.dev/mcp`, headers: {}, omitMcpHeaders: false, disabledTools: [] };
}

function githubServer(): CloudMcpServer {
  return { id: "github", name: "GitHub", kind: "github", url: "", headers: {}, omitMcpHeaders: false, disabledTools: [], token: "ghp_test_token" };
}

const READ = { name: "read_thing", annotations: { readOnlyHint: true } };
const WRITE = { name: "write_thing" };
const DESTROY = { name: "delete_thing", annotations: { destructiveHint: true } };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe("mcp-policy · risk and verdicts", () => {
  it("classifies by annotations; an unannotated tool counts as a write; native connectors use the static table", () => {
    expect(classifyMcpToolRisk(READ)).toBe("read");
    expect(classifyMcpToolRisk(WRITE)).toBe("write");
    expect(classifyMcpToolRisk(DESTROY)).toBe("destructive");
    expect(classifyMcpToolRisk({ name: "delete_file" }, "github")).toBe("destructive");
    expect(classifyMcpToolRisk({ name: "create_issue" }, "github")).toBe("write");
    expect(classifyMcpToolRisk({ name: "get_repo" }, "github")).toBe("read");
    expect(classifyMcpToolRisk({ name: "send_message" }, "slack")).toBe("write");
    expect(classifyMcpToolRisk({ name: "reply_to_conversation" }, "intercom")).toBe("write");
    expect(classifyMcpToolRisk({ name: "whoami" }, "intercom")).toBe("read");
  });

  it("verdicts: allowlist first, then auto-run, then risk, then prior approvals", () => {
    const none = new Set<string>();
    expect(mcpPolicyVerdict({ allow: { other: null }, writes: "auto" }, none, "things", READ)).toEqual({
      kind: "blocked",
      reason: "the server is not in this agent's allowlist",
    });
    expect(mcpPolicyVerdict({ allow: { things: ["read_thing"] }, writes: "auto" }, none, "things", WRITE)).toEqual({
      kind: "blocked",
      reason: "the tool is not in this agent's allowlist",
    });
    expect(mcpPolicyVerdict({ allow: { things: ["read_thing"] }, writes: "auto" }, none, "things", READ)).toEqual({ kind: "run" });
    expect(mcpPolicyVerdict({ allow: null, writes: "auto" }, none, "things", DESTROY)).toEqual({ kind: "run" });
    expect(mcpPolicyVerdict({ allow: null, writes: "ask" }, none, "things", READ)).toEqual({ kind: "run" });
    expect(mcpPolicyVerdict({ allow: null, writes: "ask" }, none, "things", WRITE)).toEqual({ kind: "confirm", risk: "write" });
    expect(mcpPolicyVerdict({ allow: null, writes: "ask" }, none, "things", DESTROY)).toEqual({ kind: "confirm", risk: "destructive" });
    expect(mcpPolicyVerdict({ allow: null, writes: "ask" }, new Set(["things\u0000write_thing"]), "things", WRITE)).toEqual({ kind: "run" });
  });

  it("argument previews mask secret-looking keys, run the caller's redaction, and cap honestly", () => {
    const preview = previewToolArguments(
      { title: "Release", apiToken: "sk-live-123", nested: { password: "hunter2", note: "keep" }, list: [{ cookie: "c=1" }] },
      (text) => text.replace("Release", "[redacted]"),
    );
    expect(preview).not.toContain("sk-live-123");
    expect(preview).not.toContain("hunter2");
    expect(preview).not.toContain("c=1");
    expect(preview).toContain("•••");
    expect(preview).toContain("keep");
    expect(preview).toContain("[redacted]");
    expect(previewToolArguments({})).toBe("{}");
    const long = previewToolArguments({ body: "x".repeat(5_000) });
    expect(long.length).toBeLessThan(2_200);
    expect(long).toMatch(/more characters not shown$/);
  });

  it("account policy: the toggle picks ask/auto and approvals are revived, bounded and deduplicated", () => {
    expect(accountMcpPolicy(undefined)).toEqual({ allow: null, writes: "auto" });
    expect(accountMcpPolicy(false, [{ serverId: "a", toolName: "b" }])).toEqual({
      allow: null,
      writes: "auto",
      approved: [{ serverId: "a", toolName: "b" }],
    });
    expect(accountMcpPolicy(true).writes).toBe("ask");
    expect(
      normalizeMcpApprovals([
        { serverId: " a ", toolName: "b" },
        { serverId: "a", toolName: "b" },
        { serverId: "", toolName: "b" },
        "junk",
        { serverId: "c", toolName: 3 },
      ]),
    ).toEqual([{ serverId: "a", toolName: "b" }]);
    expect(normalizeMcpApprovals("nope")).toEqual([]);
  });

  it("prompt wording exists only for the ask policy and differs between attended and unattended runs", () => {
    expect(describeMcpWritePolicy("auto", true)).toBe("");
    expect(describeMcpWritePolicy("ask", true)).toMatch(/pause the run for the user's confirmation/);
    expect(describeMcpWritePolicy("ask", false)).toMatch(/unattended run cannot ask/);
  });
});

// ---------------------------------------------------------------------------

describe("toolset · allowlist filters functions, search and calls", () => {
  it("native mode: only allowlisted tools become functions; a server outside the allowlist is never contacted", async () => {
    const remote = thingsServer();
    const toolset = await resolveMcpToolset({
      servers: [server(), server("other", "Other")],
      mode: "native",
      fetch: remote.fetch,
      notificationStreams: false,
      policy: { allow: { things: ["read_thing"] }, writes: "auto" },
    });
    expect(toolset.toolDefs.map((def) => def.function.name)).toEqual(["mcp_things_read_thing"]);
    expect(toolset.servers.map((info) => [info.id, info.toolCount])).toEqual([["things", 1]]);
    expect(remote.methods().filter((method) => method === "initialize")).toHaveLength(1);
    expect(toolset.owns("mcp_things_write_thing")).toBe(false);
    toolset.close();
  });

  it("deferred mode: search hides non-allowlisted tools and mcp_call_tool refuses them with a journal entry", async () => {
    const remote = thingsServer();
    const toolset = await resolveMcpToolset({
      servers: [server()],
      mode: "deferred",
      fetch: remote.fetch,
      catalog: createMemoryMcpCatalogStore(),
      notificationStreams: false,
      policy: { allow: { things: ["read_thing"] }, writes: "auto" },
    });
    const search = JSON.parse((await toolset.execute(MCP_SEARCH_TOOL_NAME, { query: "thing" })).text) as {
      matches: Array<{ toolName: string }>;
      servers: Array<{ toolCount: number }>;
    };
    expect(search.matches.map((match) => match.toolName)).toEqual(["read_thing"]);
    expect(search.servers[0].toolCount).toBe(1);
    const blocked = await toolset.execute(MCP_CALL_TOOL_NAME, { serverId: "things", toolName: "write_thing", arguments: {} });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/not allowed by this agent's MCP policy/);
    expect(remote.calls()).toEqual([]);
    expect(toolset.journal).toEqual([
      { kind: "policy_blocked", serverId: "things", serverName: "Things", toolName: "write_thing", detail: expect.stringMatching(/allowlist/) },
    ]);
    const allowed = await toolset.execute(MCP_CALL_TOOL_NAME, { serverId: "things", toolName: "read_thing", arguments: {} });
    expect(allowed).toEqual({ text: "ok read_thing" });
    toolset.close();
  });
});

// ---------------------------------------------------------------------------

describe("toolset · write policy on an unattended surface", () => {
  it("deferred: read-only tools run, write and destructive tools are declined without touching the server, and the prompt says so", async () => {
    const remote = thingsServer();
    const toolset = await resolveMcpToolset({
      servers: [server()],
      mode: "deferred",
      surface: "background",
      fetch: remote.fetch,
      catalog: createMemoryMcpCatalogStore(),
      notificationStreams: false,
      policy: { allow: null, writes: "ask" },
    });
    expect(toolset.promptNote).toMatch(/unattended run cannot ask/);
    await toolset.execute(MCP_SEARCH_TOOL_NAME, { query: "thing" });
    expect(await toolset.execute(MCP_CALL_TOOL_NAME, { serverId: "things", toolName: "read_thing", arguments: {} })).toEqual({ text: "ok read_thing" });
    const write = await toolset.execute(MCP_CALL_TOOL_NAME, {
      serverId: "things",
      toolName: "write_thing",
      arguments: { title: "Secret plan", apiToken: "sk-live-999" },
    });
    expect(write.isError).toBe(true);
    expect(write.text).toMatch(/write tool/);
    expect(write.text).toMatch(/unattended run cannot ask/);
    const destroy = await toolset.execute(MCP_CALL_TOOL_NAME, { serverId: "things", toolName: "delete_thing", arguments: {} });
    expect(destroy.isError).toBe(true);
    expect(destroy.text).toMatch(/destructive tool/);
    expect(remote.calls()).toEqual(["read_thing"]);
    expect(toolset.journal.map((entry) => [entry.kind, entry.toolName])).toEqual([
      ["confirmation_declined", "write_thing"],
      ["confirmation_declined", "delete_thing"],
    ]);
    // Journal entries never carry argument values.
    expect(JSON.stringify(toolset.journal)).not.toMatch(/Secret plan|sk-live-999/);
    toolset.close();
  });

  it("native (inline) mode and the first-party GitHub connector go through the same gate — no network for a declined write", async () => {
    const remote = thingsServer();
    const network = vi.fn(async () => {
      throw new Error("network must not be reached");
    });
    vi.stubGlobal("fetch", network);
    const toolset = await resolveMcpToolset({
      servers: [server(), githubServer()],
      mode: "native",
      surface: "background",
      fetch: remote.fetch,
      notificationStreams: false,
      policy: { allow: null, writes: "ask" },
    });
    const names = [...toolset.routes.keys()];
    expect(names).toContain("mcp_github_create_issue");
    expect(names).toContain("mcp_things_write_thing");
    const issue = await toolset.execute("mcp_github_create_issue", { owner: "acme", repo: "app", title: "Bug" });
    expect(issue.isError).toBe(true);
    expect(issue.text).toMatch(/requires the user's confirmation/);
    const deleted = await toolset.execute("mcp_github_delete_file", { owner: "acme", repo: "app", path: "a.txt" });
    expect(deleted.text).toMatch(/destructive tool/);
    const write = await toolset.execute("mcp_things_write_thing", { title: "x" });
    expect(write.isError).toBe(true);
    expect(await toolset.execute("mcp_things_read_thing", {})).toEqual({ text: "ok read_thing" });
    expect(remote.calls()).toEqual(["read_thing"]);
    expect(network).not.toHaveBeenCalled();
    expect(toolset.journal.map((entry) => `${entry.serverId}:${entry.toolName}:${entry.kind}`)).toEqual([
      "github:create_issue:confirmation_declined",
      "github:delete_file:confirmation_declined",
      "things:write_thing:confirmation_declined",
    ]);
    toolset.close();
  });
});

// ---------------------------------------------------------------------------

describe("toolset · interactive confirmations", () => {
  async function interactive(confirm: (request: McpToolsetConfirmation) => Promise<{ action: "accept" | "always" | "decline" | "cancel" }>, approved?: Array<{ serverId: string; toolName: string }>) {
    const remote = thingsServer();
    const toolset = await resolveMcpToolset({
      servers: [server()],
      mode: "native",
      surface: "interactive",
      fetch: remote.fetch,
      notificationStreams: false,
      policy: { allow: null, writes: "ask", ...(approved ? { approved } : {}) },
      confirm,
    });
    return { remote, toolset };
  }

  it("Run once: the card gets server, tool, risk and a masked preview; the tool runs and the decision is journaled", async () => {
    const seen: McpToolsetConfirmation[] = [];
    const { remote, toolset } = await interactive(async (request) => {
      seen.push(request);
      return { action: "accept" };
    });
    expect(toolset.promptNote).toMatch(/pause the run for the user's confirmation/);
    const result = await toolset.execute("mcp_things_write_thing", { title: "Release", apiToken: "sk-live-1" });
    expect(result).toEqual({ text: "ok write_thing" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ serverId: "things", serverName: "Things", toolName: "write_thing", risk: "write", description: "Writes a thing" });
    expect(seen[0].argumentsPreview).toContain("Release");
    expect(seen[0].argumentsPreview).not.toContain("sk-live-1");
    expect(remote.calls()).toEqual(["write_thing"]);
    expect(toolset.journal).toEqual([
      { kind: "confirmation_granted", serverId: "things", serverName: "Things", toolName: "write_thing", detail: expect.stringMatching(/confirmed/) },
    ]);
    // Read-only tools never ask.
    await toolset.execute("mcp_things_read_thing", {});
    expect(seen).toHaveLength(1);
    toolset.close();
  });

  it("Always allow: the second call of the same tool runs without a card; a different tool still asks", async () => {
    let asks = 0;
    const { remote, toolset } = await interactive(async () => {
      asks += 1;
      return { action: "always" };
    });
    await toolset.execute("mcp_things_write_thing", {});
    await toolset.execute("mcp_things_write_thing", {});
    expect(asks).toBe(1);
    await toolset.execute("mcp_things_delete_thing", {});
    expect(asks).toBe(2);
    expect(remote.calls()).toEqual(["write_thing", "write_thing", "delete_thing"]);
    expect(toolset.journal.map((entry) => entry.kind)).toEqual(["confirmation_always", "confirmation_always"]);
    toolset.close();
  });

  it("Decline: the call never reaches the server and the model is told not to retry", async () => {
    const { remote, toolset } = await interactive(async () => ({ action: "decline" }));
    const result = await toolset.execute("mcp_things_delete_thing", {});
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/declined running "delete_thing"/);
    expect(result.text).toMatch(/Do not retry/);
    expect(remote.calls()).toEqual([]);
    expect(toolset.journal.map((entry) => entry.kind)).toEqual(["confirmation_declined"]);
    toolset.close();
  });

  it("approvals carried in the run config skip the card from the first call", async () => {
    const confirm = vi.fn(async () => ({ action: "accept" as const }));
    const { remote, toolset } = await interactive(confirm, [{ serverId: "things", toolName: "write_thing" }]);
    expect(await toolset.execute("mcp_things_write_thing", {})).toEqual({ text: "ok write_thing" });
    expect(confirm).not.toHaveBeenCalled();
    expect(remote.calls()).toEqual(["write_thing"]);
    expect(toolset.journal).toEqual([]);
    toolset.close();
  });

  it("no decision within 10 minutes declines honestly", async () => {
    const { remote, toolset } = await interactive(() => new Promise(() => undefined));
    vi.useFakeTimers();
    const pending = toolset.execute("mcp_things_write_thing", {});
    await vi.advanceTimersByTimeAsync(CONFIRMATION_TIMEOUT_MS + 5);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/within 10 minutes/);
    expect(remote.calls()).toEqual([]);
    expect(toolset.journal.map((entry) => entry.kind)).toEqual(["confirmation_timeout"]);
    toolset.close();
  });
});

// ---------------------------------------------------------------------------

describe("run pause board · confirmation answers", () => {
  it("accepts always on confirmation cards and rejects it on elicitation forms", async () => {
    const board = createRunPauseBoard({ newId: () => "c1" });
    const waiting = board.request(
      { kind: "confirmation", serverId: "things", serverName: "Things", message: "Writes a thing", fields: [], confirm: { toolName: "write_thing", risk: "write", argumentsPreview: "{}" } },
      60_000,
    );
    expect(board.pending()[0]).toMatchObject({ id: "c1", kind: "confirmation", confirm: { toolName: "write_thing" } });
    expect(board.answer("c1", { action: "nonsense" })).toEqual({ ok: false, error: "invalid_action" });
    expect(board.answer("c1", { action: "always" })).toEqual({ ok: true });
    expect(await waiting).toEqual({ action: "always" });
    expect(board.pending()).toEqual([]);

    const form = createRunPauseBoard({ newId: () => "e1" });
    const open = form.request({ kind: "elicitation", serverId: "s", serverName: "S", message: "Region?", fields: [] }, 60_000);
    expect(form.answer("e1", { action: "always" })).toEqual({ ok: false, error: "invalid_action" });
    expect(form.answer("e1", { action: "decline" })).toEqual({ ok: true });
    expect(await open).toEqual({ action: "decline" });
  });
});

// ---------------------------------------------------------------------------

describe("project-shared · agent MCP policy", () => {
  it("selection refs carry tool allowlists; the write policy is stored only as ask", () => {
    const patch = parseMcpSelectionPatch([
      { id: "things", name: "Things", tools: [" read_thing ", "read_thing", "", 42, "write_thing"] },
      { id: "open", name: "Open" },
    ]);
    expect(patch).toEqual({
      action: "set",
      servers: [
        { id: "things", name: "Things", tools: ["read_thing", "write_thing"] },
        { id: "open", name: "Open" },
      ],
    });
    const stored = normalizeStoredMcpSelection({ owner: "Admin@Acme.io", servers: [{ id: "things", name: "Things", tools: ["read_thing"] }], writes: "ask" });
    expect(stored).toEqual({ owner: "admin@acme.io", servers: [{ id: "things", name: "Things", tools: ["read_thing"] }], writes: "ask" });
    expect(normalizeStoredMcpSelection({ owner: "a@b.c", servers: [{ id: "x" }], writes: "junk" })).toEqual({ owner: "a@b.c", servers: [{ id: "x", name: "x" }] });
    expect(parseMcpWritesPatch(undefined)).toEqual({ action: "keep" });
    expect(parseMcpWritesPatch("ask")).toEqual({ action: "set", writes: "ask" });
    expect(parseMcpWritesPatch("auto")).toEqual({ action: "set", writes: "auto" });
    expect(parseMcpWritesPatch("maybe")).toEqual({ action: "error", error: "invalid_mcp_writes" });
  });

  it("turns a selection into the run policy: every linked server, allowlisted tools or all, and the write policy", () => {
    expect(agentMcpPolicy(undefined)).toEqual({ allow: null, writes: "auto" });
    expect(
      agentMcpPolicy({ owner: "a@b.c", servers: [{ id: "things", name: "Things", tools: ["read_thing"] }, { id: "open", name: "Open" }], writes: "ask" }),
    ).toEqual({ allow: { things: ["read_thing"], open: null }, writes: "ask" });
    expect(agentMcpPolicy({ owner: "a@b.c", servers: [{ id: "open", name: "Open" }] })).toEqual({ allow: { open: null }, writes: "auto" });
  });
});

// ---------------------------------------------------------------------------

describe("mcp-journal · rows", () => {
  it("policy decisions become mcp-policy rows naming server, tool, decision and surface — never argument values", () => {
    const row = mcpJournalRow(
      { kind: "confirmation_declined", serverId: "things", serverName: "Things", toolName: "write_thing", detail: "The user declined this write call." },
      { surface: "chat", label: "Release planning" },
      1_000,
    );
    expect(row).toMatchObject({ at: 1_000, scope: "mcp-policy", message: "Declined: write_thing on Things" });
    expect(row?.id).toMatch(/^mcpj_/);
    expect(row?.detail).toContain("server: things");
    expect(row?.detail).toContain("tool: write_thing");
    expect(row?.detail).toContain("run: chat · Release planning");
    expect(mcpJournalRow({ kind: "catalog_refreshed", serverId: "s", serverName: "S", detail: "3 tools" }, { surface: "chat" })).toBeNull();
    expect(mcpJournalRow({ kind: "step_up_required", serverId: "s", serverName: "S", detail: "scope" }, { surface: "chat" })).toBeNull();
    const elicitation = mcpJournalRow(
      { kind: "elicitation_declined", serverId: "s", serverName: "DeployBot", detail: "Server asked for input; declined." },
      { surface: "automation", label: "Nightly" },
    );
    expect(elicitation).toMatchObject({ scope: "mcp", message: "Elicitation declined: DeployBot" });
  });
});
