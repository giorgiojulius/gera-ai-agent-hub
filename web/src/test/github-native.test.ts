import { describe, expect, it, vi } from "vitest";

import {
  GITHUB_NATIVE_TOOLS,
  callGitHubNativeTool,
  decodeGitHubContent,
  encodeGitHubContent,
  formatDiffFiles,
  formatRepoLine,
  githubRepoRefs,
  githubRunRepoRefs,
  injectGitHubRunAuth,
  parseRepoPick,
  resolveGitHubAuth,
  type GitHubRepoMeta,
} from "@/lib/github-native";
import type { McpServerConfig } from "@/lib/types";

describe("injectGitHubRunAuth", () => {
  const base: McpServerConfig = {
    id: "github",
    name: "GitHub",
    url: "",
    headersJson: "",
    enabled: true,
    status: "connected",
    tools: [],
    disabledTools: [],
  };
  const other: McpServerConfig = { ...base, id: "notion", name: "Notion" };

  it("hands the browser credential to the GitHub entry only", () => {
    const out = injectGitHubRunAuth([other, base], "Bearer gho_x");
    expect(out[1].token).toBe("Bearer gho_x");
    expect(out[0].token).toBeUndefined();
  });

  it("matches by catalogId when the entry has a custom id", () => {
    const custom: McpServerConfig = { ...base, id: "srv_1", catalogId: "github" };
    const out = injectGitHubRunAuth([custom], "Bearer gho_x");
    expect(out[0].token).toBe("Bearer gho_x");
  });

  it("never overwrites a pasted PAT — that credential already rides the run", () => {
    const pat: McpServerConfig = { ...base, token: "ghp_pasted" };
    const input = [pat];
    const out = injectGitHubRunAuth(input, "Bearer gho_x");
    expect(out[0].token).toBe("ghp_pasted");
    expect(out).toBe(input); // nothing changed — same array back
  });

  it("drops GitHub without a browser credential and never mutates sources", () => {
    const input = [base];
    expect(injectGitHubRunAuth(input, undefined)).toEqual([]);
    expect(input).toEqual([base]);
    const out = injectGitHubRunAuth(input, "Bearer gho_x");
    expect(out).not.toBe(input);
    expect(base.token).toBeUndefined(); // settings state stays pristine
  });
});

describe("githubRunRepoRefs", () => {
  it("uses the thread pin when the question does not repeat owner/repo", () => {
    expect(githubRunRepoRefs("найди причину бага", "acme/private-app")).toEqual([
      { owner: "acme", repo: "private-app" },
    ]);
  });

  it("lets an explicitly named repo override the thread pin", () => {
    expect(githubRunRepoRefs("compare other/repo", "acme/private-app")).toEqual([
      { owner: "other", repo: "repo" },
    ]);
  });

  it("does not turn malformed pins or file paths into repositories", () => {
    expect(githubRunRepoRefs("check this", "not-a-repo")).toEqual([]);
    expect(githubRunRepoRefs("check this", "src/app.ts/more")).toEqual([]);
  });
});

