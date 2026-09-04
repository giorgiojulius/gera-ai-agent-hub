/// <reference types="node" />
/**
 * MCP conformance — Gera's protocol core and cloud transport against a REAL
 * server: `@modelcontextprotocol/sdk` (Streamable HTTP, stateful sessions)
 * started in-process on 127.0.0.1 with a random port. No mocks: every frame
 * on the wire is produced by the reference implementation.
 *
 * Covered (plan Phase 2): initialize + version negotiation, the
 * MCP-Protocol-Version header on every request after initialize, Mcp-Session-Id
 * echo, tools/list pagination, prompts/list + get, resources/list + templates +
 * read, list_changed over the standalone GET stream → catalog invalidation,
 * elicitation round-trip (accept + decline) through the toolset's run pause
 * hook, isError, resource_link resolution, annotations + UI-only markers.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ElicitResultSchema,
  GetPromptRequestSchema,
  isInitializeRequest,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  callCloudMcpTool,
  connectCloudMcp,
  getCloudMcpPrompt,
  readCloudMcpResource,
  type CloudMcpServer,
} from "../../../functions/mcp-cloud";
import {
  MCP_LATEST_PROTOCOL_VERSION,
  type McpFetch,
} from "../../../functions/mcp-protocol";
import { handleMcpInventory, handleMcpPromptGet, handleMcpResourceRead, type McpRouteContext } from "../../../functions/mcp-routes";
import {
  createMemoryMcpCatalogStore,
  MCP_CALL_TOOL_NAME,
  MCP_SEARCH_TOOL_NAME,
  resolveMcpToolset,
  type McpToolsetElicitation,
} from "../../../functions/mcp-toolset";

type ToolRow = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

type RecordedRequest = { method: string; headers: Record<string, string>; body?: unknown };

type Harness = {
  url: string;
  requests: RecordedRequest[];
  /** Live SDK servers by session id (to push list_changed). */
  sessions: Map<string, Server>;
  /** Mutable tool table (pages of 2). */
  tools: ToolRow[];
  close(): Promise<void>;
};

const BASE_TOOLS: ToolRow[] = [
  {
    name: "echo",
    description: "Echo the text back",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "Text to echo" } }, required: ["text"] },
    annotations: { title: "Echo", readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "fail",
    description: "Always reports an error",
    inputSchema: { type: "object", properties: {} },
    annotations: { destructiveHint: true },
  },
  {
    name: "linked",
    description: "Returns a resource link to note 1",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ask",
    description: "Asks the user which region to deploy to via elicitation",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dashboard",
    description: "Renders an interactive dashboard (MCP App)",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { resourceUri: "ui://dashboard/main" } },
  },
];

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function buildServer(harness: Pick<Harness, "tools">): Server {
  const server = new Server(
    { name: "Gera conformance", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true }, prompts: { listChanged: true }, resources: { listChanged: true, subscribe: false } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const page = Number(request.params?.cursor ?? "0");
    const size = 2;
    const slice = harness.tools.slice(page * size, page * size + size);
    const next = (page + 1) * size < harness.tools.length ? String(page + 1) : undefined;
    return { tools: slice, ...(next ? { nextCursor: next } : {}) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (name === "echo") {
      return { content: [{ type: "text", text: `echo:${String(args.text ?? "")}` }] };
    }
    if (name === "fail") {
      return { isError: true, content: [{ type: "text", text: "boom: the server refused" }] };
    }
    if (name === "linked") {
      return { content: [{ type: "resource_link", uri: "memo://notes/1", name: "Note 1", mimeType: "text/plain" }] };
    }
    if (name === "ask") {
      const result = await extra.sendRequest(
        {
          method: "elicitation/create",
          params: {
            message: "Which region should this deploy to?",
            requestedSchema: {
              type: "object",
              properties: {
                region: { type: "string", title: "Region", enum: ["eu", "us"] },
                confirm: { type: "boolean", title: "Confirm" },
              },
              required: ["region"],
            },
          },
        },
        ElicitResultSchema,
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    if (name === "later") {
      return { content: [{ type: "text", text: "added after list_changed" }] };
    }
    throw new Error(`unknown tool ${name}`);
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "summarize",
        title: "Summarize",
        description: "Summarize a text in a tone",
        arguments: [
          { name: "text", description: "What to summarize", required: true },
          { name: "tone", description: "Voice of the summary", required: false },
        ],
      },
    ],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
    description: "Summary prompt",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Summarize (${request.params.arguments?.tone ?? "neutral"}): ${request.params.arguments?.text ?? ""}`,
        },
      },
    ],
  }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: "memo://notes/1", name: "Note 1", mimeType: "text/plain" }],
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{ uriTemplate: "memo://notes/{id}", name: "Note by id", mimeType: "text/plain" }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
    contents: [{ uri: request.params.uri, mimeType: "text/plain", text: `note body of ${request.params.uri}` }],
  }));
  return server;
}

async function startHarness(): Promise<Harness> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const harness: Harness = {
    url: "",
    requests: [],
    sessions: new Map(),
    tools: BASE_TOOLS.map((tool) => ({ ...tool })),
    close: async () => undefined,
  };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        headers[key] = value;
      }
    }
    const body = req.method === "POST" ? await readJson(req) : undefined;
    harness.requests.push({ method: req.method ?? "", headers, body });
    const sid = headers["mcp-session-id"];
    if (sid && transports.has(sid)) {
      await transports.get(sid)!.handleRequest(req, res, body);
      return;
    }
    if (!sid && req.method === "POST" && isInitializeRequest(body)) {
      const server = buildServer(harness);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
          harness.sessions.set(id, server);
        },
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no session" }));
  };
  const http: HttpServer = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end(String(error instanceof Error ? error.message : error));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", () => resolve()));
  const port = (http.address() as AddressInfo).port;
  harness.url = `http://127.0.0.1:${port}/mcp`;
  harness.close = async () => {
    for (const transport of transports.values()) {
      await transport.close().catch(() => undefined);
    }
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  };
  return harness;
}

const nodeFetch: McpFetch = (url, init) => fetch(url, init);

function serverFor(harness: Harness, id: string = "conf"): CloudMcpServer {
  return { id, name: "Conformance", kind: "mcp", url: harness.url, headers: {}, omitMcpHeaders: false, disabledTools: [] };
}

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  await harness.close();
});

