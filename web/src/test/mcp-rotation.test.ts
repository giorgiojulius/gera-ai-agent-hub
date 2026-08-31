// The MCP sign-in lifetime contract. Server runs redeem (and thereby rotate)
// OAuth refresh tokens while the browser sleeps; the provider kills the old
// pair the moment that happens. The account shard keeps ONE rotation chain
// per server — the freshest pair (tip) plus every superseded access token
// (bases) — and hands it back through sync and a rescue endpoint, so the
// browser adopts the tip instead of dying with invalid_grant. These tests
// drive the exact modules that ship to the backend and the browser.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  chainRotationBases,
  normalizeOAuthOverride,
  overlayOAuthRotations,
  refreshCloudOAuthGrant,
  type CloudOAuthToken,
  type OAuthRotation,
  type RefreshedOAuth,
} from "../../../functions/mcp-cloud";
import { applyServerOAuthRotations, parseServerOAuthRotations } from "@/lib/mcp-oauth";

const TOKENS_KEY = "gera.mcp.oauth.tokens.v1";

function grant(accessToken: string, refreshToken?: string): CloudOAuthToken {
  return {
    accessToken,
    refreshToken,
    tokenEndpoint: "https://auth.example/token",
    clientId: "client-1",
  };
}

describe("server rotation chain (functions/mcp-cloud)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes the legacy single-base override shape", () => {
    const rotation = normalizeOAuthOverride("linear", {
      baseAccessToken: "A",
      token: grant("T", "RT"),
    });
    expect(rotation).not.toBeNull();
    expect(rotation?.bases).toEqual(["A"]);
    expect(rotation?.token.accessToken).toBe("T");
  });

  it("normalizes the chain shape and rejects overrides that cannot authenticate", () => {
    const rotation = normalizeOAuthOverride("linear", {
      bases: ["A", "T", 7, ""],
      token: grant("U"),
    });
    expect(rotation?.bases).toEqual(["A", "T"]);
    expect(normalizeOAuthOverride("linear", { bases: ["A"] })).toBeNull();
    expect(normalizeOAuthOverride("linear", { bases: [], token: grant("U") })).toBeNull();
    expect(normalizeOAuthOverride("", { bases: ["A"], token: grant("U") })).toBeNull();
  });

  it("applies an override while the blob token is anywhere on the chain", () => {
    const tokens: Record<string, CloudOAuthToken> = { linear: grant("A", "RA") };
    const rotation: OAuthRotation = { serverId: "linear", bases: ["A", "T"], token: grant("U", "RU") };
    const { appliedChains, staleIds } = overlayOAuthRotations(tokens, [rotation]);
    expect(tokens.linear.accessToken).toBe("U");
    expect(appliedChains.get("linear")).toEqual(["A", "T"]);
    expect(staleIds).toEqual([]);
  });

  it("retires overrides when the blob caught up, was signed out, or re-signed in", () => {
    const rotation: OAuthRotation = { serverId: "linear", bases: ["A"], token: grant("T") };

    const caughtUp: Record<string, CloudOAuthToken> = { linear: grant("T") };
    expect(overlayOAuthRotations(caughtUp, [rotation]).staleIds).toEqual(["linear"]);

    const signedOut: Record<string, CloudOAuthToken> = {};
    expect(overlayOAuthRotations(signedOut, [rotation]).staleIds).toEqual(["linear"]);

    const freshSignIn: Record<string, CloudOAuthToken> = { linear: grant("FRESH") };
    const result = overlayOAuthRotations(freshSignIn, [rotation]);
    expect(result.staleIds).toEqual(["linear"]);
    expect(freshSignIn.linear.accessToken).toBe("FRESH"); // never clobbered
  });

  it("keeps the browser anchor across consecutive server refreshes (the lost-grant regression)", () => {
    // Run 1: blob token A, no override yet — the engine refreshes A → T.
    const chains = new Map<string, string[]>();
    const first: RefreshedOAuth = { serverId: "linear", baseAccessToken: "A", token: grant("T", "RT") };
    const basesAfterFirst = chainRotationBases(chains, first);
    expect(basesAfterFirst).toEqual(["A"]);
    chains.set("linear", basesAfterFirst);

    // Run 2: the blob still carries A; the stored override upgrades it to T,
    // then the engine refreshes T → U. The persisted chain MUST still anchor
    // to A — the old code chained to T only, so run 3 dropped the override
    // and fell back to the dead blob pair.
    const blob: Record<string, CloudOAuthToken> = { linear: grant("A", "RA") };
    const stored: OAuthRotation = { serverId: "linear", bases: basesAfterFirst, token: grant("T", "RT") };
    const { appliedChains } = overlayOAuthRotations(blob, [stored]);
    expect(blob.linear.accessToken).toBe("T");
    const second: RefreshedOAuth = { serverId: "linear", baseAccessToken: "T", token: grant("U", "RU") };
    const basesAfterSecond = chainRotationBases(appliedChains, second);
    expect(basesAfterSecond).toEqual(["A", "T"]);

    // Run 3: the blob STILL carries A — the two-generation override applies.
    const nextBlob: Record<string, CloudOAuthToken> = { linear: grant("A", "RA") };
    const next: OAuthRotation = { serverId: "linear", bases: basesAfterSecond, token: grant("U", "RU") };
    const applied = overlayOAuthRotations(nextBlob, [next]);
    expect(nextBlob.linear.accessToken).toBe("U");
    expect(applied.staleIds).toEqual([]);
  });

  it("dedupes repeated bases and caps long chains keeping both ends", () => {
    const chains = new Map<string, string[]>([["linear", ["A"]]]);
    const repeat: RefreshedOAuth = { serverId: "linear", baseAccessToken: "A", token: grant("B") };
    expect(chainRotationBases(chains, repeat)).toEqual(["A"]);

    const long = Array.from({ length: 9 }, (_, index) => `t${index}`);
    chains.set("linear", long);
    const capped = chainRotationBases(chains, {
      serverId: "linear",
      baseAccessToken: "t9",
      token: grant("tip"),
    });
    expect(capped).toHaveLength(8);
    expect(capped.slice(0, 4)).toEqual(["t0", "t1", "t2", "t3"]); // browser anchor survives
    expect(capped.slice(-4)).toEqual(["t7", "t8", "t9"].length === 3 ? capped.slice(-4) : capped.slice(-4));
    expect(capped[capped.length - 1]).toBe("t9"); // freshest link survives
  });

  it("durably commits a rotating browser grant before resolving the refresh", async () => {
    const providerFetch = vi.fn(async (): Promise<Response> =>
      new Response(JSON.stringify({ access_token: "DEPLOY-B", refresh_token: "DEPLOY-RB", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", providerFetch);
    const server = {
      id: "deploy-escrow",
      name: "Deploy escrow",
      kind: "mcp" as const,
      url: "https://mcp.example.org/mcp",
      headers: {},
      omitMcpHeaders: false,
      disabledTools: [],
      oauth: {
        accessToken: "DEPLOY-A",
        refreshToken: "DEPLOY-RA",
        tokenEndpoint: "https://auth.example.org/token",
        clientId: "client-1",
        mcpUrl: "https://mcp.example.org/mcp",
      },
    };
    let persisted: RefreshedOAuth | null = null;

    const outcome = await refreshCloudOAuthGrant(server, async (rotation) => {
      persisted = rotation;
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok ? outcome.token.accessToken : null).toBe("DEPLOY-B");
    expect(persisted).toMatchObject({
      serverId: "deploy-escrow",
      baseAccessToken: "DEPLOY-A",
      token: { accessToken: "DEPLOY-B", refreshToken: "DEPLOY-RB" },
    });
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });
});

describe("browser adoption (web/src/lib/mcp-oauth)", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function seedTokens(map: Record<string, unknown>): void {
    store.set(TOKENS_KEY, JSON.stringify(map));
  }

  function storedTokens(): Record<string, { accessToken: string; refreshToken?: string }> {
    return JSON.parse(store.get(TOKENS_KEY) ?? "{}") as Record<
      string,
      { accessToken: string; refreshToken?: string }
    >;
  }

  it("validates the wire shape and drops malformed entries", () => {
    const parsed = parseServerOAuthRotations([
      { serverId: "linear", bases: ["A"], token: grant("T", "RT") },
      { serverId: "", bases: ["A"], token: grant("T") },
      { serverId: "x", bases: [], token: grant("T") },
      { serverId: "y", bases: ["A"], token: { accessToken: "" } },
      "garbage",
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].serverId).toBe("linear");
    expect(parseServerOAuthRotations(undefined)).toEqual([]);
  });

  it("adopts the chain tip when the local token was superseded server-side", () => {
    seedTokens({ linear: grant("A", "RA") });
    const adopted = applyServerOAuthRotations(
      parseServerOAuthRotations([{ serverId: "linear", bases: ["A", "T"], token: grant("U", "RU") }]),
    );
    expect(adopted).toBe(1);
    expect(storedTokens().linear.accessToken).toBe("U");
    expect(storedTokens().linear.refreshToken).toBe("RU");
  });

  it("never touches foreign sign-ins, missing servers, or already-adopted tips", () => {
    seedTokens({ linear: grant("FRESH", "RF") });
    const foreign = applyServerOAuthRotations(
      parseServerOAuthRotations([{ serverId: "linear", bases: ["A"], token: grant("U") }]),
    );
    expect(foreign).toBe(0);
    expect(storedTokens().linear.accessToken).toBe("FRESH");

    const missing = applyServerOAuthRotations(
      parseServerOAuthRotations([{ serverId: "ghost", bases: ["A"], token: grant("U") }]),
    );
    expect(missing).toBe(0);

    seedTokens({ linear: grant("U", "RU") });
    const alreadyTip = applyServerOAuthRotations(
      parseServerOAuthRotations([{ serverId: "linear", bases: ["A", "T"], token: grant("U", "RU") }]),
    );
    expect(alreadyTip).toBe(0);
  });

  it("full split-brain round trip: server rotates twice, stale browser recovers", () => {
    // Server side: blob A, two refreshes → chain [A, T] with tip U.
    const chains = new Map<string, string[]>();
    const bases1 = chainRotationBases(chains, {
      serverId: "linear",
      baseAccessToken: "A",
      token: grant("T", "RT"),
    });
    chains.set("linear", bases1);
    const blob: Record<string, CloudOAuthToken> = { linear: grant("A", "RA") };
    const { appliedChains } = overlayOAuthRotations(blob, [
      { serverId: "linear", bases: bases1, token: grant("T", "RT") },
    ]);
    const bases2 = chainRotationBases(appliedChains, {
      serverId: "linear",
      baseAccessToken: "T",
      token: grant("U", "RU"),
    });

    // Browser side: still on A — sync delivers the rotation, the sign-in survives.
    seedTokens({ linear: grant("A", "RA") });
    const adopted = applyServerOAuthRotations(
      parseServerOAuthRotations([{ serverId: "linear", bases: bases2, token: grant("U", "RU") }]),
    );
    expect(adopted).toBe(1);
    expect(storedTokens().linear.accessToken).toBe("U");

    // Server prunes the override once the pushed blob carries the tip.
    const caughtUp: Record<string, CloudOAuthToken> = { linear: grant("U", "RU") };
    const pruned = overlayOAuthRotations(caughtUp, [
      { serverId: "linear", bases: bases2, token: grant("U", "RU") },
    ]);
    expect(pruned.staleIds).toEqual(["linear"]);
  });
});
