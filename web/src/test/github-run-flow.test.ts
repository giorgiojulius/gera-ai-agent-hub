import { describe, expect, it } from "vitest";

import { armCloudMcp } from "../../../functions/automation-runner";
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
