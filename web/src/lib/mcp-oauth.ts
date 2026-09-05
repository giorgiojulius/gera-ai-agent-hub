/**
 * Browser side of MCP OAuth. The account shard owns the whole grant lifecycle
 * (RFC 9728 discovery, RFC 7591 registration, PKCE, code exchange, refresh,
 * sealing in the vault) — this module only drives the popup, polls the
 * server-side flow, and keeps a few non-secret markers in localStorage:
 * the per-state callback slot, the browser nonce that binds a flow to this
 * browser, and the "one active attempt per server" marker. No access token,
 * refresh token, or client registration is ever written here.
 */

import { authSessionSnapshot, isAuthSessionCurrent } from "@/lib/auth-tokens";
import { authedFetch, authedFetchForSession } from "@/lib/backend";

export const OAUTH_RESULT_KEY = "gera.mcp.oauth.result.v1";

/** Per-state callback slot so an older popup cannot erase a newer attempt's result. */
export function oauthResultStorageKey(state: string): string {
  return state ? `${OAUTH_RESULT_KEY}.${state}` : OAUTH_RESULT_KEY;
}

const ACTIVE_FLOW_PREFIX = "gera.mcp.oauth.flow.v1.";
const SERVER_FLOW_NONCE_PREFIX = "gera.mcp.oauth.server-flow.v1.";

/**
 * Storage keys older bundles used for browser-held grants and dynamic client
 * registrations. They are purged on boot and never read for authentication.
 */
export const LEGACY_OAUTH_TOKENS_KEY = "gera.mcp.oauth.tokens.v1";
export const LEGACY_OAUTH_TOKEN_ENTRY_PREFIX = "gera.mcp.oauth.token.v2.";
export const LEGACY_OAUTH_CLIENTS_KEY = "gera.mcp.oauth.clients.v1";

let oauthOperationGeneration = 0;

/** Same-tab generation plus the persistent account boundary shared across tabs. */
export type OAuthOperationBoundary = {
  generation: number;
  authSessionNonce: string;
};

/** Invalidates popup/device work that began under a previous Gera account. */
export function invalidateOAuthOperations(): void {
  oauthOperationGeneration += 1;
}

/** Snapshot used by popup/device flows before their first await. */
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

/** Registers the only sign-in/device attempt currently allowed to complete for this server. */
export function beginOAuthGrantFlow(serverId: string): OAuthGrantFlow {
  const flow = {
    serverId,
    flowId: randomString(),
    boundary: currentOAuthOperationBoundary(),
  };
  window.localStorage.setItem(activeFlowKey(serverId), flow.flowId);
  return flow;
}

/** True while this attempt is the newest one for its server and the account has not changed. */
export function isOAuthGrantFlowCurrent(flow: OAuthGrantFlow): boolean {
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

/**
 * Removes every grant or client registration an older bundle left in this
 * browser. Returns the server ids whose grants were dropped (so the caller can
 * mark those cards for a fresh sign-in) and whether anything was there at
 * all. Never throws — restricted storage simply reports nothing purged.
 */
export function purgeLegacyOAuthStorage(): { found: boolean; serverIds: string[] } {
  const serverIds = new Set<string>();
  let found = false;
  try {
    const storage = window.localStorage;
    const legacyMap = storage.getItem(LEGACY_OAUTH_TOKENS_KEY);
    if (legacyMap !== null) {
      found = true;
      try {
        const parsed = JSON.parse(legacyMap) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const id of Object.keys(parsed as Record<string, unknown>)) {
            if (id) {
              serverIds.add(id);
            }
          }
        }
      } catch {
        // malformed legacy map — still removed below
      }
      storage.removeItem(LEGACY_OAUTH_TOKENS_KEY);
    }
    if (storage.getItem(LEGACY_OAUTH_CLIENTS_KEY) !== null) {
      found = true;
      storage.removeItem(LEGACY_OAUTH_CLIENTS_KEY);
    }
    const doomed: string[] = [];
    const length = typeof storage.length === "number" ? storage.length : 0;
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(LEGACY_OAUTH_TOKEN_ENTRY_PREFIX)) {
        doomed.push(key);
      }
    }
    for (const key of doomed) {
      found = true;
      const raw = storage.getItem(key);
      // A literal "null" entry was a deletion marker, not a grant.
      if (raw !== null && raw !== "null") {
        try {
          serverIds.add(decodeURIComponent(key.slice(LEGACY_OAUTH_TOKEN_ENTRY_PREFIX.length)));
        } catch {
          // undecodable id — the key is still removed
        }
      }
      storage.removeItem(key);
    }
  } catch {
    // restricted storage — nothing to purge
  }
  return { found, serverIds: [...serverIds] };
}

/** Explicit user disconnect: revokes the server-owned grant (the browser holds none). */
export function clearOAuthToken(serverId: string, catalogId?: string): void {
  void authedFetch("/mcp/oauth-clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, reason: "disconnect", ...(catalogId ? { catalogId } : {}) }),
  }).catch(() => undefined);
}

/**
 * Must be called synchronously from a click handler so the browser allows the popup.
 * The window is navigated once discovery finishes.
 */
export function openOAuthPopup(): Window | null {
  return window.open("about:blank", "gera-mcp-oauth", "popup,width=560,height=720");
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

/** What the browser tells the account shard about a sign-in: ids and Advanced metadata, never credentials. */
export type OAuthSignInServer = {
  id: string;
  url: string;
  name: string;
  /** Pinned scopes (RFC 6749 §3.3); empty/undefined lets the server's hints decide. */
  oauthScopes?: string;
  /** Authorization-server metadata document override (public HTTPS). */
  authServerMetadataUrl?: string;
};

/** Runs OAuth without letting the browser receive a code exchange or provider token. */
export async function runOAuthSignIn(
  server: OAuthSignInServer,
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
      body: JSON.stringify({
        server: {
          id: server.id,
          url: server.url,
          name: server.name,
          ...(server.oauthScopes?.trim() ? { oauthScopes: server.oauthScopes.trim() } : {}),
          ...(server.authServerMetadataUrl?.trim() ? { authServerMetadataUrl: server.authServerMetadataUrl.trim() } : {}),
        },
      }),
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

/** Refresh this long before the recorded expiry to absorb clock skew and latency. */
const EXPIRY_SKEW_MS = 60_000;

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
