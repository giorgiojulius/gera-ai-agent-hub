// Shared client for the Gera backend Worker — one base URL, one
// Bearer-token fetch with a single refresh retry, one error parser.
import {
  authSessionSnapshot,
  getAccessToken,
  isAuthSessionCurrent,
  refreshAccessToken,
} from "@/lib/auth-tokens";

export const FUNCTIONS_URL: string = (() => {
  const url = import.meta.env.EXPO_PUBLIC_RORK_FUNCTIONS_URL;
  if (typeof url === "string" && url.length > 0) {
    return url.replace(/\/+$/, "");
  }
  return "https://gera-ai-agent-hub-backend.rork.app";
})();

export class AuthSessionChangedError extends Error {
  constructor() {
    super("The signed-in Gera account changed while this request was running.");
    this.name = "AuthSessionChangedError";
  }
}

function accessTokenForSession(sessionNonce: string): string | null {
  if (!isAuthSessionCurrent(sessionNonce)) {
    throw new AuthSessionChangedError();
  }
  const token = getAccessToken();
  if (!isAuthSessionCurrent(sessionNonce)) {
    throw new AuthSessionChangedError();
  }
  return token;
}

/** Authenticated fetch pinned to one account session across retries and multi-round callers. */
export async function authedFetchForSession(
  path: string,
  sessionNonce: string,
  init?: RequestInit,
): Promise<Response> {
  const attempt = (token: string | null): Promise<Response> => {
    if (!isAuthSessionCurrent(sessionNonce)) {
      throw new AuthSessionChangedError();
    }
    return fetch(`${FUNCTIONS_URL}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  };
  let response = await attempt(accessTokenForSession(sessionNonce));
  if (!isAuthSessionCurrent(sessionNonce)) {
    throw new AuthSessionChangedError();
  }
  if (response.status === 401) {
    const refreshed = await refreshAccessToken();
    if (!isAuthSessionCurrent(sessionNonce)) {
      throw new AuthSessionChangedError();
    }
    if (refreshed) {
      response = await attempt(refreshed);
    }
  }
  return response;
}

/** Fetch with the current stored Bearer token, pinned through its refresh retry. */
export function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  return authedFetchForSession(path, authSessionSnapshot(), init);
}

export class RelayAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayAccessError";
  }
}

/**
 * Authenticated browser relay request. Gera's JWT occupies Authorization so
 * the platform can stamp identity; an upstream provider Authorization value
 * rides in a dedicated internal header that the Worker remaps and never leaks.
 * A 401 from the provider is not mistaken for a dead Gera session.
 */
export async function relayFetch(path: string, target: string, init?: RequestInit): Promise<Response> {
  const sessionNonce = authSessionSnapshot();
  const baseHeaders = new Headers(init?.headers);
  const upstreamAuthorization = baseHeaders.get("Authorization");
  baseHeaders.delete("Authorization");
  baseHeaders.set("X-Gera-Upstream-Url", target);
  if (upstreamAuthorization) {
    baseHeaders.set("X-Gera-Upstream-Authorization", upstreamAuthorization);
  }
  const attempt = (token: string | null): Promise<Response> => {
    if (!isAuthSessionCurrent(sessionNonce)) {
      throw new AuthSessionChangedError();
    }
    const headers = new Headers(baseHeaders);
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return fetch(`${FUNCTIONS_URL}${path}`, { ...init, headers });
  };
  let response = await attempt(accessTokenForSession(sessionNonce));
  if (!isAuthSessionCurrent(sessionNonce)) {
    throw new AuthSessionChangedError();
  }
  if (response.status === 401 && response.headers?.get?.("X-Gera-Relay-Auth") === "required") {
    const refreshed = await refreshAccessToken();
    if (!isAuthSessionCurrent(sessionNonce)) {
      throw new AuthSessionChangedError();
    }
    if (refreshed) {
      response = await attempt(refreshed);
    }
  }
  const relayAuth = response.headers?.get?.("X-Gera-Relay-Auth") ?? null;
  if (relayAuth) {
    throw new RelayAccessError(
      relayAuth === "forbidden"
        ? "Your Gera account no longer has access to external connectors."
        : "Sign in to Gera again before using external connectors.",
    );
  }
  return response;
}

/** Resolves the JSON body, or throws the backend's error code / a fallback. */
export async function parseOrThrow<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${fallback} (${response.status})`);
  }
  return (await response.json()) as T;
}
