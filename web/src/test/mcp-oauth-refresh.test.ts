// The "works for a day, then asks to sign in again" failure lives in the
// OAuth layer, not the MCP protocol: a refresh token that was never granted
// (missing offline_access), a refresh race that clobbers the winning pair,
// or a dead cached client registration. These tests pin the client-side
// defense for each mechanism.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { invalidateAuthSession } from "@/lib/auth-tokens";
import {
  OAUTH_TOKENS_CHANGED_EVENT,
  adoptProfileOAuthTokens,
  beginOAuthGrantFlow,
  composeAuthScope,
  exportOAuthTokens,
  forceRefreshOAuthHeader,
  hasOAuthToken,
  isClientRegistrationUsable,
  invalidateOAuthOperations,
  oauthAuthHeader,
  oauthResultStorageKey,
  storeExternalOAuthToken,
} from "@/lib/mcp-oauth";

const TOKENS_KEY = "gera.mcp.oauth.tokens.v1";

type StubResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

describe("refresh survival (web/src/lib/mcp-oauth)", () => {
  let store: Map<string, string>;
  let dispatchEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = new Map<string, string>();
    dispatchEvent = vi.fn();
    const storage = {
      get length(): number {
        return store.size;
      },
      key: (index: number): string | null => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    vi.stubGlobal("window", { localStorage: storage, dispatchEvent });
    vi.stubGlobal("localStorage", storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function seedToken(id: string, accessToken: string, refreshToken: string): void {
    const map = JSON.parse(store.get(TOKENS_KEY) ?? "{}") as Record<string, unknown>;
    const token = {
      accessToken,
      refreshToken,
      tokenEndpoint: "https://auth.example/token",
      clientId: "client-1",
      // Long expired so forceRefresh has a reason to redeem.
      expiresAt: 1,
    };
    map[id] = token;
    store.set(TOKENS_KEY, JSON.stringify(map));
    store.set(`gera.mcp.oauth.token.v2.${encodeURIComponent(id)}`, JSON.stringify(token));
  }

  function clearStoredOAuth(): void {
    for (const key of [...store.keys()]) {
      if (key.startsWith("gera.mcp.oauth.")) {
        store.delete(key);
      }
    }
  }

  function storedToken(id: string): { accessToken: string; refreshToken?: string } | undefined {
    const map = JSON.parse(store.get(TOKENS_KEY) ?? "{}") as Record<
      string,
      { accessToken: string; refreshToken?: string }
    >;
    return map[id];
  }

  function brokerToken(accessToken: string, refreshToken?: string): Record<string, unknown> {
    return {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + 3_600_000,
      tokenEndpoint: "https://auth.example/token",
      clientId: "client-1",
    };
  }

  function stubFetch(onTokenRequest: () => StubResponse): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown): Promise<StubResponse> => {
        const url = String(input);
        if (url.includes("/mcp/oauth-refresh")) {
          const provider = onTokenRequest();
          const data = (await provider.json()) as {
            access_token?: unknown;
            refresh_token?: unknown;
          };
          if (provider.ok && typeof data.access_token === "string") {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                token: brokerToken(
                  data.access_token as string,
                  typeof data.refresh_token === "string" ? data.refresh_token : undefined,
                ),
              }),
            };
          }
          return { ...provider, json: async () => data };
        }
        // A completed durable lookup confirms this fatal pair has no newer tip.
        return { ok: true, status: 200, json: async () => ({ rotations: [] }) };
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

  it("cannot repopulate an old account after another tab replaces the auth session", async () => {
    seedToken("logout-race", "A", "RA");
    let finish: ((response: StubResponse) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (): Promise<StubResponse> =>
          new Promise<StubResponse>((resolve) => {
            finish = resolve;
          }),
      ),
    );

    const pending = forceRefreshOAuthHeader("logout-race");
    await Promise.resolve();
    invalidateAuthSession();
    clearStoredOAuth();
    finish?.({
      ok: true,
      status: 200,
      json: async () => ({ token: brokerToken("OLD-ACCOUNT", "OLD-REFRESH") }),
    });

    await expect(pending).resolves.toBeNull();
    expect(storedToken("logout-race")).toBeUndefined();
  });

  it("cannot commit a delayed server-rotation rescue after logout", async () => {
    seedToken("rescue-race", "A", "RA");
    let finishRescue: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        if (String(input).includes("/mcp/oauth-refresh")) {
          return new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Promise<Response>((resolve) => {
          finishRescue = resolve;
        });
      }),
    );

    const pending = forceRefreshOAuthHeader("rescue-race");
    for (let turn = 0; turn < 20 && !finishRescue; turn += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(finishRescue).toBeTypeOf("function");
    invalidateAuthSession();
    clearStoredOAuth();
    finishRescue?.(
      new Response(
        JSON.stringify({
          rotations: [
            {
              serverId: "rescue-race",
              bases: ["A"],
              token: {
                accessToken: "SERVER-NEW",
                refreshToken: "SERVER-REFRESH",
                tokenEndpoint: "https://auth.example/token",
                clientId: "client-1",
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(pending).resolves.toBeNull();
    expect(storedToken("rescue-race")).toBeUndefined();
  });

  it("rejects a late external/device token across the persistent account boundary", () => {
    const flow = beginOAuthGrantFlow("github");
    invalidateAuthSession();
    const stored = storeExternalOAuthToken(
      "github",
      {
        accessToken: "old-account-token",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        clientId: "client",
      },
      flow,
    );
    expect(stored).toBe(false);
    expect(storedToken("github")).toBeUndefined();
  });

  it("lets only the newest sign-in attempt replace a server grant", () => {
    const oldFlow = beginOAuthGrantFlow("same-server");
    const newFlow = beginOAuthGrantFlow("same-server");
    const oldStored = storeExternalOAuthToken(
      "same-server",
      { accessToken: "old", tokenEndpoint: "https://auth.example/token", clientId: "client-1" },
      oldFlow,
    );
    const newStored = storeExternalOAuthToken(
      "same-server",
      { accessToken: "new", tokenEndpoint: "https://auth.example/token", clientId: "client-1" },
      newFlow,
    );
    expect(oldStored).toBe(false);
    expect(newStored).toBe(true);
    expect(storedToken("same-server")?.accessToken).toBe("new");
  });

  it("keeps unrelated grants in independent per-server storage", () => {
    const firstFlow = beginOAuthGrantFlow("first");
    const secondFlow = beginOAuthGrantFlow("second");
    storeExternalOAuthToken(
      "first",
      { accessToken: "one", tokenEndpoint: "https://auth.example/token", clientId: "client-1" },
      firstFlow,
    );
    storeExternalOAuthToken(
      "second",
      { accessToken: "two", tokenEndpoint: "https://auth.example/token", clientId: "client-1" },
      secondFlow,
    );
    // Simulate a stale tab clobbering only the legacy compatibility mirror.
    store.set(TOKENS_KEY, JSON.stringify({ second: storedToken("second") }));
    expect(Object.keys(exportOAuthTokens()).sort()).toEqual(["first", "second"]);
  });

  it("isolates popup callback storage by OAuth state", () => {
    expect(oauthResultStorageKey("state-a")).not.toBe(oauthResultStorageKey("state-b"));
  });

  it("does not overwrite a fresh sign-in when an older successful refresh lands late", async () => {
    seedToken("success-race", "A", "RA");
    stubFetch(() => {
      seedToken("success-race", "FRESH", "RFRESH");
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "STALE-B", refresh_token: "STALE-RB", expires_in: 3600 }),
      };
    });

    const header = await forceRefreshOAuthHeader("success-race");
    expect(header).toBe("Bearer FRESH");
    expect(storedToken("success-race")?.accessToken).toBe("FRESH");
    expect(storedToken("success-race")?.refreshToken).toBe("RFRESH");
  });

  it("rescues GitHub's bad_refresh_token spelling from the server rotation chain", async () => {
    seedToken("github", "A", "RA");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        if (String(input).includes("/mcp/oauth-refresh")) {
          return new Response(JSON.stringify({ error: "bad_refresh_token" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            rotations: [
              {
                serverId: "github",
                bases: ["A"],
                token: {
                  accessToken: "SERVER-NEW",
                  refreshToken: "SERVER-REFRESH",
                  tokenEndpoint: "https://auth.example/token",
                  clientId: "client-1",
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    await expect(forceRefreshOAuthHeader("github")).resolves.toBe("Bearer SERVER-NEW");
    expect(storedToken("github")?.refreshToken).toBe("SERVER-REFRESH");
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

  it("keeps a fatal-looking pair when rotation lookup is unavailable during deploy", async () => {
    seedToken("deploy-gap", "A", "RA");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        if (String(input).includes("/mcp/oauth-refresh")) {
          return new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "upstream_unreachable" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    await expect(forceRefreshOAuthHeader("deploy-gap")).resolves.toBeNull();
    expect(storedToken("deploy-gap")?.accessToken).toBe("A");
    expect(storedToken("deploy-gap")?.refreshToken).toBe("RA");
  });

  it("adopts the escrowed pair after a deploy loses the first browser response", async () => {
    seedToken("deploy-replay", "A", "RA");
    const durableTip = brokerToken("B", "RB");
    let attempts = 0;
    let firstInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (!String(input).includes("/mcp/oauth-refresh")) {
          return new Response(JSON.stringify({ rotations: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        attempts += 1;
        if (attempts === 1) {
          firstInit = init;
          // The account shard already committed B/RB, but the old bundle was
          // replaced before its fetch promise received the response.
          throw new TypeError("page unloaded during deploy");
        }
        return new Response(JSON.stringify({ token: durableTip, replayed: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    await expect(forceRefreshOAuthHeader("deploy-replay")).resolves.toBeNull();
    expect(storedToken("deploy-replay")?.accessToken).toBe("A");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(forceRefreshOAuthHeader("deploy-replay")).resolves.toBe("Bearer B");
    expect(storedToken("deploy-replay")?.refreshToken).toBe("RB");
    expect(firstInit?.keepalive).toBe(true);
    expect(JSON.parse(String(firstInit?.body))).toMatchObject({ serverId: "deploy-replay" });
  });

  it("stores the rotated pair on a successful refresh and wakes profile sync", async () => {
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
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect((dispatchEvent.mock.calls[0]?.[0] as Event | undefined)?.type).toBe(OAUTH_TOKENS_CHANGED_EVENT);
  });

  it("adopts grants from a newer synced profile instead of keeping a green card without auth", () => {
    seedToken("local-only", "L", "RL");
    const adopted = adoptProfileOAuthTokens({
      github: {
        accessToken: "G",
        refreshToken: "RG",
        expiresAt: Date.now() + 3_600_000,
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        clientId: "github-client",
      },
      malformed: { accessToken: "secret-without-client-metadata" },
    });

    expect(adopted).toBe(1);
    expect(storedToken("github")?.accessToken).toBe("G");
    expect(storedToken("github")?.refreshToken).toBe("RG");
    expect(storedToken("local-only")?.accessToken).toBe("L");
    expect(storedToken("malformed")).toBeUndefined();
    expect(dispatchEvent).not.toHaveBeenCalled(); // remote apply must not echo as a local edit
  });

  it("does not advertise or send a known-expired access token with no refresh grant", async () => {
    const map = {
      dead: {
        accessToken: "A",
        expiresAt: Date.now() - 1,
        tokenEndpoint: "https://auth.example/token",
        clientId: "client-1",
      },
    };
    store.set(TOKENS_KEY, JSON.stringify(map));

    expect(hasOAuthToken("dead")).toBe(false);
    await expect(oauthAuthHeader("dead")).resolves.toBeNull();
    expect(storedToken("dead")).toBeUndefined();
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
