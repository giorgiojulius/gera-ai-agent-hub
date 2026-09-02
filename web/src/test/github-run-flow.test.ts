import { describe, expect, it } from "vitest";

import { armCloudMcp, type McpRoute } from "../../../functions/automation-runner";
import type { EngineToolDef } from "../../../functions/agent-engine";
import { runServerJulius } from "../../../functions/julius-runner";
import { cloudMcpServersForAutomation } from "../../../functions/mcp-cloud";
import {
  callGitHubNativeTool as callServerGitHubNativeTool,
  fetchGitHubViewer as fetchServerGitHubViewer,
  githubRunRepoRefs as serverGitHubRunRepoRefs,
} from "../../../functions/native-github";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Regression coverage for the browser-token → cloud-native-tool boundary. */
describe("GitHub cloud run hand-off", () => {
  it("keeps the exact browser credential and arms server-side GitHub tools", async () => {
    const eligible = cloudMcpServersForAutomation(
      [
        {
          id: "github",
          catalogId: "github",
          name: "GitHub",
          enabled: true,
          status: "connected",
          token: "Bearer gho_browser_token",
          disabledTools: [],
        },
      ],
      null,
    );

    expect(eligible).toHaveLength(1);
    expect(eligible[0].kind).toBe("github");
    expect(eligible[0].token).toBe("Bearer gho_browser_token");

    const runtime = await armCloudMcp(eligible);
    expect(runtime.toolDefs.some((tool) => tool.function.name === "mcp_github_get_contents")).toBe(true);
    const route = runtime.routes.get("mcp_github_get_contents");
    expect(route?.type).toBe("native");
    if (route?.type === "native") {
      expect(route.kind).toBe("github");
      expect(route.auth).toBe("Bearer gho_browser_token");
    }
  });

  it("resolves the canonical device-flow grant for a GitHub card with a legacy instance id", async () => {
    const grant = {
      accessToken: "gho_device_flow",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      clientId: "Iv1.workspace",
      mcpUrl: "https://api.github.com",
    };
    const eligible = cloudMcpServersForAutomation(
      [
        {
          id: "mcp-legacy-7",
          catalogId: "github",
          name: "GitHub",
          enabled: true,
          status: "connected",
          token: "",
          disabledTools: [],
        },
      ],
      null,
      { github: grant },
    );

    expect(eligible).toHaveLength(1);
    expect(eligible[0].kind).toBe("github");
    expect(eligible[0].token).toBeUndefined();
    expect(eligible[0].oauth?.accessToken).toBe("gho_device_flow");

    const runtime = await armCloudMcp(eligible);
    const route = [...runtime.routes.values()].find(
      (item) => item.type === "native" && item.kind === "github" && item.toolName === "get_contents",
    );
    expect(route?.type).toBe("native");
    if (route?.type === "native") {
      expect(route.auth).toBe("Bearer gho_device_flow");
    }
  });

  it("lets a grant stored under the catalog id arm a card with a different instance id", () => {
    const eligible = cloudMcpServersForAutomation(
      [
        {
          id: "row-linear-2",
          catalogId: "linear",
          name: "Linear",
          url: "https://mcp.linear.app/mcp",
          enabled: true,
          status: "connected",
          authMode: "oauth",
          disabledTools: [],
        },
      ],
      null,
      {
        linear: {
          accessToken: "lin_access",
          tokenEndpoint: "https://mcp.linear.app/oauth/token",
          clientId: "client",
          mcpUrl: "https://mcp.linear.app/mcp",
        },
      },
    );

    expect(eligible).toHaveLength(1);
    expect(eligible[0].oauth?.accessToken).toBe("lin_access");
  });

  it("still lets a pasted PAT win over the canonical grant", () => {
    const eligible = cloudMcpServersForAutomation(
      [
        {
          id: "github",
          catalogId: "github",
          name: "GitHub",
          enabled: true,
          status: "connected",
          token: "ghp_pasted",
          disabledTools: [],
        },
      ],
      null,
      {
        github: {
          accessToken: "gho_device_flow",
          tokenEndpoint: "https://github.com/login/oauth/access_token",
          clientId: "Iv1.workspace",
          mcpUrl: "https://api.github.com",
        },
      },
    );

    expect(eligible).toHaveLength(1);
    expect(eligible[0].token).toBe("ghp_pasted");
    expect(eligible[0].oauth).toBeUndefined();
  });

  it("feeds a thread pin to the server research contour without changing the question", () => {
    expect(serverGitHubRunRepoRefs("why does login fail?", "acme/private-app")).toEqual([
      { owner: "acme", repo: "private-app" },
    ]);
  });

  it("keeps an explicitly named repository ahead of the pin", () => {
    expect(serverGitHubRunRepoRefs("inspect other/service", "acme/private-app")).toEqual([
      { owner: "other", repo: "service" },
    ]);
  });
});

