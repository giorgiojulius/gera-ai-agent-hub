// Account-shard MCP routes: the connection check (`/mcp/check`), the
// worker-internal credential routes project agents use (`/mcp/resolve`,
// `/mcp/auth-lease`), the composer's prompt (`/`) and resource (`@`) menus
// and `/mcp/oauth-start` (discovery with pinned scopes / metadata override,
// dynamic registration, the PKCE pending row). Connection and credentials
// stay server-side — the browser only names a server id, a prompt name /
// resource URI, and arguments.
//
// Handlers are plain functions over small seams so ChatStore's dispatch stays
// one line per route and the logic is unit-testable with SQL stubs:
// `McpRouteContext` for the menu/oauth-start routes (storage + server
// resolution) and the credential store's `OAuthStoreContext` for check /
// resolve / auth-lease. The browser sign-in state machine lives in
// mcp-oauth-routes.ts, the grant/state store in mcp-oauth-store.ts.

import { capStr, isPlaceholderCredential, isValidId, type ChatSql } from "./chat-shared";
import { parseScopeString } from "./mcp-auth-challenge";
import {
  chainRotationBases,
  cloudMcpServersForAutomation,
  connectCloudMcp,
  ensureFreshCloudOAuth,
  forceRefreshCloudOAuthOutcome,
  getCloudMcpPrompt,
  readCloudMcpResource,
  redactCloudMcpText,
  cloudServerRedactions,
  type CloudMcpServer,
  type CloudOAuthToken,
  type RefreshedOAuth,
} from "./mcp-cloud";
import {
  buildAuthorizationUrl,
  discoverMcpOAuth,
  newOAuthState,
  newPkceVerifier,
  pkceChallenge,
  registerDynamicOAuthClient,
} from "./mcp-oauth-flow";
import { pendingStepUp, planAuthorizationScopes, readOAuthScopes, recordRequestedScopes } from "./mcp-oauth-scopes";
import {
  isBlockedOAuthState,
  markOAuthReady,
  markOAuthRefreshStarted,
  mcpServerSecret,
  oauthDiagnostic,
  oauthGrantState,
  persistCanonicalOAuthGrant,
  profileOAuthTokens,
  rawOAuthGrant,
  recordOAuthFailure,
  resolveOwnerMcpServers,
  type OAuthStoreContext,
} from "./mcp-oauth-store";
import {
  DEFERRED_TOOLS_PER_SERVER,
  CATALOG_TTL_MS,
  catalogHasInventory,
  createSqlMcpCatalogStore,
  resolveMcpToolset,
} from "./mcp-toolset";
import type { McpFetch } from "./mcp-protocol";
import { oauthPendingFieldScope, sealServerSecret, type ServerSecret } from "./secret-rows";

