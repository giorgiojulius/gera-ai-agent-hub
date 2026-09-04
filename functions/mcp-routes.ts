// Account-shard MCP routes that go beyond tools: the composer's prompt (`/`)
// and resource (`@`) menus. Connection and credentials stay server-side — the
// browser only names a server id, a prompt name / resource URI, and
// arguments. Handlers are plain functions over a small seam (`McpRouteContext`)
// so ChatStore's dispatch stays a few lines and the logic is unit-testable.
//
// `/mcp/oauth-start` (Phase 3) lives here too: discovery with pinned scopes /
// metadata override, dynamic registration, the PKCE pending row. Phase 6 moves
// the remaining `/mcp/*` handlers (check, resolve, auth-lease, the rest of the
// OAuth state machine) here through the same seam.

import { capStr, isValidId, type ChatSql } from "./chat-shared";
import { parseScopeString } from "./mcp-auth-challenge";
import {
  connectCloudMcp,
  getCloudMcpPrompt,
  readCloudMcpResource,
  redactCloudMcpText,
  cloudServerRedactions,
  type CloudMcpServer,
} from "./mcp-cloud";
import {
  buildAuthorizationUrl,
  discoverMcpOAuth,
  newOAuthState,
  newPkceVerifier,
  pkceChallenge,
  registerDynamicOAuthClient,
} from "./mcp-oauth-flow";
import { planAuthorizationScopes, readOAuthScopes, recordRequestedScopes } from "./mcp-oauth-scopes";
import { DEFERRED_TOOLS_PER_SERVER, CATALOG_TTL_MS, catalogHasInventory, createSqlMcpCatalogStore } from "./mcp-toolset";
import type { McpFetch } from "./mcp-protocol";
import { oauthPendingFieldScope } from "./secret-rows";

