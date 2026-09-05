import { afterEach, describe, expect, it, vi } from "vitest";

import { shardFailureReason } from "../../../functions/chat-shared";
import { invalidateAuthSession } from "@/lib/auth-tokens";
import { AuthSessionChangedError } from "@/lib/backend";
import { isRecoverableMcpHealthError } from "@/lib/agent-store";
import { diagnosticContextOf } from "@/lib/diagnostic-context";
import { McpAuthError, connectMcpServer, describeMcpCheckFailure } from "@/lib/mcp";
import type { McpServerConfig } from "@/lib/types";

function testerArmy(): McpServerConfig {
  return {
    id: "testerarmy",
    catalogId: "testerarmy",
    name: "TesterArmy",
    url: "https://tester.army/mcp",
    enabled: true,
    status: "connected",
    authMode: "oauth",
    headersJson: "",
    disabledTools: [],
    tools: [],
    credentialStored: true,
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The exact body the Worker mints when its call into the account shard throws. */
const SHARD_RESET = { error: "account_shard_unavailable", reason: "redeploy", transient: true, retryable: true };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shardFailureReason", () => {
  it("recognises a deploy reset and an overloaded object; everything else is internal", () => {
    expect(shardFailureReason(new Error("Durable Object reset because its code was updated."))).toBe("redeploy");
    expect(shardFailureReason(new Error("Durable Object is overloaded. Requests queued for too long."))).toBe(
      "overloaded",
    );
    expect(shardFailureReason(new Error("Network connection lost."))).toBe("internal");
    expect(shardFailureReason("boom")).toBe("internal");
    expect(shardFailureReason(undefined)).toBe("internal");
  });
});

describe("describeMcpCheckFailure", () => {
  it("blames Gera's backend, not the MCP server, for a failed shard call", () => {
    expect(describeMcpCheckFailure("account_shard_unavailable", { reason: "redeploy" })).toBe(
      "Gera's backend was updating while checking this server — a temporary blip; it will retry automatically.",
    );
    expect(describeMcpCheckFailure("account_shard_unavailable", { reason: "overloaded" })).toContain("was busy");
    expect(describeMcpCheckFailure("account_shard_unavailable", {})).toContain("hit an internal error");
    expect(describeMcpCheckFailure("upstream_unreachable", {})).toBe(
      "The MCP server did not answer — it may be down or unreachable.",
    );
    expect(describeMcpCheckFailure("mcp_check_failed", { detail: "stale OAuth refresh result" })).toBe(
      "The server check temporarily failed inside Gera: stale OAuth refresh result — it will retry automatically.",
    );
    expect(isRecoverableMcpHealthError(describeMcpCheckFailure("mcp_check_failed", {}))).toBe(true);
    expect(isRecoverableMcpHealthError(describeMcpCheckFailure("identity_unavailable", {}))).toBe(true);
    expect(describeMcpCheckFailure("identity_unavailable", {})).toContain("saved connections are unchanged");
    expect(describeMcpCheckFailure("server_auth_missing", {})).toBeNull();
  });

  it("keeps every backend-side wording inside the recoverable health-error class", () => {
    for (const reason of ["redeploy", "overloaded", undefined]) {
      expect(isRecoverableMcpHealthError(describeMcpCheckFailure("account_shard_unavailable", { reason }))).toBe(true);
    }
  });
});

describe("/mcp/check when Gera's own backend fails", () => {
  it.each([false, true])("retries an identity-registry reset with legacy/current retry metadata (%s)", async (hasFlag) => {
    const fetchMock = vi.fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ error: "identity_unavailable", ...(hasFlag ? { retryable: true } : {}) }, 503))
      .mockResolvedValueOnce(jsonResponse({ tools: [{ name: "list_teams" }], credentialStored: true }, 200));
    vi.stubGlobal("fetch", fetchMock);
    const connection = await connectMcpServer(testerArmy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(connection.credentialStored).toBe(true);
  });

  it("never replays the old credential body after an account switch during the retry pause", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    });
    const fetchMock = vi.fn(async () => {
      setTimeout(() => invalidateAuthSession(), 0);
      return jsonResponse({ error: "identity_unavailable", retryable: true }, 503);
    });
    vi.stubGlobal("fetch", fetchMock);
    const caught: unknown = await connectMcpServer({ ...testerArmy(), token: "fixture-old-account-key" }).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AuthSessionChangedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not reinterpret an identity conflict as a retryable outage", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "principal_conflict" }, 409));
    vi.stubGlobal("fetch", fetchMock);
    await expect(connectMcpServer(testerArmy())).rejects.toThrow("principal_conflict");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isRecoverableMcpHealthError("principal_conflict")).toBe(false);
  });
  it("retries once when the Worker flags the failure as retryable and returns the healthy answer", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(SHARD_RESET, 502))
      .mockResolvedValueOnce(
        jsonResponse(
          { tools: [{ name: "list_runs" }], identity: "TesterArmy · server verified", credentialStored: true },
          200,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const connection = await connectMcpServer(testerArmy());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(connection.tools.map((tool) => tool.name)).toEqual(["list_runs"]);
    expect(connection.identity).toBe("TesterArmy · server verified");
    expect(connection.credentialStored).toBe(true);
  });

  it("names Gera's backend when the shard call failed twice, and never as a provider or auth problem", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => jsonResponse(SHARD_RESET, 502));
    vi.stubGlobal("fetch", fetchMock);

    const caught: unknown = await connectMcpServer(testerArmy()).catch((error: unknown) => error);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(McpAuthError);
    const message = (caught as Error).message;
    expect(message).toContain("Gera's backend was updating");
    expect(message).not.toMatch(/unreachable|upstream|down/i);
    expect(isRecoverableMcpHealthError(message)).toBe(true);
    expect(diagnosticContextOf(caught)).toMatchObject({
      path: "POST /mcp/check",
      status: 502,
      code: "account_shard_unavailable",
      reason: "redeploy",
      attempts: 2,
      serverId: "testerarmy",
    });
  });

  it("does not retry a verdict the shard actually reached about the provider", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> =>
      jsonResponse({ error: 'Could not connect MCP server "TesterArmy": HTTP 503' }, 502),
    );
    vi.stubGlobal("fetch", fetchMock);

    const caught: unknown = await connectMcpServer(testerArmy()).catch((error: unknown) => error);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((caught as Error).message).toBe('Could not connect MCP server "TesterArmy": HTTP 503');
    expect(diagnosticContextOf(caught)).toMatchObject({ attempts: 1 });
  });

  it("reports a fault inside the check in plain words — a refresh race is not a revoked sign-in", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> =>
      jsonResponse({ error: "mcp_check_failed", detail: "stale OAuth refresh result", retryable: true }, 502),
    );
    vi.stubGlobal("fetch", fetchMock);

    const caught: unknown = await connectMcpServer(testerArmy()).catch((error: unknown) => error);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(McpAuthError);
    expect((caught as Error).message).toBe("The server check temporarily failed inside Gera: stale OAuth refresh result — it will retry automatically.");
  });
});