export type McpRouteContext = {
  sql: ChatSql;
  /**
   * Resolves the owner's connected generic MCP servers (auth attached, expiring
   * grants refreshed) for the given ids — the same path `/mcp/resolve` uses.
   */
  resolveServers(owner: string, ids: string[]): Promise<CloudMcpServer[]>;
  /** Seals one secret column for the account vault (PKCE verifier, browser nonce). */
  seal?(plain: string, scope: string): Promise<string>;
  /** Vault scope subject for `owner`'s rows (the Rork Auth account once migrated); defaults to the owner. */
  subject?(owner: string): string;
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
      await ctx.seal(verifier, oauthPendingFieldScope(ctx.subject?.(owner) ?? owner, state, "verifier")),
      callbackUrl,
      discovery.resource ?? "",
      discovery.issuer,
      normalizedReturnOrigin,
      await ctx.seal(browserNonce, oauthPendingFieldScope(ctx.subject?.(owner) ?? owner, state, "browser_nonce")),
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

/**
 * POST /mcp/check { server } — server-side connection check; credentials,
 * refresh and the MCP session stay in this shard. A pasted key/header pair
 * is sealed into `mcp_server_secrets` first; the arm then uses only
 * shard-resolved secrets or the account's OAuth grant and returns the
 * complete remote tool table (disabled-tool preferences apply at run time).
 */
export async function handleMcpCheck(ctx: OAuthStoreContext, request: Request, owner: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const rawServer = isRecord(body) && isRecord(body.server) ? body.server : null;
  const serverId = rawServer && typeof rawServer.id === "string" ? rawServer.id : "";
  if (!rawServer || !isValidId(serverId)) {
    return json({ error: "invalid_server" }, 400);
  }
  const secret = {
    token:
      typeof rawServer.token === "string" && !isPlaceholderCredential(rawServer.token)
        ? rawServer.token
        : "",
    headersJson: typeof rawServer.headersJson === "string" ? rawServer.headersJson : "",
  };
  const catalogId = typeof rawServer.catalogId === "string" ? rawServer.catalogId : "";
  if (rawServer.credentialStored === false && !secret.token && !secret.headersJson) {
    ctx.sql.exec("DELETE FROM mcp_server_secrets WHERE owner_email = ? AND server_id = ?", owner, serverId);
  }
  if (secret.token || secret.headersJson) {
    ctx.sql.exec(
      "INSERT OR REPLACE INTO mcp_server_secrets (owner_email, server_id, payload, updated_at) VALUES (?, ?, ?, ?)",
      owner,
      serverId,
      await sealServerSecret(ctx.vault, ctx.subject(owner), serverId, secret),
      Date.now(),
    );
  }
  const storedSecret = await mcpServerSecret(ctx, owner, serverId);
  const legacyCatalogSecret: ServerSecret =
    catalogId && catalogId !== serverId ? await mcpServerSecret(ctx, owner, catalogId) : {};
  let resolvedSecret = Object.keys(storedSecret).length > 0 ? storedSecret : legacyCatalogSecret;
  const nativeGithub = (catalogId || serverId) === "github";
  if (nativeGithub && !resolvedSecret.token) {
    // Native GitHub talks REST with a bearer token only. A leftover
    // headers-style secret can neither authenticate it nor should it mask
    // the OAuth grant path.
    resolvedSecret = {};
  }
  const authMode =
    rawServer.authMode === "none" ||
    rawServer.authMode === "bearer" ||
    rawServer.authMode === "headers" ||
    rawServer.authMode === "oauth"
      ? rawServer.authMode
      : "auto";
  const reliesOnOAuth =
    (authMode === "oauth" || authMode === "auto") &&
    !resolvedSecret.token &&
    !resolvedSecret.headersJson;
  // Every id whose grant row can authenticate this card. Device-flow GitHub
  // always commits under the canonical "github" id, so github-native cards
  // resolve it even when their own instance id differs.
  const grantIds = [
    ...new Set([
      serverId,
      ...(catalogId ? [catalogId] : []),
      ...(nativeGithub ? ["github"] : []),
    ]),
  ];
  const storedGrants = new Map<string, CloudOAuthToken>();
  for (const id of grantIds) {
    const grant = await rawOAuthGrant(ctx, owner, id);
    if (grant) {
      storedGrants.set(id, grant);
    }
  }
  // Fail closed on blocked states only when no grant physically exists. A
  // user-initiated check with a fresh grant must try it: success below
  // clears the stale marker, failure re-records an accurate one.
  const blockedState = reliesOnOAuth && storedGrants.size === 0
    ? grantIds.map((id) => oauthGrantState(ctx, owner, id)).find(isBlockedOAuthState)
    : undefined;
  // A run's insufficient_scope challenge, pending until a new sign-in consents to it.
  const stepUp = grantIds.map((id) => pendingStepUp(ctx.sql, owner, id)).find(Boolean) ?? null;
  if (blockedState) {
    return json({ error: blockedState, ...(stepUp ? { stepUp } : {}) }, blockedState === "step_up_required" ? 403 : 401);
  }
  const oauthTokens = await profileOAuthTokens(ctx, owner);
  for (const [id, grant] of storedGrants) {
    if (!oauthTokens[id]) {
      oauthTokens[id] = grant;
    }
  }
  if (!oauthTokens[serverId]) {
    const donor = grantIds.find((id) => Boolean(oauthTokens[id]));
    if (donor) {
      oauthTokens[serverId] = oauthTokens[donor];
    }
  }
  // A health check must always return the complete remote tool table. The
  // account's disabled-tool preferences stay in the profile and are applied
  // when a run arms; filtering here made disabled tools disappear forever.
  const candidate = {
    ...rawServer,
    // Only shard-resolved secrets may authenticate the arm. The browser's
    // raw `token` is either already stored above or a non-credential
    // (`gera-account:*` marker) that would otherwise ride into the request
    // as a fake PAT, shadow the OAuth grant, and fail with GitHub 401.
    token: resolvedSecret.token ?? "",
    headersJson: resolvedSecret.headersJson ?? "",
    disabledTools: [],
    enabled: true,
    status: "connected",
  };
  const servers = cloudMcpServersForAutomation([candidate], [serverId], oauthTokens);
  if (servers.length === 0) {
    // Metadata only — which ids were consulted and why they cannot arm.
    // Never any token material.
    const detail = grantIds.map((id) => oauthDiagnostic(ctx, owner, id));
    return json({ error: "server_auth_missing", detail }, 400);
  }
  const appliedChains = new Map<string, string[]>();
  const persist = async (rotated: RefreshedOAuth): Promise<void> => {
    await persistCanonicalOAuthGrant(ctx, owner, rotated);
    const bases = chainRotationBases(appliedChains, rotated);
    appliedChains.set(rotated.serverId, bases);
  };
  try {
    // Uncapped: a health check returns the complete remote table (with
    // annotations and UI-only markers), lists prompts/resources, and the
    // handshake refreshes the account's catalog cache (deferred runs and the
    // composer menus read it without reconnecting). No notification stream:
    // a check has no run to keep it alive.
    const runtime = await resolveMcpToolset({
      servers,
      mode: "native",
      uncapped: true,
      inventory: true,
      notificationStreams: false,
      catalog: createSqlMcpCatalogStore(ctx.sql, owner),
      persist,
      reportFailure: (id, outcome) => recordOAuthFailure(ctx, owner, id, outcome),
      beginRefresh: (id) => markOAuthRefreshStarted(ctx, owner, id),
    });
    if (runtime.failures.length > 0 || runtime.routes.size === 0) {
      // Only a failed arm may surface an auth state — a stale pre-existing
      // marker must never veto a verification that just succeeded.
      const authState = grantIds.map((id) => oauthGrantState(ctx, owner, id)).find(isBlockedOAuthState);
      if (authState) {
        return json({ error: authState, ...(stepUp ? { stepUp } : {}) }, authState === "step_up_required" ? 403 : 401);
      }
      const armFailure = runtime.failures[0]?.result ?? "MCP server returned no tools.";
      return json({ error: armFailure }, 502);
    }
    if (servers[0]?.oauth) {
      // The grant just proved itself against the live provider: clear any
      // stuck reauth/step-up markers so leases and relays use it again. A
      // pending insufficient_scope step-up is the exception — the handshake
      // only proves the token, not the scopes a tool demanded; only a new
      // sign-in (which asks for the union) clears that one.
      for (const id of grantIds) {
        if (storedGrants.has(id) && !pendingStepUp(ctx.sql, owner, id)) {
          markOAuthReady(ctx, owner, id);
        }
      }
    }
    const info = runtime.servers[0];
    // Generic MCP servers: the complete remote table straight from the
    // handshake (titles, annotations, UI-only). Native connectors: their
    // static tables as armed.
    const tools = info?.tools
      ? info.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.title ? { title: tool.title } : {}),
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
          ...(tool.uiOnly ? { uiOnly: true } : {}),
        }))
      : [...runtime.routes.entries()].map(([functionName, route]) => {
          const definition = runtime.toolDefs.find((tool) => tool.function.name === functionName);
          return {
            name: route.toolName,
            description: definition?.function.description ?? route.toolName,
            inputSchema: definition?.function.parameters ?? { type: "object", properties: {} },
          };
        });
    const credentialStored = Boolean(
      resolvedSecret.token ||
      resolvedSecret.headersJson ||
      oauthTokens[serverId],
    );
    return json({
      tools,
      identity: `${servers[0].name} · server verified`,
      credentialStored,
      promptCount: info?.promptCount ?? 0,
      resourceCount: info?.resourceCount ?? 0,
      ...(stepUp ? { stepUp } : {}),
    });
  } catch (error) {
    // An unexpected fault inside the check (a refresh race, a storage error)
    // must not escape as a Durable Object exception: the Worker would report
    // Gera's backend as unavailable and the real cause would never reach the
    // journal. Every credential in scope is redacted first; a health probe
    // is idempotent, so one retry is always safe.
    const armed = servers[0];
    const secrets = [
      ...Object.values(armed?.headers ?? {}),
      armed?.token ?? "",
      resolvedSecret.token ?? "",
      ...Object.values(oauthTokens).flatMap((grant) => [grant.accessToken, grant.refreshToken ?? ""]),
    ];
    const detail = redactCloudMcpText(error instanceof Error ? error.message : "check failed", secrets).slice(0, 300);
    console.error("mcp check failed", serverId, detail);
    return json({ error: "mcp_check_failed", detail, retryable: true }, 502);
  }
}

