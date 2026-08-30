import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mcpCredentialProblem, revalidateMcpServers } from "@/lib/agent-store";
import { parseProfilePayload } from "@/lib/chat-sync";
import { normalizeStoredSettings } from "@/lib/history";
import { isSessionLostRpcMessage, isSessionLostSignal } from "@/lib/mcp";
import { adoptProfileOAuthTokens } from "@/lib/mcp-oauth";
import type { AgentSettings, McpServerConfig } from "@/lib/types";

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
  it("replays only the spec-defined HTTP 404 session-expiry signal", () => {
    expect(isSessionLostSignal(404, "", true)).toBe(true);
    expect(isSessionLostSignal(400, "Mcp-Session-Id invalid or expired", true)).toBe(false);
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
  it("keeps the OAuth half of a synced profile available to the caller", () => {
    const oauth = {
      github: {
        accessToken: "credential",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        clientId: "client",
      },
    };
    const parsed = parseProfilePayload(JSON.stringify({ settings: {}, life: {}, mcpOAuth: oauth }));
    expect(parsed?.mcpOAuth).toEqual(oauth);
  });

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

describe("honest MCP auth status", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    vi.stubGlobal("window", { localStorage: storage, dispatchEvent: vi.fn() });
    vi.stubGlobal("localStorage", storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a fresh-looking green GitHub card when its credential is absent", () => {
    const github = storedServer({
      id: "github",
      catalogId: "github",
      name: "GitHub",
      status: "connected",
      verifiedAt: Date.now(),
      tools: [{ name: "get_contents" }],
    });
    expect(mcpCredentialProblem(github)).toContain("sign-in is missing");

    let settings: AgentSettings = normalizeStoredSettings({ mcpServers: [github] });
    revalidateMcpServers(settings.mcpServers, (updater) => {
      settings = updater(settings);
    });
    expect(settings.mcpServers[0]?.status).toBe("error");
    expect(settings.mcpServers[0]?.verifiedAt).toBeUndefined();
    expect(settings.mcpServers[0]?.error).toContain("sign in again");
  });

  it("accepts the same card once the synced OAuth grant has been adopted", () => {
    const adopted = adoptProfileOAuthTokens({
      github: {
        accessToken: "credential",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        clientId: "client",
      },
    });
    const github = storedServer({
      id: "github-instance",
      catalogId: "github",
      name: "GitHub",
      status: "connected",
      verifiedAt: Date.now(),
      tools: [{ name: "get_contents" }],
    });

    expect(adopted).toBe(1);
    expect(mcpCredentialProblem(github)).toBeNull();
  });
});
