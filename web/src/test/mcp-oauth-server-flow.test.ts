import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAuthorizationUrl,
  discoverMcpOAuth,
  exchangeAuthorizationCode,
  pkceChallenge,
  registerDynamicOAuthClient,
} from "../../../functions/mcp-oauth-flow";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("server-owned MCP OAuth flow", () => {
  it("binds discovery to the MCP resource and issuer, then builds S256 authorization", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.hostname === "mcp.staging-provider.dev" && url.pathname.includes("oauth-protected-resource")) {
        return json({
          resource: "https://mcp.staging-provider.dev/mcp",
          authorization_servers: ["https://auth.staging-provider.dev"],
          scopes_supported: ["tools:read"],
        });
      }
      if (url.hostname === "auth.staging-provider.dev" && url.pathname.includes("oauth-authorization-server")) {
        return json({
          issuer: "https://auth.staging-provider.dev",
          authorization_endpoint: "https://auth.staging-provider.dev/authorize",
          token_endpoint: "https://auth.staging-provider.dev/token",
          registration_endpoint: "https://auth.staging-provider.dev/register",
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["tools:read", "offline_access"],
        });
      }
      return json({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const discovery = await discoverMcpOAuth("https://mcp.staging-provider.dev/mcp");
    const challenge = await pkceChallenge("a".repeat(64));
    const authorization = new URL(buildAuthorizationUrl({
      discovery,
      clientId: "client-1",
      redirectUri: "https://backend.staging.workers.dev/mcp/oauth/callback",
      state: "state-1",
      challenge,
    }));

    expect(discovery.issuer).toBe("https://auth.staging-provider.dev/");
    expect(discovery.scopes).toEqual(["tools:read", "offline_access"]);
    expect(authorization.searchParams.get("resource")).toBe("https://mcp.staging-provider.dev/mcp");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toBe(challenge);
  });

  it("registers and exchanges entirely on the server boundary", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/register")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.redirect_uris).toEqual(["https://backend.staging.workers.dev/mcp/oauth/callback"]);
        return json({ client_id: "client-1", client_secret_expires_at: 2_000_000_000 });
      }
      if (url.endsWith("/token")) {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("code_verifier")).toBe("verifier-1");
        expect(body.get("code")).toBe("one-time-code");
        return json({ access_token: "ACCESS-A", refresh_token: "REFRESH-A", expires_in: 30 });
      }
      return json({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = await registerDynamicOAuthClient(
      "https://auth.staging-provider.dev/register",
      "https://backend.staging.workers.dev/mcp/oauth/callback",
    );
    const token = await exchangeAuthorizationCode({
      tokenEndpoint: "https://auth.staging-provider.dev/token",
      clientId: client.clientId,
      code: "one-time-code",
      verifier: "verifier-1",
      redirectUri: "https://backend.staging.workers.dev/mcp/oauth/callback",
      resource: "https://mcp.staging-provider.dev/mcp",
      mcpUrl: "https://mcp.staging-provider.dev/mcp",
    });

    expect(token).toMatchObject({
      accessToken: "ACCESS-A",
      refreshToken: "REFRESH-A",
      tokenEndpoint: "https://auth.staging-provider.dev/token",
      clientId: "client-1",
      mcpUrl: "https://mcp.staging-provider.dev/mcp",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects cross-origin resource metadata before authorization", async () => {
    vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => json({
      resource: "https://attacker.example.net/mcp",
      authorization_servers: ["https://auth.staging-provider.dev"],
    })));
    await expect(discoverMcpOAuth("https://mcp.staging-provider.dev/mcp")).rejects.toThrow(
      "resource origin",
    );
  });
});