/**
 * POST /mcp/auth-lease { serverId, catalogId?, force? } — internal,
 * Worker-only: one `Authorization` value for a native connector (pasted key
 * first, then the account's OAuth grant, refreshed or force-redeemed here).
 * Provider credentials never cross a public response.
 */
export async function handleMcpAuthLease(ctx: OAuthStoreContext, request: Request, owner: string): Promise<Response> {
  let body: { serverId?: unknown; catalogId?: unknown; force?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const serverId = typeof body.serverId === "string" ? body.serverId : "";
  const catalogId = typeof body.catalogId === "string" ? body.catalogId : "";
  if (!isValidId(serverId) || (catalogId && !isValidId(catalogId))) {
    return json({ error: "invalid_server" }, 400);
  }
  const nativeGithub = (catalogId || serverId) === "github";
  const ids = [
    ...new Set([
      serverId,
      ...(catalogId && catalogId !== serverId ? [catalogId] : []),
      // Device-flow GitHub commits its grant under the canonical "github"
      // id; instance cards must resolve it regardless of their own id.
      ...(nativeGithub ? ["github"] : []),
    ]),
  ];
  for (const id of ids) {
    const secret = await mcpServerSecret(ctx, owner, id);
    if (secret.token) {
      const authorization = /^Bearer\s/i.test(secret.token) ? secret.token : `Bearer ${secret.token}`;
      return json({ authorization });
    }
  }
  const storedGrants = new Map<string, CloudOAuthToken>();
  for (const id of ids) {
    const stored = await rawOAuthGrant(ctx, owner, id);
    if (stored) {
      storedGrants.set(id, stored);
    }
  }
  // A stale blocked marker must never hide a physically present grant: a
  // fresh sign-in is the recovery path and has to be tried. Fail closed on
  // the marker only when no grant exists at all.
  const blockedState = storedGrants.size === 0
    ? ids.map((id) => oauthGrantState(ctx, owner, id)).find(isBlockedOAuthState)
    : undefined;
  if (blockedState) {
    return json({ error: blockedState }, blockedState === "step_up_required" ? 403 : 401);
  }
  const tokens = await profileOAuthTokens(ctx, owner);
  for (const [id, stored] of storedGrants) {
    if (!tokens[id]) {
      tokens[id] = stored;
    }
  }
  const grantId = ids.find((id) => Boolean(tokens[id]));
  if (!grantId) {
    // Metadata only — never token material. Tells the caller exactly which
    // ids were consulted and why each one cannot authenticate.
    const detail = ids.map((id) => oauthDiagnostic(ctx, owner, id));
    return json({ error: "server_auth_missing", detail }, 404);
  }
  const grant = tokens[grantId];
  const server = {
    id: grantId,
    name: grantId,
    kind: "mcp" as const,
    url: grant.mcpUrl ?? grant.tokenEndpoint,
    headers: {},
    omitMcpHeaders: false,
    disabledTools: [],
    oauth: grant,
  };
  const refreshed: RefreshedOAuth[] = [];
  const persist = (rotated: RefreshedOAuth): Promise<void> => persistCanonicalOAuthGrant(ctx, owner, rotated);
  const begin = (id: string): Promise<void> => markOAuthRefreshStarted(ctx, owner, id);
  const outcome = body.force === true
    ? await forceRefreshCloudOAuthOutcome(server, refreshed, persist, begin)
    : await ensureFreshCloudOAuth(server, refreshed, persist, begin);
  if (outcome?.ok === false) {
    await recordOAuthFailure(ctx, owner, grantId, outcome);
    return json(
      { error: outcome.transient ? "retryable_error" : oauthGrantState(ctx, owner, grantId) },
      outcome.transient ? 503 : 401,
    );
  }
  if (storedGrants.has(grantId) && !pendingStepUp(ctx.sql, owner, grantId)) {
    // The grant is durable and just leased successfully — clear any stale
    // reauth/step-up marker so later leases stop tripping over it (a pending
    // insufficient_scope step-up waits for the wider sign-in instead).
    markOAuthReady(ctx, owner, grantId);
  }
  return json({ authorization: `Bearer ${server.oauth?.accessToken ?? grant.accessToken}` });
}

/**
 * POST /mcp/resolve { ids, force? } — internal: resolves this account's
 * connected MCP servers for a project agent run. Reuses the exact
 * cloud-automation pipeline (profile blob + rotation overlays); expiring —
 * or force-listed — sign-ins are refreshed here and the rotated pairs
 * persist to this shard, so browsers and later runs adopt them. Project
 * agents inherit the account's loading mode and catalog cache, so their
 * runs can defer without a fresh handshake. Credentials never leave the
 * backend.
 */
export async function handleMcpResolve(ctx: OAuthStoreContext, request: Request, owner: string): Promise<Response> {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  const ids =
    isRecord(body) && Array.isArray(body.ids)
      ? body.ids.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 8)
      : [];
  const force = new Set(
    isRecord(body) && Array.isArray(body.force)
      ? body.force.filter((item): item is string => typeof item === "string")
      : [],
  );
  if (ids.length === 0) {
    return json({ servers: [] });
  }
  const resolved = await resolveOwnerMcpServers(ctx, owner, ids, force);
  if (!resolved) {
    return json({ servers: [] });
  }
  const catalog = createSqlMcpCatalogStore(ctx.sql, owner);
  return json({
    servers: resolved.servers,
    toolLoading: resolved.toolLoading,
    catalog: resolved.servers.flatMap((server) => {
      const entry = catalog.read(server.id);
      return entry ? [entry] : [];
    }),
  });
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
