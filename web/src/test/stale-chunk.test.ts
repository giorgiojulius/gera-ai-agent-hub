import { describe, expect, it } from "vitest";

import { RELOAD_LOOP_WINDOW_MS, isStaleChunkError, shouldAutoReload } from "@/lib/stale-chunk";

describe("isStaleChunkError", () => {
  it("matches chunk-load failures across browsers", () => {
    expect(
      isStaleChunkError(
        new TypeError(
          "Failed to fetch dynamically imported module: https://gera-ai-agent-hub.rork.app/assets/timeline-definition-24CTP7MA-DX6ytgVD.js",
        ),
      ),
    ).toBe(true);
    expect(isStaleChunkError(new Error("error loading dynamically imported module"))).toBe(true);
    expect(isStaleChunkError("Importing a module script failed.")).toBe(true);
    expect(isStaleChunkError(new Error("Unable to preload CSS for /assets/a.css"))).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isStaleChunkError(new Error("Syntax error in text mermaid version 11"))).toBe(false);
    expect(isStaleChunkError(undefined)).toBe(false);
    expect(isStaleChunkError(404)).toBe(false);
    expect(isStaleChunkError("")).toBe(false);
  });
});

describe("shouldAutoReload", () => {
  it("allows the first reload and blocks a rapid second one", () => {
    const now = 1_700_000_000_000;
    expect(shouldAutoReload(0, now)).toBe(true);
    expect(shouldAutoReload(now - 1_000, now)).toBe(false);
    expect(shouldAutoReload(now - RELOAD_LOOP_WINDOW_MS + 1, now)).toBe(false);
    expect(shouldAutoReload(now - RELOAD_LOOP_WINDOW_MS, now)).toBe(true);
  });
});
