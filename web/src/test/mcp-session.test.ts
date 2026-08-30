import { describe, expect, it } from "vitest";

import { normalizeStoredSettings } from "@/lib/history";
import { isSessionLostRpcMessage, isSessionLostSignal } from "@/lib/mcp";
import type { McpServerConfig } from "@/lib/types";

function storedServer(overrides: Partial<McpServerConfig>): McpServerConfig {
  return {
    id: "srv",
    name: "Server",
    url: "https://example.com/mcp",
    headersJson: "",
    enabled: true,
    status: "idle",
    tools: [],
    disabledTools: [],
    ...overrides,
  };
}

describe("session-lost detection", () => {
  it("treats 404 with an established session as idle expiry", () => {
    expect(isSessionLostSignal(404, "", true)).toBe(true);
    expect(isSessionLostSignal(400, "Mcp-Session-Id invalid or expired", true)).toBe(true);
  });

  it("never fires before a session id was issued — a 404 then means wrong URL", () => {
    expect(isSessionLostSignal(404, "", false)).toBe(false);
    expect(isSessionLostSignal(400, "session missing", false)).toBe(false);
  });

  it("ignores unrelated failures", () => {
    expect(isSessionLostSignal(500, "boom", true)).toBe(false);
    expect(isSessionLostSignal(400, "bad params", true)).toBe(false);
    expect(isSessionLostSignal(401, "unauthorized", true)).toBe(false);
  });

  it("recognizes JSON-RPC session-expiry phrasings, and only those", () => {
    expect(isSessionLostRpcMessage("Session not found", true)).toBe(true);
    expect(isSessionLostRpcMessage("session expired", true)).toBe(true);
    expect(isSessionLostRpcMessage("Invalid session ID", true)).toBe(true);
    expect(isSessionLostRpcMessage("Session terminated by server", true)).toBe(true);
    // Tool-level errors that merely mention a session must not trigger a replay.
    expect(isSessionLostRpcMessage("no active browser session for tab", true)).toBe(false);
    expect(isSessionLostRpcMessage("rate limit exceeded", true)).toBe(false);
    // Without an issued session id there is nothing to have lost.
    expect(isSessionLostRpcMessage("Session not found", false)).toBe(false);
  });
});

describe("MCP connection persistence — connect once and forget", () => {
  it("keeps verified servers connected across reloads, with proof intact", () => {
    const settings = normalizeStoredSettings({
      mcpServers: [
        storedServer({
          status: "connected",
          identity: "Notion MCP v1.2",
          verifiedAt: 123,
          tools: [{ name: "search" }],
        }),
      ],
    });
    expect(settings.mcpServers[0]?.status).toBe("connected");
    expect(settings.mcpServers[0]?.identity).toBe("Notion MCP v1.2");
    expect(settings.mcpServers[0]?.verifiedAt).toBe(123);
    expect(settings.mcpServers[0]?.tools.map((tool) => tool.name)).toEqual(["search"]);
  });

  it("resets interrupted connects to idle and keeps honest error states", () => {
    const settings = normalizeStoredSettings({
      mcpServers: [
        storedServer({ id: "mid", status: "connecting" }),
        storedServer({ id: "bad", status: "error", error: "Sign-in expired." }),
      ],
    });
    expect(settings.mcpServers[0]?.status).toBe("idle");
    expect(settings.mcpServers[0]?.error).toBeUndefined();
    expect(settings.mcpServers[1]?.status).toBe("error");
    expect(settings.mcpServers[1]?.error).toBe("Sign-in expired.");
  });

  it("drops junk identity/verifiedAt values from foreign blobs", () => {
    const settings = normalizeStoredSettings({
      mcpServers: [
        storedServer({
          status: "connected",
          identity: 42 as unknown as string,
          verifiedAt: "yesterday" as unknown as number,
          tools: [{ name: "search" }],
        }),
      ],
    });
    expect(settings.mcpServers[0]?.status).toBe("connected");
    expect(settings.mcpServers[0]?.identity).toBeUndefined();
    expect(settings.mcpServers[0]?.verifiedAt).toBeUndefined();
  });
});
