// The "works for a day, then asks to sign in again" failure lives in the
// OAuth layer, not the MCP protocol: a refresh token that was never granted
// (missing offline_access), a refresh race that clobbers the winning pair,
// or a dead cached client registration. These tests pin the client-side
// defense for each mechanism.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  composeAuthScope,
  forceRefreshOAuthHeader,
  isClientRegistrationUsable,
} from "@/lib/mcp-oauth";

const TOKENS_KEY = "gera.mcp.oauth.tokens.v1";

type StubResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

describe("refresh survival (web/src/lib/mcp-oauth)", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    vi.stubGlobal("window", { localStorage: storage });
    vi.stubGlobal("localStorage", storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function seedToken(id: string, accessToken: string, refreshToken: string): void {
    const map = JSON.parse(store.get(TOKENS_KEY) ?? "{}") as Record<string, unknown>;
    map[id] = {
      accessToken,
      refreshToken,
      tokenEndpoint: "https://auth.example/token",
      clientId: "client-1",
      // Long expired so forceRefresh has a reason to redeem.
      expiresAt: 1,
    };
    store.set(TOKENS_KEY, JSON.stringify(map));
  }

  function storedToken(id: string): { accessToken: string; refreshToken?: string } | undefined {
    const map = JSON.parse(store.get(TOKENS_KEY) ?? "{}") as Record<
      string,
      { accessToken: string; refreshToken?: string }
    >;
    return map[id];
  }

  function stubFetch(onTokenRequest: () => StubResponse): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown): Promise<StubResponse> => {
        const url = String(input);
        if (url.includes("oauth-proxy")) {
          return onTokenRequest();
        }
        // The rotation-rescue endpoint: 403 keeps authedFetch from retrying.
        return { ok: false, status: 403, json: async () => ({}) };
      }),
    );
  }

  it("adopts the pair another tab rotated in instead of clobbering it (invalid_grant race)", async () => {
    seedToken("race", "A", "RA");
    stubFetch(() => {
      // While this refresh was in flight, a sibling tab redeemed RA first and
      // stored the winning pair — our own redeem answers invalid_grant.
      seedToken("race", "U", "RU");
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid_grant", error_description: "token already used" }),
      };
    });

    const header = await forceRefreshOAuthHeader("race");
    expect(header).toBe("Bearer U");
    expect(storedToken("race")?.accessToken).toBe("U");
    expect(storedToken("race")?.refreshToken).toBe("RU");
  });

  it("drops the sign-in only when the failed pair is still the stored one", async () => {
    seedToken("dead", "A", "RA");
    stubFetch(() => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_grant" }),
    }));

    const header = await forceRefreshOAuthHeader("dead");
    expect(header).toBeNull();
    expect(storedToken("dead")).toBeUndefined();
  });

  it("keeps the stored pair on transient refresh failures", async () => {
    seedToken("transient", "A", "RA");
    stubFetch(() => ({
      ok: false,
      status: 502,
      json: async () => ({ error: "temporarily_unavailable" }),
    }));

    const header = await forceRefreshOAuthHeader("transient");
    expect(header).toBeNull();
    expect(storedToken("transient")?.accessToken).toBe("A");
    expect(storedToken("transient")?.refreshToken).toBe("RA");
  });

  it("stores the rotated pair on a successful refresh", async () => {
    seedToken("happy", "A", "RA");
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "B", refresh_token: "RB", expires_in: 3600 }),
    }));

    const header = await forceRefreshOAuthHeader("happy");
    expect(header).toBe("Bearer B");
    expect(storedToken("happy")?.accessToken).toBe("B");
    expect(storedToken("happy")?.refreshToken).toBe("RB");
  });
});

describe("composeAuthScope", () => {
  it("appends offline_access when the AS offers it and the resource list omits it", () => {
    expect(composeAuthScope(["read", "write"], ["read", "write", "offline_access"])).toBe(
      "read write offline_access",
    );
    expect(composeAuthScope([], ["read", "offline_access"])).toBe("offline_access");
  });

  it("never duplicates or invents offline_access", () => {
    expect(composeAuthScope(["read", "offline_access"], ["offline_access"])).toBe(
      "read offline_access",
    );
    expect(composeAuthScope(["read"], ["read"])).toBe("read");
  });

  it("falls back to server scopes and to no scope at all", () => {
    expect(composeAuthScope(undefined, ["a", "b"])).toBe("a b");
    expect(composeAuthScope(undefined, undefined)).toBeUndefined();
    expect(composeAuthScope([], undefined)).toBeUndefined();
  });
});

describe("isClientRegistrationUsable", () => {
  const now = 1_000_000_000_000;
  const uri = "https://app.example/oauth/callback";

  it("accepts a matching registration that has not expired or never expires", () => {
    expect(isClientRegistrationUsable({ clientId: "c", redirectUri: uri }, uri, now)).toBe(true);
    expect(
      isClientRegistrationUsable(
        { clientId: "c", redirectUri: uri, expiresAt: now + 3_600_000 },
        uri,
        now,
      ),
    ).toBe(true);
    expect(
      isClientRegistrationUsable({ clientId: "c", redirectUri: uri, expiresAt: 0 }, uri, now),
    ).toBe(true);
  });

  it("rejects missing, mismatched, expired, or nearly expired registrations", () => {
    expect(isClientRegistrationUsable(undefined, uri, now)).toBe(false);
    expect(
      isClientRegistrationUsable({ clientId: "c", redirectUri: "https://old.example/cb" }, uri, now),
    ).toBe(false);
    expect(
      isClientRegistrationUsable({ clientId: "c", redirectUri: uri, expiresAt: now - 1 }, uri, now),
    ).toBe(false);
    // Inside the 60s clock-skew window counts as expired.
    expect(
      isClientRegistrationUsable({ clientId: "c", redirectUri: uri, expiresAt: now + 30_000 }, uri, now),
    ).toBe(false);
  });
});
