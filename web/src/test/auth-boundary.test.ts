import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Gera auth session boundary", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("EXPO_PUBLIC_RORK_AUTH_URL", "https://auth.example.com");
    vi.stubEnv("EXPO_PUBLIC_RORK_APP_KEY", "app-key");
    store = new Map<string, string>();
    const storage = {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => void store.set(key, value),
      removeItem: (key: string): void => void store.delete(key),
    };
    vi.stubGlobal("localStorage", storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("single-flights one refresh grant and stores a rotated pair", async () => {
    const auth = await import("@/lib/auth-tokens");
    store.set(auth.REFRESH_TOKEN_KEY, "refresh-a");
    let finish: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      async (): Promise<Response> =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = auth.refreshAccessToken();
    const second = auth.refreshAccessToken();
    finish?.(
      new Response(JSON.stringify({ access_token: "access-b", refresh_token: "refresh-b" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(first).resolves.toBe("access-b");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.get(auth.ACCESS_TOKEN_KEY)).toBe("access-b");
    expect(store.get(auth.REFRESH_TOKEN_KEY)).toBe("refresh-b");
  });

  it.each([
    ["rotating refresh token", "refresh-b"],
    ["stable refresh token", "refresh-a"],
  ])(
    "reuses one refreshed access generation for delayed relay 401s (%s)",
    async (_label, nextRefreshToken) => {
      const auth = await import("@/lib/auth-tokens");
      const { relayFetch } = await import("@/lib/backend");
      store.set(auth.ACCESS_TOKEN_KEY, "access-a");
      store.set(auth.REFRESH_TOKEN_KEY, "refresh-a");

      let staleRelayCalls = 0;
      let refreshCalls = 0;
      let releaseSecondStale: ((response: Response) => void) | undefined;
      const gated401 = (): Response =>
        new Response(JSON.stringify({ error: "sign_in_required" }), {
          status: 401,
          headers: { "X-Gera-Relay-Auth": "required" },
        });
      const fetchMock = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          if (String(input).includes("/oauth/refresh")) {
            refreshCalls += 1;
            return new Response(
              JSON.stringify({ access_token: "access-b", refresh_token: nextRefreshToken }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          const authorization = new Headers(init?.headers).get("Authorization");
          if (authorization === "Bearer access-a") {
            staleRelayCalls += 1;
            if (staleRelayCalls === 1) {
              return gated401();
            }
            return new Promise<Response>((resolve) => {
              releaseSecondStale = resolve;
            });
          }
          if (authorization === "Bearer access-b") {
            return new Response("ok", { status: 200 });
          }
          return gated401();
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      const first = relayFetch("/mcp-proxy", "https://one.example.com/mcp");
      const delayed = relayFetch("/mcp-proxy", "https://two.example.com/mcp");
      await expect(first).resolves.toMatchObject({ status: 200 });
      expect(releaseSecondStale).toBeTypeOf("function");
      releaseSecondStale?.(gated401());
      await expect(delayed).resolves.toMatchObject({ status: 200 });

      expect(refreshCalls).toBe(1);
      expect(store.get(auth.ACCESS_TOKEN_KEY)).toBe("access-b");
      expect(store.get(auth.REFRESH_TOKEN_KEY)).toBe(nextRefreshToken);
    },
  );

  it("classifies deploy/network refresh gaps without deleting the stored session", async () => {
    const auth = await import("@/lib/auth-tokens");
    store.set(auth.ACCESS_TOKEN_KEY, "expired-access");
    store.set(auth.REFRESH_TOKEN_KEY, "refresh-a");
    vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => {
      throw new TypeError("deployment connection reset");
    }));

    await expect(auth.refreshAccessTokenResult()).resolves.toEqual({ status: "unavailable" });
    expect(store.get(auth.ACCESS_TOKEN_KEY)).toBe("expired-access");
    expect(store.get(auth.REFRESH_TOKEN_KEY)).toBe("refresh-a");
  });

  it("treats auth 5xx as retryable but an explicit invalid_grant as rejected", async () => {
    const auth = await import("@/lib/auth-tokens");
    store.set(auth.ACCESS_TOKEN_KEY, "expired-access");
    store.set(auth.REFRESH_TOKEN_KEY, "refresh-a");
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "server_error" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(auth.refreshAccessTokenResult()).resolves.toEqual({ status: "unavailable" });
    await expect(auth.refreshAccessTokenResult()).resolves.toEqual({ status: "rejected" });
    expect(store.get(auth.REFRESH_TOKEN_KEY)).toBe("refresh-a");
  });

  it("adopts the rotated pair another tab saved for the same session", async () => {
    const auth = await import("@/lib/auth-tokens");
    store.set(auth.ACCESS_TOKEN_KEY, "access-a");
    store.set(auth.REFRESH_TOKEN_KEY, "refresh-a");
    let finish: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (): Promise<Response> =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );

    const pending = auth.refreshAccessToken();
    await Promise.resolve();
    store.set(auth.ACCESS_TOKEN_KEY, "sibling-access");
    store.set(auth.REFRESH_TOKEN_KEY, "sibling-refresh");
    finish?.(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));

    await expect(pending).resolves.toBe("sibling-access");
    expect(store.get(auth.ACCESS_TOKEN_KEY)).toBe("sibling-access");
    expect(store.get(auth.REFRESH_TOKEN_KEY)).toBe("sibling-refresh");
  });

  it("never retries an account A payload with account B after a session swap", async () => {
    const auth = await import("@/lib/auth-tokens");
    const { authedFetchForSession } = await import("@/lib/backend");
    store.set(auth.ACCESS_TOKEN_KEY, "access-a");
    store.set(auth.REFRESH_TOKEN_KEY, "refresh-a");
    const session = auth.authSessionSnapshot();
    let finish: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      async (): Promise<Response> =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = authedFetchForSession("/chats/sync", session, {
      method: "POST",
      body: JSON.stringify({ profile: "account-a" }),
    });
    await Promise.resolve();
    auth.invalidateAuthSession();
    store.set(auth.ACCESS_TOKEN_KEY, "access-b");
    store.set(auth.REFRESH_TOKEN_KEY, "refresh-b");
    finish?.(new Response(null, { status: 401 }));

    await expect(pending).rejects.toThrow(/account changed/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cannot restore account A after logout or account B replaces its nonce", async () => {
    const auth = await import("@/lib/auth-tokens");
    store.set(auth.ACCESS_TOKEN_KEY, "access-a");
    store.set(auth.REFRESH_TOKEN_KEY, "refresh-a");
    let finish: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (): Promise<Response> =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );

    const pending = auth.refreshAccessToken();
    await Promise.resolve();
    auth.invalidateAuthSession();
    store.set(auth.ACCESS_TOKEN_KEY, "access-b");
    store.set(auth.REFRESH_TOKEN_KEY, "refresh-b");
    finish?.(
      new Response(JSON.stringify({ access_token: "late-a", refresh_token: "late-refresh-a" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(pending).resolves.toBeNull();
    expect(store.get(auth.ACCESS_TOKEN_KEY)).toBe("access-b");
    expect(store.get(auth.REFRESH_TOKEN_KEY)).toBe("refresh-b");
  });
});
