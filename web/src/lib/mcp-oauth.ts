/**
 * Browser-side OAuth 2.1 for MCP servers: RFC 9728 protected-resource discovery,
 * RFC 8414 authorization-server metadata, RFC 7591 dynamic client registration,
 * and PKCE (S256) with a popup redirect. Tokens live in localStorage. Every
 * HTTP request rides the Gera relay — the browser never talks to provider
 * OAuth endpoints directly.
 */

import { authSessionSnapshot, isAuthSessionCurrent } from "@/lib/auth-tokens";
import { authedFetch, authedFetchForSession, relayFetch } from "@/lib/backend";

export const OAUTH_RESULT_KEY = "gera.mcp.oauth.result.v1";

/** Per-state callback slot so an older popup cannot erase a newer attempt's result. */
export function oauthResultStorageKey(state: string): string {
  return state ? `${OAUTH_RESULT_KEY}.${state}` : OAUTH_RESULT_KEY;
}
export const OAUTH_TOKENS_KEY = "gera.mcp.oauth.tokens.v1";
export const OAUTH_TOKENS_CHANGED_EVENT = "gera:mcp-oauth-changed";
const CLIENTS_KEY = "gera.mcp.oauth.clients.v1";
const TOKEN_ENTRY_PREFIX = "gera.mcp.oauth.token.v2.";
const ACTIVE_FLOW_PREFIX = "gera.mcp.oauth.flow.v1.";
const SERVER_FLOW_NONCE_PREFIX = "gera.mcp.oauth.server-flow.v1.";

type StoredToken = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires. */
  expiresAt?: number;
  tokenEndpoint: string;
  clientId: string;
  resource?: string;
  /** Canonical MCP endpoint this grant was issued for; prevents URL-swap credential leaks. */
  mcpUrl?: string;
};

type AuthServerMeta = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  issuer?: string;
  codeChallengeMethodsSupported?: string[];
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
  iss?: string;
};

class OAuthTokenError extends Error {
  readonly code: string;
  readonly isFatal: boolean;

  constructor(message: string, code: string, isFatal: boolean = false) {
    super(message);
    this.name = "OAuthTokenError";
    this.code = code;
    this.isFatal = isFatal;
  }
}

/** OAuth error codes that mean the grant is dead and only a new sign-in can help. */
const FATAL_REFRESH_CODES = new Set<string>([
  "invalid_grant",
  // GitHub uses this non-standard spelling when a rotated refresh token is stale.
  "bad_refresh_token",
  "invalid_client",
  "unauthorized_client",
]);

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
const REFRESH_FAILURE_COOLDOWN_MS = 60_000;
type RefreshFailureCooldown = { grant: StoredToken; retryAfter: number };
const refreshFailureCooldowns = new Map<string, RefreshFailureCooldown>();
let oauthOperationGeneration = 0;

/** Same-tab generation plus the persistent account boundary shared across tabs. */
export type OAuthOperationBoundary = {
  generation: number;
  authSessionNonce: string;
};

/** Invalidates popup/refresh work that began under a previous Gera account. */
export function invalidateOAuthOperations(): void {
  oauthOperationGeneration += 1;
  refreshInFlight.clear();
  refreshFailureCooldowns.clear();
}

/** Snapshot used by popup/device/refresh flows before their first await. */
export function currentOAuthOperationBoundary(): OAuthOperationBoundary {
  return {
    generation: oauthOperationGeneration,
    authSessionNonce: authSessionSnapshot(),
  };
}

function isOAuthOperationCurrent(boundary: OAuthOperationBoundary): boolean {
  return (
    boundary.generation === oauthOperationGeneration &&
    isAuthSessionCurrent(boundary.authSessionNonce)
  );
}

export type OAuthGrantFlow = {
  serverId: string;
  flowId: string;
  boundary: OAuthOperationBoundary;
};

function activeFlowKey(serverId: string): string {
  return `${ACTIVE_FLOW_PREFIX}${encodeURIComponent(serverId)}`;
}

