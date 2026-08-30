import { describe, expect, it, vi } from "vitest";

import { listRepoOptions, pinnedRepoPromptBlock } from "@/lib/github-native";

describe("pinnedRepoPromptBlock", () => {
  it("names owner and repo and defaults GitHub tools to the pin", () => {
    const block = pinnedRepoPromptBlock("acme/site", true);
    expect(block).toContain("## Pinned GitHub repository");
    expect(block).toContain('"acme/site"');
    expect(block).toContain('owner "acme"');
    expect(block).toContain('repo "site"');
    // An explicitly named different repo must win over the pin.
    expect(block).toContain("takes precedence");
  });

  it("stays honest when the connector is off for the run", () => {
    const block = pinnedRepoPromptBlock("acme/site", false);
    expect(block).toContain("cannot be read right now");
    expect(block).not.toContain("mcp_github_");
  });

  it("keeps dots and dashes in repo names intact", () => {
    const block = pinnedRepoPromptBlock("my-org/site.v2", true);
    expect(block).toContain('owner "my-org"');
    expect(block).toContain('repo "site.v2"');
  });

  it("never invents an owner for a malformed pin", () => {
    const block = pinnedRepoPromptBlock("just-a-name", true);
    expect(block).toContain('"just-a-name"');
    expect(block).not.toContain('owner "');
    // The connector is on — the block must not claim it is off.
    expect(block).not.toContain("connector is off");
  });
});

describe("listRepoOptions", () => {
  it("maps /user/repos rows, drops nameless ones, stops on a short page", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/user/repos");
      expect(url.searchParams.get("sort")).toBe("pushed");
      expect(url.searchParams.get("affiliation")).toBe("owner,collaborator,organization_member");
      return new Response(
        JSON.stringify([
          {
            full_name: "acme/site",
            private: true,
            description: "Marketing site",
            pushed_at: "2026-08-29T10:00:00Z",
          },
          { full_name: "", private: false },
          { full_name: "acme/api", private: false, description: null },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const repos = await listRepoOptions("Bearer t");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(repos).toEqual([
        { fullName: "acme/site", private: true, description: "Marketing site", pushedAt: "2026-08-29T10:00:00Z" },
        { fullName: "acme/api", private: false, description: "", pushedAt: "" },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("pages full batches and caps at 300 repos", async () => {
    const fullPage = (page: number) =>
      Array.from({ length: 100 }, (_, index) => ({ full_name: `o/r${page}-${index}` }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
      return new Response(JSON.stringify(fullPage(page)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const repos = await listRepoOptions("Bearer t");
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(repos).toHaveLength(300);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("surfaces GitHub's auth rejection honestly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    try {
      await expect(listRepoOptions("Bearer bad")).rejects.toThrow(/Sign in with GitHub/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
