import { describe, expect, it } from "vitest";

import { githubIdentityLabel, missingGitHubScopes, parseOAuthScopes } from "@/lib/github-device";

describe("parseOAuthScopes", () => {
  it("returns null when GitHub omits the header (fine-grained tokens)", () => {
    expect(parseOAuthScopes(null)).toBeNull();
  });

  it("parses classic scope lists with stray whitespace", () => {
    expect(parseOAuthScopes(" repo, read:org ,gist")).toEqual(["repo", "read:org", "gist"]);
  });

  it("returns an empty list for a scopeless token", () => {
    expect(parseOAuthScopes("")).toEqual([]);
  });
});

describe("missingGitHubScopes", () => {
  it("flags a token without repo — private repos would be invisible", () => {
    expect(missingGitHubScopes(["read:user", "gist"])).toEqual(["repo"]);
  });

  it("flags a token with zero scopes", () => {
    expect(missingGitHubScopes([])).toEqual(["repo"]);
  });

  it("passes a token with repo", () => {
    expect(missingGitHubScopes(["repo", "read:org"])).toEqual([]);
  });

  it("stays quiet when scopes are unknown (fine-grained PAT)", () => {
    expect(missingGitHubScopes(null)).toEqual([]);
  });
});

describe("githubIdentityLabel", () => {
  it("answers who-am-I with repo access confirmed", () => {
    expect(githubIdentityLabel({ login: "octocat", name: null, scopes: ["repo", "gist"] })).toBe(
      "@octocat · repo access OK",
    );
  });

  it("warns honestly when repo scope is missing", () => {
    const label = githubIdentityLabel({ login: "octocat", name: null, scopes: ["read:user"] });
    expect(label).toContain("@octocat");
    expect(label).toContain("private repos are hidden");
  });

  it("shows just the login when scopes are unknown", () => {
    expect(githubIdentityLabel({ login: "octocat", name: null, scopes: null })).toBe("@octocat");
  });
});
