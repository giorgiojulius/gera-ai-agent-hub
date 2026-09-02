// Shared client for the Gera backend Worker — one base URL, one
// Bearer-token fetch with a single refresh retry, one error parser.
import {
  authSessionSnapshot,
  getAccessToken,
  isAuthSessionCurrent,
  refreshAccessToken,
} from "@/lib/auth-tokens";
import { redactSecrets, withDiagnosticContext } from "@/lib/diagnostic-context";
import { FUNCTIONS_URL } from "@/lib/functions-url";

export { FUNCTIONS_URL };

/**
 * One failed backend round-trip, as the diagnostics journal wants to see it:
 * the route, the verdict, and the (already redacted) body — never the
 * request's Authorization header or any credential.
 */
export type BackendFailure = {
  method: string;
  /** Path + query as sent, with credential-shaped query values redacted. */
  path: string;
  status: number | null;
  /** Response headers that explain a failure (relay auth, rate limits, request ids). */
  headers: Record<string, string>;
  /** Redacted body excerpt for non-streaming JSON/text answers. */
  body: string;
  /** Network-level failure when no response arrived at all. */
  error?: unknown;
  /** Request body keys/ids that identify what was asked for (never values). */
  request?: string;
  durationMs: number;
};

type BackendFailureObserver = (failure: BackendFailure) => void;

let failureObserver: BackendFailureObserver | null = null;

/**
 * Registers the sink for failed backend calls. The diagnostics journal
 * installs itself here at import time; keeping the hook here (instead of
 * importing the journal) avoids a module cycle and lets tests observe calls.
 */
export function setBackendFailureObserver(observer: BackendFailureObserver | null): void {
  failureObserver = observer;
}

const FAILURE_BODY_CHARS = 2_400;
const FAILURE_HEADERS = [
  "X-Gera-Relay-Auth",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
  "Retry-After",
  "Content-Type",
  "CF-Ray",
  "X-OAuth-Scopes",
];

/** Journal-of-the-journal would recurse; its own routes are never observed. */
function observed(path: string): boolean {
  return failureObserver !== null && !path.startsWith("/diag/");
}

/** Identifies WHAT was requested from a JSON request body without copying values that could be secrets. */
function describeRequestBody(body: BodyInit | null | undefined): string | undefined {
  if (typeof body !== "string" || !body) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const idKeys = ["serverId", "catalogId", "id", "chatId", "runId", "agentId", "automationId", "projectId", "reason", "mode", "kind"];
    const parts: string[] = [];
    for (const key of idKeys) {
      const value = record[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        parts.push(`${key}=${String(value).slice(0, 80)}`);
      }
    }
    const server = record.server;
    if (server && typeof server === "object" && !Array.isArray(server)) {
      const nested = server as Record<string, unknown>;
      for (const key of ["id", "catalogId", "authMode", "credentialStored"]) {
        if (nested[key] !== undefined && typeof nested[key] !== "object") {
          parts.push(`server.${key}=${String(nested[key]).slice(0, 80)}`);
        }
      }
    }
    const keys = Object.keys(record).slice(0, 12).join(",");
    return `${parts.join(" ")}${parts.length > 0 ? " " : ""}keys=[${keys}]`.trim();
  } catch {
    return undefined;
  }
}

function captureHeaders(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FAILURE_HEADERS) {
    const value = response.headers?.get?.(name);
    if (value) {
      out[name] = value;
    }
  }
  return out;
}

/** Reports a non-OK response; the body is read from a clone so callers keep theirs. */
function reportFailedResponse(method: string, path: string, init: RequestInit | undefined, response: Response, startedAt: number): void {
  if (!observed(path)) {
    return;
  }
  const observer = failureObserver;
  if (!observer) {
    return;
  }
  const base: BackendFailure = {
    method,
    path: redactSecrets(path),
    status: response.status,
    headers: captureHeaders(response),
    body: "",
    request: describeRequestBody(init?.body),
    durationMs: Math.max(0, Date.now() - startedAt),
  };
  const type = response.headers?.get?.("Content-Type") ?? "";
  const readable = typeof response.clone === "function" && !type.includes("text/event-stream");
  if (!readable) {
    observer(base);
    return;
  }
  let clone: Response;
  try {
    clone = response.clone();
  } catch {
    observer(base);
    return;
  }
  void clone
    .text()
    .then((text) => {
      observer({ ...base, body: redactSecrets(text.slice(0, FAILURE_BODY_CHARS)) });
    })
    .catch(() => {
      observer(base);
    });
}

