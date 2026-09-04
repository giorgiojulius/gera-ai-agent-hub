import { afterEach, describe, expect, it, vi } from "vitest";

import {
  armCloudMcp,
  callNativeConnectorTool,
  type McpRoute,
} from "../../../functions/automation-runner";
import {
  callCloudMcpTool,
  parseCloudMcpRpcResponse,
  stringifyCloudMcpResult,
  type CloudMcpSession,
} from "../../../functions/mcp-cloud";
import { cloudMcpServersForAutomation } from "../../../functions/mcp-cloud";
import { callGitHubNativeTool as callServerGitHubNativeTool } from "../../../functions/native-github";
import { callGitHubNativeTool as callBrowserGitHubNativeTool } from "@/lib/github-native";
import {
  callMcpTool,
  connectMcpServerLegacy,
  parseMcpRpcResponse,
  stringifyMcpResult,
} from "@/lib/mcp";
import type { McpServerConfig } from "@/lib/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(events: unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("GitHub MCP file bodies", () => {
  it("reads an encoding:none file through the cloud route with the same auth, path, and ref", async () => {
    const requests: Array<{ url: string; accept: string | null; authorization: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        const request = {
          url: String(input),
          accept: headers.get("accept"),
          authorization: headers.get("authorization"),
        };
        requests.push(request);
        if (request.accept === "application/vnd.github.raw+json") {
          return new Response("export const FILE_BODY = 'cloud';\n", { status: 200 });
        }
        return jsonResponse({
          type: "file",
          path: "src/big file.ts",
          size: 1_200_000,
          encoding: "none",
          content: "",
        });
      }),
    );

    const servers = cloudMcpServersForAutomation(
      [
        {
          id: "github",
          catalogId: "github",
          name: "GitHub",
          enabled: true,
          status: "connected",
          token: "Bearer private-repo-token",
          disabledTools: [],
        },
      ],
      null,
    );
    const runtime = await armCloudMcp(servers);
    const route: McpRoute | undefined = runtime.routes.get("mcp_github_get_contents");
    expect(route?.type).toBe("native");
    if (!route || route.type !== "native") {
      throw new Error("GitHub route was not armed");
    }

    const output = await callNativeConnectorTool(route, {
      owner: "acme",
      repo: "private-app",
      path: "src/big file.ts",
      ref: "feature/read-files",
    });

    expect(output).toContain("FILE_BODY");
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toContain("/contents/src/big%20file.ts?ref=feature%2Fread-files");
    expect(requests[1].url).toContain("/contents/src/big%20file.ts?ref=feature%2Fread-files");
    expect(requests[1]).toMatchObject({
      accept: "application/vnd.github.raw+json",
      authorization: "Bearer private-repo-token",
    });
  });

  it("uses the authenticated raw fallback in the browser connector too", async () => {
    const accepts: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        accepts.push(headers.get("accept"));
        if (headers.get("accept") === "application/vnd.github.raw+json") {
          expect(headers.get("authorization")).toBe("Bearer browser-token");
          return new Response("const FILE_BODY = 'browser';\n", { status: 200 });
        }
        return jsonResponse({ type: "file", path: "src/app.ts", size: 1_100_000, encoding: "none", content: "" });
      }),
    );

    await expect(
      callBrowserGitHubNativeTool("Bearer browser-token", "get_contents", {
        owner: "acme",
        repo: "app",
        path: "src/app.ts",
        ref: "main",
      }),
    ).resolves.toContain("FILE_BODY");
    expect(accepts).toEqual(["application/vnd.github+json", "application/vnd.github.raw+json"]);
  });

  it("treats an empty inline base64 file as readable instead of binary or missing", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> =>
      jsonResponse({ type: "file", path: "empty.txt", size: 0, encoding: "base64", content: "" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callServerGitHubNativeTool("Bearer token", "get_contents", {
        owner: "acme",
        repo: "app",
        path: "empty.txt",
      }),
    ).resolves.toBe("empty.txt (0 B):\n");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("generic MCP file-content transport", () => {
  it("selects the matching SSE response after progress notifications", () => {
    const body = [
      `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 0.5 } })}`,
      "",
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "FILE_BODY" }] } })}`,
      "",
    ].join("\n");

    expect(parseMcpRpcResponse(body, 7).result).toEqual({
      content: [{ type: "text", text: "FILE_BODY" }],
    });
    expect(parseCloudMcpRpcResponse(body, 7).result).toEqual({
      content: [{ type: "text", text: "FILE_BODY" }],
    });
    expect(() => parseMcpRpcResponse(body, 8)).toThrow(/request 8/);
  });

  it("keeps structured and embedded file content while omitting binary base64", () => {
    const structured = { content: [], structuredContent: { path: "src/a.ts", contents: "STRUCTURED_FILE_BODY" } };
    expect(stringifyMcpResult(structured)).toContain("STRUCTURED_FILE_BODY");
    expect(stringifyCloudMcpResult(structured)).toContain("STRUCTURED_FILE_BODY");

    const embedded = {
      content: [
        {
          type: "resource",
          resource: { uri: "file:///project/src/a.ts", mimeType: "text/typescript", text: "EMBEDDED_FILE_BODY" },
        },
        { type: "image", mimeType: "image/png", data: "A".repeat(30_000) },
      ],
    };
    for (const output of [stringifyMcpResult(embedded), stringifyCloudMcpResult(embedded)]) {
      expect(output).toContain("EMBEDDED_FILE_BODY");
      expect(output).toContain("image content omitted");
      expect(output).not.toContain("A".repeat(100));
    }
  });

  // The cloud session's resource_link follow-up (tools/call → resources/read on
  // the same authenticated session) runs against the real SDK server in
  // mcp-conformance.test.ts.

  it("follows resource links in the browser MCP client as well", async () => {
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method: string };
        methods.push(body.method);
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (body.method === "initialize") {
          return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "Files" } } });
        }
        if (body.method === "tools/list") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [
                {
                  name: "read_file",
                  description: "Read one file",
                  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
                },
              ],
            },
          });
        }
        if (body.method === "tools/call") {
          return sseResponse([
            { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } },
            {
              jsonrpc: "2.0",
              id: body.id,
              result: { content: [{ type: "resource_link", uri: "file:///project/README.md", name: "README.md" }] },
            },
          ]);
        }
        if (body.method === "resources/read") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: { contents: [{ uri: "file:///project/README.md", mimeType: "text/markdown", text: "BROWSER_RESOURCE_BODY" }] },
          });
        }
        throw new Error(`Unexpected method ${body.method}`);
      }),
    );
    const server: McpServerConfig = {
      id: "file-content-test-server",
      name: "Files",
      url: "https://mcp.example.com",
      headersJson: "",
      authMode: "none",
      enabled: true,
      status: "connected",
      tools: [],
      disabledTools: [],
    };

    await connectMcpServerLegacy(server);
    await expect(callMcpTool(server, "read_file", { path: "README.md" })).resolves.toContain(
      "BROWSER_RESOURCE_BODY",
    );
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
      "resources/read",
    ]);
  });
});
