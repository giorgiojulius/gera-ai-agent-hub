// The browser holds no MCP grant anymore. Legacy keys older bundles left
// behind are purged on boot and never read for authentication; an explicit
// disconnect is the only action that revokes the server-owned grant — an
// expired or missing browser copy must never do so (older bundles auto-POSTed
// /mcp/oauth-clear on local expiry and destroyed fresh sign-ins).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authedFetch = vi.fn(
  async (..._args: unknown[]) => ({ ok: true, json: async () => ({}) }),
);

vi.mock("@/lib/backend", () => ({
  authedFetch: (...args: unknown[]) => authedFetch(...args),
  authedFetchForSession: (...args: unknown[]) => authedFetch(...args),
}));

const TOKENS_KEY = "gera.mcp.oauth.tokens.v1";
const CLIENTS_KEY = "gera.mcp.oauth.clients.v1";

describe("browser-held MCP grants (web/src/lib/mcp-oauth)", () => {
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

  function seedLegacyGrant(id: string, expired: boolean = true): void {
    const token = {
      accessToken: "gho_legacy",
      refreshToken: "ghr_legacy",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      clientId: "client-1",
      expiresAt: expired ? Date.now() - 60_000 : Date.now() + 60_000,
    };
    store.set(TOKENS_KEY, JSON.stringify({ [id]: token }));
    store.set(`gera.mcp.oauth.token.v2.${encodeURIComponent(id)}`, JSON.stringify(token));
  }

  it("purges every legacy grant and client registration, reports the ids, and never writes them back", async () => {
    seedLegacyGrant("github", false);
    seedLegacyGrant("linear");
    store.set("gera.mcp.oauth.token.v2.deleted", "null");
    store.set(CLIENTS_KEY, JSON.stringify({ "https://auth.example/register": { clientId: "c" } }));
    store.set("gera.mcp.oauth.flow.v1.github", "attempt-1");
    const { purgeLegacyOAuthStorage } = await import("@/lib/mcp-oauth");

    const purged = purgeLegacyOAuthStorage();
    expect(purged.found).toBe(true);
    expect([...purged.serverIds].sort()).toEqual(["github", "linear"]);
    expect([...store.keys()].filter((key) => key.startsWith("gera.mcp.oauth.token"))).toEqual([]);
    expect(store.has(CLIENTS_KEY)).toBe(false);
    // Non-secret flow markers are not grants and stay untouched.
    expect(store.get("gera.mcp.oauth.flow.v1.github")).toBe("attempt-1");

    // A second boot finds nothing — and the purge itself never revoked anything server-side.
    expect(purgeLegacyOAuthStorage()).toEqual({ found: false, serverIds: [] });
    const clearCalls = authedFetch.mock.calls.filter(
      (call) => typeof call[0] === "string" && (call[0] as string).includes("/mcp/oauth-clear"),
    );
    expect(clearCalls).toHaveLength(0);
    expect(JSON.stringify([...store.entries()])).not.toContain("gho_legacy");
    expect(JSON.stringify([...store.entries()])).not.toContain("ghr_legacy");
  });

  it("exposes no API that reads or writes a browser grant", async () => {
    const oauth = (await import("@/lib/mcp-oauth")) as Record<string, unknown>;
    for (const gone of [
      "hasOAuthToken",
      "hasOAuthRefreshToken",
      "oauthAuthHeader",
      "forceRefreshOAuthHeader",
      "exportOAuthTokens",
      "adoptProfileOAuthTokens",
      "applyServerOAuthRotations",
      "storeExternalOAuthToken",
      "storeOAuthTokenOnServer",
      "migrateLegacyOAuthTokensToServer",
      "dropLocalOAuthToken",
    ]) {
      expect(oauth[gone], gone).toBeUndefined();
    }
  });

  it("explicit disconnect revokes server-side with an explicit reason", async () => {
    const { clearOAuthToken } = await import("@/lib/mcp-oauth");
    clearOAuthToken("github", "github");
    const clearCall = authedFetch.mock.calls.find(
      (call) => typeof call[0] === "string" && (call[0] as string).includes("/mcp/oauth-clear"),
    );
    expect(clearCall).toBeDefined();
    const init = clearCall?.[1] as { body?: string } | undefined;
    const body = JSON.parse(init?.body ?? "{}") as { reason?: string; serverId?: string; catalogId?: string };
    expect(body).toEqual({ serverId: "github", reason: "disconnect", catalogId: "github" });
  });
});
