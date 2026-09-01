// Regression: an expired BROWSER copy of an OAuth grant must never revoke the
// server-owned grant. Older bundles auto-POSTed /mcp/oauth-clear on local
// expiry, creating a durable revocation tombstone that destroyed every fresh
// GitHub device-flow sign-in minutes after it succeeded (server_auth_missing).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authedFetch = vi.fn(
  async (..._args: unknown[]) => ({ ok: true, json: async () => ({}) }),
);

vi.mock("@/lib/backend", () => ({
  authedFetch: (...args: unknown[]) => authedFetch(...args),
}));

const TOKENS_KEY = "gera.mcp.oauth.tokens.v1";

describe("oauth clear safety (web/src/lib/mcp-oauth)", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    vi.resetModules();
    authedFetch.mockClear();
    store = new Map<string, string>();
    const storage = {
      get length(): number {
        return store.size;
      },
      key: (index: number): string | null => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    vi.stubGlobal("window", { localStorage: storage, dispatchEvent: vi.fn() });
    vi.stubGlobal("localStorage", storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function seedExpiredToken(id: string): void {
    const token = {
      accessToken: "gho_expired",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      clientId: "client-1",
      expiresAt: Date.now() - 60_000,
    };
    store.set(TOKENS_KEY, JSON.stringify({ [id]: token }));
    store.set(`gera.mcp.oauth.token.v2.${encodeURIComponent(id)}`, JSON.stringify(token));
  }

  it("expired local token is dropped locally without revoking the server grant", async () => {
    seedExpiredToken("github");
    const { oauthAuthHeader, hasOAuthToken } = await import("@/lib/mcp-oauth");
    const header = await oauthAuthHeader("github");
    expect(header).toBeNull();
    expect(hasOAuthToken("github")).toBe(false);
    const clearCalls = authedFetch.mock.calls.filter(
      (call) => typeof call[0] === "string" && (call[0] as string).includes("/mcp/oauth-clear"),
    );
    expect(clearCalls).toHaveLength(0);
  });

  it("explicit disconnect revokes server-side with an explicit reason", async () => {
    seedExpiredToken("github");
    const { clearOAuthToken } = await import("@/lib/mcp-oauth");
    clearOAuthToken("github", "github");
    const clearCall = authedFetch.mock.calls.find(
      (call) => typeof call[0] === "string" && (call[0] as string).includes("/mcp/oauth-clear"),
    );
    expect(clearCall).toBeDefined();
    const init = clearCall?.[1] as { body?: string } | undefined;
    const body = JSON.parse(init?.body ?? "{}") as { reason?: string; serverId?: string };
    expect(body.reason).toBe("disconnect");
    expect(body.serverId).toBe("github");
  });
});