export type McpRouteContext = {
  sql: ChatSql;
  /**
   * Resolves the owner's connected generic MCP servers (auth attached, expiring
   * grants refreshed) for the given ids — the same path `/mcp/resolve` uses.
   */
  resolveServers(owner: string, ids: string[]): Promise<CloudMcpServer[]>;
  /** Seals one secret column for the account vault (PKCE verifier, browser nonce). */
  seal?(plain: string, scope: string): Promise<string>;
  /** Injected transport for tests; production keeps the public-HTTPS guard. */
  fetch?: McpFetch;
  now?: () => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

const ID_LIMIT = 80;

function serverIdOf(body: Record<string, unknown>): string {
  const raw = typeof body.serverId === "string" ? body.serverId.trim() : "";
  return raw && raw.length <= ID_LIMIT ? raw : "";
}

async function resolveOne(ctx: McpRouteContext, owner: string, serverId: string): Promise<CloudMcpServer | null> {
  const servers = await ctx.resolveServers(owner, [serverId]);
  return servers.find((server) => server.id === serverId && server.kind === "mcp") ?? null;
}

function failure(server: CloudMcpServer | null, error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback;
  return server ? redactCloudMcpText(raw, cloudServerRedactions(server)) : raw;
}

/**
 * POST /mcp/inventory { serverId, refresh? } → { prompts, resources,
 * resourceTemplates, toolCount, cached }. Served from the account's catalog
 * cache when a recent handshake listed the inventory; otherwise one bounded
 * handshake refreshes the cache for the next menu open.
 */
export async function handleMcpInventory(ctx: McpRouteContext, request: Request, owner: string): Promise<Response> {
  const body = await readBody(request);
  const serverId = body ? serverIdOf(body) : "";
  if (!body || !serverId) {
    return json({ error: "invalid_body" }, 400);
  }
  const now = ctx.now ?? (() => Date.now());
  const catalog = createSqlMcpCatalogStore(ctx.sql, owner);
  const cached = catalog.read(serverId);
  if (body.refresh !== true && catalogHasInventory(cached) && now() - cached.fetchedAt < CATALOG_TTL_MS) {
    return json({
      prompts: cached.prompts,
      resources: cached.resources ?? [],
      resourceTemplates: cached.resourceTemplates ?? [],
      toolCount: cached.tools.length,
      cached: true,
    });
  }
  const server = await resolveOne(ctx, owner, serverId);
  if (!server) {
    return json({ error: "server_unavailable" }, 404);
  }
  try {
    const connection = await connectCloudMcp(server, {
      maxTools: DEFERRED_TOOLS_PER_SERVER,
      includeDisabled: true,
      inventory: true,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    });
    catalog.write({
      serverId: server.id,
      serverName: server.name,
      tools: connection.tools,
      fetchedAt: now(),
      prompts: connection.prompts,
      resources: connection.resources,
      resourceTemplates: connection.resourceTemplates,
      capabilities: connection.session.capabilities ?? {},
    });
    return json({
      prompts: connection.prompts,
      resources: connection.resources,
      resourceTemplates: connection.resourceTemplates,
      toolCount: connection.tools.length,
      cached: false,
    });
  } catch (error) {
    return json({ error: failure(server, error, "MCP server did not answer") }, 502);
  }
}

const PROMPT_ARG_CHARS = 20_000;

/** POST /mcp/prompt-get { serverId, name, arguments? } → { description?, messages }. */
export async function handleMcpPromptGet(ctx: McpRouteContext, request: Request, owner: string): Promise<Response> {
  const body = await readBody(request);
  const serverId = body ? serverIdOf(body) : "";
  const name = body && typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
  if (!body || !serverId || !name) {
    return json({ error: "invalid_body" }, 400);
  }
  const args: Record<string, string> = {};
  if (isRecord(body.arguments)) {
    for (const [key, value] of Object.entries(body.arguments).slice(0, 40)) {
      if (typeof value === "string") {
        args[key.slice(0, 100)] = value.slice(0, PROMPT_ARG_CHARS);
      } else if (typeof value === "number" || typeof value === "boolean") {
        args[key.slice(0, 100)] = String(value);
      }
    }
  }
  const server = await resolveOne(ctx, owner, serverId);
  if (!server) {
    return json({ error: "server_unavailable" }, 404);
  }
  try {
    const connection = await connectCloudMcp(server, {
      maxTools: 1,
      includeDisabled: true,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    });
    if (!connection.session.capabilities?.prompts) {
      return json({ error: `MCP server "${server.name}" does not offer prompts.` }, 400);
    }
    const prompt = await getCloudMcpPrompt(connection.session, name, args);
    return json(prompt);
  } catch (error) {
    return json({ error: failure(server, error, "prompts/get failed") }, 502);
  }
}

/** How long a started sign-in may wait for the provider's callback. */
const OAUTH_PENDING_TTL_MS = 10 * 60_000;
const MCP_URL_CHARS = 4_000;

/**
 * POST /mcp/oauth-start { server: { id, url, oauthScopes?, authServerMetadataUrl? },
 * returnOrigin } → { authorizationUrl, state, browserNonce, expiresAt, scopes,
 * scopeSource }.
 *
 * Discovery honors the card's Advanced settings: a pinned scope string goes
 * into the authorize URL as-is (plus `offline_access` when the authorization
 * server declares it); a metadata URL replaces the well-known walk (public
 * HTTPS only, issuer still verified). A pending step-up (a run hit
 * `insufficient_scope`) widens the request to pin ∪ granted ∪ required so the
 * new consent never loses tools that already worked. PKCE verifier and the
 * browser nonce are sealed into the pending row; the browser only ever sees
 * the authorize URL, the opaque state and its own nonce.
 */
export async function handleMcpOAuthStart(ctx: McpRouteContext, request: Request, owner: string): Promise<Response> {
  const body = await readBody(request);
  if (!body) {
    return json({ error: "invalid_body" }, 400);
  }
  const server = isRecord(body.server) ? body.server : null;
  const serverId = server && typeof server.id === "string" ? server.id : "";
  const mcpUrl = server && typeof server.url === "string" ? server.url.trim() : "";
  const pinnedScopes = server ? parseScopeString(server.oauthScopes) : [];
  const authServerMetadataUrl =
    server && typeof server.authServerMetadataUrl === "string" ? server.authServerMetadataUrl.trim().slice(0, MCP_URL_CHARS) : "";
  const returnOrigin = typeof body.returnOrigin === "string" ? body.returnOrigin : "";
  let normalizedReturnOrigin = "";
  try {
    const parsed = new URL(returnOrigin);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("unsafe origin");
    }
    normalizedReturnOrigin = parsed.origin;
  } catch {
    return json({ error: "invalid_return_origin" }, 400);
  }
  if (!isValidId(serverId) || !mcpUrl || mcpUrl.length > MCP_URL_CHARS) {
    return json({ error: "invalid_server" }, 400);
  }
  if (!ctx.seal) {
    return json({ error: "oauth_unavailable" }, 503);
  }
  const now = ctx.now ?? (() => Date.now());
  const callbackUrl = new URL("/mcp/oauth/callback", request.url).toString();
  try {
    const explicitScopes = planAuthorizationScopes({
      pinned: pinnedScopes,
      record: readOAuthScopes(ctx.sql, owner, serverId),
    });
    const discovery = await discoverMcpOAuth(mcpUrl, {
      ...(explicitScopes ? { scopes: explicitScopes } : {}),
      ...(authServerMetadataUrl ? { authServerMetadataUrl } : {}),
    });
    if (!discovery.registrationEndpoint) {
      return json({ error: "oauth_registration_unsupported" }, 400);
    }
    const cached = ctx.sql
      .exec<{ client_id: string; expires_at: number }>(
        `SELECT client_id, expires_at FROM mcp_oauth_clients
         WHERE owner_email = ? AND registration_endpoint = ? AND redirect_uri = ?`,
        owner,
        discovery.registrationEndpoint,
        callbackUrl,
      )
      .toArray()[0];
    let clientId = cached?.client_id ?? "";
    if (!clientId || (cached.expires_at > 0 && cached.expires_at <= now() + 60_000)) {
      const registered = await registerDynamicOAuthClient(discovery.registrationEndpoint, callbackUrl);
      clientId = registered.clientId;
      ctx.sql.exec(
        `INSERT OR REPLACE INTO mcp_oauth_clients
          (owner_email, registration_endpoint, redirect_uri, client_id, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        owner,
        discovery.registrationEndpoint,
        callbackUrl,
        clientId,
        registered.expiresAt ?? 0,
        now(),
      );
    }
    const state = newOAuthState();
    const browserNonce = newOAuthState();
    const verifier = newPkceVerifier();
    const challenge = await pkceChallenge(verifier);
    const expiresAt = now() + OAUTH_PENDING_TTL_MS;
    // A newer attempt supersedes every older callback for this connector.
    ctx.sql.exec(
      "DELETE FROM mcp_oauth_pending WHERE owner_email = ? AND (server_id = ? OR expires_at < ?)",
      owner,
      serverId,
      now(),
    );
    ctx.sql.exec(
      `INSERT INTO mcp_oauth_pending
        (owner_email, state, server_id, mcp_url, token_endpoint, client_id, verifier,
         redirect_uri, resource, issuer, return_origin, browser_nonce, callback_challenge,
         authorization_code, expires_at, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, 'pending', '', ?, ?)`,
      owner,
      state,
      serverId,
      mcpUrl,
      discovery.tokenEndpoint,
      clientId,
      await ctx.seal(verifier, oauthPendingFieldScope(owner, state, "verifier")),
      callbackUrl,
      discovery.resource ?? "",
      discovery.issuer,
      normalizedReturnOrigin,
      await ctx.seal(browserNonce, oauthPendingFieldScope(owner, state, "browser_nonce")),
      expiresAt,
      now(),
      now(),
    );
    const scopes = discovery.scopes ?? [];
    recordRequestedScopes(ctx.sql, owner, serverId, scopes, now());
    const authorizationUrl = buildAuthorizationUrl({
      discovery,
      clientId,
      redirectUri: callbackUrl,
      state,
      challenge,
    });
    return json({ authorizationUrl, state, browserNonce, expiresAt, scopes, scopeSource: discovery.scopeSource });
  } catch (error) {
    return json({ error: capStr(error instanceof Error ? error.message : "oauth_start_failed", 300) }, 502);
  }
}

/** POST /mcp/resource-read { serverId, uri } → { contents }. */
export async function handleMcpResourceRead(ctx: McpRouteContext, request: Request, owner: string): Promise<Response> {
  const body = await readBody(request);
  const serverId = body ? serverIdOf(body) : "";
  const uri = body && typeof body.uri === "string" ? body.uri.trim().slice(0, 2_000) : "";
  if (!body || !serverId || !uri) {
    return json({ error: "invalid_body" }, 400);
  }
  const server = await resolveOne(ctx, owner, serverId);
  if (!server) {
    return json({ error: "server_unavailable" }, 404);
  }
  try {
    const connection = await connectCloudMcp(server, {
      maxTools: 1,
      includeDisabled: true,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    });
    if (!connection.session.capabilities?.resources) {
      return json({ error: `MCP server "${server.name}" does not offer resources.` }, 400);
    }
    const contents = await readCloudMcpResource(connection.session, uri);
    return json({ contents });
  } catch (error) {
    return json({ error: failure(server, error, "resources/read failed") }, 502);
  }
}
