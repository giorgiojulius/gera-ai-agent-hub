// OAuth grants live only in the account vault; the browser drives the
// server-side flow and keeps nothing but non-secret markers. What remains
// testable here are the pure scope/registration helpers the flow shares.
import { describe, expect, it } from "vitest";

import { composeAuthScope, isClientRegistrationUsable } from "@/lib/mcp-oauth";

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
