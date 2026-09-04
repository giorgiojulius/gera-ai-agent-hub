/**
 * Phase 3 — OAuth parity: pinned scopes in the authorize URL, `offline_access`
 * only when the authorization server declares it, the metadata-URL override
 * (used, https-only, issuer-checked), the scope order without a pin
 * (challenge → resource → authorization server), and the `insufficient_scope`
 * step-up: the toolset parks the server for the rest of the run, records the
 * demanded scopes, and the next sign-in asks for pin ∪ granted ∪ required.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bearerChallenge,
  classifyMcpAuthRejection,
  mergeScopes,
  parseScopeString,
  parseWwwAuthenticate,
} from "../../../functions/mcp-auth-challenge";
import { blockedCloudServerFailures, type CloudMcpServer, type CloudOAuthRefreshFailure } from "../../../functions/mcp-cloud";
import { buildAuthorizationUrl, discoverMcpOAuth, issuerFromMetadataUrl } from "../../../functions/mcp-oauth-flow";
import {
  pendingStepUp,
  planAuthorizationScopes,
  readOAuthScopes,
  recordGrantedScopes,
  recordRequestedScopes,
  recordRequiredScopes,
} from "../../../functions/mcp-oauth-scopes";
import type { McpFetch } from "../../../functions/mcp-protocol";
import { handleMcpOAuthStart, type McpRouteContext } from "../../../functions/mcp-routes";
import {
  createMemoryMcpCatalogStore,
  MCP_CALL_TOOL_NAME,
  MCP_SEARCH_TOOL_NAME,
  resolveMcpToolset,
} from "../../../functions/mcp-toolset";

// ---------------------------------------------------------------------------
// Fixtures

const MCP_URL = "https://mcp.scoped-provider.dev/mcp";
const AUTH_ORIGIN = "https://auth.scoped-provider.dev";

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
}

type ProviderOptions = {
  /** `scopes_supported` on the authorization server (undefined = not published). */
  serverScopes?: string[];
  /** `scopes_supported` on the protected resource (undefined = not published). */
  resourceScopes?: string[];
  /** WWW-Authenticate the MCP endpoint answers to the unauthenticated probe (undefined = 404). */
  challenge?: string;
  /** Extra metadata document served at this exact URL (the override). */
  overrideDocument?: { url: string; body: Record<string, unknown> };
  /** Skip the well-known authorization-server documents (override must be used). */
  hideWellKnown?: boolean;
};

/** A provider that publishes PRM + AS metadata and a registration endpoint. */
function stubProvider(options: ProviderOptions = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const href = `${url.origin}${url.pathname}`;
    if (href === MCP_URL) {
      if ((init?.method ?? "GET") === "POST" && options.challenge) {
        return new Response("", { status: 401, headers: { "WWW-Authenticate": options.challenge } });
      }
      return json({ error: "not found" }, 404);
    }
    if (url.hostname === "mcp.scoped-provider.dev" && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json({
        resource: MCP_URL,
        authorization_servers: [AUTH_ORIGIN],
        ...(options.resourceScopes ? { scopes_supported: options.resourceScopes } : {}),
      });
    }
    const metadata = {
      issuer: AUTH_ORIGIN,
      authorization_endpoint: `${AUTH_ORIGIN}/authorize`,
      token_endpoint: `${AUTH_ORIGIN}/token`,
      registration_endpoint: `${AUTH_ORIGIN}/register`,
      code_challenge_methods_supported: ["S256"],
      ...(options.serverScopes ? { scopes_supported: options.serverScopes } : {}),
    };
    if (options.overrideDocument && href === options.overrideDocument.url) {
      return json(options.overrideDocument.body);
    }
    if (!options.hideWellKnown && url.origin === AUTH_ORIGIN && url.pathname.startsWith("/.well-known/")) {
      return json(metadata);
    }
    if (href === `${AUTH_ORIGIN}/register`) {
      return json({ client_id: "client-scoped" });
    }
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestedUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
}