/** Registers the only sign-in/device attempt currently allowed to replace this server's grant. */
export function beginOAuthGrantFlow(serverId: string): OAuthGrantFlow {
  const flow = {
    serverId,
    flowId: randomString(),
    boundary: currentOAuthOperationBoundary(),
  };
  window.localStorage.setItem(activeFlowKey(serverId), flow.flowId);
  return flow;
}

function isOAuthGrantFlowCurrent(flow: OAuthGrantFlow): boolean {
  return (
    flow.serverId.length > 0 &&
    isOAuthOperationCurrent(flow.boundary) &&
    window.localStorage.getItem(activeFlowKey(flow.serverId)) === flow.flowId
  );
}

/** Clears an attempt marker without ever cancelling the newer attempt that replaced it. */
export function finishOAuthGrantFlow(flow: OAuthGrantFlow): void {
  if (window.localStorage.getItem(activeFlowKey(flow.serverId)) === flow.flowId) {
    window.localStorage.removeItem(activeFlowKey(flow.serverId));
  }
}

/** OAuth discovery, registration, exchange, and refresh all use the authenticated Gera relay. */
function oauthRelayFetch(target: string, init?: RequestInit): Promise<Response> {
  return relayFetch("/oauth-proxy", target, init);
}

function isUnsafeOAuthHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const blockedSuffixes = [
    ".localhost",
    ".local",
    ".internal",
    ".lan",
    ".home",
    ".home.arpa",
    ".test",
    ".invalid",
    ".nip.io",
    ".sslip.io",
    ".xip.io",
    ".localtest.me",
    ".lvh.me",
    ".vcap.me",
    ".traefik.me",
    ".local.gd",
  ];
  if (
    !host ||
    host === "localhost" ||
    host === "metadata.google.internal" ||
    blockedSuffixes.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix)) ||
    (!host.includes(".") && !host.includes(":"))
  ) {
    return true;
  }
  if (/^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(host)) {
    return true;
  }
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) {
    return true;
  }
  return (
    host === "::" ||
    host === "::1" ||
    /^(?:fc|fd|fe[89ab]|ff)/i.test(host) ||
    /^(?:::ffff:|::|64:ff9b(?::1)?::)(?:7f00:1|a00:|ac1[0-9a-f]:|a9fe:|c0a8:)/i.test(host)
  );
}

/** Rejects executable, insecure, credential-bearing, and local OAuth metadata endpoints. */
export function safeOAuthEndpoint(value: string, label: string = "OAuth endpoint"): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    isUnsafeOAuthHostname(parsed.hostname)
  ) {
    throw new Error(`${label} must be a public absolute HTTPS URL without embedded credentials.`);
  }
  return parsed.toString();
}

function canonicalMcpUrl(value: string): string {
  const parsed = new URL(safeOAuthEndpoint(value, "MCP endpoint"));
  parsed.hash = "";
  return parsed.toString();
}

function sameEndpoint(left: string, right: string): boolean {
  return left.replace(/\/$/, "") === right.replace(/\/$/, "");
}

function sameStoredGrant(left: StoredToken | undefined, right: StoredToken): boolean {
  return (
    left?.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.tokenEndpoint === right.tokenEndpoint &&
    left.clientId === right.clientId &&
    left.resource === right.resource &&
    left.mcpUrl === right.mcpUrl
  );
}