/** Reports a request that never produced a response (offline, DNS, CORS, abort). */
function reportNetworkFailure(method: string, path: string, init: RequestInit | undefined, error: unknown, startedAt: number): void {
  if (!observed(path) || error instanceof AuthSessionChangedError) {
    return;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return;
  }
  failureObserver?.({
    method,
    path: redactSecrets(path),
    status: null,
    headers: {},
    body: "",
    error,
    request: describeRequestBody(init?.body),
    durationMs: Math.max(0, Date.now() - startedAt),
  });
}

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
  const method = (init?.method ?? "GET").toUpperCase();
  const startedAt = Date.now();
  const attemptedToken = accessTokenForSession(sessionNonce);
  let response: Response;
  try {
    response = await attempt(attemptedToken);
    if (!isAuthSessionCurrent(sessionNonce)) {
      throw new AuthSessionChangedError();
    }
    if (response.status === 401) {
      // Tie recovery to the token that actually received this 401. A sibling
      // request may already have refreshed while this response was in flight;
      // in that case refreshAccessToken adopts the newer access token instead of
      // rotating the account session again for every delayed response.
      const refreshed = await refreshAccessToken(attemptedToken);
      if (!isAuthSessionCurrent(sessionNonce)) {
        throw new AuthSessionChangedError();
      }
      if (refreshed) {
        response = await attempt(refreshed);
      }
    }
  } catch (error) {
    reportNetworkFailure(method, path, init, error, startedAt);
    throw error;
  }
  if (!response.ok) {
    reportFailedResponse(method, path, init, response, startedAt);
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
  const method = (init?.method ?? "GET").toUpperCase();
  const startedAt = Date.now();
  const journalPath = `${path} → ${target}`;
  const attemptedToken = accessTokenForSession(sessionNonce);
  let response: Response;
  try {
    response = await attempt(attemptedToken);
    if (!isAuthSessionCurrent(sessionNonce)) {
      throw new AuthSessionChangedError();
    }
    if (response.status === 401 && response.headers?.get?.("X-Gera-Relay-Auth") === "required") {
      const refreshed = await refreshAccessToken(attemptedToken);
      if (!isAuthSessionCurrent(sessionNonce)) {
        throw new AuthSessionChangedError();
      }
      if (refreshed) {
        response = await attempt(refreshed);
      }
    }
  } catch (error) {
    reportNetworkFailure(method, journalPath, init, error, startedAt);
    throw error;
  }
  const relayAuth = response.headers?.get?.("X-Gera-Relay-Auth") ?? null;
  if (relayAuth) {
    reportFailedResponse(method, journalPath, init, response, startedAt);
    throw withDiagnosticContext(
      new RelayAccessError(
        relayAuth === "forbidden"
          ? "Your Gera account no longer has access to external connectors."
          : "Sign in to Gera again before using external connectors.",
      ),
      { path: redactSecrets(journalPath), status: response.status, relayAuth },
    );
  }
  if (!response.ok) {
    reportFailedResponse(method, journalPath, init, response, startedAt);
  }
  return response;
}

/** Resolves the JSON body, or throws the backend's error code / a fallback. */
export async function parseOrThrow<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; detail?: unknown };
    const url = typeof response.url === "string" && response.url ? redactSecrets(response.url) : undefined;
    throw withDiagnosticContext(new Error(body.error ?? `${fallback} (${response.status})`), {
      status: response.status,
      ...(url ? { url } : {}),
      ...(body.error ? { code: body.error } : {}),
      ...(body.detail !== undefined ? { detail: body.detail } : {}),
    });
  }
  return (await response.json()) as T;
}
