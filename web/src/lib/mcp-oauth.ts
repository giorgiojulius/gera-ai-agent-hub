/**
 * Browser-side OAuth 2.1 for MCP servers: RFC 9728 protected-resource discovery,
 * RFC 8414 authorization-server metadata, RFC 7591 dynamic client registration,
 * and PKCE (S256) with a popup redirect. Tokens live in localStorage. Every
 * HTTP request rides the Gera relay — the browser never talks to provider
 * OAuth endpoints directly.
 */

export const OAUTH_RESULT_KEY = "gera.mcp.oauth.result.v1";
const TOKENS_KEY = "gera.mcp.oauth.tokens.v1";
const CLIENTS_KEY = "gera.mcp.oauth.clients.v1";

type StoredToken = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires. */
  expiresAt?: number;
  tokenEndpoint: string;
  clientId: string;
  resource?: string;
};

type AuthServerMeta = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
};

type StoredClient = {
  clientId: string;
  redirectUri: string;
  /** Epoch ms when the registration itself expires (RFC 7591 client_secret_expires_at). */
  expiresAt?: number;
};

type CallbackPayload = {
  type?: string;
  state?: string;
  code?: string;
  error?: string;
};

class OAuthTokenError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "OAuthTokenError";
    this.code = code;
  }
}

/** OAuth error codes that mean the grant is dead and only a new sign-in can help. */
const FATAL_REFRESH_CODES = new Set<string>(["invalid_grant", "invalid_client", "unauthorized_client"]);

/** Refresh this long before the recorded expiry to absorb clock skew and latency. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * How long a sign-in stays alive after the popup reports closed. The closed
 * flag lies: providers that send Cross-Origin-Opener-Policy headers make the
 * browser sever the opener link on navigation, and popup.closed reads true
 * while the window is still open (Google/Okta SSO pages do this). Results
 * arrive through localStorage (storage event + poll) regardless of that
 * severance, so a long grace lets those sign-ins finish — only prolonged
 * silence after a close fails the flow.
 */
const CLOSED_POPUP_GRACE_MS = 10 * 60_000;

const refreshInFlight = new Map<string, Promise<string | null>>();

const FUNCTIONS_URL = (() => {
  const url = import.meta.env.EXPO_PUBLIC_RORK_FUNCTIONS_URL;
  if (typeof url === "string" && url.trim().length > 0) {
    return url.trim().replace(/\/$/, "");
  }
  return "https://gera-ai-agent-hub-backend.rork.app";
})();

/**
 * Every OAuth request — discovery, registration, token exchange, refresh —
 * goes through the Gera relay, the same backend that already carries all MCP
 * tool traffic. Many providers CORS-block their OAuth endpoints; direct
 * browser attempts only left red CORS noise in the console before falling
 * back, so the direct path is gone entirely. The relay forwards each request
 * verbatim, adds CORS on the way back, and never stores anything beyond the
 * exchange.
 */
function oauthProxyUrl(target: string): string {
  return `${FUNCTIONS_URL}/oauth-proxy?url=${encodeURIComponent(target)}`;
}

function loadJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage may be unavailable; sign-in will simply not persist
  }
}

function loadTokens(): Record<string, StoredToken> {
  return loadJson<Record<string, StoredToken>>(TOKENS_KEY) ?? {};
}

export function hasOAuthToken(serverId: string): boolean {
  return Boolean(loadTokens()[serverId]?.accessToken);
}

/**
 * Snapshot of every stored MCP sign-in. It rides inside the profile blob so
 * the account's cloud automation runs can use — and refresh — the same
 * grants server-side; the blob is per-account state, never shared.
 */
export function exportOAuthTokens(): Record<string, StoredToken> {
  return loadTokens();
}

export function clearOAuthToken(serverId: string): void {
  const tokens = loadTokens();
  if (tokens[serverId]) {
    delete tokens[serverId];
    saveJson(TOKENS_KEY, tokens);
  }
}

