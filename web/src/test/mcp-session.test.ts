import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isRecoverableMcpHealthError,
  mcpCredentialProblem,
  revalidateMcpServers,
} from "@/lib/agent-store";
import { parseProfilePayload } from "@/lib/chat-sync";
import { normalizeStoredSettings } from "@/lib/history";
import { isSessionLostRpcMessage, isSessionLostSignal, mcpCheckServerPayload } from "@/lib/mcp";
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
  it("keeps health-check payloads small even after a server listed huge tool schemas", () => {
    const server = storedServer({
      id: "large-server",
      status: "connected",
      credentialStored: true,
      disabledTools: ["mutate"],
      tools: Array.from({ length: 200 }, (_, index) => ({
        name: `tool_${index}`,
        description: "x".repeat(1_000),
        inputSchema: { type: "object", properties: { payload: { type: "string", description: "y".repeat(1_000) } } },
      })),
    });

    const payload = mcpCheckServerPayload(server);
    expect(JSON.stringify(payload).length).toBeLessThan(1_000);
    expect(payload).not.toHaveProperty("tools");
    expect(payload).not.toHaveProperty("disabledTools");
    expect(payload.credentialStored).toBe(true);
  });

  it("does not invent a missing server credential flag for legacy profiles", () => {
    const legacy = normalizeStoredSettings({ mcpServers: [storedServer({ status: "connected" })] });
    expect(legacy.mcpServers[0]?.credentialStored).toBeUndefined();
    expect(mcpCheckServerPayload(legacy.mcpServers[0])).not.toHaveProperty("credentialStored");
  });

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

  it("keeps a green GitHub card armed when the browser has no local grant", () => {
    const github = storedServer({
      id: "github",
      catalogId: "github",
      name: "GitHub",
      status: "connected",
      verifiedAt: Date.now(),
      tools: [{ name: "get_contents" }],
    });
    expect(mcpCredentialProblem(github)).toBeNull();

    let settings: AgentSettings = normalizeStoredSettings({ mcpServers: [github] });
    revalidateMcpServers(settings.mcpServers, (updater) => {
      settings = updater(settings);
    });
    expect(settings.mcpServers[0]?.status).toBe("connected");
    expect(settings.mcpServers[0]?.error).toBeUndefined();
  });

  it("treats a poisoned local-credential error as recoverable", () => {
    expect(isRecoverableMcpHealthError("GitHub sign-in is missing — sign in again or paste a PAT.")).toBe(true);
  });

  it("does not treat a real missing API key as a transient health blip", () => {
    expect(isRecoverableMcpHealthError("This server needs an API key.")).toBe(false);
    expect(isRecoverableMcpHealthError("Bearer token is missing.")).toBe(false);
    expect(isRecoverableMcpHealthError("Authorize this server again.")).toBe(false);
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

  it("keeps a connected MCP armed when background revalidation hits a transient relay outage", async () => {
    let settings: AgentSettings = normalizeStoredSettings({
      mcpServers: [
        storedServer({
          id: "transient-health",
          authMode: "none",
          status: "connected",
          verifiedAt: 1,
          tools: [{ name: "search" }],
        }),
      ],
    });
    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    revalidateMcpServers(
      settings.mcpServers,
      (updater) => {
        settings = updater(settings);
      },
      new Set(["transient-health"]),
    );

    // Background checks no longer disarm every cloud/browser MCP as "connecting".
    expect(settings.mcpServers[0]?.status).toBe("connected");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settings.mcpServers[0]?.status).toBe("connected");
    expect(settings.mcpServers[0]?.error).toBeUndefined();
  });

  it("self-heals a persisted shared-relay error once the MCP answers again", async () => {
    let settings: AgentSettings = normalizeStoredSettings({
      mcpServers: [
        storedServer({
          id: "relay-recovery",
          authMode: "none",
          status: "error",
          error: "Could not reach the Gera relay. Check your connection and try again.",
          tools: [{ name: "search" }],
        }),
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> =>
        new Response(
          JSON.stringify({ tools: [{ name: "search" }], identity: "Recovered MCP v1" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    expect(isRecoverableMcpHealthError(settings.mcpServers[0]?.error)).toBe(true);
    revalidateMcpServers(settings.mcpServers, (updater) => {
      settings = updater(settings);
    });
    // Retry eligibility is not verification: the old error clears only on success.
    expect(settings.mcpServers[0]?.status).toBe("error");
    await vi.waitFor(() => expect(settings.mcpServers[0]?.identity).toBe("Recovered MCP v1"));
    expect(settings.mcpServers[0]?.status).toBe("connected");
    expect(settings.mcpServers[0]?.error).toBeUndefined();
  });

  it("keeps every connector armed when the Gera account gate asks for sign-in", async () => {
    let settings: AgentSettings = normalizeStoredSettings({
      mcpServers: [
        storedServer({
          id: "account-gated-a",
          name: "TesterArmy",
          authMode: "none",
          status: "connected",
          verifiedAt: 1,
          tools: [{ name: "search" }],
        }),
        storedServer({
          id: "account-gated-b",
          name: "Second server",
          authMode: "none",
          status: "connected",
          verifiedAt: 1,
          tools: [{ name: "read" }],
        }),
      ],
    });
    const fetchMock = vi.fn(async (): Promise<Response> =>
      new Response(JSON.stringify({ error: "sign_in_required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    revalidateMcpServers(
      settings.mcpServers,
      (updater) => {
        settings = updater(settings);
      },
      new Set(["account-gated-a", "account-gated-b"]),
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settings.mcpServers.map((server) => server.status)).toEqual(["connected", "connected"]);
    expect(settings.mcpServers.map((server) => server.error)).toEqual([undefined, undefined]);

    revalidateMcpServers(
      settings.mcpServers,
      (updater) => {
        settings = updater(settings);
      },
      new Set(["account-gated-a", "account-gated-b"]),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(settings.mcpServers.map((server) => server.status)).toEqual(["connected", "connected"]);
  });

  it("still disconnects only the provider whose credential is definitively rejected", async () => {
    let settings: AgentSettings = normalizeStoredSettings({
      mcpServers: [
        storedServer({
          id: "provider-auth-dead",
          authMode: "none",
          status: "connected",
          verifiedAt: 1,
          tools: [{ name: "search" }],
        }),
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> =>
        new Response(JSON.stringify({ error: "This server needs a key or sign-in." }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    revalidateMcpServers(
      settings.mcpServers,
      (updater) => {
        settings = updater(settings);
      },
      new Set(["provider-auth-dead"]),
    );
    await vi.waitFor(() => expect(settings.mcpServers[0]?.status).toBe("error"));
    expect(settings.mcpServers[0]?.error).toContain("needs a key or sign-in");
  });
});