/**
 * Just enough of the account shard's SQL for the OAuth-start route and the
 * scope bookkeeping: three tables keyed the way the real statements key them.
 */
function fakeShardSql(): McpRouteContext["sql"] & { pending: Map<string, Record<string, unknown>> } {
  type ScopeRow = { requested: string; granted: string; required: string; step_up_code: string; updated_at: number };
  const scopes = new Map<string, ScopeRow>();
  const clients = new Map<string, { client_id: string; expires_at: number }>();
  const pending = new Map<string, Record<string, unknown>>();
  const key = (...parts: unknown[]): string => parts.map(String).join("\u0000");
  const cursor = <T>(rows: T[]) => ({ toArray: () => rows });
  const sql = {
    pending,
    exec(query: string, ...params: unknown[]) {
      const text = query.replace(/\s+/g, " ").trim();
      if (/FROM mcp_oauth_scopes/.test(text) && text.startsWith("SELECT")) {
        const row = scopes.get(key(params[0], params[1]));
        return cursor(row ? [row] : []);
      }
      if (text.startsWith("INSERT INTO mcp_oauth_scopes")) {
        const id = key(params[0], params[1]);
        const current = scopes.get(id) ?? { requested: "", granted: "", required: "", step_up_code: "", updated_at: 0 };
        if (/requested = excluded\.requested/.test(text)) {
          scopes.set(id, { ...current, requested: String(params[2]), updated_at: Number(params[3]) });
        } else if (/granted = excluded\.granted/.test(text)) {
          scopes.set(id, {
            requested: scopes.has(id) ? current.requested : String(params[2]),
            granted: String(params[3]),
            required: "",
            step_up_code: "",
            updated_at: Number(params[4]),
          });
        } else if (/required = excluded\.required/.test(text)) {
          scopes.set(id, { ...current, required: String(params[2]), step_up_code: String(params[3]), updated_at: Number(params[4]) });
        } else {
          throw new Error(`unexpected scopes statement: ${text}`);
        }
        return cursor([]);
      }
      if (text.startsWith("DELETE FROM mcp_oauth_scopes")) {
        scopes.delete(key(params[0], params[1]));
        return cursor([]);
      }
      if (/FROM mcp_oauth_clients/.test(text) && text.startsWith("SELECT")) {
        const row = clients.get(key(params[0], params[1], params[2]));
        return cursor(row ? [row] : []);
      }
      if (text.startsWith("INSERT OR REPLACE INTO mcp_oauth_clients")) {
        clients.set(key(params[0], params[1], params[2]), { client_id: String(params[3]), expires_at: Number(params[4]) });
        return cursor([]);
      }
      if (text.startsWith("DELETE FROM mcp_oauth_pending")) {
        for (const [state, row] of pending) {
          if (row.owner_email === params[0] && (row.server_id === params[1] || Number(row.expires_at) < Number(params[2]))) {
            pending.delete(state);
          }
        }
        return cursor([]);
      }
      if (text.startsWith("INSERT INTO mcp_oauth_pending")) {
        const [owner_email, state, server_id, mcp_url, token_endpoint, client_id, verifier, redirect_uri, resource, issuer, return_origin, browser_nonce, expires_at] = params;
        pending.set(String(state), { owner_email, state, server_id, mcp_url, token_endpoint, client_id, verifier, redirect_uri, resource, issuer, return_origin, browser_nonce, expires_at });
        return cursor([]);
      }
      throw new Error(`unexpected statement: ${text}`);
    },
  };
  return sql as unknown as McpRouteContext["sql"] & { pending: Map<string, Record<string, unknown>> };
}

function startRequest(server: Record<string, unknown>): Request {
  return new Request("https://backend.example.workers.dev/mcp/oauth-start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server, returnOrigin: "https://gera.example.app" }),
  });
}

async function startSignIn(
  ctx: McpRouteContext,
  server: Record<string, unknown>,
): Promise<{ status: number; body: { authorizationUrl?: string; scopes?: string[]; scopeSource?: string; error?: string } }> {
  const response = await handleMcpOAuthStart(ctx, startRequest(server), "owner@example.com");
  return { status: response.status, body: (await response.json()) as { authorizationUrl?: string; scopes?: string[]; scopeSource?: string; error?: string } };
}

