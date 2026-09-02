import { describe, expect, test } from "vitest";

import { resolveAuthUrl } from "@/lib/auth-tokens";

const WORKER = "https://gera-ai-agent-hub-backend.rork.app";

describe("resolveAuthUrl", () => {
  test("regular origins talk to Rork Auth directly", () => {
    expect(resolveAuthUrl("https://api.rork.com", "https://gera.rork.live", WORKER)).toBe("https://api.rork.com");
    expect(resolveAuthUrl("https://api.rork.com/", "http://localhost:5173", WORKER)).toBe("https://api.rork.com");
    expect(resolveAuthUrl("https://api.rork.com", null, WORKER)).toBe("https://api.rork.com");
  });

  test("an opaque-origin document (sandboxed preview) goes through the Worker relay", () => {
    expect(resolveAuthUrl("https://api.rork.com", "null", WORKER)).toBe(`${WORKER}/auth-relay`);
    expect(resolveAuthUrl("https://api.rork.com", "null", `${WORKER}/`)).toBe(`${WORKER}/auth-relay`);
  });

  test("a build without the auth variables stays unconfigured so the guard can say so", () => {
    expect(resolveAuthUrl("", "null", WORKER)).toBe("");
    expect(resolveAuthUrl("   ", "https://gera.rork.live", WORKER)).toBe("");
  });
});
