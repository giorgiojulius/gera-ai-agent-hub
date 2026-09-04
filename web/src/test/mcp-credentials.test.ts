// Phase 5.2 — decrypted credentials never outlive one request: the toolset
// strips the server objects it keeps, the session carries a lease instead of
// headers, every request leases (and drops) its credential, and provider
// output is redacted with that one-request list.
import { describe, expect, it } from "vitest";

import type { CloudMcpServer } from "../../../functions/mcp-cloud";
import {
  createCredentialLease,
  leasedCredentialFor,
  McpCredentialUnavailableError,
  stripCloudMcpCredentials,
} from "../../../functions/mcp-credentials";
import type { McpFetch } from "../../../functions/mcp-protocol";
import { resolveMcpToolset } from "../../../functions/mcp-toolset";

const TOKEN = "secret-token-123";

function server(overrides: Partial<CloudMcpServer> = {}): CloudMcpServer {
  return {
    id: "srv",
    name: "Srv",
    kind: "mcp",
    url: "https://mcp.example.com/mcp?api_key=urltoken-456",
    headers: { Authorization: `Bearer ${TOKEN}`, "X-Custom": "custom-value" },
    omitMcpHeaders: false,
    disabledTools: [],
    ...overrides,
  };
}

/** A one-tool Streamable HTTP server that echoes the caller's Authorization header inside its result. */
function fakeServer(): { fetch: McpFetch; requests: Array<{ method: string; authorization: string | null; url: string }> } {
  const requests: Array<{ method: string; authorization: string | null; url: string }> = [];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Mcp-Session-Id": "sess-1" } });
  const fetch: McpFetch = async (url, init) => {
    const headers = new Headers(init.headers);
    const frame = JSON.parse(String(init.body ?? "{}")) as { id?: number; method?: string; params?: { name?: string } };
    requests.push({ method: frame.method ?? (init.method ?? "GET"), authorization: headers.get("authorization"), url });
    if (headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return new Response("nope", { status: 401 });
    }
    switch (frame.method) {
      case "initialize":
        return json({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake" } } });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        return json({ jsonrpc: "2.0", id: frame.id, result: { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } }] } });
      case "tools/call":
        return json({
          jsonrpc: "2.0",
          id: frame.id,
          result: { content: [{ type: "text", text: `you sent Authorization=${headers.get("authorization")} and key=urltoken-456` }] },
        });
      default:
        return json({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "nope" } });
    }
  };
  return { fetch, requests };
}

describe("credential lease helpers", () => {
  it("strips every credential from the kept server copy and redacts the URL", () => {
    const stripped = stripCloudMcpCredentials(
      server({ oauth: { accessToken: "at", refreshToken: "rt", tokenEndpoint: "https://as/token", clientId: "c" }, token: "pat" }),
    );
    const text = JSON.stringify(stripped);
    expect(stripped.headers).toEqual({});
    expect(stripped.oauth).toBeUndefined();
    expect(stripped.token).toBeUndefined();
    expect(stripped.url).toBe("https://mcp.example.com/mcp?api_key=[REDACTED_CREDENTIAL]");
    for (const secret of [TOKEN, "custom-value", "at", "rt", "pat", "urltoken-456"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("builds the one-request credential: URL, headers with a Bearer from the grant, exact redactions", () => {
    const leased = leasedCredentialFor(
      server({ headers: {}, oauth: { accessToken: "at-1", tokenEndpoint: "https://as/token", clientId: "c" } }),
    );
    expect(leased.url).toBe("https://mcp.example.com/mcp?api_key=urltoken-456");
    expect(leased.headers).toEqual({ Authorization: "Bearer at-1" });
    expect(leased.redactions).toContain("at-1");
    expect(leased.redactions).toContain("urltoken-456");
  });

  it("resolver-backed leases re-resolve per request, repair with force, and fail honestly when nothing resolves", async () => {
    const calls: boolean[] = [];
    const lease = createCredentialLease(server(), {
      resolve: async (force) => {
        calls.push(force);
        return calls.length > 3 ? null : server({ headers: { Authorization: `Bearer fresh-${calls.length}` } });
      },
    });
    expect((await lease.get()).headers.Authorization).toBe("Bearer fresh-1");
    expect((await lease.get()).headers.Authorization).toBe("Bearer fresh-2");
    expect(await lease.repair()).toBe(true);
    expect(calls).toEqual([false, false, true]);
    await expect(lease.get()).rejects.toBeInstanceOf(McpCredentialUnavailableError);
    expect(await lease.repair()).toBe(false);
  });

  it("private leases keep the material in the closure and repair through the grant hook only", async () => {
    let repaired = 0;
    const withGrant = createCredentialLease(
      server({ headers: {}, oauth: { accessToken: "at", refreshToken: "rt", tokenEndpoint: "https://as/token", clientId: "c" } }),
      {
        repairGrant: async (material) => {
          repaired += 1;
          material.oauth = { ...material.oauth!, accessToken: "at-2" };
          return true;
        },
      },
    );
    expect((await withGrant.get()).headers.Authorization).toBe("Bearer at");
    expect(await withGrant.repair()).toBe(true);
    expect(repaired).toBe(1);
    expect((await withGrant.get()).headers.Authorization).toBe("Bearer at-2");
    const noRefresh = createCredentialLease(server(), { repairGrant: async () => true });
    expect(await noRefresh.repair()).toBe(false);
  });
});

describe("toolset sessions carry no credentials", () => {
  it("leases the credential per request, redacts the answer, and keeps the session and states clean", async () => {
    const remote = fakeServer();
    const toolset = await resolveMcpToolset({
      servers: [server()],
      mode: "native",
      fetch: remote.fetch,
      notificationStreams: false,
    });
    const route = toolset.routes.get("mcp_srv_echo");
    expect(route?.type).toBe("mcp");
    if (!route || route.type !== "mcp") {
      throw new Error("route missing");
    }
    const outcome = await toolset.execute("mcp_srv_echo", {});
    expect(outcome.isError).toBeUndefined();
    // The whole header value is a credential variant, so "Bearer …" goes as one.
    expect(outcome.text).toContain("Authorization=[REDACTED_CREDENTIAL]");
    expect(outcome.text).toContain("key=[REDACTED_CREDENTIAL]");
    expect(outcome.text).not.toContain(TOKEN);

    // Every request went out with the real credential …
    expect(remote.requests.map((request) => request.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    for (const request of remote.requests) {
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.url).toContain("api_key=urltoken-456");
    }
    // … while the session object itself never held it.
    const session = JSON.stringify({ ...route.session, fetch: undefined, lease: undefined });
    for (const secret of [TOKEN, "custom-value", "urltoken-456"]) {
      expect(session).not.toContain(secret);
    }
    expect(route.session.headers).toEqual({});
    expect(route.session.lease).toBeTypeOf("function");
    expect(route.session.url).toBe("https://mcp.example.com/mcp?api_key=[REDACTED_CREDENTIAL]");
    expect(JSON.stringify(toolset.servers)).not.toContain(TOKEN);
  });

  it("a credentials resolver is consulted for every request and the toolset never sees the material otherwise", async () => {
    const remote = fakeServer();
    let resolves = 0;
    const toolset = await resolveMcpToolset({
      // The arriving server object carries no usable credential — only the resolver does.
      servers: [server({ headers: {} })],
      mode: "native",
      fetch: remote.fetch,
      notificationStreams: false,
      credentials: async (serverId) => {
        resolves += 1;
        return serverId === "srv" ? server() : null;
      },
    });
    const outcome = await toolset.execute("mcp_srv_echo", {});
    expect(outcome.text).toContain("Authorization=[REDACTED_CREDENTIAL]");
    expect(resolves).toBe(remote.requests.length);
    expect(remote.requests.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("an auth rejection triggers one forced re-resolve and the retry connects", async () => {
    const remote = fakeServer();
    const forces: boolean[] = [];
    const toolset = await resolveMcpToolset({
      servers: [server({ headers: {} })],
      mode: "native",
      fetch: remote.fetch,
      notificationStreams: false,
      credentials: async (_serverId, { force }) => {
        forces.push(force);
        // Stale until repaired: the first credentials are wrong, a forced refresh fixes them.
        const repaired = forces.includes(true);
        return server({ headers: { Authorization: repaired ? `Bearer ${TOKEN}` : "Bearer stale" } });
      },
    });
    const outcome = await toolset.execute("mcp_srv_echo", {});
    expect(outcome.isError).toBeUndefined();
    expect(forces.filter(Boolean)).toHaveLength(1);
    expect(remote.requests[0].authorization).toBe("Bearer stale");
    expect(remote.requests[remote.requests.length - 1]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(toolset.servers[0].unavailable).toBeUndefined();
  });
});
