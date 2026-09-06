import { authSessionSnapshot, isAuthSessionCurrent } from "@/lib/auth-tokens";
import { authedFetchForSession, AuthSessionChangedError } from "@/lib/backend";
import { connectorCacheKey, assertConnectorScope } from "@/lib/connector-cache-scope";

export const GERA_ACCOUNT_AUTH_PREFIX = "gera-account:";
/** Definitive provider credential rejection, distinct from account/transport failures. */
export class GitHubAuthError extends Error {
  constructor(message: string) { super(message); this.name = "GitHubAuthError"; }
}
/** Parses a non-secret account reference; provider bearer tokens are never accepted. */
export function accountAuthServerId(auth: string): string | null {
  if (!auth.startsWith(GERA_ACCOUNT_AUTH_PREFIX)) return null;
  const id = auth.slice(GERA_ACCOUNT_AUTH_PREFIX.length).split("#")[0];
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}
/** Pins multi-page work to the account and connection that started it. */
export function githubAccountReference(serverId: string): string {
  return `${GERA_ACCOUNT_AUTH_PREFIX}${serverId}#${encodeURIComponent(connectorCacheKey(serverId))}`;
}
/** Validates a local pin and returns the server-side reference without browser-only metadata. */
export function githubWireReference(auth: string): string {
  const id = accountAuthServerId(auth);
  if (!id) throw new GitHubAuthError("Save and check the PAT on Gera's server, or sign in with GitHub first.");
  const pin = auth.indexOf("#");
  if (pin >= 0) {
    let scope = "";
    try { scope = decodeURIComponent(auth.slice(pin + 1)); } catch { throw new AuthSessionChangedError(); }
    assertConnectorScope(id, scope);
  }
  return `${GERA_ACCOUNT_AUTH_PREFIX}${id}`;
}
/** GitHub REST only through the account proxy; no direct or after-401 raw PAT fallback. */
export async function githubTransportFetch(auth: string, url: URL, init: RequestInit): Promise<Response> {
  githubWireReference(auth);
  const serverId = accountAuthServerId(auth)!;
  if (url.origin !== "https://api.github.com" || url.username || url.password) throw new Error("GitHub requests must stay on api.github.com.");
  const session = authSessionSnapshot();
  const scope = connectorCacheKey(serverId);
  const source = new Headers(init.headers);
  const headers: Record<string, string> = { "X-Gera-GitHub-Accept": source.get("Accept") ?? "application/vnd.github+json" };
  if (source.has("Content-Type")) headers["Content-Type"] = source.get("Content-Type")!;
  const response = await authedFetchForSession(`/github-proxy?serverId=${encodeURIComponent(serverId)}&path=${encodeURIComponent(`${url.pathname}${url.search}`)}`, session, { ...init, headers });
  if (!isAuthSessionCurrent(session)) throw new AuthSessionChangedError();
  assertConnectorScope(serverId, scope);
  githubWireReference(auth);
  return response;
}
