// Shared Rork Auth token storage — used by the auth hook and the access API
// client so a mid-session token refresh works from either side.

export const ACCESS_TOKEN_KEY = "rork:access_token";
export const REFRESH_TOKEN_KEY = "rork:refresh_token";
export const CODE_VERIFIER_KEY = "rork:pkce_verifier";
export const AUTH_FLOW_NONCE_KEY = "rork:auth_flow_nonce";
export const AUTH_FLOW_ATTEMPT_KEY = "rork:auth_flow_attempt";
export const AUTH_SESSION_NONCE_KEY = "rork:auth_session_nonce";

export const AUTH_URL: string = import.meta.env.EXPO_PUBLIC_RORK_AUTH_URL ?? "";
export const APP_KEY: string = import.meta.env.EXPO_PUBLIC_RORK_APP_KEY ?? "";

const refreshInFlight = new Map<string, Promise<string | null>>();
let memorySessionNonce = "";

function newSessionNonce(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(24);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Persistent account-session boundary shared by every tab in this browser. */
export function authSessionSnapshot(): string {
  if (typeof localStorage === "undefined") {
    memorySessionNonce ||= newSessionNonce();
    return memorySessionNonce;
  }
  const stored = localStorage.getItem(AUTH_SESSION_NONCE_KEY);
  if (stored) {
    return stored;
  }
  const created = newSessionNonce();
  localStorage.setItem(AUTH_SESSION_NONCE_KEY, created);
  return created;
}

/** True only while logout/account replacement has not crossed the snapshot. */
export function isAuthSessionCurrent(snapshot: string): boolean {
  if (!snapshot) {
    return false;
  }
  if (typeof localStorage === "undefined") {
    return memorySessionNonce === snapshot;
  }
  return localStorage.getItem(AUTH_SESSION_NONCE_KEY) === snapshot;
}

/** Cancels late async auth/provider work in this and every other open tab. */
export function invalidateAuthSession(): string {
  if (typeof localStorage === "undefined") {
    memorySessionNonce = newSessionNonce();
    refreshInFlight.clear();
    return memorySessionNonce;
  }
  const next = newSessionNonce();
  localStorage.setItem(AUTH_SESSION_NONCE_KEY, next);
  refreshInFlight.clear();
  return next;
}

export function getAccessToken(): string | null {
  return typeof localStorage === "undefined" ? null : localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function clearTokens(): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  // PKCE attempts live in sessionStorage so a callback in one tab can never
  // consume or clear another tab's verifier. Remove legacy local copies too.
  localStorage.removeItem(CODE_VERIFIER_KEY);
  localStorage.removeItem(AUTH_FLOW_NONCE_KEY);
  localStorage.removeItem(AUTH_FLOW_ATTEMPT_KEY);
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.removeItem(CODE_VERIFIER_KEY);
    sessionStorage.removeItem(AUTH_FLOW_NONCE_KEY);
    sessionStorage.removeItem(AUTH_FLOW_ATTEMPT_KEY);
  }
}

async function withCrossTabLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(name, operation);
  }
  return operation();
}

function siblingRefreshResult(sessionNonce: string, originalRefresh: string): string | null {
  if (!isAuthSessionCurrent(sessionNonce)) {
    return null;
  }
  const currentRefresh = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (currentRefresh && currentRefresh !== originalRefresh) {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  }
  return null;
}

/** A delayed 401 for an older access token adopts the already-refreshed generation. */
function replacementForRejectedAccess(
  sessionNonce: string,
  rejectedAccessToken: string | null | undefined,
): string | null {
  if (rejectedAccessToken === undefined || !isAuthSessionCurrent(sessionNonce)) {
    return null;
  }
  const currentAccess = localStorage.getItem(ACCESS_TOKEN_KEY);
  return currentAccess && currentAccess !== rejectedAccessToken ? currentAccess : null;
}

/**
 * Exchanges the stored refresh token for a fresh access token. Web Locks make
 * the redeem single-flight across tabs; nonce + access/refresh CAS makes a
 * response from a logged-out/replaced account inert and adopts a sibling tab's
 * winner. When called after a 401, pass the rejected access token: delayed 401s
 * from the old generation then reuse the new access token instead of rotating
 * the account session once per concurrent request.
 */
export function refreshAccessToken(
  rejectedAccessToken?: string | null,
): Promise<string | null> {
  if (typeof localStorage === "undefined") {
    return Promise.resolve(null);
  }
  const sessionNonce = authSessionSnapshot();
  const replacement = replacementForRejectedAccess(sessionNonce, rejectedAccessToken);
  if (replacement) {
    return Promise.resolve(replacement);
  }
  const refresh = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!refresh || !AUTH_URL || !APP_KEY || !sessionNonce) {
    return Promise.resolve(null);
  }
  const key = JSON.stringify([sessionNonce, refresh]);
  const existing = refreshInFlight.get(key);
  if (existing) {
    return existing;
  }
  const task = withCrossTabLock("gera:auth-refresh", async (): Promise<string | null> => {
    if (!isAuthSessionCurrent(sessionNonce)) {
      return null;
    }
    const newerBeforeRedeem = replacementForRejectedAccess(sessionNonce, rejectedAccessToken);
    if (newerBeforeRedeem) {
      return newerBeforeRedeem;
    }
    if (localStorage.getItem(REFRESH_TOKEN_KEY) !== refresh) {
      return siblingRefreshResult(sessionNonce, refresh);
    }
    try {
      const response = await fetch(`${AUTH_URL}/oauth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_key: APP_KEY, refresh_token: refresh }),
      });
      if (!isAuthSessionCurrent(sessionNonce)) {
        return null;
      }
      const newerAfterRedeem = replacementForRejectedAccess(sessionNonce, rejectedAccessToken);
      if (newerAfterRedeem) {
        return newerAfterRedeem;
      }
      if (localStorage.getItem(REFRESH_TOKEN_KEY) !== refresh) {
        return siblingRefreshResult(sessionNonce, refresh);
      }
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as { access_token?: unknown; refresh_token?: unknown };
      if (!isAuthSessionCurrent(sessionNonce)) {
        return null;
      }
      const newerBeforeCommit = replacementForRejectedAccess(sessionNonce, rejectedAccessToken);
      if (newerBeforeCommit) {
        return newerBeforeCommit;
      }
      if (localStorage.getItem(REFRESH_TOKEN_KEY) !== refresh) {
        return siblingRefreshResult(sessionNonce, refresh);
      }
      if (typeof data.access_token !== "string" || data.access_token.length === 0) {
        return null;
      }
      if (typeof data.refresh_token === "string" && data.refresh_token.length > 0) {
        localStorage.setItem(REFRESH_TOKEN_KEY, data.refresh_token);
      }
      localStorage.setItem(ACCESS_TOKEN_KEY, data.access_token);
      return data.access_token;
    } catch {
      return replacementForRejectedAccess(sessionNonce, rejectedAccessToken) ?? siblingRefreshResult(sessionNonce, refresh);
    }
  });
  refreshInFlight.set(key, task);
  void task.finally(() => {
    if (refreshInFlight.get(key) === task) {
      refreshInFlight.delete(key);
    }
  });
  return task;
}