function tokenMatchesMcpUrl(token: StoredToken, mcpUrl?: string): boolean {
  if (!mcpUrl || !token.mcpUrl) {
    return true;
  }
  try {
    return sameEndpoint(token.mcpUrl, canonicalMcpUrl(mcpUrl));
  } catch {
    return false;
  }
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

function tokenEntryKey(serverId: string): string {
  return `${TOKEN_ENTRY_PREFIX}${encodeURIComponent(serverId)}`;
}

function loadTokens(): Record<string, StoredToken> {
  const tokens = loadJson<Record<string, StoredToken>>(OAUTH_TOKENS_KEY) ?? {};
  try {
    // Migrate legacy map entries independently. Per-server keys prevent two
    // tabs writing different connectors from clobbering one another's grant.
    for (const [serverId, token] of Object.entries(tokens)) {
      const key = tokenEntryKey(serverId);
      if (window.localStorage.getItem(key) === null) {
        window.localStorage.setItem(key, JSON.stringify(token));
      }
    }
    const storage = window.localStorage;
    const length = typeof storage.length === "number" ? storage.length : 0;
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(TOKEN_ENTRY_PREFIX)) {
        continue;
      }
      const encodedId = key.slice(TOKEN_ENTRY_PREFIX.length);
      let serverId: string;
      try {
        serverId = decodeURIComponent(encodedId);
      } catch {
        continue;
      }
      const raw = storage.getItem(key);
      if (raw === "null") {
        delete tokens[serverId];
        continue;
      }
      try {
        const token = parseStoredToken(raw ? JSON.parse(raw) : null);
        if (token) {
          tokens[serverId] = token;
        }
      } catch {
        // Ignore malformed per-entry storage; the legacy copy may still recover it.
      }
    }
  } catch {
    // Restricted storage falls back to the legacy map already loaded above.
  }
  return tokens;
}

/** Commits independent server entries, refreshes the legacy mirror, and wakes profile sync. */
function commitTokenChanges(
  changes: Record<string, StoredToken | null>,
  notify: boolean = true,
): void {
  try {
    for (const [serverId, token] of Object.entries(changes)) {
      window.localStorage.setItem(tokenEntryKey(serverId), token ? JSON.stringify(token) : "null");
    }
  } catch {
    // The legacy mirror below remains the fallback in restricted storage.
  }
  const tokens = loadTokens();
  for (const [serverId, token] of Object.entries(changes)) {
    refreshFailureCooldowns.delete(serverId);
    if (token) {
      tokens[serverId] = token;
    } else {
      delete tokens[serverId];
    }
  }
  saveJson(OAUTH_TOKENS_KEY, tokens);
  if (!notify) {
    return;
  }
  try {
    window.dispatchEvent(new Event(OAUTH_TOKENS_CHANGED_EVENT));
  } catch {
    // Tests, SSR, and restricted documents may not expose DOM events.
  }
}

function parseStoredToken(value: unknown): StoredToken | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<StoredToken>;
  if (
    typeof raw.accessToken !== "string" ||
    !raw.accessToken ||
    typeof raw.tokenEndpoint !== "string" ||
    typeof raw.clientId !== "string"
  ) {
    return null;
  }
  return {
    accessToken: raw.accessToken,
    refreshToken: typeof raw.refreshToken === "string" && raw.refreshToken ? raw.refreshToken : undefined,
    expiresAt:
      typeof raw.expiresAt === "number" && Number.isFinite(raw.expiresAt) ? raw.expiresAt : undefined,
    tokenEndpoint: raw.tokenEndpoint,
    clientId: raw.clientId,
    resource: typeof raw.resource === "string" && raw.resource ? raw.resource : undefined,
    mcpUrl: typeof raw.mcpUrl === "string" && raw.mcpUrl ? raw.mcpUrl : undefined,
  };
}

/** A grant is usable when its access token is live or its refresh token can renew it. */
export function hasOAuthToken(serverId: string, mcpUrl?: string): boolean {
  const token = loadTokens()[serverId];
  if (!token?.accessToken || !tokenMatchesMcpUrl(token, mcpUrl)) {
    return false;
  }
  return token.expiresAt === undefined || Date.now() < token.expiresAt || Boolean(token.refreshToken);
}

/** Whether a rejected access token can be repaired without asking the user to sign in. */
export function hasOAuthRefreshToken(serverId: string): boolean {
  return Boolean(loadTokens()[serverId]?.refreshToken);
}

