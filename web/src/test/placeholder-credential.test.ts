// The browser marks "credential lives on the server" with a `gera-account:`
// sentinel instead of a real token. If that marker is ever persisted as a
// manual secret it shadows the actual OAuth grant on every provider call —
// GitHub escalates repeated bad-credential attempts to HTTP 403, which users
// see as "Could not verify the server-owned GitHub sign-in". The shard must
// never store or serve it.
import { describe, expect, it } from "vitest";

import { isPlaceholderCredential } from "../../../functions/chat-shared";

describe("isPlaceholderCredential", () => {
  it("flags the bare browser sentinel", () => {
    expect(isPlaceholderCredential("gera-account:github")).toBe(true);
    expect(isPlaceholderCredential("gera-account:")).toBe(true);
    expect(isPlaceholderCredential("  gera-account:mcp-123  ")).toBe(true);
  });

  it("flags the Bearer-prefixed sentinel the auth path produces", () => {
    expect(isPlaceholderCredential("Bearer gera-account:github")).toBe(true);
    expect(isPlaceholderCredential("bearer gera-account:github")).toBe(true);
  });

  it("keeps real credentials untouched", () => {
    expect(isPlaceholderCredential("ghp_realPersonalAccessToken123")).toBe(false);
    expect(isPlaceholderCredential("Bearer gho_deviceFlowToken456")).toBe(false);
    expect(isPlaceholderCredential("github_pat_fineGrained789")).toBe(false);
    expect(isPlaceholderCredential("")).toBe(false);
  });
});