/** One server-rotated grant from the account backend: chain + freshest pair. */
export type ServerOAuthRotation = {
  serverId: string;
  /** Access tokens the chain superseded — ours must be among them to adopt. */
  bases: string[];
  token: StoredToken;
};

/** Validates the wire shape of sync/rescue rotation payloads. */
export function parseServerOAuthRotations(raw: unknown): ServerOAuthRotation[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ServerOAuthRotation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const entry = item as { serverId?: unknown; bases?: unknown; token?: unknown };
    if (typeof entry.serverId !== "string" || !entry.serverId || !Array.isArray(entry.bases)) {
      continue;
    }
    const bases = entry.bases.filter(
      (base): base is string => typeof base === "string" && base.length > 0,
    );
    const token = entry.token as Partial<StoredToken> | null | undefined;
    if (
      bases.length === 0 ||
      !token ||
      typeof token.accessToken !== "string" ||
      !token.accessToken ||
      typeof token.tokenEndpoint !== "string" ||
      typeof token.clientId !== "string"
    ) {
      continue;
    }
    out.push({
      serverId: entry.serverId,
      bases,
      token: {
        accessToken: token.accessToken,
        refreshToken:
          typeof token.refreshToken === "string" && token.refreshToken ? token.refreshToken : undefined,
        expiresAt:
          typeof token.expiresAt === "number" && Number.isFinite(token.expiresAt)
            ? token.expiresAt
            : undefined,
        tokenEndpoint: token.tokenEndpoint,
        clientId: token.clientId,
        resource: typeof token.resource === "string" && token.resource ? token.resource : undefined,
      },
    });
  }
  return out;
}

/**
 * Adopts server-rotated grants. Server runs redeem refresh tokens while this
 * browser sleeps; with refresh-token rotation the pair stored here dies at
 * the provider the moment that happens. Any stored token found on a
 * rotation's chain is replaced with the chain's tip, so the sign-in survives
 * exactly like it does in a single-process app. Foreign tokens (a fresh
 * sign-in) and already-adopted tips are left untouched.
 */
export function applyServerOAuthRotations(rotations: ServerOAuthRotation[]): number {
  if (rotations.length === 0) {
    return 0;
  }
  const tokens = loadTokens();
  let adopted = 0;
  for (const rotation of rotations) {
    const stored = tokens[rotation.serverId];
    if (!stored?.accessToken || stored.accessToken === rotation.token.accessToken) {
      continue;
    }
    if (!rotation.bases.includes(stored.accessToken)) {
      continue;
    }
    tokens[rotation.serverId] = rotation.token;
    adopted += 1;
  }
  if (adopted > 0) {
    saveJson(TOKENS_KEY, tokens);
  }
  return adopted;
}

/**
 * Last-resort rescue before dropping a sign-in: ask the backend whether a
 * server run rotated this grant while the browser slept. Adopting the tip
 * repairs the session without a new sign-in; only a genuinely dead grant
 * falls through to Sign in.
 */
async function adoptRotationFromServer(
  serverId: string,
  currentAccessToken: string,
): Promise<string | null> {
  try {
    const { authedFetch } = await import("@/lib/backend");
    const response = await authedFetch("/mcp/oauth-rotations");
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { rotations?: unknown };
    const match = parseServerOAuthRotations(data.rotations).find(
      (rotation) =>
        rotation.serverId === serverId &&
        rotation.token.accessToken !== currentAccessToken &&
        rotation.bases.includes(currentAccessToken),
    );
    if (!match) {
      return null;
    }
    const tokens = loadTokens();
    tokens[serverId] = match.token;
    saveJson(TOKENS_KEY, tokens);
    return match.token.accessToken;
  } catch {
    return null;
  }
}

/**
 * Stores a token obtained outside the popup flow (e.g. the GitHub device
 * flow) so the regular header resolution and refresh machinery pick it up.
 */
export function storeExternalOAuthToken(
  serverId: string,
  token: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    tokenEndpoint: string;
    clientId: string;
  },
): void {
  const tokens = loadTokens();
  tokens[serverId] = token;
  saveJson(TOKENS_KEY, tokens);
}

