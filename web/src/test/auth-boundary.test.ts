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
    expect(second).toBe(first);
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
