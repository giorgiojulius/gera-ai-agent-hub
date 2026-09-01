import { afterEach, describe, expect, it, vi } from "vitest";

import type { EngineToolDef } from "../../../functions/agent-engine";
import type { McpRoute } from "../../../functions/automation-runner";
import { mcpRoutesForToolDefs } from "../../../functions/julius-runner";
import { cloudMcpServersForAutomation, intersectMcpAllowIds, unlockGithubChatWrites } from "../../../functions/mcp-cloud";
import {
  GITHUB_NATIVE_TOOLS as SERVER_GITHUB_TOOLS,
  callGitHubNativeTool as callServerGitHub,
} from "../../../functions/native-github";
import {
  createServerSurfSession,
  createSourceLedger,
  executeServerTool,
} from "../../../functions/run-tools";
import { parseRemoteChat } from "@/lib/chat-sync";
import { probeRepoAccess } from "@/lib/github-diagnose";
import {
  GITHUB_NATIVE_TOOLS as BROWSER_GITHUB_TOOLS,
  callGitHubNativeTool as callBrowserGitHub,
  githubRunRepoRefs,
  injectGitHubRunAuth,
  parseRepoPick,
  type GitHubRepoMeta,
} from "@/lib/github-native";
import { clearLocalAccountState, normalizeStoredSettings } from "@/lib/history";
import { findCatalogEntry, catalogEntryToServer, GITHUB_WRITE_TOOLS } from "@/lib/mcp-catalog";
import { findServerForTool, mcpFunctionName } from "@/lib/mcp";
import type { McpServerConfig } from "@/lib/types";

type NativeCall = (auth: string, name: string, args: unknown) => Promise<string>;

const nativeCalls: Array<{ label: string; call: NativeCall }> = [
  { label: "browser", call: callBrowserGitHub },
  { label: "worker", call: callServerGitHub },
];

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub native contract parity", () => {
  it("keeps every browser and Worker tool name/schema identical", () => {
    const browser = BROWSER_GITHUB_TOOLS.map((tool) => ({ name: tool.name, schema: tool.inputSchema }));
    const worker = SERVER_GITHUB_TOOLS.map((tool) => ({ name: tool.name, schema: tool.inputSchema }));
    expect(worker).toEqual(browser);
    expect(browser).toHaveLength(30);
  });

  it("new GitHub connections begin with writes enabled", () => {
    const entry = findCatalogEntry("github");
    expect(entry).toBeDefined();
    const server = catalogEntryToServer(entry!);
    expect(server.disabledTools).toEqual([]);
  });

  it("strips the factory GitHub write block from stored chat connectors", () => {
    const settings = normalizeStoredSettings({
      mcpServers: [
        {
          id: "github",
          catalogId: "github",
          name: "GitHub",
          url: "",
          headersJson: "",
          enabled: true,
          status: "connected",
          tools: [{ name: "get_contents" }],
          disabledTools: [...GITHUB_WRITE_TOOLS],
        },
      ],
    });
    expect(settings.mcpServers[0]?.disabledTools).toEqual([]);
    expect(unlockGithubChatWrites("github", [...GITHUB_WRITE_TOOLS, "get_pull_files"])).toEqual(["get_pull_files"]);
  });

  it("arms GitHub writes on cloud runs even if the profile still lists the factory block", () => {
    const eligible = cloudMcpServersForAutomation(
      [
        {
          id: "github",
          catalogId: "github",
          name: "GitHub",
          enabled: true,
          status: "connected",
          token: "Bearer gho_chat",
          disabledTools: [...GITHUB_WRITE_TOOLS],
        },
      ],
      null,
    );
    expect(eligible).toHaveLength(1);
    expect(eligible[0]?.disabledTools).toEqual([]);
  });

  it("does not let a stale server-side OAuth grant resurrect locally signed-out GitHub", () => {
    const github: McpServerConfig = {
      id: "github",
      catalogId: "github",
      name: "GitHub",
      url: "",
      headersJson: "",
      enabled: true,
      status: "connected",
      tools: [],
      disabledTools: [],
    };
    const notion: McpServerConfig = { ...github, id: "notion", catalogId: "notion", name: "Notion" };
    expect(injectGitHubRunAuth([github, notion], undefined)).toEqual([notion]);
  });
});

