import { describe, expect, it } from "vitest";

import { githubOAuthFormHeaders, githubRequestHeaders } from "../../../functions/native-github";

/**
 * Cloudflare Workers' fetch sends no default User-Agent and api.github.com
 * answers UA-less requests with 403 "Request forbidden by administrative
 * rules" (probed live). Every server-side GitHub call — native tools, the
 * account relay behind /github-proxy, and the device flow — must identify
 * itself, or the account card can never resolve who the grant belongs to.
 */
describe("server-side GitHub headers", () => {
  it("identify the relay to api.github.com and keep the caller's Accept", () => {
    const headers = githubRequestHeaders("Bearer gho_x", true, "application/vnd.github.raw+json");
    expect(headers["User-Agent"]).toMatch(/^Gera-AI-Agent-Hub\//);
    expect(headers.Authorization).toBe("Bearer gho_x");
    expect(headers.Accept).toBe("application/vnd.github.raw+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("default to the JSON media type and omit Content-Type without a body", () => {
    const headers = githubRequestHeaders("Bearer gho_x");
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["Content-Type"]).toBeUndefined();
    expect(headers["User-Agent"]).toBeTruthy();
  });

  it("identify the device flow to github.com's OAuth endpoints", () => {
    const headers = githubOAuthFormHeaders();
    expect(headers["User-Agent"]).toMatch(/^Gera-AI-Agent-Hub\//);
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(headers.Accept).toBe("application/json");
  });
});
