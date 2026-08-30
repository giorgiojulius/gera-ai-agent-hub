// The repo-access probe: parsing targets and mapping the two-contour result
// matrix (metadata vs contents, SSO, org visibility) to honest verdicts.
import { describe, expect, it } from "vitest";
import { diagnoseRepoAccess, parseRepoTarget, type RepoProbe } from "@/lib/github-diagnose";
import type { GitHubViewer } from "@/lib/github-device";

describe("parseRepoTarget", () => {
  it("parses plain owner/repo", () => {
    expect(parseRepoTarget("acme/widgets")).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("strips .git and whitespace", () => {
    expect(parseRepoTarget("  acme/widgets.git ")).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("parses https URLs with tails", () => {
    expect(parseRepoTarget("https://github.com/acme/widgets/tree/main/src")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
    expect(parseRepoTarget("https://github.com/acme/widgets?tab=readme-ov-file")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
  });

  it("parses ssh remotes", () => {
    expect(parseRepoTarget("git@github.com:acme/widgets.git")).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("keeps dots in repo names", () => {
    expect(parseRepoTarget("acme/site.io")).toEqual({ owner: "acme", repo: "site.io" });
  });

  it("rejects garbage", () => {
    expect(parseRepoTarget("")).toBeNull();
    expect(parseRepoTarget("just-a-name")).toBeNull();
    expect(parseRepoTarget("a/b/c")).toBeNull();
  });
});

const viewer = (overrides: Partial<GitHubViewer> = {}): GitHubViewer => ({
  login: "me",
  name: null,
  scopes: ["repo", "read:org"],
  ...overrides,
});

const probe = (overrides: Partial<RepoProbe> = {}): RepoProbe => ({
  metadataStatus: 200,
  contentsStatus: 200,
  size: 42,
  sso: null,
  message: null,
  ...overrides,
});

const target = { owner: "acme", repo: "widgets" };

describe("diagnoseRepoAccess", () => {
  it("both contours answering is a clean OK", () => {
    const verdict = diagnoseRepoAccess({ viewer: viewer(), orgs: ["acme"], target, probe: probe() });
    expect(verdict.kind).toBe("ok");
    expect(verdict.checked).toContain("@me");
    expect(verdict.checked).toContain("repo HTTP 200");
    expect(verdict.checked).toContain("contents HTTP 200");
  });

  it("empty repo: metadata 200 + contents 404 + size 0 is honest, not scary", () => {
    const verdict = diagnoseRepoAccess({
      viewer: viewer(),
      orgs: null,
      target,
      probe: probe({ contentsStatus: 404, size: 0 }),
    });
    expect(verdict.kind).toBe("empty");
  });

  it("metadata without contents flags the fine-grained-token gap", () => {
    const verdict = diagnoseRepoAccess({
      viewer: viewer({ scopes: null }),
      orgs: null,
      target,
      probe: probe({ contentsStatus: 404, size: 42 }),
    });
    expect(verdict.kind).toBe("contents");
    expect(verdict.detail).toContain("Contents: Read");
    expect(verdict.action?.url).toContain("tokens");
  });

  it("SSO challenge wins over everything and extracts the authorize URL", () => {
    const verdict = diagnoseRepoAccess({
      viewer: viewer(),
      orgs: null,
      target,
      probe: probe({
        metadataStatus: 403,
        contentsStatus: null,
        sso: "required; url=https://github.com/orgs/acme/sso?authorization_request=abc",
      }),
    });
    expect(verdict.kind).toBe("sso");
    expect(verdict.action?.url).toBe("https://github.com/orgs/acme/sso?authorization_request=abc");
  });

  it("401 says the credential is dead", () => {
    const verdict = diagnoseRepoAccess({
      viewer: viewer(),
      orgs: null,
      target,
      probe: probe({ metadataStatus: 401, contentsStatus: null }),
    });
    expect(verdict.kind).toBe("unauthorized");
  });

  it("403 without SSO quotes GitHub's message (rate limit / IP allow list)", () => {
    const verdict = diagnoseRepoAccess({
      viewer: viewer(),
      orgs: null,
      target,
      probe: probe({ metadataStatus: 403, contentsStatus: null, message: "API rate limit exceeded" }),
    });
    expect(verdict.kind).toBe("forbidden");
    expect(verdict.detail).toContain("API rate limit exceeded");
  });

  it("404 with a token that lacks the repo scope points at the scope first", () => {
    const verdict = diagnoseRepoAccess({
      viewer: viewer({ scopes: ["read:user"] }),
      orgs: [],
      target,
      probe: probe({ metadataStatus: 404, contentsStatus: null }),
    });
    expect(verdict.kind).toBe("scope");
    expect(verdict.detail).toContain('"repo"');
  });

  it("404 for the user's own repo with a fine-grained token blames the selection", () => {
    const verdict = diagnoseRepoAccess({
      viewer: viewer({ login: "acme", scopes: null }),
      orgs: null,
      target,
      probe: probe({ metadataStatus: 404, contentsStatus: null }),
    });
    expect(verdict.kind).toBe("own-missing");
    expect(verdict.detail).toContain("Repository access");
  });

  it("404 for the user's own repo with full scopes suggests a name mismatch", () => {
    const verdict = diagnoseRepoAccess({
      viewer: viewer({ login: "ACME" }),
      orgs: null,
      target,
      probe: probe({ metadataStatus: 404, contentsStatus: null }),
    });
    expect(verdict.kind).toBe("own-missing");
    expect(verdict.detail).toContain("404");
  });

  it("404 with the org visible points at repo-level access, not approval", () => {
    const verdict = diagnoseRepoAccess({
      viewer: viewer(),
      orgs: ["Acme", "other"],
      target,
      probe: probe({ metadataStatus: 404, contentsStatus: null }),
    });
    expect(verdict.kind).toBe("org-hidden");
  });

  it("404 with the org invisible is the org-approval verdict with an action link", () => {
    const verdict = diagnoseRepoAccess({
      viewer: viewer(),
      orgs: ["different-org"],
      target,
      probe: probe({ metadataStatus: 404, contentsStatus: null }),
    });
    expect(verdict.kind).toBe("org-approval");
    expect(verdict.title).toContain("acme");
    expect(verdict.action?.label).toBe("Review org access");
  });

  it("404 with unknown org visibility stays honest about all causes", () => {
    const verdict = diagnoseRepoAccess({
      viewer: viewer(),
      orgs: null,
      target,
      probe: probe({ metadataStatus: 404, contentsStatus: null }),
    });
    expect(verdict.kind).toBe("unknown");
    expect(verdict.detail).toContain("hides private repos");
    expect(verdict.action?.label).toBe("Review org access");
  });

  it("unexpected statuses fall through to an honest inconclusive", () => {
    const verdict = diagnoseRepoAccess({
      viewer: viewer(),
      orgs: null,
      target,
      probe: probe({ metadataStatus: 500, contentsStatus: null }),
    });
    expect(verdict.kind).toBe("unknown");
    expect(verdict.detail).toContain("500");
  });

  it("the checked trace shows scopes when known and hides them for fine-grained tokens", () => {
    const classic = diagnoseRepoAccess({ viewer: viewer(), orgs: null, target, probe: probe() });
    expect(classic.checked).toContain("scopes: repo, read:org");
    const fineGrained = diagnoseRepoAccess({
      viewer: viewer({ scopes: null }),
      orgs: null,
      target,
      probe: probe(),
    });
    expect(fineGrained.checked).not.toContain("scopes:");
  });
});