describe("all 30 GitHub tool dispatchers", () => {
  const cases: Array<{ name: string; args: Record<string, unknown>; endpoint: string; method?: string }> = [
    { name: "whoami", args: {}, endpoint: "/user" },
    { name: "list_my_repos", args: { limit: 1 }, endpoint: "/user/repos" },
    { name: "search_repositories", args: { query: "x" }, endpoint: "/search/repositories" },
    { name: "get_repo", args: { owner: "o", repo: "r" }, endpoint: "/repos/o/r" },
    { name: "get_contents", args: { owner: "o", repo: "r", path: "file.txt", ref: "main" }, endpoint: "/contents/file.txt" },
    { name: "get_file_tree", args: { owner: "o", repo: "r", ref: "main" }, endpoint: "/git/trees/main" },
    { name: "get_readme", args: { owner: "o", repo: "r" }, endpoint: "/readme" },
    { name: "list_commits", args: { owner: "o", repo: "r", branch: "main" }, endpoint: "/commits" },
    { name: "search_code", args: { query: "repo:o/r x" }, endpoint: "/search/code" },
    { name: "search_issues", args: { query: "repo:o/r is:open" }, endpoint: "/search/issues" },
    { name: "list_issues", args: { owner: "o", repo: "r", limit: 1 }, endpoint: "/issues" },
    { name: "list_pulls", args: { owner: "o", repo: "r", limit: 1 }, endpoint: "/pulls" },
    { name: "get_pull", args: { owner: "o", repo: "r", number: 1 }, endpoint: "/pulls/1" },
    { name: "get_pull_files", args: { owner: "o", repo: "r", number: 1 }, endpoint: "/pulls/1/files" },
    { name: "get_commit", args: { owner: "o", repo: "r", ref: "abc1234" }, endpoint: "/commits/abc1234" },
    { name: "compare_commits", args: { owner: "o", repo: "r", base: "main", head: "fix/x" }, endpoint: "/compare/" },
    { name: "list_workflow_runs", args: { owner: "o", repo: "r" }, endpoint: "/actions/runs" },
    { name: "list_run_jobs", args: { owner: "o", repo: "r", run_id: 8 }, endpoint: "/actions/runs/8/jobs" },
    { name: "get_job_logs", args: { owner: "o", repo: "r", job_id: 9 }, endpoint: "/actions/jobs/9/logs" },
    { name: "list_run_artifacts", args: { owner: "o", repo: "r", run_id: 8 }, endpoint: "/actions/runs/8/artifacts" },
    { name: "list_releases", args: { owner: "o", repo: "r" }, endpoint: "/releases" },
    { name: "list_branches", args: { owner: "o", repo: "r" }, endpoint: "/branches" },
    { name: "list_deployments", args: { owner: "o", repo: "r" }, endpoint: "/deployments" },
    { name: "create_issue", args: { owner: "o", repo: "r", title: "Issue" }, endpoint: "/issues", method: "POST" },
    { name: "add_issue_comment", args: { owner: "o", repo: "r", number: 1, body: "Comment" }, endpoint: "/issues/1/comments", method: "POST" },
    { name: "create_branch", args: { owner: "o", repo: "r", branch: "fix/x", from: "main" }, endpoint: "/git/refs", method: "POST" },
    { name: "put_file", args: { owner: "o", repo: "r", branch: "fix/x", path: "new.txt", content: "x", message: "add" }, endpoint: "/contents/new.txt", method: "PUT" },
    { name: "delete_file", args: { owner: "o", repo: "r", branch: "fix/x", path: "old.txt", expected_sha: "blob-sha", message: "delete" }, endpoint: "/contents/old.txt", method: "DELETE" },
    { name: "create_pull", args: { owner: "o", repo: "r", title: "PR", head: "fix/x", base: "main" }, endpoint: "/pulls", method: "POST" },
    { name: "update_pull", args: { owner: "o", repo: "r", number: 1, title: "Updated" }, endpoint: "/pulls/1", method: "PATCH" },
  ];

  it("routes every tool successfully in both browser and Worker implementations", async () => {
    for (const { label, call } of nativeCalls) {
      for (const testCase of cases) {
        const requests: Array<{ target: string; method: string }> = [];
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const requestUrl = String(input);
            const headers = new Headers(init?.headers);
            const target = headers.get("X-Gera-Upstream-Url") ?? requestUrl;
            const url = new URL(requestUrl);
            const method = init?.method ?? "GET";
            requests.push({ target: decodeURIComponent(target), method });
            const path = url.pathname;
            if (path === "/mcp-proxy") {
              return new Response("job log", { status: 200 });
            }
            if (path === "/user") {
              return json({ login: "octocat", name: "Mona" }, 200, { "X-OAuth-Scopes": "repo" });
            }
            if (path === "/user/orgs" || path === "/user/repos") {
              return json([]);
            }
            if (path === "/search/repositories" || path === "/search/code" || path === "/search/issues") {
              return json({ total_count: 0, items: [] });
            }
            if (path === "/repos/o/r") {
              return json({ full_name: "o/r", default_branch: "main", html_url: "https://github.com/o/r" });
            }
            if (path.endsWith("/contents/file.txt")) {
              return json({ type: "file", path: "file.txt", size: 5, sha: "file-sha", encoding: "base64", content: "aGVsbG8=" });
            }
            if (path.endsWith("/contents/new.txt")) {
              return method === "GET" ? json({ message: "Not Found" }, 404) : json({ commit: { sha: "new-commit" } });
            }
            if (path.endsWith("/contents/old.txt")) {
              return method === "GET" ? json({ type: "file", sha: "blob-sha" }) : json({ commit: { sha: "delete-commit" } });
            }
            if (path.endsWith("/git/trees/main")) {
              return json({ tree: [] });
            }
            if (path.endsWith("/readme")) {
              return json({ path: "README.md", size: 6, sha: "readme-sha", encoding: "base64", content: "UkVBRE1F" });
            }
            if (path.endsWith("/commits") || path.endsWith("/issues") && method === "GET" || path.endsWith("/pulls") && method === "GET") {
              return json([]);
            }
            if (path.endsWith("/commits/main")) {
              return json({ sha: "base-sha" });
            }
            if (path.endsWith("/commits/abc1234")) {
              return json({ sha: "abc1234", commit: { message: "commit", author: { name: "Mona", date: "2026-08-30" } }, stats: {}, files: [] });
            }
            if (path.includes("/compare/")) {
              return json({ status: "ahead", ahead_by: 1, behind_by: 0, commits: [], files: [] });
            }
            if (path.endsWith("/pulls/1/files")) {
              return json([]);
            }
            if (path.endsWith("/pulls/1")) {
              return json({ number: 1, title: "PR", state: "open", user: { login: "octocat" }, head: { ref: "fix/x" }, base: { ref: "main" }, html_url: "https://github.com/o/r/pull/1" });
            }
            if (path.endsWith("/actions/runs")) {
              return json({ workflow_runs: [] });
            }
            if (path.endsWith("/actions/runs/8/jobs")) {
              return json({ jobs: [] });
            }
            if (path.endsWith("/actions/jobs/9/logs")) {
              return new Response("job log", { status: 200 });
            }
            if (path.endsWith("/actions/runs/8/artifacts")) {
              return json({ artifacts: [] });
            }
            if (path.endsWith("/releases") || path.endsWith("/branches") || path.endsWith("/deployments")) {
              return json([]);
            }
            if (path.endsWith("/issues") && method === "POST") {
              return json({ number: 1, html_url: "https://github.com/o/r/issues/1" });
            }
            if (path.endsWith("/issues/1/comments")) {
              return json({ html_url: "https://github.com/o/r/issues/1#comment" });
            }
            if (path.endsWith("/git/refs")) {
              return json({ ref: "refs/heads/fix/x" });
            }
            if (path.endsWith("/pulls") && method === "POST") {
              return json({ number: 1, html_url: "https://github.com/o/r/pull/1" });
            }
            throw new Error(`unhandled ${method} ${path} for ${testCase.name}`);
          }),
        );
        const result = await call("Bearer x", testCase.name, testCase.args);
        expect(result, `${label}.${testCase.name}`).toEqual(expect.any(String));
        expect(result.length, `${label}.${testCase.name}`).toBeGreaterThan(0);
        expect(
          requests.some(
            (request) =>
              request.target.includes(testCase.endpoint) &&
              request.method === (testCase.method ?? "GET"),
          ),
          `${label}.${testCase.name} did not call ${testCase.method ?? "GET"} ${testCase.endpoint}`,
        ).toBe(true);
        vi.unstubAllGlobals();
      }
    }
  });
});

