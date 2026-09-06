import { fetchPublicHttps } from "./network-safety";
import { githubRequestHeaders } from "./native-github";

export type GitHubAccountRelayContext<A> = {
  corsHeaders: Record<string, string>;
  corsJson(data: unknown, status: number): Response;
  requireAccount(request: Request): Promise<A | Response>;
  readBoundedText(request: Request, limit: number): Promise<string | null>;
  shardCall(requestUrl: string, account: A, path: string, init: RequestInit): Promise<Response>;
};
type LeaseOutcome = { ok: true; authorization: string } | { ok: false; response: Response };
/** A failed lease returns only allowlisted non-secret auth/infrastructure codes, never grant data. */
export async function leaseGitHubAccount<A>(ctx: GitHubAccountRelayContext<A>, requestUrl: string, account: A, serverId: string, force: boolean): Promise<LeaseOutcome> {
  const response = await ctx.shardCall(requestUrl, account, "/mcp/auth-lease", { method: "POST", body: JSON.stringify({ serverId, catalogId: "github", force }) });
  const data = await response.json().catch(() => ({})) as { authorization?: unknown; error?: unknown };
  if (response.ok && typeof data.authorization === "string" && data.authorization) return { ok: true, authorization: data.authorization };
  const status = response.status === 403 ? 403 : response.status >= 500 ? 503 : 401;
  const allowed = ["step_up_required", "reauth_required", "retryable_error", "identity_unavailable", "account_shard_unavailable", "server_auth_missing"];
  const code = typeof data.error === "string" && allowed.includes(data.error) ? data.error : status === 503 ? "account_shard_unavailable" : "github_sign_in_required";
  return { ok: false, response: ctx.corsJson({ error: code }, status) };
}
/** Account-owned GitHub REST and log relay; provider auth never enters a public response. */
export async function relayGitHubAccount<A>(ctx: GitHubAccountRelayContext<A>, request: Request, url: URL): Promise<Response> {
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return ctx.corsJson({ error: "method_not_allowed" }, 405);
  const account = await ctx.requireAccount(request);
  if (account instanceof Response) return account;
  const serverId = url.searchParams.get("serverId") ?? "github";
  const rawPath = url.searchParams.get("path") ?? "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(serverId) || !rawPath.startsWith("/") || rawPath.length > 4_000) return ctx.corsJson({ error: "invalid_github_request" }, 400);
  let target: URL;
  try { target = new URL(rawPath, "https://api.github.com"); }
  catch { return ctx.corsJson({ error: "invalid_github_request" }, 400); }
  if (target.origin !== "https://api.github.com" || target.username || target.password || target.pathname.split("/").some((segment) => segment === "." || segment === "..")) return ctx.corsJson({ error: "invalid_github_request" }, 400);
  const body = request.method === "GET" ? undefined : await ctx.readBoundedText(request, 2_000_000);
  if (body === null) return ctx.corsJson({ error: "body_too_large" }, 413);
  const execute = async (force: boolean): Promise<{ upstream: Response } | { refused: Response }> => {
    const lease = await leaseGitHubAccount(ctx, request.url, account, serverId, force);
    if (lease.ok === false) return { refused: lease.response };
    const upstream = await fetchPublicHttps(target.toString(), {
      method: request.method,
      headers: githubRequestHeaders(lease.authorization, body !== undefined, request.headers.get("X-Gera-GitHub-Accept") ?? "application/vnd.github+json"),
      body, signal: AbortSignal.timeout(30_000),
    }, { allowCrossOriginGet: request.method === "GET" });
    return { upstream };
  };
  let result = await execute(false);
  if ("refused" in result) return result.refused;
  if (result.upstream.status === 401) {
    await result.upstream.body?.cancel().catch(() => undefined);
    result = await execute(true);
  }
  if ("refused" in result) return result.refused;
  const headers = new Headers(ctx.corsHeaders);
  for (const name of ["Content-Type", "Content-Disposition", "X-GitHub-SSO", "X-OAuth-Scopes", "X-Accepted-OAuth-Scopes", "X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After", "Link"]) {
    const value = result.upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(result.upstream.body, { status: result.upstream.status, headers });
}