describe("Julius GitHub verification", () => {
  it("lets the council Verifier execute the same native GitHub route without exposing write tools", async () => {
    const readTool = "mcp_github_whoami";
    const writeTool = "mcp_github_create_issue";
    const eventStream = (events: Array<Record<string, unknown>>): Response =>
      new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    const textStream = (model: string, content: string): Response =>
      eventStream([{ model, choices: [{ delta: { content } }] }]);

    let verifierCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === "https://api.github.com/user") {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer verifier-credential");
        return new Response(JSON.stringify({ login: "octocat", name: "Mona" }), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-OAuth-Scopes": "repo, read:org" },
        });
      }
      if (url.startsWith("https://api.github.com/user/orgs")) {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (!url.endsWith("/v2/vercel/v1/chat/completions")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as {
        model?: string;
        messages?: Array<{ role?: string; content?: unknown }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      const model = body.model ?? "";
      if (model === "test/candidate") {
        return textStream(model, "The connected GitHub account is @octocat.");
      }
      if (model === "test/proponent") {
        return textStream(model, "The answer is specific.");
      }
      if (model === "test/critic") {
        return textStream(model, "The account claim needs checking.");
      }
      if (model === "test/verifier") {
        verifierCalls += 1;
        const toolNames = (body.tools ?? []).map((tool) => tool.function?.name ?? "");
        expect(toolNames).toContain(readTool);
        expect(toolNames).not.toContain(writeTool);
        const prompt = (body.messages ?? [])
          .map((message) => (typeof message.content === "string" ? message.content : ""))
          .join("\n");
        expect(prompt).toContain("inspect that source with the matching read tool");
        const toolResult = (body.messages ?? []).find((message) => message.role === "tool");
        if (!toolResult) {
          return eventStream([
            {
              model,
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "verify-github-account",
                        type: "function",
                        function: { name: readTool, arguments: "{}" },
                      },
                    ],
                  },
                },
              ],
            },
          ]);
        }
        expect(String(toolResult.content)).toContain("Signed in as @octocat");
        return textStream(model, "✓ GitHub independently verified @octocat.");
      }
      if (model === "test/chairman") {
        const prompt = (body.messages ?? [])
          .map((message) => (typeof message.content === "string" ? message.content : ""))
          .join("\n");
        return prompt.includes("final deliverable")
          ? textStream(model, "Final answer after an independent GitHub check.")
          : textStream(model, "VERDICT: Solid after the GitHub verification.");
      }
      throw new Error(`Unexpected model: ${model}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const mcpToolDefs: EngineToolDef[] = [readTool, writeTool].map((name) => ({
      type: "function",
      function: { name, description: name, parameters: { type: "object", properties: {} } },
    }));
    const mcpRoutes = new Map<string, McpRoute>([
      [
        readTool,
        {
          type: "native",
          kind: "github",
          auth: "Bearer verifier-credential",
          toolName: "whoami",
          serverName: "GitHub",
        },
      ],
    ]);

    const result = await runServerJulius({
      authKey: "toolkit-key",
      history: [{ role: "user", content: "Check the connected GitHub account." }],
      prompt: "Check the connected GitHub account.",
      settings: {
        candidateModelIds: ["test/candidate"],
        decision: "council",
        proponentModelId: "test/proponent",
        criticModelId: "test/critic",
        verifierModelId: "test/verifier",
        chairmanModelId: "test/chairman",
      },
      builtins: {
        web_search: false,
        fetch_url: false,
        selfsurf: false,
        generate_image: false,
        generate_video: false,
        generate_audio: false,
      },
      mcpToolDefs,
      mcpRoutes,
      onUpdate: () => undefined,
    });

    const verifier = result.julius.reviews.find((review) => review.role === "verifier");
    expect(verifierCalls).toBe(2);
    expect(verifier?.content).toContain("independently verified @octocat");
    expect(verifier?.toolCalls).toEqual([
      expect.objectContaining({
        name: readTool,
        status: "done",
        result: expect.stringContaining("Signed in as @octocat"),
      }),
    ]);
    expect(result.content).toBe("Final answer after an independent GitHub check.");
  });
});

describe("GitHub cloud REST transport", () => {
  it("identifies every Worker request to GitHub instead of triggering User Agent Required 403", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      expect(headers.get("user-agent")).toBe("Gera-AI-Agent-Hub/1.0");
      expect(headers.get("x-github-api-version")).toBe("2022-11-28");
      expect(headers.get("authorization")).toBe("Bearer opaque-credential");
      return new Response(JSON.stringify({ login: "octocat", name: "Mona" }), {
        status: 200,
        headers: { "Content-Type": "application/json", "X-OAuth-Scopes": "repo, read:org" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchServerGitHubViewer("Bearer opaque-credential")).resolves.toEqual({
      login: "octocat",
      name: "Mona",
      scopes: ["repo", "read:org"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps 403 as a retryable GitHub policy/rate-limit failure, not a dead credential", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> =>
        new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": "1788080400",
          },
        }),
      ),
    );

    const error = await fetchServerGitHubViewer("Bearer opaque-credential").then(
      () => null,
      (reason: unknown) => (reason instanceof Error ? reason : new Error(String(reason))),
    );
    expect(error?.message).toContain("GitHub rate limit reached");
    expect(error?.message).toContain("credential was kept");
    expect(error?.message).not.toContain("Sign in");
  });

  it("asks for a new credential only after GitHub's definitive 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> =>
        new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      callServerGitHubNativeTool("Bearer opaque-credential", "whoami", {}),
    ).rejects.toThrow(/credential \(401\).*Sign in with GitHub/);
  });
});