describe("GitHub repository and path boundaries", () => {
  it("accepts structured pins whose legitimate repository name looks like a file", () => {
    expect(githubRunRepoRefs("inspect it", "acme/app.js")).toEqual([{ owner: "acme", repo: "app.js" }]);
    expect(githubRunRepoRefs("inspect it", "src/app.ts/more")).toEqual([]);
  });

  it("accepts slash-containing branch refs selected by the research reflector", () => {
    const meta: GitHubRepoMeta = {
      fullName: "acme/app",
      htmlUrl: "https://github.com/acme/app",
      defaultBranch: "main",
      isPrivate: true,
      description: "",
      language: "TypeScript",
      stars: 0,
      pushedAt: "",
      openIssues: 0,
    };
    const repos = new Map<string, GitHubRepoMeta>([["acme/app", meta]]);
    expect(parseRepoPick("acme/app@feature/fix-login", repos)).toEqual({
      meta,
      kind: "commit",
      ref: "feature/fix-login",
    });
  });

  it("requires an explicit get_contents path while still allowing path:'' for root", async () => {
    for (const { call } of nativeCalls) {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(call("Bearer x", "get_contents", { owner: "acme", repo: "app" })).rejects.toThrow(
        /path.*string/i,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it("rejects dot segments and invalid repo coordinates before any network request", async () => {
    for (const { call } of nativeCalls) {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        call("Bearer x", "get_contents", {
          owner: "safe",
          repo: "repo",
          path: "../../../repos/victim/private/contents/README.md",
        }),
      ).rejects.toThrow(/cannot contain.*\.\./i);
      await expect(call("Bearer x", "get_repo", { owner: "..", repo: "victim" })).rejects.toThrow(
        /valid GitHub "owner"/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it("rejects write traversal and missing put_file content before touching GitHub", async () => {
    for (const { call } of nativeCalls) {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        call("Bearer x", "put_file", {
          owner: "safe",
          repo: "repo",
          branch: "fix/x",
          path: "../../../repos/victim/private/contents/README.md",
          content: "owned",
          message: "write",
        }),
      ).rejects.toThrow(/cannot contain.*\.\./i);
      await expect(
        call("Bearer x", "put_file", {
          owner: "safe",
          repo: "repo",
          branch: "fix/x",
          path: "README.md",
          message: "empty by accident",
        }),
      ).rejects.toThrow(/content.*string/i);
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });
});

describe("GitHub write concurrency rails", () => {
  async function assertStaleWriteRefused(call: NativeCall): Promise<void> {
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        methods.push(method);
        if (url.pathname === "/repos/acme/app") {
          return json({ full_name: "acme/app", default_branch: "main" });
        }
        if (url.pathname === "/repos/acme/app/contents/src/a.ts" && method === "GET") {
          return json({ type: "file", sha: "current-sha", path: "src/a.ts" });
        }
        throw new Error(`unexpected ${method} ${url.pathname}`);
      }),
    );
    await expect(
      call("Bearer x", "put_file", {
        owner: "acme",
        repo: "app",
        branch: "fix/x",
        path: "src/a.ts",
        content: "next",
        expected_sha: "stale-sha",
        message: "update",
      }),
    ).rejects.toThrow(/changed since it was read/);
    expect(methods).not.toContain("PUT");
  }

  it("refuses stale updates in both browser and Worker", async () => {
    for (const { call } of nativeCalls) {
      await assertStaleWriteRefused(call);
      vi.unstubAllGlobals();
    }
  });

  it("does not reinterpret 403/rate-limit as a missing file and attempt a create", async () => {
    for (const { call } of nativeCalls) {
      const methods: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const url = new URL(String(input));
          const method = init?.method ?? "GET";
          methods.push(method);
          if (url.pathname === "/repos/acme/app") {
            return json({ full_name: "acme/app", default_branch: "main" });
          }
          return json(
            { message: "secondary rate limit" },
            403,
            { "Retry-After": "60", "X-RateLimit-Remaining": "10" },
          );
        }),
      );
      await expect(
        call("Bearer x", "put_file", {
          owner: "acme",
          repo: "app",
          branch: "fix/x",
          path: "src/a.ts",
          content: "next",
          message: "update",
        }),
      ).rejects.toThrow(/rate limit/i);
      expect(methods).not.toContain("PUT");
      vi.unstubAllGlobals();
    }
  });

  it("allows an explicit empty new file but requires expected_sha for an existing file", async () => {
    for (const { call } of nativeCalls) {
      let putBody: Record<string, unknown> | null = null;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const url = new URL(String(input));
          const method = init?.method ?? "GET";
          if (url.pathname === "/repos/acme/app") {
            return json({ full_name: "acme/app", default_branch: "main" });
          }
          if (url.pathname === "/repos/acme/app/contents/empty.txt" && method === "GET") {
            return json({ message: "Not Found" }, 404);
          }
          if (url.pathname === "/repos/acme/app/contents/empty.txt" && method === "PUT") {
            putBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
            return json({ commit: { sha: "abc1234" } });
          }
          throw new Error(`unexpected ${method} ${url.pathname}`);
        }),
      );
      await expect(
        call("Bearer x", "put_file", {
          owner: "acme",
          repo: "app",
          branch: "fix/x",
          path: "empty.txt",
          content: "",
          message: "add empty file",
        }),
      ).resolves.toContain("Created empty.txt");
      expect(putBody?.content).toBe("");
      vi.unstubAllGlobals();
    }
  });
});