function scopeParam(authorizationUrl: string | undefined): string | null {
  return new URL(authorizationUrl ?? "https://invalid.invalid/").searchParams.get("scope");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe("mcp-auth-challenge · WWW-Authenticate + scope strings", () => {
  it("parses Bearer challenges with quoted commas, several schemes and RFC 9728 resource_metadata", () => {
    const header =
      'Bearer realm="mcp", error="insufficient_scope", error_description="Needs write, not read", scope="repo:write things:write", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", Basic realm="legacy"';
    const challenges = parseWwwAuthenticate(header);
    expect(challenges.map((challenge) => challenge.scheme)).toEqual(["Bearer", "Basic"]);
    const bearer = bearerChallenge(header);
    expect(bearer).toEqual({
      realm: "mcp",
      error: "insufficient_scope",
      errorDescription: "Needs write, not read",
      scope: ["repo:write", "things:write"],
      resourceMetadata: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    });
    expect(bearerChallenge("Basic realm=\"x\"")).toBeNull();
    expect(bearerChallenge(null)).toBeNull();
    expect(bearerChallenge("Bearer")).toEqual({ scope: [] });
  });

  it("classifies insufficient_scope (and a 403 naming scopes) as a step-up, everything else as reauth", () => {
    expect(classifyMcpAuthRejection(403, 'Bearer error="insufficient_scope", scope="a b"')).toEqual({
      kind: "step_up",
      code: "insufficient_scope",
      scopes: ["a", "b"],
    });
    expect(classifyMcpAuthRejection(403, 'Bearer scope="write"')).toMatchObject({ kind: "step_up", scopes: ["write"] });
    expect(classifyMcpAuthRejection(401, 'Bearer error="invalid_token", error_description="expired"')).toEqual({
      kind: "reauth",
      code: "invalid_token",
      description: "expired",
    });
    expect(classifyMcpAuthRejection(401, null)).toEqual({ kind: "reauth", code: "invalid_token" });
    expect(classifyMcpAuthRejection(403, null)).toEqual({ kind: "reauth", code: "forbidden" });
  });

  it("parses scope strings per RFC 6749 §3.3, dropping illegal tokens and duplicates", () => {
    expect(parseScopeString("repo read:org repo\nuser:email,gist")).toEqual(["repo", "read:org", "user:email", "gist"]);
    expect(parseScopeString('bad"quote ok back\\slash fine')).toEqual(["ok", "fine"]);
    expect(parseScopeString(["a", "b", "a"])).toEqual(["a", "b"]);
    expect(parseScopeString(42)).toEqual([]);
    expect(mergeScopes(["a", "b"], undefined, ["b", "c"], null)).toEqual(["a", "b", "c"]);
  });
});

describe("discoverMcpOAuth · scope selection and the metadata override", () => {
  it("(a) pins explicit scopes into the authorize URL and (b) adds offline_access only when the AS declares it", async () => {
    stubProvider({ serverScopes: ["tools:read", "tools:write", "offline_access"], resourceScopes: ["tools:read"] });
    const pinned = await discoverMcpOAuth(MCP_URL, { scopes: ["tools:write", "custom:thing"] });
    expect(pinned.scopeSource).toBe("explicit");
    expect(pinned.scopes).toEqual(["tools:write", "custom:thing", "offline_access"]);
    const authorization = new URL(
      buildAuthorizationUrl({ discovery: pinned, clientId: "c", redirectUri: "https://backend/cb", state: "s", challenge: "ch" }),
    );
    expect(authorization.searchParams.get("scope")).toBe("tools:write custom:thing offline_access");
    expect(authorization.searchParams.get("resource")).toBe(MCP_URL);

    vi.unstubAllGlobals();
    stubProvider({ serverScopes: ["tools:read", "tools:write"], resourceScopes: ["tools:read"] });
    const noOffline = await discoverMcpOAuth(MCP_URL, { scopes: ["tools:write"] });
    expect(noOffline.scopes).toEqual(["tools:write"]);
    const fromResource = await discoverMcpOAuth(MCP_URL);
    expect(fromResource.scopeSource).toBe("resource");
    expect(fromResource.scopes).toEqual(["tools:read"]);
  });

  it("without a pin follows challenge → protected resource → authorization server", async () => {
    stubProvider({
      challenge: 'Bearer resource_metadata="https://mcp.scoped-provider.dev/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"',
      resourceScopes: ["tools:read"],
      serverScopes: ["tools:read", "tools:write", "offline_access"],
    });
    const fromChallenge = await discoverMcpOAuth(MCP_URL);
    expect(fromChallenge.scopeSource).toBe("challenge");
    expect(fromChallenge.scopes).toEqual(["mcp:tools", "offline_access"]);

    vi.unstubAllGlobals();
    stubProvider({ challenge: "Bearer realm=\"mcp\"", serverScopes: ["tools:read", "offline_access"] });
    const fromServer = await discoverMcpOAuth(MCP_URL);
    expect(fromServer.scopeSource).toBe("authorization_server");
    expect(fromServer.scopes).toEqual(["tools:read", "offline_access"]);

    vi.unstubAllGlobals();
    stubProvider({});
    const none = await discoverMcpOAuth(MCP_URL);
    expect(none.scopeSource).toBe("none");
    expect(none.scopes).toBeUndefined();
  });

  it("(c) uses the metadata URL override instead of the well-known walk, and still verifies the issuer", async () => {
    const overrideUrl = `${AUTH_ORIGIN}/tenant-42/custom-oauth-metadata.json`;
    const fetchMock = stubProvider({
      hideWellKnown: true,
      overrideDocument: {
        url: overrideUrl,
        body: {
          issuer: AUTH_ORIGIN,
          authorization_endpoint: `${AUTH_ORIGIN}/tenant-42/authorize`,
          token_endpoint: `${AUTH_ORIGIN}/tenant-42/token`,
          registration_endpoint: `${AUTH_ORIGIN}/tenant-42/register`,
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["tools:read", "offline_access"],
        },
      },
    });
    const discovery = await discoverMcpOAuth(MCP_URL, { authServerMetadataUrl: overrideUrl, probeChallenge: false });
    expect(discovery.metadataUrl).toBe(overrideUrl);
    expect(discovery.authorizationEndpoint).toBe(`${AUTH_ORIGIN}/tenant-42/authorize`);
    expect(discovery.scopes).toEqual(["tools:read", "offline_access"]);
    expect(requestedUrls(fetchMock).some((url) => url.includes("/.well-known/oauth-authorization-server"))).toBe(false);

    // Issuer mismatch: the document claims to speak for a server the resource never named.
    vi.unstubAllGlobals();
    stubProvider({
      hideWellKnown: true,
      overrideDocument: {
        url: overrideUrl,
        body: {
          issuer: "https://evil.example.net",
          authorization_endpoint: "https://evil.example.net/authorize",
          token_endpoint: "https://evil.example.net/token",
        },
      },
    });
    await expect(discoverMcpOAuth(MCP_URL, { authServerMetadataUrl: overrideUrl, probeChallenge: false })).rejects.toThrow(
      "OAuth metadata issuer mismatch",
    );
  });

  it("(c) rejects http:// and private-host metadata URLs before any request leaves", async () => {
    const fetchMock = stubProvider({});
    await expect(discoverMcpOAuth(MCP_URL, { authServerMetadataUrl: "http://auth.scoped-provider.dev/.well-known/oauth-authorization-server" })).rejects.toThrow(
      "OAuth metadata URL must be a public HTTPS URL",
    );
    await expect(discoverMcpOAuth(MCP_URL, { authServerMetadataUrl: "https://127.0.0.1/.well-known/openid-configuration" })).rejects.toThrow(
      "OAuth metadata URL must be a public HTTPS URL",
    );
    expect(requestedUrls(fetchMock).some((url) => url.startsWith("http://") || url.includes("127.0.0.1"))).toBe(false);
  });

  it("derives the issuer a well-known metadata URL speaks for", () => {
    expect(issuerFromMetadataUrl(new URL("https://auth.example.com/.well-known/oauth-authorization-server"))).toBe("https://auth.example.com");
    expect(issuerFromMetadataUrl(new URL("https://auth.example.com/.well-known/oauth-authorization-server/tenant"))).toBe("https://auth.example.com/tenant");
    expect(issuerFromMetadataUrl(new URL("https://auth.example.com/tenant/.well-known/openid-configuration"))).toBe("https://auth.example.com/tenant");
    expect(issuerFromMetadataUrl(new URL("https://auth.example.com/.well-known/openid-configuration/tenant"))).toBe("https://auth.example.com/tenant");
    expect(issuerFromMetadataUrl(new URL("https://auth.example.com/custom.json"))).toBeNull();
  });
});

describe("/mcp/oauth-start · pinned scopes, override, step-up union", () => {
  function routeContext(sql: McpRouteContext["sql"]): McpRouteContext {
    return {
      sql,
      resolveServers: async () => [],
      seal: async (plain, scope) => `sealed(${scope}):${plain.length}`,
      now: () => 1_700_000_000_000,
    };
  }

  it("(a) puts the card's pinned scopes into the authorize URL and records them as requested", async () => {
    stubProvider({ serverScopes: ["tools:read", "tools:write", "offline_access"], resourceScopes: ["tools:read"] });
    const sql = fakeShardSql();
    const { status, body } = await startSignIn(routeContext(sql), {
      id: "scoped",
      url: MCP_URL,
      oauthScopes: "tools:write, custom:thing",
    });
    expect(status).toBe(200);
    expect(body.scopeSource).toBe("explicit");
    expect(scopeParam(body.authorizationUrl)).toBe("tools:write custom:thing offline_access");
    expect(readOAuthScopes(sql, "owner@example.com", "scoped")).toMatchObject({
      requested: ["tools:write", "custom:thing", "offline_access"],
      granted: [],
      required: [],
    });
    // The sealed PKCE proof never rides in the response; the pending row holds it.
    const pending = [...sql.pending.values()][0];
    expect(String(pending.verifier)).toMatch(/^sealed\(/);
    expect(JSON.stringify(body)).not.toContain("sealed(");
  });

  it("(c) honors the metadata URL override and refuses an http:// one with the exact reason", async () => {
    const overrideUrl = `${AUTH_ORIGIN}/tenant-42/.well-known/oauth-authorization-server`;
    stubProvider({
      hideWellKnown: true,
      overrideDocument: {
        url: overrideUrl,
        body: {
          issuer: AUTH_ORIGIN,
          authorization_endpoint: `${AUTH_ORIGIN}/tenant-42/authorize`,
          token_endpoint: `${AUTH_ORIGIN}/tenant-42/token`,
          registration_endpoint: `${AUTH_ORIGIN}/register`,
          code_challenge_methods_supported: ["S256"],
        },
      },
    });
    const sql = fakeShardSql();
    const used = await startSignIn(routeContext(sql), { id: "scoped", url: MCP_URL, authServerMetadataUrl: overrideUrl });
    expect(used.status).toBe(200);
    expect(new URL(used.body.authorizationUrl ?? "").pathname).toBe("/tenant-42/authorize");

    const refused = await startSignIn(routeContext(sql), {
      id: "scoped",
      url: MCP_URL,
      authServerMetadataUrl: "http://auth.scoped-provider.dev/.well-known/oauth-authorization-server",
    });
    expect(refused.status).toBe(502);
    expect(refused.body.error).toBe("OAuth metadata URL must be a public HTTPS URL");
  });

  it("(d) after insufficient_scope the next sign-in asks for pin ∪ granted ∪ required, and completion clears the step-up", async () => {
    stubProvider({ serverScopes: ["tools:read", "tools:write", "offline_access"] });
    const sql = fakeShardSql();
    const owner = "owner@example.com";
    // Earlier sign-in granted the read scope; a run then hit a scope challenge.
    recordRequestedScopes(sql, owner, "scoped", ["tools:read"]);
    recordGrantedScopes(sql, owner, "scoped", ["tools:read"]);
    expect(pendingStepUp(sql, owner, "scoped")).toBeNull();
    recordRequiredScopes(sql, owner, "scoped", ["tools:write", "things:write"], "insufficient_scope");
    expect(pendingStepUp(sql, owner, "scoped")).toEqual({ scopes: ["tools:write", "things:write"], code: "insufficient_scope" });
    expect(planAuthorizationScopes({ pinned: ["custom:pin"], record: readOAuthScopes(sql, owner, "scoped") })).toEqual([
      "custom:pin",
      "tools:read",
      "tools:write",
      "things:write",
    ]);
    expect(planAuthorizationScopes({ pinned: [], record: null })).toBeNull();

    const { body } = await startSignIn(routeContext(sql), { id: "scoped", url: MCP_URL, oauthScopes: "custom:pin" });
    expect(scopeParam(body.authorizationUrl)).toBe("custom:pin tools:read tools:write things:write offline_access");

    // The provider answered with its own (narrower) scope list — that is what counts as granted now.
    recordGrantedScopes(sql, owner, "scoped", ["tools:read", "tools:write"]);
    expect(pendingStepUp(sql, owner, "scoped")).toBeNull();
    expect(readOAuthScopes(sql, owner, "scoped")).toMatchObject({ granted: ["tools:read", "tools:write"], required: [], stepUpCode: "" });
    // Silence from the provider means "as requested".
    recordGrantedScopes(sql, owner, "scoped", null);
    expect(readOAuthScopes(sql, owner, "scoped")?.granted).toEqual(["custom:pin", "tools:read", "tools:write", "things:write", "offline_access"]);
  });
});

// ---------------------------------------------------------------------------

/** A Streamable HTTP server whose tools/call answers 403 insufficient_scope. */
function scopedServer(): { fetch: McpFetch; calls: () => string[] } {
  const methods: string[] = [];
  const fetch: McpFetch = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { id?: number; method: string; params?: Record<string, unknown> };
    methods.push(body.method);
    const reply = (result: unknown): Response =>
      json({ jsonrpc: "2.0", id: body.id, result }, 200, { "Mcp-Session-Id": "sess-1" });
    switch (body.method) {
      case "initialize":
        return reply({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "scoped", version: "1" } });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        return reply({
          tools: [
            { name: "read_thing", description: "Reads a thing", inputSchema: { type: "object", properties: {} } },
            { name: "write_thing", description: "Writes a thing", inputSchema: { type: "object", properties: {} } },
          ],
        });
      case "tools/call":
        return new Response("scope", {
          status: 403,
          headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="things:write repo:write", error_description="write scope missing"' },
        });
      default:
        return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no" } });
    }
  };
  return { fetch, calls: () => methods.filter((method) => method === "tools/call") };
}