/** Non-secret revision marker used to re-check a card when its grant changes. */
export function oauthTokenFingerprint(serverId: string): string {
  const token = loadTokens()[serverId];
  if (!token?.accessToken) {
    return "missing";
  }
  const material = `${token.accessToken}\u0000${token.refreshToken ?? ""}\u0000${token.expiresAt ?? 0}\u0000${token.mcpUrl ?? ""}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Adopts the grants carried by a newer synced profile. The profile payload
 * already crossed the authenticated account boundary; older code applied its
 * green MCP settings but discarded this half, producing a connected card with
 * no credential. Remote entries win for the same server, while local-only
 * grants survive until their own profile update syncs.
 */
export function adoptProfileOAuthTokens(raw: unknown): number {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return 0;
  }
  const tokens = loadTokens();
  const changes: Record<string, StoredToken | null> = {};
  let adopted = 0;
  for (const [serverId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!serverId) {
      continue;
    }
    const token = parseStoredToken(value);
    if (!token || JSON.stringify(tokens[serverId]) === JSON.stringify(token)) {
      continue;
    }
    tokens[serverId] = token;
    changes[serverId] = token;
    adopted += 1;
  }
  if (adopted > 0) {
    // This is a remote profile application, not a new local mutation: do not
    // bump the profile clock and immediately echo it back.
    commitTokenChanges(changes, false);
  }
  return adopted;
}

/**
 * Snapshot of every stored MCP sign-in. It rides inside the profile blob so
 * the account's cloud automation runs can use — and refresh — the same
 * grants server-side; the blob is per-account state, never shared.
 */
export function exportOAuthTokens(): Record<string, StoredToken> {
  return loadTokens();
}

/**
 * Drops only this browser's copy of a grant. Automatic housekeeping (an
 * expired local token, a dead session) must use this — never `clearOAuthToken`
 * — because the server-owned grant may be newer than what this tab knows:
 * revoking it server-side destroyed every fresh GitHub sign-in.
 */
export function dropLocalOAuthToken(serverId: string): void {
  if (loadTokens()[serverId]) {
    commitTokenChanges({ [serverId]: null });
  }
}

/** Explicit user disconnect: removes the browser copy AND revokes the server-owned grant. */
export function clearOAuthToken(serverId: string, catalogId?: string): void {
  dropLocalOAuthToken(serverId);
  void authedFetch("/mcp/oauth-clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, reason: "disconnect", ...(catalogId ? { catalogId } : {}) }),
  }).catch(() => undefined);
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
        mcpUrl: typeof token.mcpUrl === "string" && token.mcpUrl ? token.mcpUrl : undefined,
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
  const changes: Record<string, StoredToken | null> = {};
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
    changes[rotation.serverId] = rotation.token;
    adopted += 1;
  }
  if (adopted > 0) {
    commitTokenChanges(changes, false);
  }
  return adopted;
}

/**
 * Last-resort rescue before dropping a sign-in: ask the backend whether a
 * server run rotated this grant while the browser slept. Adopting the tip
 * repairs the session without a new sign-in; only a genuinely dead grant
 * falls through to Sign in.
 */
type ServerRotationLookup =
  | { status: "found"; token: StoredToken }
  | { status: "missing" }
  | { status: "unavailable" };

async function findRotationFromServer(
  serverId: string,
  currentAccessToken: string,
  boundary: OAuthOperationBoundary,
): Promise<ServerRotationLookup> {
  try {
    if (!isOAuthOperationCurrent(boundary)) {
      return { status: "unavailable" };
    }
    const response = await authedFetch("/mcp/oauth-rotations");
    if (!isOAuthOperationCurrent(boundary) || !response.ok) {
      return { status: "unavailable" };
    }
    const data = (await response.json()) as { rotations?: unknown };
    if (!isOAuthOperationCurrent(boundary)) {
      return { status: "unavailable" };
    }
    const token = parseServerOAuthRotations(data.rotations).find(
      (rotation) =>
        rotation.serverId === serverId &&
        rotation.token.accessToken !== currentAccessToken &&
        rotation.bases.includes(currentAccessToken),
    )?.token;
    return token ? { status: "found", token } : { status: "missing" };
  } catch {
    // A deployment/network gap proves nothing about the provider credential.
    // Keep the local pair so the next boot can retrieve a durable rotation tip.
    return { status: "unavailable" };
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
    resource?: string;
    mcpUrl?: string;
  },
  flow: OAuthGrantFlow,
): boolean {
  if (flow.serverId !== serverId || !isOAuthGrantFlowCurrent(flow)) {
    return false;
  }
  commitTokenChanges({ [serverId]: token });
  return true;
}

/** Returns an Authorization header value for a signed-in server, refreshing when close to expiry. */
export async function oauthAuthHeader(serverId: string, mcpUrl?: string): Promise<string | null> {
  const stored = loadTokens()[serverId];
  if (!stored?.accessToken || !tokenMatchesMcpUrl(stored, mcpUrl)) {
    return null;
  }
  const now = Date.now();
  const expiringSoon = stored.expiresAt !== undefined && now > stored.expiresAt - EXPIRY_SKEW_MS;
  if (expiringSoon && stored.refreshToken) {
    const refreshed = await refreshServerToken(serverId);
    if (refreshed) {
      return `Bearer ${refreshed}`;
    }
    // Refresh failed: the token may have been cleared (dead grant) or the
    // failure was transient — re-read and fall back only while access is
    // genuinely unexpired. Sending a known-expired token just creates another
    // 401 and used to turn temporary refresh outages into forced re-logins.
    const after = loadTokens()[serverId];
    const stillLive = after?.expiresAt === undefined || now < after.expiresAt;
    return after?.accessToken && stillLive ? `Bearer ${after.accessToken}` : null;
  }
  if (stored.expiresAt !== undefined && now >= stored.expiresAt) {
    // Local copy is dead — but the account shard may hold a fresh grant this
    // tab never saw. Drop only the browser copy; server relays keep working.
    dropLocalOAuthToken(serverId);
    return null;
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

async function withCrossTabOAuthLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(name, operation);
  }
  return operation();
}

function refreshLockName(stored: StoredToken): string {
  // Exact same-origin lock key. It is neither logged nor persisted, and keeps
  // duplicate server cards sharing one rotating grant in the same critical section.
  return `gera:mcp-refresh:${JSON.stringify([
    stored.tokenEndpoint,
    stored.clientId,
    stored.refreshToken ?? "",
    stored.resource ?? "",
    stored.mcpUrl ?? "",
  ])}`;
}

/**
 * Single-flight refresh across calls and browser tabs. The Web Lock is held
 * through provider exchange + local commit, so a rotating token is redeemed once.
 */
function refreshServerToken(serverId: string): Promise<string | null> {
  const inFlight = refreshInFlight.get(serverId);
  if (inFlight) {
    return inFlight;
  }
  const boundary = currentOAuthOperationBoundary();
  const stored = loadTokens()[serverId];
  if (!stored?.refreshToken) {
    return Promise.resolve(null);
  }
  const cooldown = refreshFailureCooldowns.get(serverId);
  if (cooldown) {
    if (!sameStoredGrant(cooldown.grant, stored)) {
      refreshFailureCooldowns.delete(serverId);
    } else if (Date.now() < cooldown.retryAfter) {
      return Promise.resolve(null);
    } else {
      refreshFailureCooldowns.delete(serverId);
    }
  }
  const task = withCrossTabOAuthLock(refreshLockName(stored), async (): Promise<string | null> => {
    if (!isOAuthOperationCurrent(boundary)) {
      return null;
    }
    const before = loadTokens()[serverId];
    if (before?.accessToken && !sameStoredGrant(before, stored)) {
      return before.accessToken;
    }
    if (!sameStoredGrant(before, stored)) {
      return null;
    }
    try {
      const refreshed = await refreshAccessToken(serverId, stored);
      if (!isOAuthOperationCurrent(boundary)) {
        return null;
      }
      const latest = loadTokens()[serverId];
      if (latest?.accessToken && !sameStoredGrant(latest, stored)) {
        return latest.accessToken;
      }
      if (!sameStoredGrant(latest, stored)) {
        return null;
      }
      commitTokenChanges({ [serverId]: refreshed });
      return refreshed.accessToken;
    } catch (error) {
      if (!isOAuthOperationCurrent(boundary)) {
        return null;
      }
      if (error instanceof OAuthTokenError && (error.isFatal || FATAL_REFRESH_CODES.has(error.code))) {
        const sibling = loadTokens()[serverId];
        if (sibling?.accessToken && !sameStoredGrant(sibling, stored)) {
          return sibling.accessToken;
        }
        const rescued = await findRotationFromServer(serverId, stored.accessToken, boundary);
        if (!isOAuthOperationCurrent(boundary)) {
          return null;
        }
        const latest = loadTokens()[serverId];
        if (latest?.accessToken && !sameStoredGrant(latest, stored)) {
          return latest.accessToken;
        }
        if (rescued.status === "found" && sameStoredGrant(latest, stored)) {
          commitTokenChanges({ [serverId]: rescued.token });
          return rescued.token.accessToken;
        }
        // Only a successful account-shard lookup that confirms no rotation
        // makes a fatal provider rejection definitive. A rollout/relay failure
        // keeps the grant for the next deploy-safe retry.
        if (rescued.status === "missing" && sameStoredGrant(latest, stored)) {
          commitTokenChanges({ [serverId]: null });
          return null;
        }
      }
      const latest = loadTokens()[serverId];
      if (error instanceof OAuthTokenError && sameStoredGrant(latest, stored)) {
        // A provider/relay HTTP rejection may be observed by several mounted
        // cards or visibility wakes. Keep deploy-safe grants, but do not hammer
        // the account shard with the same pair until a short cooldown. A fetch
        // that vanished during publish is deliberately not cooled down: the
        // next bundle must immediately replay and adopt the durable winner.
        refreshFailureCooldowns.set(serverId, {
          grant: stored,
          retryAfter: Date.now() + REFRESH_FAILURE_COOLDOWN_MS,
        });
      }
      return null;
    }
  });
  refreshInFlight.set(serverId, task);
  void task.finally(() => {
    if (refreshInFlight.get(serverId) === task) {
      refreshInFlight.delete(serverId);
    }
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

/** Persists a provider grant in the authenticated account shard; no token is returned to app state. */
export async function storeOAuthTokenOnServer(serverId: string, token: StoredToken): Promise<void> {
  const response = await authedFetch("/mcp/oauth-store", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, token, mode: "replace" }),
    keepalive: true,
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(typeof data.error === "string" ? data.error : "Could not save MCP sign-in on the server.");
  }
  // Remove any legacy browser copy only after the server confirms durability.
  commitTokenChanges({ [serverId]: null });
}

/** One-time migration for grants created by older bundles. */
export async function migrateLegacyOAuthTokensToServer(): Promise<number> {
  const grants = exportOAuthTokens();
  if (Object.keys(grants).length === 0) return 0;
  const response = await authedFetch("/mcp/oauth-store", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grants, mode: "migrate" }),
    keepalive: true,
  });
  if (!response.ok) return 0;
  const data = (await response.json().catch(() => ({}))) as { settledIds?: unknown };
  const settledIds = Array.isArray(data.settledIds)
    ? data.settledIds.filter((id): id is string => typeof id === "string" && id in grants)
    : [];
  for (const serverId of settledIds) {
    commitTokenChanges({ [serverId]: null }, false);
  }
  return settledIds.length;
}

function serverFlowNonceKey(state: string): string {
  return `${SERVER_FLOW_NONCE_PREFIX}${state}`;
}

/** Completes the backend callback only in the same browser + Gera account that started it. */
export async function completeServerOAuthSignIn(state: string, callbackChallenge: string): Promise<void> {
  const browserNonce = window.localStorage.getItem(serverFlowNonceKey(state)) ?? "";
  if (!browserNonce || !callbackChallenge) {
    throw new Error("This OAuth link was opened outside the browser that started it.");
  }
  const session = authSessionSnapshot();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await authedFetchForSession("/mcp/oauth-complete", session, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, browserNonce, callbackChallenge }),
    });
    const data = (await response.json().catch(() => ({}))) as { error?: unknown; retryable?: unknown };
    if (response.ok) {
      window.localStorage.removeItem(serverFlowNonceKey(state));
      return;
    }
    if (data.retryable === true && attempt < 3 && isAuthSessionCurrent(session)) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 700 * (attempt + 1)));
      continue;
    }
    throw new Error(typeof data.error === "string" ? data.error : "OAuth confirmation failed.");
  }
}

/** Runs OAuth without letting the browser receive a code exchange or provider token. */
export async function runOAuthSignIn(
  server: { id: string; url: string; name: string },
  popup: Window | null,
): Promise<void> {
  if (!popup) {
    throw new Error("Popup was blocked. Allow popups for this site and press Sign in again.");
  }
  const flow = beginOAuthGrantFlow(server.id);
  const ensureCurrentAccount = (): void => {
    if (!isOAuthGrantFlowCurrent(flow)) {
      throw new Error("The Gera account changed while this sign-in was open. Start it again.");
    }
  };
  let flowState = "";
  try {
    const response = await authedFetch("/mcp/oauth-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: { id: server.id, url: server.url, name: server.name } }),
    });
    const start = (await response.json().catch(() => ({}))) as {
      authorizationUrl?: unknown;
      state?: unknown;
      browserNonce?: unknown;
      expiresAt?: unknown;
      error?: unknown;
    };
    if (
      !response.ok ||
      typeof start.authorizationUrl !== "string" ||
      typeof start.state !== "string" ||
      typeof start.browserNonce !== "string" ||
      typeof start.expiresAt !== "number"
    ) {
      throw new Error(
        typeof start.error === "string" ? start.error : "Could not start OAuth in the account store.",
      );
    }
    ensureCurrentAccount();
    flowState = start.state;
    window.localStorage.setItem(serverFlowNonceKey(start.state), start.browserNonce);
    popup.location.replace(start.authorizationUrl);

    while (Date.now() < start.expiresAt) {
      ensureCurrentAccount();
      const statusResponse = await authedFetch(
        `/mcp/oauth-status?state=${encodeURIComponent(start.state)}`,
      );
      const status = (await statusResponse.json().catch(() => ({}))) as {
        status?: unknown;
        error?: unknown;
      };
      ensureCurrentAccount();
      if (statusResponse.ok && status.status === "completed") {
        return;
      }
      if (status.status === "failed" || status.status === "missing") {
        throw new Error(
          typeof status.error === "string" ? status.error : "OAuth sign-in did not complete.",
        );
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 900));
    }
    throw new Error("OAuth sign-in expired before the provider completed it.");
  } catch (error) {
    try {
      popup.close();
    } catch {
      // ignore
    }
    throw error;
  } finally {
    finishOAuthGrantFlow(flow);
    // Completed callbacks already removed this; failed/cancelled attempts must
    // not leave a reusable browser proof behind.
    try {
      if (flowState) {
        window.localStorage.removeItem(serverFlowNonceKey(flowState));
      }
    } catch {
      // restricted storage — pending server state still expires
    }
  }
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await oauthRelayFetch(url, { headers: { Accept: "application/json" } });
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
  const target = new URL(safeOAuthEndpoint(mcpUrl, "MCP endpoint"));
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
      authServers = servers.map((server) => safeOAuthEndpoint(String(server), "OAuth issuer"));
      if (typeof prm?.resource === "string") {
        const advertisedResource = new URL(safeOAuthEndpoint(prm.resource, "OAuth resource"));
        if (advertisedResource.origin !== target.origin) {
          throw new Error("OAuth resource metadata points at a different origin than the MCP server.");
        }
        resource = advertisedResource.toString();
      }
      if (Array.isArray(prm?.scopes_supported)) {
        scopes = (prm.scopes_supported as unknown[]).map(String);
      }
      break;
    }
  }
  if (authServers.length === 0) {
    authServers = [target.origin];
  }
  resource ??= target.toString();

  for (const authServer of authServers) {
    const asUrl = new URL(safeOAuthEndpoint(authServer, "OAuth issuer"));
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
        const issuer = typeof meta?.issuer === "string" ? safeOAuthEndpoint(meta.issuer, "OAuth issuer") : undefined;
        if (issuer && !sameEndpoint(issuer, asUrl.toString())) {
          throw new Error("OAuth metadata issuer does not match the discovered authorization server.");
        }
        const methods = Array.isArray(meta?.code_challenge_methods_supported)
          ? (meta.code_challenge_methods_supported as unknown[]).map(String)
          : undefined;
        if (methods && !methods.includes("S256")) {
          throw new Error("This OAuth server does not advertise secure S256 PKCE.");
        }
        return {
          meta: {
            authorizationEndpoint: safeOAuthEndpoint(authorizationEndpoint, "OAuth authorization endpoint"),
            tokenEndpoint: safeOAuthEndpoint(tokenEndpoint, "OAuth token endpoint"),
            registrationEndpoint:
              typeof meta?.registration_endpoint === "string"
                ? safeOAuthEndpoint(meta.registration_endpoint, "OAuth registration endpoint")
                : undefined,
            scopesSupported: Array.isArray(meta?.scopes_supported)
              ? (meta.scopes_supported as unknown[]).map(String)
              : undefined,
            issuer: issuer ?? asUrl.toString(),
            codeChallengeMethodsSupported: methods,
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
    response = await oauthRelayFetch(registrationEndpoint, registerInit);
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

function waitForCallback(
  state: string,
  popup: Window,
  expectedIssuer: string | undefined,
  resultKey: string,
): Promise<string> {
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
      if (payload.iss && expectedIssuer && !sameEndpoint(payload.iss, expectedIssuer)) {
        fail("OAuth callback issuer did not match the server you authorized.");
      } else if (payload.code) {
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
      if (event.key === resultKey && event.newValue) {
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
      const raw = loadJson<CallbackPayload>(resultKey);
      if (raw) {
        handlePayload(raw);
        return;
      }
      if (popup.closed && closeGraceTimer === null) {
        closeGraceTimer = window.setTimeout(() => {
          const late = loadJson<CallbackPayload>(resultKey);
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
    response = await oauthRelayFetch(tokenEndpoint, {
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
  mcpUrl: string;
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
    mcpUrl: params.mcpUrl,
  };
}

async function refreshAccessToken(serverId: string, stored: StoredToken): Promise<StoredToken> {
  if (!stored.refreshToken) {
    throw new OAuthTokenError("No refresh token stored.", "invalid_grant");
  }
  let response: Response;
  try {
    response = await authedFetch("/mcp/oauth-refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // keepalive lets a publish-triggered page unload leave the small request
      // running long enough for the account shard to escrow the rotated pair.
      keepalive: true,
      body: JSON.stringify({ serverId, token: stored }),
    });
  } catch {
    throw new Error("Could not reach the Gera relay. Check your connection and try again.");
  }
  const data = (await response.json().catch(() => ({}))) as {
    token?: unknown;
    error?: unknown;
    error_description?: unknown;
    transient?: unknown;
  };
  const token = parseStoredToken(data.token);
  if (!response.ok || !token) {
    const code = typeof data.error === "string" ? data.error : "request_failed";
    const detail =
      (typeof data.error_description === "string" && data.error_description) ||
      code ||
      `token request failed (${response.status})`;
    // This authenticated endpoint already classifies provider failures. A
    // non-transient 400/409 means the stored grant cannot be redeemed (even
    // when the provider supplied only the generic `request_failed` code).
    // Treat it like invalid_grant so the rotation rescue can reconcile it once
    // instead of retrying the same pair on every background health check.
    const isFatal =
      data.transient !== true && (response.status === 400 || response.status === 409);
    throw new OAuthTokenError(`Sign-in failed: ${detail}`, code, isFatal);
  }
  if (
    token.clientId !== stored.clientId ||
    !sameEndpoint(token.tokenEndpoint, stored.tokenEndpoint) ||
    token.resource !== stored.resource ||
    token.mcpUrl !== stored.mcpUrl
  ) {
    throw new Error("The refreshed sign-in did not match the stored MCP grant boundary.");
  }
  return token;
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
