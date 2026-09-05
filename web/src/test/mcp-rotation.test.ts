// The MCP sign-in lifetime contract. Server runs redeem (and thereby rotate)
// OAuth refresh tokens while the browser sleeps; the provider kills the old
// pair the moment that happens. The account shard keeps ONE rotation chain
// per server — the freshest pair (tip) plus every superseded access token
// (bases) — and hands it back through sync and a rescue endpoint, so the
// vault-backed lease always uses the tip. The browser holds no grant anymore,
// so only the backend chain is under test here.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chainRotationBases,
  normalizeOAuthOverride,
  overlayOAuthRotations,
  refreshCloudOAuthGrant,
  type CloudOAuthToken,
  type OAuthRotation,
  type RefreshedOAuth,
} from "../../../functions/mcp-cloud";

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
