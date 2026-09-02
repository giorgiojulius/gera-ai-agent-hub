import { describe, expect, test } from "vitest";

import { documentOriginOf, resolveAuthUrl } from "@/lib/auth-tokens";

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

describe("documentOriginOf", () => {
  test("reads the document origin, which is \"null\" in a sandbox even though the URL origin stays https", () => {
    // Exactly the shape a sandboxed Repo Preview presents: an opaque document
    // origin behind a perfectly ordinary https URL. `location.origin` alone
    // would have hidden the sandbox and sent sign-in straight into a CORS wall.
    expect(documentOriginOf({ origin: "null", location: { origin: WORKER } })).toBe("null");
  });

  test("a regular document reports its own origin", () => {
    expect(documentOriginOf({ origin: "https://gera.rork.live", location: { origin: "https://gera.rork.live" } })).toBe(
      "https://gera.rork.live",
    );
  });

  test("falls back to the URL origin without self.origin, and to null without a window", () => {
    expect(documentOriginOf({ location: { origin: "http://localhost:5173" } })).toBe("http://localhost:5173");
    expect(documentOriginOf({})).toBeNull();
    expect(documentOriginOf(undefined)).toBeNull();
  });

  test("a throwing accessor never breaks module evaluation", () => {
    const hostile = {
      get origin(): string {
        throw new Error("blocked");
      },
    };
    expect(documentOriginOf(hostile)).toBeNull();
  });
});