/** Returns an Authorization header value for a signed-in server, refreshing when close to expiry. */
export async function oauthAuthHeader(serverId: string): Promise<string | null> {
  const stored = loadTokens()[serverId];
  if (!stored?.accessToken) {
    return null;
  }
  const expiringSoon = stored.expiresAt !== undefined && Date.now() > stored.expiresAt - EXPIRY_SKEW_MS;
  if (expiringSoon && stored.refreshToken) {
    const refreshed = await refreshServerToken(serverId);
    if (refreshed) {
      return `Bearer ${refreshed}`;
    }
    // Refresh failed: the token may have been cleared (dead grant) or the
    // failure was transient — re-read and fall back to whatever is left.
    const after = loadTokens()[serverId];
    return after?.accessToken ? `Bearer ${after.accessToken}` : null;
  }
  return `Bearer ${stored.accessToken}`;
}

/**
 * Forces a refresh regardless of the recorded expiry. Used after a 401 so a
 * still-valid refresh token repairs the session without a new sign-in
 * (covers servers that omit expires_in or revoke tokens early).
 */
export async function forceRefreshOAuthHeader(serverId: string): Promise<string | null> {
  const refreshed = await refreshServerToken(serverId);
  return refreshed ? `Bearer ${refreshed}` : null;
}

/**
 * Single-flight refresh per server: concurrent tool calls share one token
 * request. Servers with refresh-token rotation revoke the whole grant when
 * the same refresh token is redeemed twice, so this must never race.
 */
function refreshServerToken(serverId: string): Promise<string | null> {
  const inFlight = refreshInFlight.get(serverId);
  if (inFlight) {
    return inFlight;
  }
  const task = (async (): Promise<string | null> => {
    const stored = loadTokens()[serverId];
    if (!stored?.refreshToken) {
      return null;
    }
    try {
      const refreshed = await refreshAccessToken(stored);
      const tokens = loadTokens();
      tokens[serverId] = refreshed;
      saveJson(TOKENS_KEY, tokens);
      return refreshed.accessToken;
    } catch (error) {
      if (error instanceof OAuthTokenError && FATAL_REFRESH_CODES.has(error.code)) {
        // Rotation makes refresh tokens single-use: when another tab redeemed
        // this pair first, its success is our invalid_grant. Never destroy
        // the fresher pair that tab stored — adopt it instead.
        const sibling = loadTokens()[serverId];
        if (
          sibling?.accessToken &&
          (sibling.accessToken !== stored.accessToken || sibling.refreshToken !== stored.refreshToken)
        ) {
          return sibling.accessToken;
        }
        // "Dead" also happens when a server run rotated this grant while the
        // browser slept — adopt the server's fresh pair when it chains from ours.
        const rescued = await adoptRotationFromServer(serverId, stored.accessToken);
        if (rescued) {
          return rescued;
        }
        // The rescue took network time — re-check for a sibling write before
        // the destructive step. Only a genuinely dead grant drops to Sign in.
        const latest = loadTokens()[serverId];
        if (
          latest?.accessToken &&
          (latest.accessToken !== stored.accessToken || latest.refreshToken !== stored.refreshToken)
        ) {
          return latest.accessToken;
        }
        clearOAuthToken(serverId);
      }
      return null;
    }
  })();
  refreshInFlight.set(serverId, task);
  void task.finally(() => {
    refreshInFlight.delete(serverId);
  });
  return task;
}

/**
 * Must be called synchronously from a click handler so the browser allows the popup.
 * The window is navigated once discovery finishes.
 */
export function openOAuthPopup(): Window | null {
  return window.open("about:blank", "gera-mcp-oauth", "popup,width=560,height=720");
}

