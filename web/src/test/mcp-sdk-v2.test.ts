import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { createMcpHandler, McpServer, inputRequired, acceptedContent } from "@modelcontextprotocol/server";
import { resolveMcpToolset, createMemoryMcpCatalogStore } from "../../../functions/mcp-toolset";
import { connectCloudMcp, callCloudMcpToolRich, type CloudMcpServer } from "../../../functions/mcp-cloud";
import { MCP_MODERN_PROTOCOL_VERSION, MCP_META_LOG_LEVEL, type McpFetch } from "../../../functions/mcp-protocol";

/** Standard Schema adapter for the app's existing Zod version, without upgrading app dependencies. */
function fixtureSchema<T>(schema: z.ZodType<T>): {
  "~standard": { version: 1; vendor: string; types?: { input: T; output: T };
    validate(value: unknown): { value: T } | { issues: Array<{ message: string }> };
    jsonSchema: { input(): Record<string, unknown>; output(): Record<string, unknown> } };
} {
  return { "~standard": { version: 1, vendor: "gera-test-zod", validate(value) {
    const parsed = schema.safeParse(value);
    return parsed.success ? { value: parsed.data } : { issues: parsed.error.issues.map((issue) => ({ message: issue.message })) };
  }, jsonSchema: { input: () => z.toJSONSchema(schema), output: () => z.toJSONSchema(schema) } } };
}
/** Official v2 factory/handler, strictly modern. Only the HTTP adapter is in-process. */
function officialServer() {
  let executions = 0;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "official-modern", version: "2.0.0" }, { capabilities: { tools: { listChanged: true } } });
    server.registerTool("echo", { inputSchema: fixtureSchema(z.object({ message: z.string() })), annotations: { readOnlyHint: true } }, async ({ message }) => {
      executions += 1;
      return { content: [{ type: "text", text: `echo: ${message}` }] };
    });
    server.registerTool("confirm", { inputSchema: fixtureSchema(z.object({})), annotations: { readOnlyHint: true } }, async (_args, context) => {
      const answer = acceptedContent<{ confirm: boolean }>(context.mcpReq.inputResponses, "consent");
      if (answer?.confirm === true) return { content: [{ type: "text", text: "accepted" }] };
      if (context.mcpReq.inputResponses?.consent) return { content: [{ type: "text", text: "declined" }], isError: true };
      return inputRequired({ inputRequests: { consent: inputRequired.elicit({ message: "Continue?", requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"] } }) } });
    });
    server.registerPrompt("greet", { argsSchema: fixtureSchema(z.object({ name: z.string() })) }, ({ name }) => ({ messages: [{ role: "user", content: { type: "text", text: `Hello ${name}` } }] }));
    server.registerResource("readme", "file:///README.md", { mimeType: "text/plain" }, async (uri) => ({ contents: [{ uri: uri.href, text: "Official SDK resource" }] }));
    return server;
  }, { legacy: "reject", keepAliveMs: 0 });
  const requests: Array<{ method: string; params: Record<string, unknown>; headers: Headers }> = [];
  const fetch: McpFetch = async (url, init) => {
    const frame = JSON.parse(String(init.body)) as { method: string; params: Record<string, unknown> };
    requests.push({ ...frame, headers: new Headers(init.headers) });
    return handler.fetch(new Request(url, init));
  };
  const config: CloudMcpServer = { id: "sdk", name: "Official SDK", kind: "mcp", url: "https://sdk.fixture.dev/mcp", headers: {}, disabledTools: [], omitMcpHeaders: false };
  return { handler, fetch, requests, config, executions: () => executions };
}

describe("official @modelcontextprotocol/server 2.0.0 conformance", () => {
  it("strict modern cold search/call, inventory, wire cache and subscription invalidation", async () => {
    const sdk = officialServer();
    const catalog = createMemoryMcpCatalogStore();
    const toolset = await resolveMcpToolset({ servers: [sdk.config], mode: "deferred", fetch: sdk.fetch, catalog, inventory: true });
    try {
      expect(sdk.requests).toEqual([]);
      const cold = await toolset.execute("mcp_call_tool", { serverId: "sdk", toolName: "echo", arguments: { message: "first" } });
      expect(cold.executed).toBe(false); expect(sdk.executions()).toBe(0);
      expect(toolset.servers[0]).toMatchObject({ protocolVersion: MCP_MODERN_PROTOCOL_VERSION, toolCount: 2, promptCount: 1, resourceCount: 1 });
      expect((await toolset.execute("mcp_call_tool", { serverId: "sdk", toolName: "echo", arguments: { message: "second" } })).text).toBe("echo: second");
      expect(sdk.executions()).toBe(1);
      const warm = await resolveMcpToolset({ servers: [sdk.config], mode: "native", fetch: sdk.fetch, catalog, notificationStreams: false });
      expect(sdk.requests.filter((frame) => frame.method === "server/discover")).toHaveLength(1);
      warm.close();
      sdk.handler.notify.toolsChanged();
      await expect.poll(() => catalog.read("sdk")).toBeNull();
      await toolset.execute("mcp_search_tools", { query: "echo", serverId: "sdk" });
      expect(catalog.read("sdk")?.wire?.era).toBe("modern");
      expect(sdk.requests.some((frame) => frame.method === "initialize" || frame.method === "notifications/initialized")).toBe(false);
      expect(sdk.requests.every((frame) => !frame.headers.has("Mcp-Session-Id"))).toBe(true);
    } finally { toolset.close(); await sdk.handler.close(); }
  });
  it("MRTR accepts interactive form input, declines unattended input, and keeps log metadata across rounds", async () => {
    const sdk = officialServer();
    try {
      const connected = await connectCloudMcp(sdk.config, { fetch: sdk.fetch, logLevel: "warning", onServerRequest: async () => ({ result: { action: "accept", content: { confirm: true } } }) });
      expect((await callCloudMcpToolRich(connected.session, "confirm", {})).text).toBe("accepted");
      for (const frame of sdk.requests) expect((frame.params._meta as Record<string, unknown>)[MCP_META_LOG_LEVEL]).toBe("warning");
      const background = await connectCloudMcp(sdk.config, { fetch: sdk.fetch });
      await expect(callCloudMcpToolRich(background.session, "confirm", {})).rejects.toThrow("declined");
      expect(sdk.requests.filter((frame) => frame.method === "tools/call")).toHaveLength(4);
    } finally { await sdk.handler.close(); }
  });
});
