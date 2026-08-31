import { createElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useAuth, AuthProvider } from "@/hooks/use-auth";
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, refreshAccessTokenResult } from "@/lib/auth-tokens";
import { relayFetch } from "@/lib/backend";
import { forceRefreshOAuthHeader } from "@/lib/mcp-oauth";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("sleeping-tab MCP requests share one Gera refresh generation", async () => {
  localStorage.setItem(ACCESS_TOKEN_KEY, "expired-access");
  localStorage.setItem(REFRESH_TOKEN_KEY, "refresh-a");

  let staleRequests = 0;
  let refreshRequests = 0;
  let releaseDelayed401: ((response: Response) => void) | undefined;
  const gated401 = (): Response =>
    new Response(JSON.stringify({ error: "sign_in_required" }), {
      status: 401,
      headers: { "X-Gera-Relay-Auth": "required" },
    });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).includes("/oauth/refresh")) {
        refreshRequests += 1;
        return new Response(
          JSON.stringify({ access_token: "fresh-access", refresh_token: "refresh-b" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      const authorization = new Headers(init?.headers).get("Authorization");
      if (authorization === "Bearer expired-access") {
        staleRequests += 1;
        if (staleRequests === 1) {
          return gated401();
        }
        return new Promise<Response>((resolve) => {
          releaseDelayed401 = resolve;
        });
      }
      if (authorization === "Bearer fresh-access") {
        return new Response("ok", { status: 200 });
      }
      return gated401();
    }),
  );

  const firstMcp = relayFetch("/mcp-proxy", "https://one.example.com/mcp");
  const delayedMcp = relayFetch("/mcp-proxy", "https://two.example.com/mcp");

  await expect(firstMcp).resolves.toMatchObject({ status: 200 });
  expect(releaseDelayed401).toBeTypeOf("function");
  releaseDelayed401?.(gated401());
  await expect(delayedMcp).resolves.toMatchObject({ status: 200 });

  expect(refreshRequests).toBe(1);
  expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe("fresh-access");
  expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe("refresh-b");
});

test("deploy-time auth outage preserves the stored Gera session", async () => {
  localStorage.setItem(ACCESS_TOKEN_KEY, "expired-access");
  localStorage.setItem(REFRESH_TOKEN_KEY, "refresh-a");
  vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => {
    throw new TypeError("connection reset by deploy");
  }));

  await expect(refreshAccessTokenResult()).resolves.toEqual({ status: "unavailable" });
  expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe("expired-access");
  expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe("refresh-a");
});

test("AuthProvider keeps expired identity context while a deploy refresh retries", async () => {
  const encode = (value: object): string =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const expiredJwt = `${encode({ alg: "none" })}.${encode({
    sub: "deploy-user",
    email: "deploy@gera.app",
    exp: Math.floor(Date.now() / 1000) - 60,
  })}.signature`;
  localStorage.setItem(ACCESS_TOKEN_KEY, expiredJwt);
  localStorage.setItem(REFRESH_TOKEN_KEY, "refresh-a");
  vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => {
    throw new TypeError("backend rolling out");
  }));

  const Probe = () => {
    const { user, isLoading } = useAuth();
    return createElement(
      "output",
      { "data-testid": "auth-deploy-probe" },
      isLoading ? "loading" : `ready:${user?.id ?? "signed-out"}`,
    );
  };
  const screen = await render(createElement(AuthProvider, null, createElement(Probe)));

  await expect.element(screen.getByTestId("auth-deploy-probe")).toHaveTextContent("ready:deploy-user");
  expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe(expiredJwt);
  expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe("refresh-a");
});

test("new bundle adopts an MCP refresh escrowed before the old response was lost", async () => {
  const serverId = "deploy-browser";
  const oldToken = {
    accessToken: "provider-a",
    refreshToken: "provider-ra",
    expiresAt: 1,
    tokenEndpoint: "https://auth.example.org/token",
    clientId: "client-1",
    mcpUrl: "https://mcp.example.org/mcp",
  };
  const newToken = {
    ...oldToken,
    accessToken: "provider-b",
    refreshToken: "provider-rb",
    expiresAt: Date.now() + 3_600_000,
  };
  localStorage.setItem("gera.mcp.oauth.tokens.v1", JSON.stringify({ [serverId]: oldToken }));
  localStorage.setItem(
    `gera.mcp.oauth.token.v2.${encodeURIComponent(serverId)}`,
    JSON.stringify(oldToken),
  );
  let attempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes("/mcp/oauth-refresh")) {
        attempts += 1;
        if (attempts === 1) {
          // The shard persisted provider-b/provider-rb, then this old page's
          // response disappeared with the published bundle.
          throw new TypeError("page unloaded");
        }
        return new Response(JSON.stringify({ token: newToken, replayed: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ rotations: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );

  await expect(forceRefreshOAuthHeader(serverId)).resolves.toBeNull();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await expect(forceRefreshOAuthHeader(serverId)).resolves.toBe("Bearer provider-b");
  expect(attempts).toBe(2);
  const stored = JSON.parse(localStorage.getItem("gera.mcp.oauth.tokens.v1") ?? "{}") as Record<
    string,
    { refreshToken?: string }
  >;
  expect(stored[serverId]?.refreshToken).toBe("provider-rb");
});