/** Runs the full sign-in flow and stores the resulting token for the server id. */
export async function runOAuthSignIn(
  server: { id: string; url: string; name: string },
  popup: Window | null,
): Promise<void> {
  if (!popup) {
    throw new Error("Popup was blocked. Allow popups for this site and press Sign in again.");
  }
  let registrationKey: string | null = null;
  try {
    const redirectUri = `${window.location.origin}/oauth/callback`;
    const { meta, resource, scopes } = await discover(server.url);
    registrationKey = meta.registrationEndpoint ?? "";
    const clientId = await ensureClient(meta.registrationEndpoint, redirectUri);
    const verifier = randomString();
    const challenge = await sha256Base64Url(verifier);
    const state = randomString();

    try {
      window.localStorage.removeItem(OAUTH_RESULT_KEY);
    } catch {
      // ignore
    }

    const authorizeUrl = new URL(meta.authorizationEndpoint);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    if (resource) {
      authorizeUrl.searchParams.set("resource", resource);
    }
    const scope = composeAuthScope(scopes, meta.scopesSupported);
    if (scope) {
      authorizeUrl.searchParams.set("scope", scope);
    }

    popup.location.replace(authorizeUrl.toString());

    const code = await waitForCallback(state, popup);
    const token = await exchangeCode({
      tokenEndpoint: meta.tokenEndpoint,
      clientId,
      code,
      verifier,
      redirectUri,
      resource,
    });

    const tokens = loadTokens();
    tokens[server.id] = token;
    saveJson(TOKENS_KEY, tokens);
  } catch (error) {
    // A registration the provider expired or revoked would fail every future
    // sign-in straight from cache — forget it so the next attempt re-registers.
    if (registrationKey !== null && isClientRejection(error)) {
      dropCachedClient(registrationKey);
    }
    try {
      popup.close();
    } catch {
      // ignore
    }
    throw error;
  } finally {
    try {
      window.localStorage.removeItem(OAUTH_RESULT_KEY);
    } catch {
      // ignore
    }
  }
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(oauthProxyUrl(url), { headers: { Accept: "application/json" } });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function discover(
  mcpUrl: string,
): Promise<{ meta: AuthServerMeta; resource?: string; scopes?: string[] }> {
  const target = new URL(mcpUrl);
  const path = target.pathname.replace(/\/$/, "");

  let authServers: string[] = [];
  let resource: string | undefined;
  let scopes: string[] | undefined;

  const prmCandidates = [
    path ? `${target.origin}/.well-known/oauth-protected-resource${path}` : "",
    `${target.origin}/.well-known/oauth-protected-resource`,
  ].filter(Boolean);
  for (const candidate of prmCandidates) {
    const prm = await fetchJson(candidate);
    const servers = prm?.authorization_servers;
    if (Array.isArray(servers) && servers.length > 0) {
      authServers = servers.map(String);
      resource = typeof prm?.resource === "string" ? prm.resource : undefined;
      if (Array.isArray(prm?.scopes_supported)) {
        scopes = (prm.scopes_supported as unknown[]).map(String);
      }
      break;
    }
  }
  if (authServers.length === 0) {
    authServers = [target.origin];
  }

  for (const authServer of authServers) {
    const asUrl = new URL(authServer);
    const asPath = asUrl.pathname.replace(/\/$/, "");
    const metaCandidates = [
      asPath ? `${asUrl.origin}/.well-known/oauth-authorization-server${asPath}` : "",
      `${asUrl.origin}/.well-known/oauth-authorization-server`,
      asPath ? `${asUrl.origin}/.well-known/openid-configuration${asPath}` : "",
      `${asUrl.origin}/.well-known/openid-configuration`,
    ].filter(Boolean);
    for (const candidate of metaCandidates) {
      const meta = await fetchJson(candidate);
      const authorizationEndpoint =
        typeof meta?.authorization_endpoint === "string" ? meta.authorization_endpoint : null;
      const tokenEndpoint = typeof meta?.token_endpoint === "string" ? meta.token_endpoint : null;
      if (authorizationEndpoint && tokenEndpoint) {
        return {
          meta: {
            authorizationEndpoint,
            tokenEndpoint,
            registrationEndpoint:
              typeof meta?.registration_endpoint === "string" ? meta.registration_endpoint : undefined,
            scopesSupported: Array.isArray(meta?.scopes_supported)
              ? (meta.scopes_supported as unknown[]).map(String)
              : undefined,
          },
          resource,
          scopes,
        };
      }
    }
  }

  throw new Error("This server does not offer browser sign-in. Paste an API token instead.");
}

/**
 * Builds the authorize scope. Resource-advertised scopes win, but
 * offline_access is appended whenever the authorization server offers it and
 * the list omits it: without that scope many providers issue no refresh
 * token, and the sign-in silently dies at the first access-token expiry —
 * the "works for a day, then asks to sign in again" failure.
 */
export function composeAuthScope(
  resourceScopes: string[] | undefined,
  serverScopes: string[] | undefined,
): string | undefined {
  const scopes = [...(resourceScopes ?? serverScopes ?? [])];
  if (serverScopes?.includes("offline_access") && !scopes.includes("offline_access")) {
    scopes.push("offline_access");
  }
  return scopes.length > 0 ? scopes.join(" ") : undefined;
}

/**
 * True while a cached dynamic registration can still be reused for this
 * redirect. Some providers expire the registered client itself — reusing a
 * dead client id would fail every future sign-in until storage is cleared.
 */
export function isClientRegistrationUsable(
  cached: { clientId?: string; redirectUri?: string; expiresAt?: number } | undefined,
  redirectUri: string,
  now: number = Date.now(),
): boolean {
  if (!cached?.clientId || cached.redirectUri !== redirectUri) {
    return false;
  }
  if (typeof cached.expiresAt !== "number" || cached.expiresAt <= 0) {
    return true;
  }
  return now < cached.expiresAt - EXPIRY_SKEW_MS;
}

/** Forgets a cached registration so the next sign-in re-registers cleanly. */
function dropCachedClient(registrationKey: string): void {
  const clients = loadJson<Record<string, StoredClient>>(CLIENTS_KEY) ?? {};
  if (clients[registrationKey]) {
    delete clients[registrationKey];
    saveJson(CLIENTS_KEY, clients);
  }
}

/** The provider no longer recognizes our registered client id. */
function isClientRejection(error: unknown): boolean {
  if (error instanceof OAuthTokenError) {
    return error.code === "invalid_client" || error.code === "unauthorized_client";
  }
  return error instanceof Error && /invalid_client|unauthorized_client/i.test(error.message);
}

async function ensureClient(registrationEndpoint: string | undefined, redirectUri: string): Promise<string> {
  const clients = loadJson<Record<string, StoredClient>>(CLIENTS_KEY) ?? {};
  const key = registrationEndpoint ?? "";
  const cached = clients[key];
  if (cached && isClientRegistrationUsable(cached, redirectUri)) {
    return cached.clientId;
  }
  if (!registrationEndpoint) {
    throw new Error("This server does not support automatic app registration. Paste an API token instead.");
  }
  const registerInit: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Gera AI",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  };
  let response: Response;
  try {
    response = await fetch(oauthProxyUrl(registrationEndpoint), registerInit);
  } catch {
    throw new Error("Could not reach the Gera relay. Check your connection and try again.");
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      error_description?: unknown;
    };
    const code = typeof data.error === "string" ? data.error : "";
    if (code === "invalid_redirect_uri") {
      // Providers like Intercom allowlist redirect domains for pre-approved
      // apps only — no browser client outside that list can ever sign in.
      throw new Error(
        "This provider only allows sign-in from apps on its own allowlist and rejected this app's domain at registration. Use its API-token connector instead.",
      );
    }
    const detail =
      (typeof data.error_description === "string" && data.error_description) ||
      code ||
      `HTTP ${response.status}`;
    throw new Error(`The server rejected app registration: ${detail}`);
  }
  const data = (await response.json()) as { client_id?: unknown; client_secret_expires_at?: unknown };
  const clientId = typeof data.client_id === "string" ? data.client_id : null;
  if (!clientId) {
    throw new Error("The server returned no client id during registration.");
  }
  const expiresSec =
    typeof data.client_secret_expires_at === "number"
      ? data.client_secret_expires_at
      : Number(data.client_secret_expires_at ?? 0);
  clients[key] = {
    clientId,
    redirectUri,
    // RFC 7591: epoch seconds; 0 or absent means the registration never expires.
    expiresAt: Number.isFinite(expiresSec) && expiresSec > 0 ? expiresSec * 1000 : undefined,
  };
  saveJson(CLIENTS_KEY, clients);
  return clientId;
}