describe("GitHub reads, diffs, and logs", () => {
  it("paginates PR files in both implementations", async () => {
    for (const { call } of nativeCalls) {
      const pages: number[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
          const url = new URL(String(input));
          const page = Number(url.searchParams.get("page") ?? "1");
          pages.push(page);
          const count = page === 1 ? 100 : 1;
          return json(
            Array.from({ length: count }, (_, index) => ({
              filename: `src/${page}-${index}.ts`,
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "+x",
            })),
          );
        }),
      );
      await expect(
        call("Bearer x", "get_pull_files", { owner: "acme", repo: "app", number: 7 }),
      ).resolves.toContain("101 changed files");
      expect(pages).toEqual([1, 2]);
      vi.unstubAllGlobals();
    }
  });

  it("follows the Worker job-log redirect without forwarding Authorization and bounds the body", async () => {
    const seenAuth: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        seenAuth.push(headers.get("authorization"));
        if (url.startsWith("https://api.github.com/")) {
          expect(init?.redirect).toBe("manual");
          return new Response(null, {
            status: 302,
            headers: { Location: "https://signed-logs.example.net/job.txt?sig=opaque" },
          });
        }
        expect(url).toContain("signed-logs.example.net");
        return new Response(`${"old\n".repeat(4_000)}TAIL FAILURE SENTINEL`, { status: 200 });
      }),
    );
    const output = await callServerGitHub("Bearer secret", "get_job_logs", {
      owner: "acme",
      repo: "app",
      job_id: 42,
    });
    expect(seenAuth).toEqual(["Bearer secret", null]);
    expect(output).toContain("TAIL FAILURE SENTINEL");
    expect(output).toContain("last 9000");
    expect(output.length).toBeLessThan(9_200);
  });
});