describe("GITHUB_NATIVE_TOOLS", () => {
  it("has unique, function-safe names", () => {
    const names = GITHUB_NATIVE_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("declares every required field in properties", () => {
    for (const tool of GITHUB_NATIVE_TOOLS) {
      const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      for (const key of schema.required ?? []) {
        expect(schema.properties?.[key], `${tool.name}.${key}`).toBeDefined();
      }
    }
  });

  it("keeps the key read tools in the surface", () => {
    const names = GITHUB_NATIVE_TOOLS.map((tool) => tool.name);
    expect(names).toContain("list_my_repos");
    expect(names).toContain("whoami");
    expect(names).toContain("get_file_tree");
    expect(names).toContain("get_commit");
    expect(names).toContain("compare_commits");
    expect(names).toContain("get_pull_files");
    expect(names).toContain("list_workflow_runs");
    expect(names).toContain("list_run_jobs");
    expect(names).toContain("get_job_logs");
    expect(names).toContain("list_run_artifacts");
    expect(names).toContain("list_releases");
    expect(names).toContain("list_branches");
    expect(names).toContain("list_deployments");
  });

  it("ships the write tools — and deliberately no merge tool", () => {
    const names = GITHUB_NATIVE_TOOLS.map((tool) => tool.name);
    expect(names).toContain("create_branch");
    expect(names).toContain("put_file");
    expect(names).toContain("delete_file");
    expect(names).toContain("create_pull");
    expect(names).toContain("update_pull");
    // Merging stays with the human — the factory must never grow this tool silently.
    expect(names.some((name) => name.includes("merge"))).toBe(false);
  });
});

describe("githubRepoRefs", () => {
  it("finds repos in github.com URLs, ignoring deep paths", () => {
    expect(githubRepoRefs("see https://github.com/giorgiojulius/geostocks/blob/main/src/app.ts")).toEqual([
      { owner: "giorgiojulius", repo: "geostocks" },
    ]);
  });

  it("finds bare owner/repo mentions in any language", () => {
    expect(githubRepoRefs("проверь баги в giorgiojulius/geostocks пожалуйста")).toEqual([
      { owner: "giorgiojulius", repo: "geostocks" },
    ]);
  });

  it("ignores file paths, npm scopes, and dates", () => {
    expect(githubRepoRefs("fix web/src/lib bug in functions/index.ts using @tanstack/react-query 24/7")).toEqual([]);
  });

  it("dedupes URL and bare mentions of the same repo", () => {
    expect(githubRepoRefs("github.com/a1/b2 and also a1/b2 again")).toEqual([{ owner: "a1", repo: "b2" }]);
  });

  it("strips .git suffixes and trailing punctuation", () => {
    expect(githubRepoRefs("clone https://github.com/foo/bar.git now")).toEqual([{ owner: "foo", repo: "bar" }]);
    expect(githubRepoRefs("look at foo/geostocks.")).toEqual([{ owner: "foo", repo: "geostocks" }]);
  });

  it("caps at three repos", () => {
    expect(githubRepoRefs("a/r1 b/r2 c/r3 d/r4")).toHaveLength(3);
  });
});

describe("parseRepoPick", () => {
  const meta: GitHubRepoMeta = {
    fullName: "giorgiojulius/geostocks",
    htmlUrl: "https://github.com/giorgiojulius/geostocks",
    defaultBranch: "main",
    isPrivate: true,
    description: "",
    language: "TypeScript",
    stars: 0,
    pushedAt: "2026-08-20",
    openIssues: 2,
  };
  const repos = new Map<string, GitHubRepoMeta>([["giorgiojulius/geostocks", meta]]);

  it("parses owner/repo:path file picks", () => {
    expect(parseRepoPick("giorgiojulius/geostocks:src/valuation.ts", repos)).toEqual({
      meta,
      kind: "file",
      path: "src/valuation.ts",
    });
  });

  it("parses owner/repo/path file picks", () => {
    expect(parseRepoPick("giorgiojulius/geostocks/src/valuation.ts", repos)).toEqual({
      meta,
      kind: "file",
      path: "src/valuation.ts",
    });
  });

  it("resolves bare paths when exactly one repo is loaded", () => {
    expect(parseRepoPick("src/valuation.ts", repos)).toEqual({ meta, kind: "file", path: "src/valuation.ts" });
  });

  it("returns null for unknown repos", () => {
    expect(parseRepoPick("other/repo:file.ts", repos)).toBeNull();
  });

  it("parses commit-diff picks", () => {
    expect(parseRepoPick("giorgiojulius/geostocks@a1b2c3d", repos)).toEqual({
      meta,
      kind: "commit",
      ref: "a1b2c3d",
    });
  });

  it("accepts branch refs after @ for a known repo", () => {
    expect(parseRepoPick("giorgiojulius/geostocks@main", repos)).toEqual({ meta, kind: "commit", ref: "main" });
  });

  it("binds bare sha picks to the single loaded repo", () => {
    expect(parseRepoPick("@deadbeef1", repos)).toEqual({ meta, kind: "commit", ref: "deadbeef1" });
  });

  it("parses PR-diff picks", () => {
    expect(parseRepoPick("giorgiojulius/geostocks#42", repos)).toEqual({ meta, kind: "pull", number: 42 });
  });

  it("keeps @ inside file paths as file picks", () => {
    expect(parseRepoPick("src/@types/globals.d.ts", repos)).toEqual({
      meta,
      kind: "file",
      path: "src/@types/globals.d.ts",
    });
  });
});

describe("formatDiffFiles", () => {
  it("renders patches and flags binary files", () => {
    const out = formatDiffFiles([
      { filename: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" },
      { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
    ]);
    expect(out).toContain("src/a.ts [modified] +2/−1");
    expect(out).toContain("+new");
    expect(out).toContain("logo.png [added]");
    expect(out).toContain("binary or too large");
  });

  it("truncates huge patches", () => {
    const out = formatDiffFiles([
      { filename: "big.ts", status: "modified", additions: 9, deletions: 9, patch: "x".repeat(30_000) },
    ]);
    expect(out).toContain("…(patch truncated)");
    expect(out.length).toBeLessThan(13_000);
  });
});

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

describe("decodeGitHubContent", () => {
  it("decodes newline-wrapped base64 as UTF-8", () => {
    const raw = toBase64("Привет, мир! 🚀");
    const wrapped = `${raw.slice(0, 8)}\n${raw.slice(8)}\n`;
    expect(decodeGitHubContent(wrapped)).toBe("Привет, мир! 🚀");
  });
});

describe("encodeGitHubContent", () => {
  it("round-trips UTF-8 (cyrillic + emoji + code) through base64", () => {
    const text = "Привет, мир! 🚀\nconst x = 1;\n";
    expect(decodeGitHubContent(encodeGitHubContent(text))).toBe(text);
  });
});

describe("write rails", () => {
  it("put_file refuses the default branch before any write", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const target = String(input);
        if (target.endsWith("/repos/o/r")) {
          return new Response(
            JSON.stringify({ full_name: "o/r", default_branch: "main", html_url: "https://github.com/o/r" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`unexpected fetch: ${target}`);
      }),
    );
    try {
      await expect(
        callGitHubNativeTool("Bearer x", "put_file", {
          owner: "o",
          repo: "r",
          branch: "main",
          path: "src/a.ts",
          content: "x",
          message: "m",
        }),
      ).rejects.toThrow(/write-protected/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("delete_file rides the same default-branch guard", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const target = String(input);
        if (target.endsWith("/repos/o/r")) {
          return new Response(JSON.stringify({ full_name: "o/r", default_branch: "develop" }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${target}`);
      }),
    );
    try {
      await expect(
        callGitHubNativeTool("Bearer x", "delete_file", {
          owner: "o",
          repo: "r",
          branch: "develop",
          path: "a.ts",
          message: "m",
        }),
      ).rejects.toThrow(/write-protected/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("create_pull refuses head === base without touching the network", async () => {
    await expect(
      callGitHubNativeTool("Bearer x", "create_pull", {
        owner: "o",
        repo: "r",
        title: "t",
        head: "main",
        base: "main",
      }),
    ).rejects.toThrow(/working branch/);
  });

  it("update_pull validates state and requires an actual change", async () => {
    await expect(
      callGitHubNativeTool("Bearer x", "update_pull", { owner: "o", repo: "r", number: 1, state: "merged" }),
    ).rejects.toThrow(/"open" or "closed"/);
    await expect(
      callGitHubNativeTool("Bearer x", "update_pull", { owner: "o", repo: "r", number: 1 }),
    ).rejects.toThrow(/Nothing to update/);
  });

  it("put_file rejects oversized content before any network call", async () => {
    await expect(
      callGitHubNativeTool("Bearer x", "put_file", {
        owner: "o",
        repo: "r",
        branch: "fix/x",
        path: "a.ts",
        content: "x".repeat(350_001),
        message: "m",
      }),
    ).rejects.toThrow(/per-write cap/);
  });
});

describe("formatRepoLine", () => {
  it("marks private repos and includes the description", () => {
    const line = formatRepoLine({
      full_name: "gera/secret-app",
      private: true,
      language: "TypeScript",
      stargazers_count: 3,
      pushed_at: "2026-08-20T10:00:00Z",
      description: "Internal tooling",
    });
    expect(line).toContain("gera/secret-app");
    expect(line).toContain("private");
    expect(line).toContain("TypeScript");
    expect(line).toContain("pushed 2026-08-20");
    expect(line).toContain("Internal tooling");
  });

  it("labels plain public repos", () => {
    expect(formatRepoLine({ full_name: "a/b" })).toBe("a/b [public]");
  });
});

describe("resolveGitHubAuth", () => {
  it("prefers a pasted PAT and normalizes it to a Bearer header", async () => {
    await expect(resolveGitHubAuth({ id: "github", token: "ghp_abc" })).resolves.toBe("Bearer ghp_abc");
  });

  it("keeps an explicit Bearer prefix untouched", async () => {
    await expect(resolveGitHubAuth({ id: "github", token: "Bearer gho_xyz" })).resolves.toBe("Bearer gho_xyz");
  });
});

describe("callGitHubNativeTool", () => {
  it("rejects unknown tools without touching the network", async () => {
    await expect(callGitHubNativeTool("Bearer x", "nope", {})).rejects.toThrow('Unknown GitHub tool "nope"');
  });
});