function waitForCallback(state: string, popup: Window): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let closeGraceTimer: number | null = null;

    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("storage", onStorage);
      window.clearInterval(poller);
      if (closeGraceTimer !== null) {
        window.clearTimeout(closeGraceTimer);
      }
    };
    const finish = (code: string) => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(code);
      }
    };
    const fail = (message: string) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(message));
      }
    };
    const handlePayload = (payload: CallbackPayload | null) => {
      if (!payload || payload.state !== state) {
        return;
      }
      if (payload.code) {
        finish(payload.code);
      } else {
        fail(payload.error || "Sign-in was denied.");
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }
      const data = event.data as CallbackPayload;
      if (data && data.type === "gera-mcp-oauth") {
        handlePayload(data);
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === OAUTH_RESULT_KEY && event.newValue) {
        try {
          handlePayload(JSON.parse(event.newValue) as CallbackPayload);
        } catch {
          // ignore malformed payloads
        }
      }
    };

    window.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);

    const poller = window.setInterval(() => {
      const raw = loadJson<CallbackPayload>(OAUTH_RESULT_KEY);
      if (raw) {
        handlePayload(raw);
        return;
      }
      if (popup.closed && closeGraceTimer === null) {
        closeGraceTimer = window.setTimeout(() => {
          const late = loadJson<CallbackPayload>(OAUTH_RESULT_KEY);
          if (late) {
            handlePayload(late);
          }
          fail("Sign-in window was closed. Press Sign in to try again.");
        }, CLOSED_POPUP_GRACE_MS);
      }
    }, 500);

    // No overall deadline: sign-in legitimately takes as long as the user
    // needs (SSO redirects, 2FA, password managers). The flow settles only
    // on a result — or a popup that stays silent past the closed-grace.
  });
}