describe("GitHub execution and scope boundaries", () => {
  it("uses exact browser dispatch and refuses disabled tools", () => {
    const server: McpServerConfig = {
      id: "github",
      catalogId: "github",
      name: "GitHub",
      url: "",
      headersJson: "",
      enabled: true,
      status: "connected",
      tools: [],
      disabledTools: ["get_pull_files"],
    };
    expect(findServerForTool([server], mcpFunctionName("github", "get_pull"))?.toolName).toBe("get_pull");
    expect(findServerForTool([server], mcpFunctionName("github", "get_pull_files"))).toBeNull();
    expect(findServerForTool([server], "mcp_github_get_p")).toBeNull();
    expect(
      findServerForTool(
        [{ ...server, disabledTools: [...server.disabledTools, "put_file"] }],
        mcpFunctionName("github", "put_file"),
      )?.toolName,
    ).toBe("put_file");
  });

  it("intersects profile and automation connector scopes by row or catalog id", () => {
    const servers = [
      { id: "gh-row", catalogId: "github" },
      { id: "notion", catalogId: "notion" },
      { id: "linear-row", catalogId: "linear" },
    ];
    expect(intersectMcpAllowIds(servers, ["github", "notion"], ["gh-row", "linear"])).toEqual(["gh-row"]);
    expect(intersectMcpAllowIds(servers, [], null)).toEqual([]);
    expect(intersectMcpAllowIds(servers, null, null)).toBeNull();
  });

  it("limits Julius runtime routes to the read-only definitions of each phase", () => {
    const readName = "mcp_github_get_contents";
    const writeName = "mcp_github_put_file";
    const defs: EngineToolDef[] = [
      { type: "function", function: { name: readName, description: "read", parameters: {} } },
    ];
    const route = (toolName: string): McpRoute => ({
      type: "native",
      kind: "github",
      auth: "Bearer x",
      toolName,
      serverName: "GitHub",
    });
    const scoped = mcpRoutesForToolDefs(
      defs,
      new Map<string, McpRoute>([
        [readName, route("get_contents")],
        [writeName, route("put_file")],
      ]),
    );
    expect([...scoped!.keys()]).toEqual([readName]);
  });

  it("marks a GitHub HTTP failure as an error while still returning it to the model", async () => {
    vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => json({ message: "Bad credentials" }, 401)));
    const name = "mcp_github_whoami";
    const route: McpRoute = {
      type: "native",
      kind: "github",
      auth: "Bearer bad",
      toolName: "whoami",
      serverName: "GitHub",
    };
    const outcome = await executeServerTool(name, "{}", {
      authKey: "toolkit",
      ledger: createSourceLedger(),
      surf: createServerSurfSession(),
      mcpRoutes: new Map([[name, route]]),
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("MCP tool failed (GitHub)");
    expect(outcome.text).toContain("401");
  });
});

