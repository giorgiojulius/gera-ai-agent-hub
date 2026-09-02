import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StorageModule = typeof import("../../../functions/knowledge-storage");

const creds = {
  accessKeyId: "AKIA",
  secretAccessKey: "secret",
  sessionToken: "token",
  bucket: "rork-storage-p1",
  endpoint: "https://acct.r2.cloudflarestorage.com",
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A fake Rork network: each host answers the credentials POST its own way. */
function fakeNetwork(hosts: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    calls.push(url.host);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(url.pathname).toBe("/api/storage/temp-credentials");
    const answer = hosts[url.host];
    if (!answer) {
      throw new TypeError("fetch failed");
    }
    return answer();
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

// Module globals (credential cache, resolved host) are part of what is under
// test, so every case gets a fresh module instance.
async function freshModule(): Promise<StorageModule> {
  vi.resetModules();
  return import("../../../functions/knowledge-storage");
}

describe("rork storage credentials", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("orders candidate API hosts, drops duplicates and malformed values, and always ends at api.rork.com", async () => {
    const mod = await freshModule();
    expect(
      mod.rorkStorageApiCandidates({
        EXPO_PUBLIC_RORK_API_BASE_URL: "https://dev-p1.rorktest.dev/",
        EXPO_PUBLIC_RORK_AUTH_URL: "https://api.rork.com",
        RORK_AUTH_URL: "https://api.rork.com/",
      }),
    ).toEqual(["https://dev-p1.rorktest.dev", "https://api.rork.com"]);
    expect(mod.rorkStorageApiCandidates({ EXPO_PUBLIC_RORK_API_BASE_URL: "not a url" })).toEqual(["https://api.rork.com"]);
    expect(mod.rorkStorageApiCandidates({})).toEqual(["https://api.rork.com"]);
  });

  it("falls through a dev host that answers 404 HTML and a base that redirects, and mints from the real API", async () => {
    const mod = await freshModule();
    const calls = fakeNetwork({
      "dev-p1.rorktest.dev": () => new Response("<html>Site Not Found</html>", { status: 404 }),
      "rork.app": () => new Response(null, { status: 301, headers: { Location: "https://rork.com/x" } }),
      "api.rork.com": () => jsonResponse(creds, 200),
    });
    const env = {
      EXPO_PUBLIC_RORK_API_BASE_URL: "https://dev-p1.rorktest.dev",
      EXPO_PUBLIC_RORK_AUTH_URL: "https://rork.app",
      EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY: "tk",
    };
    await expect(mod.getRorkStorageCredentials(env)).resolves.toEqual(creds);
    expect(calls).toEqual(["dev-p1.rorktest.dev", "rork.app", "api.rork.com"]);

    // The winning host is remembered and the credential is cached — a probe
    // needs no further network round-trip and never leaks key material.
    const probe = await mod.probeRorkStorage(env);
    expect(probe).toEqual({ ok: true, bucket: creds.bucket, apiHost: "api.rork.com", expiresAt: creds.expiresAt });
    expect(JSON.stringify(probe)).not.toContain("token");
    expect(calls).toHaveLength(3);
  });

  it("treats a JSON 403 from the API as the final answer and names the reason", async () => {
    const mod = await freshModule();
    const calls = fakeNetwork({
      "api.rork.com": () => jsonResponse({ error: "storage_not_enabled" }, 403),
    });
    await expect(mod.getRorkStorageCredentials({ EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY: "tk" })).rejects.toThrow(
      "storage_unavailable:403 storage_not_enabled",
    );
    expect(calls).toEqual(["api.rork.com"]);
  });

  it("keeps looking past a 401 that is not the Rork API's JSON shape", async () => {
    const mod = await freshModule();
    const calls = fakeNetwork({
      "gateway.example": () => new Response("Unauthorized", { status: 401 }),
      "api.rork.com": () => jsonResponse(creds, 200),
    });
    await expect(
      mod.getRorkStorageCredentials({
        EXPO_PUBLIC_RORK_API_BASE_URL: "https://gateway.example",
        EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY: "tk",
      }),
    ).resolves.toEqual(creds);
    expect(calls).toEqual(["gateway.example", "api.rork.com"]);
  });

  it("maps quota to storage_quota and reports every dead host when nothing answers", async () => {
    const quota = await freshModule();
    fakeNetwork({ "api.rork.com": () => jsonResponse({ error: "over_quota" }, 429) });
    await expect(quota.getRorkStorageCredentials({ EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY: "tk" })).rejects.toThrow(
      "storage_quota",
    );

    const dead = await freshModule();
    fakeNetwork({ "api.rork.com": () => new Response("oops", { status: 502 }) });
    const probe = await dead.probeRorkStorage({
      EXPO_PUBLIC_RORK_API_BASE_URL: "https://down.example",
      EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY: "tk",
    });
    expect(probe).toEqual({ ok: false, error: "storage_unavailable:down.example unreachable; api.rork.com 502" });
  });

  it("refuses to call anywhere without a toolkit secret", async () => {
    const mod = await freshModule();
    const calls = fakeNetwork({ "api.rork.com": () => jsonResponse(creds, 200) });
    await expect(mod.getRorkStorageCredentials({})).rejects.toThrow("storage_unavailable:no_toolkit_secret");
    expect(calls).toEqual([]);
  });
});