describe("MCP conformance against @modelcontextprotocol/sdk", () => {
  it("negotiates the latest revision, pins the header on every later request, and echoes the session id", async () => {
    const before = harness.requests.length;
    const connection = await connectCloudMcp(serverFor(harness), { fetch: nodeFetch, inventory: true });
    expect(connection.session.protocolVersion).toBe(MCP_LATEST_PROTOCOL_VERSION);
    expect(connection.session.sessionId).toBeTruthy();
    expect(connection.session.capabilities?.tools?.listChanged).toBe(true);
    expect(connection.session.serverInfo?.name).toBe("Gera conformance");
    const mine = harness.requests.slice(before);
    const initialize = mine.find((request) => (request.body as { method?: string } | undefined)?.method === "initialize");
    expect(initialize).toBeDefined();
    const later = mine.filter((request) => request !== initialize);
    expect(later.length).toBeGreaterThan(3); // initialized, 3 tools/list pages, prompts, resources, templates
    for (const request of later) {
      expect(request.headers["mcp-protocol-version"]).toBe(MCP_LATEST_PROTOCOL_VERSION);
      expect(request.headers["mcp-session-id"]).toBe(connection.session.sessionId);
    }
    // Pagination: five tools in pages of two → three tools/list requests.
    const listPages = later.filter((request) => (request.body as { method?: string } | undefined)?.method === "tools/list");
    expect(listPages).toHaveLength(3);
    expect(connection.tools.map((tool) => tool.name)).toEqual(["echo", "fail", "linked", "ask", "dashboard"]);
    // Annotations + MCP Apps marker survive the redacting normalizer.
    const echo = connection.tools.find((tool) => tool.name === "echo");
    expect(echo?.annotations).toEqual({ title: "Echo", readOnlyHint: true, idempotentHint: true });
    expect(echo?.title).toBe("Echo");
    expect(connection.tools.find((tool) => tool.name === "fail")?.annotations?.destructiveHint).toBe(true);
    expect(connection.tools.find((tool) => tool.name === "dashboard")?.uiOnly).toBe(true);
    // Inventory rides the same handshake.
    expect(connection.prompts.map((prompt) => prompt.name)).toEqual(["summarize"]);
    expect(connection.prompts[0].arguments?.map((argument) => argument.required)).toEqual([true, false]);
    expect(connection.resources.map((resource) => resource.uri)).toEqual(["memo://notes/1"]);
    expect(connection.resourceTemplates.map((template) => template.uriTemplate)).toEqual(["memo://notes/{id}"]);
  });

  it("runs tools/call, surfaces isError honestly, and resolves resource_link contents", async () => {
    const { session } = await connectCloudMcp(serverFor(harness), { fetch: nodeFetch });
    expect(await callCloudMcpTool(session, "echo", { text: "hi" })).toBe("echo:hi");
    await expect(callCloudMcpTool(session, "fail", {})).rejects.toThrow(/Tool reported an error[\s\S]*boom: the server refused/);
    const linked = await callCloudMcpTool(session, "linked", {});
    expect(linked).toContain("[Resource link Note 1 · memo://notes/1]");
    expect(linked).toContain("note body of memo://notes/1");
  });

  it("gets prompts and reads resources through the transport helpers", async () => {
    const { session } = await connectCloudMcp(serverFor(harness), { fetch: nodeFetch });
    const prompt = await getCloudMcpPrompt(session, "summarize", { text: "MCP is neat", tone: "dry" });
    expect(prompt.description).toBe("Summary prompt");
    expect(prompt.messages).toEqual([{ role: "user", text: "Summarize (dry): MCP is neat" }]);
    const contents = await readCloudMcpResource(session, "memo://notes/7");
    expect(contents).toEqual([{ uri: "memo://notes/7", mimeType: "text/plain", text: "note body of memo://notes/7" }]);
  });

  it("serves the account routes: inventory (then cached), prompt-get, resource-read", async () => {
    const rows = new Map<string, { payload: string; updated_at: number }>();
    const sql = {
      exec<T>(query: string, ...params: unknown[]) {
        const results: T[] = [];
        if (query.startsWith("SELECT")) {
          const row = rows.get(String(params[1]));
          if (row) {
            results.push(row as unknown as T);
          }
        } else if (query.startsWith("INSERT")) {
          rows.set(String(params[1]), { payload: String(params[2]), updated_at: Number(params[3]) });
        } else if (query.startsWith("DELETE")) {
          rows.delete(String(params[1]));
        }
        return { toArray: () => results, one: () => results[0], raw: () => results[Symbol.iterator](), columnNames: [], rowsRead: 0, rowsWritten: 0, [Symbol.iterator]: () => results[Symbol.iterator]() };
      },
    } as unknown as McpRouteContext["sql"];
    const ctx: McpRouteContext = {
      sql,
      resolveServers: async (_owner, ids) => (ids.includes("conf") ? [serverFor(harness)] : []),
      fetch: nodeFetch,
    };
    const post = (body: unknown): Request =>
      new Request("https://shard.internal/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    const first = await handleMcpInventory(ctx, post({ serverId: "conf" }), "owner@example.com");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { prompts: unknown[]; resources: unknown[]; resourceTemplates: unknown[]; toolCount: number; cached: boolean };
    expect(firstBody.cached).toBe(false);
    expect(firstBody.toolCount).toBe(5);
    expect(firstBody.prompts).toHaveLength(1);
    expect(firstBody.resources).toHaveLength(1);
    expect(firstBody.resourceTemplates).toHaveLength(1);

    const second = await handleMcpInventory(ctx, post({ serverId: "conf" }), "owner@example.com");
    expect(((await second.json()) as { cached: boolean }).cached).toBe(true);

    const prompt = await handleMcpPromptGet(ctx, post({ serverId: "conf", name: "summarize", arguments: { text: "x" } }), "owner@example.com");
    expect(prompt.status).toBe(200);
    expect(((await prompt.json()) as { messages: Array<{ text: string }> }).messages[0].text).toBe("Summarize (neutral): x");

    const resource = await handleMcpResourceRead(ctx, post({ serverId: "conf", uri: "memo://notes/1" }), "owner@example.com");
    expect(resource.status).toBe(200);
    expect(((await resource.json()) as { contents: Array<{ text: string }> }).contents[0].text).toBe("note body of memo://notes/1");

    const unknown = await handleMcpInventory(ctx, post({ serverId: "nope" }), "owner@example.com");
    expect(unknown.status).toBe(404);
  });

  it("answers elicitation from the toolset's pause hook (accept, then decline) and hides UI-only tools", async () => {
    const asked: McpToolsetElicitation[] = [];
    let nextAnswer: { action: "accept" | "decline"; content?: Record<string, string | number | boolean> } = {
      action: "accept",
      content: { region: "eu", confirm: true },
    };
    const toolset = await resolveMcpToolset({
      servers: [serverFor(harness)],
      mode: "deferred",
      fetch: nodeFetch,
      catalog: createMemoryMcpCatalogStore(),
      elicit: async (request) => {
        asked.push(request);
        return nextAnswer;
      },
    });
    try {
      expect(toolset.servers[0].toolCount).toBe(4); // dashboard is UI-only → invisible
      const search = await toolset.execute(MCP_SEARCH_TOOL_NAME, { query: "" });
      expect(search.text).not.toContain("dashboard");
      const refused = await toolset.execute(MCP_CALL_TOOL_NAME, { serverId: "conf", toolName: "dashboard", arguments: {} });
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/UI-only/);

      await toolset.execute(MCP_SEARCH_TOOL_NAME, { query: "region" });
      const accepted = await toolset.execute(MCP_CALL_TOOL_NAME, { serverId: "conf", toolName: "ask", arguments: {} });
      expect(accepted.isError).toBeUndefined();
      expect(JSON.parse(accepted.text)).toEqual({ action: "accept", content: { region: "eu", confirm: true } });
      expect(asked).toHaveLength(1);
      expect(asked[0].message).toBe("Which region should this deploy to?");
      expect(asked[0].fields.map((field) => [field.name, field.type, field.required])).toEqual([
        ["region", "string", true],
        ["confirm", "boolean", false],
      ]);
      expect(asked[0].fields[0].enum).toEqual(["eu", "us"]);

      nextAnswer = { action: "decline" };
      const declined = await toolset.execute(MCP_CALL_TOOL_NAME, { serverId: "conf", toolName: "ask", arguments: {} });
      expect(JSON.parse(declined.text)).toEqual({ action: "decline" });
    } finally {
      toolset.close();
    }
  });

  it("declines elicitation on background surfaces and journals it", async () => {
    const toolset = await resolveMcpToolset({
      servers: [serverFor(harness)],
      mode: "deferred",
      fetch: nodeFetch,
      catalog: createMemoryMcpCatalogStore(),
      notificationStreams: false,
    });
    try {
      await toolset.execute(MCP_SEARCH_TOOL_NAME, { query: "ask" });
      const outcome = await toolset.execute(MCP_CALL_TOOL_NAME, { serverId: "conf", toolName: "ask", arguments: {} });
      expect(JSON.parse(outcome.text)).toEqual({ action: "decline" });
      expect(toolset.journal.map((entry) => entry.kind)).toEqual(["elicitation_declined"]);
      expect(toolset.journal[0].detail).not.toContain("eu");
    } finally {
      toolset.close();
    }
  });

  it("refreshes the catalog after tools/list_changed arrives on the GET stream", async () => {
    const catalog = createMemoryMcpCatalogStore();
    const toolset = await resolveMcpToolset({
      servers: [serverFor(harness, "live")],
      mode: "deferred",
      fetch: nodeFetch,
      catalog,
    });
    try {
      const first = await toolset.execute(MCP_SEARCH_TOOL_NAME, { query: "later" });
      expect(first.text).not.toContain('"toolName": "later"');
      expect(catalog.read("live")).not.toBeNull();
      // Wait for the standalone GET stream to be registered on the server side.
      await expect.poll(() => harness.requests.some((request) => request.method === "GET"), { timeout: 3_000 }).toBe(true);
      const sessionIds = [...harness.sessions.keys()];
      const sessionId = sessionIds[sessionIds.length - 1];
      harness.tools.push({
        name: "later",
        description: "Appears after the list changed",
        inputSchema: { type: "object", properties: {} },
      });
      await harness.sessions.get(sessionId)!.sendToolListChanged();
      await expect.poll(() => catalog.read("live") === null, { timeout: 3_000 }).toBe(true);
      const second = await toolset.execute(MCP_SEARCH_TOOL_NAME, { query: "later" });
      expect(second.text).toContain('"toolName": "later"');
      const call = await toolset.execute(MCP_CALL_TOOL_NAME, { serverId: "live", toolName: "later", arguments: {} });
      expect(call.text).toBe("added after list_changed");
      expect(toolset.journal.some((entry) => entry.kind === "catalog_refreshed")).toBe(true);
    } finally {
      toolset.close();
      harness.tools = harness.tools.filter((tool) => tool.name !== "later");
    }
  });
});