describe("GitHub account isolation and diagnostics", () => {
  it("preserves a synced thread pin and rejects malformed wire pins", () => {
    const base = {
      id: "chat-1",
      title: "Repo",
      updatedAt: 20,
      payload: JSON.stringify({
        id: "chat-1",
        title: "Repo",
        modelId: "model",
        githubRepo: "acme/app.js",
        messages: [{ id: "m1", role: "user", content: "hello" }],
        createdAt: 10,
      }),
    };
    expect(parseRemoteChat(base)?.githubRepo).toBe("acme/app.js");
    expect(
      parseRemoteChat({
        ...base,
        payload: JSON.stringify({
          id: "chat-1",
          title: "Repo",
          modelId: "model",
          githubRepo: "../other/repo",
          messages: [{ id: "m1", role: "user", content: "hello" }],
        }),
      })?.githubRepo,
    ).toBeUndefined();
  });

  it("clears every Gera account value on sign-out but leaves unrelated auth storage alone", () => {
    const store = new Map<string, string>([
      ["gera.settings.v1", "private PAT"],
      ["gera.mcp.oauth.tokens.v1", "private OAuth"],
      ["gera.conversations.v1", "private repo names"],
      ["rork:access_token", "cleared separately by AuthProvider"],
      ["theme", "unrelated"],
    ]);
    const storage = {
      get length(): number {
        return store.size;
      },
      key: (index: number): string | null => [...store.keys()][index] ?? null,
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => void store.set(key, value),
      removeItem: (key: string): void => void store.delete(key),
      clear: (): void => store.clear(),
    } as Storage;
    vi.stubGlobal("window", { localStorage: storage, clearTimeout: vi.fn() });
    vi.stubGlobal("localStorage", storage);
    clearLocalAccountState();
    expect([...store.keys()]).toEqual(["rork:access_token", "theme"]);
  });

  it("captures SSO and GitHub's message from the contents contour, not only metadata", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => {
        call += 1;
        return call === 1
          ? json({ size: 120 })
          : json(
              { message: "Resource protected by organization SAML enforcement" },
              403,
              { "X-GitHub-SSO": "required; url=https://github.com/orgs/acme/sso?authorization_request=x" },
            );
      }),
    );
    const probe = await probeRepoAccess("Bearer x", { owner: "acme", repo: "private" });
    expect(probe.contentsStatus).toBe(403);
    expect(probe.sso).toContain("authorization_request=x");
    expect(probe.message).toContain("SAML enforcement");
  });
});
