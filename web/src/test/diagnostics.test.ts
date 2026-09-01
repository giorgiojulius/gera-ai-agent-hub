import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  listDiagnostics,
  logDiagnostic,
  resetDiagnosticsForTests,
  unseenDiagnosticsCount,
} from "@/lib/diagnostics";

describe("diagnostics journal", () => {
  beforeEach(() => {
    resetDiagnosticsForTests();
  });

  afterEach(() => {
    resetDiagnosticsForTests();
    vi.unstubAllGlobals();
  });

  it("records a surfaced error", () => {
    logDiagnostic("chat", "The run failed on the server", "model timeout");
    const entries = listDiagnostics();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.scope).toBe("chat");
    expect(entries[0]?.message).toBe("The run failed on the server");
    expect(entries[0]?.detail).toBe("model timeout");
    expect(unseenDiagnosticsCount()).toBe(1);
  });

  it("skips user aborts and known browser noise", () => {
    logDiagnostic("chat", new DOMException("Stopped.", "AbortError"));
    logDiagnostic("app", "ResizeObserver loop limit exceeded");
    logDiagnostic("promise", "Script error.");
    expect(listDiagnostics()).toHaveLength(0);
  });

  it("collapses identical bursts", () => {
    logDiagnostic("mcp", "GitHub disconnected");
    logDiagnostic("mcp", "GitHub disconnected");
    expect(listDiagnostics()).toHaveLength(1);
  });

  it("keeps distinct scopes and messages", () => {
    logDiagnostic("chat", "The run failed on the server");
    logDiagnostic("mcp", "This server needs a key or sign-in.");
    expect(listDiagnostics().map((entry) => entry.scope)).toEqual(["mcp", "chat"]);
  });
});