async function requestToken(
  tokenEndpoint: string,
  body: URLSearchParams,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
  let response: Response;
  try {
    // Exactly one request per exchange, always through the relay — a single-use
    // authorization code is never burned by a second attempt on another path.
    response = await fetch(oauthProxyUrl(tokenEndpoint), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    // Plain Error, not OAuthTokenError: refresh treats relay unreachability as
    // transient and keeps the stored grant instead of dropping the sign-in.
    throw new Error("Could not reach the Gera relay. Check your connection and try again.");
  }
  const data = (await response.json().catch(() => ({}))) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    error_description?: unknown;
    error?: unknown;
  };
  if (!response.ok || typeof data.access_token !== "string") {
    const detail =
      (typeof data.error_description === "string" && data.error_description) ||
      (typeof data.error === "string" && data.error) ||
      `token request failed (${response.status})`;
    throw new OAuthTokenError(
      `Sign-in failed: ${detail}`,
      typeof data.error === "string" ? data.error : "request_failed",
    );
  }
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : Number(data.expires_in);
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
  };
}

async function exchangeCode(params: {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  resource?: string;
}): Promise<StoredToken> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.verifier,
  });
  if (params.resource) {
    body.set("resource", params.resource);
  }
  const token = await requestToken(params.tokenEndpoint, body);
  return {
    ...token,
    tokenEndpoint: params.tokenEndpoint,
    clientId: params.clientId,
    resource: params.resource,
  };
}

async function refreshAccessToken(stored: StoredToken): Promise<StoredToken> {
  if (!stored.refreshToken) {
    throw new OAuthTokenError("No refresh token stored.", "invalid_grant");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    client_id: stored.clientId,
  });
  if (stored.resource) {
    body.set("resource", stored.resource);
  }
  const token = await requestToken(stored.tokenEndpoint, body);
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? stored.refreshToken,
    expiresAt: token.expiresAt,
    tokenEndpoint: stored.tokenEndpoint,
    clientId: stored.clientId,
    resource: stored.resource,
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}