function server(): CloudMcpServer {
  return {
    id: "scoped",
    name: "Scoped Things",
    kind: "mcp",
    url: MCP_URL,
    headers: {},
    omitMcpHeaders: false,
    disabledTools: [],
    oauth: { accessToken: "access-secret-1", tokenEndpoint: `${AUTH_ORIGIN}/token`, clientId: "client-scoped" },
  };
}

describe("toolset · insufficient_scope → step_up_required without a second call", () => {
  it("(d) deferred: parks the server, reports the demanded scopes once, and never contacts it again this run", async () => {
    const remote = scopedServer();
    const reported: Array<[string, CloudOAuthRefreshFailure]> = [];
    const toolset = await resolveMcpToolset({
      servers: [server()],
      mode: "deferred",
      fetch: remote.fetch,
      catalog: createMemoryMcpCatalogStore(),
      reportFailure: async (id, outcome) => {
        reported.push([id, outcome]);
      },
    });
    await toolset.execute(MCP_SEARCH_TOOL_NAME, { query: "thing" });
    const first = await toolset.execute(MCP_CALL_TOOL_NAME, { serverId: "scoped", toolName: "write_thing", arguments: {} });
    expect(first.isError).toBe(true);
    expect(first.text).toMatch(/wider access/);
    expect(first.text).toContain("things:write repo:write");
    expect(first.text).not.toContain("access-secret-1");
    expect(remote.calls()).toHaveLength(1);
    expect(reported).toEqual([
      [
        "scoped",
        {
          ok: false,
          status: 403,
          code: "insufficient_scope",
          detail: "write scope missing",
          transient: false,
          ambiguous: false,
          requiredScopes: ["things:write", "repo:write"],
        },
      ],
    ]);
    expect(toolset.journal.map((entry) => entry.kind)).toEqual(["step_up_required"]);

    // A different tool on the same server: parked, no network.
    const second = await toolset.execute(MCP_CALL_TOOL_NAME, { serverId: "scoped", toolName: "read_thing", arguments: {} });
    expect(second.isError).toBe(true);
    expect(second.text).toMatch(/wider access/);
    expect(remote.calls()).toHaveLength(1);
    expect(reported).toHaveLength(1);
    // Search stays honest about the parked server.
    const search = JSON.parse((await toolset.execute(MCP_SEARCH_TOOL_NAME, { query: "thing" })).text) as { servers: Array<{ unavailable?: string }> };
    expect(search.servers[0].unavailable).toMatch(/wider access/);
    toolset.close();
  });

  it("(d) native: inline functions of a parked server answer without a request", async () => {
    const remote = scopedServer();
    const reported: string[] = [];
    const toolset = await resolveMcpToolset({
      servers: [server()],
      mode: "native",
      fetch: remote.fetch,
      reportFailure: async (id, outcome) => {
        reported.push(`${id}:${outcome.code}`);
      },
    });
    const names = [...toolset.routes.keys()];
    const write = names.find((name) => name.endsWith("write_thing")) ?? "";
    const read = names.find((name) => name.endsWith("read_thing")) ?? "";
    expect(write && read).toBeTruthy();
    const first = await toolset.execute(write, {});
    expect(first).toMatchObject({ isError: true });
    expect(first.text).toMatch(/Sign in again with wider access/);
    const second = await toolset.execute(read, {});
    expect(second).toMatchObject({ isError: true });
    expect(remote.calls()).toHaveLength(1);
    expect(reported).toEqual(["scoped:insufficient_scope"]);
  });

  it("turns a blocked sign-in into an honest run record instead of a vanished server", () => {
    const configs = [
      { id: "scoped", name: "Scoped Things", url: MCP_URL, authMode: "oauth", enabled: true, status: "connected" },
      { id: "renew", name: "Renew Me", url: MCP_URL, authMode: "auto", enabled: true, status: "connected" },
      { id: "keyed", name: "Keyed", url: MCP_URL, authMode: "auto", token: "sk-live", enabled: true, status: "connected" },
      { id: "github", name: "GitHub", authMode: "oauth", enabled: true, status: "connected" },
      { id: "off", name: "Off", url: MCP_URL, authMode: "oauth", enabled: false, status: "connected" },
    ];
    const blocked = new Map<string, string>([
      ["scoped", "step_up_required"],
      ["renew", "reauth_required"],
      ["keyed", "reauth_required"],
      ["github", "reauth_required"],
      ["off", "step_up_required"],
    ]);
    const records = blockedCloudServerFailures(configs, blocked);
    expect(records.map((record) => record.arguments)).toEqual(["Scoped Things", "Renew Me"]);
    expect(records[0].result).toMatch(/Sign in again with wider access/);
    expect(records[1].result).toMatch(/sign-in must be renewed/);
    expect(blockedCloudServerFailures(configs, new Map())).toEqual([]);
  });
});
