// Worker-side relay routes for MCP: the account-shard control routes
// (`/mcp/*` state, OAuth start/complete, health checks, inventory), the
// browser grant refresh, the public OAuth callback that routes one state to
// one account shard, the rotations feed, and the plain Streamable HTTP relay
// the browser transport uses. Moved out of index.ts verbatim; the Worker
// injects its helpers through McpRelayContext (CORS shape, identity + invite
// gate, shard dispatch) so this module never sees the Env type.

import { shardFailureReason } from "./chat-shared";
import { isForbiddenHost, safePublicHttpsUrl } from "./network-safety";

/** What the relays need to know about an authenticated account. */
export type McpRelayAccount = { storageOwner: string; shardId: string };

export type McpRelayContext<A extends McpRelayAccount = McpRelayAccount> = {
  /** Durable Object namespace binding: OAuth state routes live in the AccessRegistry, callbacks land in account shards. */
  durable: { fetch(request: Request): Promise<Response> };
  corsHeaders: Record<string, string>;
  corsJson(data: unknown, status: number): Response;
  /** Platform identity + invite gate; a Response means "answer with this". */
  requireInvitedAccount(request: Request): Promise<A | Response>;
  /** Dispatches into the account's ChatStore shard (retries a redeploy reset once). */
  shardCall(
    requestUrl: string,
    account: A,
    path: string,
    options: { method: "GET" | "POST"; body?: string },
  ): Promise<Response>;
  /** Identity + invite gate for the plain HTTP relay (no shard involved). */
  relayAccessProblem(request: Request): Promise<Response | null>;
};

// ---------------------------------------------------------------------------
// Account-shard control routes.

/** GET /mcp/oauth-rotations — the account's pending grant rotations for the browser. */
export async function relayOAuthRotations(ctx: McpRelayContext, request: Request): Promise<Response> {
  try {
    if (request.method !== "GET") {
      return ctx.corsJson({ error: "not_found" }, 404);
    }
    const account = await ctx.requireInvitedAccount(request);
    if (account instanceof Response) {
      return account;
    }
    const upstream = await ctx.shardCall(request.url, account, "/mcp/oauth-rotations", { method: "GET" });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...ctx.corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("oauth rotations relay failed", error instanceof Error ? error.message : "error");
    return ctx.corsJson({ error: "upstream_unreachable" }, 502);
  }
}

const MCP_OAUTH_REFRESH_BODY_LIMIT = 64_000;

/** The app origin an OAuth popup may return to: Gera hosts, previews and local dev only. */
export function oauthAppOrigin(request: Request): string | null {
  const raw = request.headers.get("Origin") ?? "";
  try {
    const origin = new URL(raw);
    const host = origin.hostname.toLowerCase();
    const allowedHost =
      host.endsWith(".rork.live") ||
      host.endsWith(".rork.app") ||
      host.endsWith(".workers.dev") ||
      host === "localhost" ||
      host === "127.0.0.1";
    return origin.protocol === "https:" && !origin.username && !origin.password && allowedHost
      ? origin.origin
      : null;
  } catch {
    return null;
  }
}

/** OAuth state → account shard routing table, kept by the AccessRegistry (internal route). */
async function oauthRouteCall(
  ctx: McpRelayContext,
  origin: string,
  path: "/oauth-route/register" | "/oauth-route/resolve" | "/oauth-route/consume",
  body: Record<string, unknown>,
): Promise<Response> {
  return ctx.durable.fetch(
    new Request(new URL(path, origin).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Rork-DO-Class": "AccessRegistry",
        "X-Rork-DO-Id": "global",
        "X-Gera-Internal-Route": "oauth",
      },
      body: JSON.stringify(body),
    }),
  );
}

/** Server-owned MCP state/control routes for one authenticated account shard. */
export async function relayAccountMcp(ctx: McpRelayContext, request: Request, url: URL): Promise<Response> {
  try {
    const methods: Record<string, "GET" | "POST"> = {
      "/mcp/oauth-start": "POST",
      "/mcp/oauth-status": "GET",
      "/mcp/oauth-complete": "POST",
      "/mcp/github-device-start": "POST",
      "/mcp/github-device-status": "GET",
      "/mcp/oauth-store": "POST",
      "/mcp/oauth-clear": "POST",
      "/mcp/check": "POST",
      "/mcp/inventory": "POST",
      "/mcp/prompt-get": "POST",
      "/mcp/resource-read": "POST",
    };
    const method = methods[url.pathname];
    if (!method || request.method !== method) {
      return ctx.corsJson({ error: "not_found" }, 404);
    }
    const account = await ctx.requireInvitedAccount(request);
    if (account instanceof Response) {
      return account;
    }
    let body: string | undefined;
    if (method === "POST") {
      body = await request.text();
      if (body.length > MCP_OAUTH_REFRESH_BODY_LIMIT) {
        return ctx.corsJson({ error: "body_too_large" }, 413);
      }
      if (url.pathname === "/mcp/oauth-start") {
        const returnOrigin = oauthAppOrigin(request);
        if (!returnOrigin) {
          return ctx.corsJson({ error: "invalid_return_origin" }, 400);
        }
        let parsed: Record<string, unknown>;
        try {
          const value = JSON.parse(body) as unknown;
          parsed = value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
        } catch {
          return ctx.corsJson({ error: "invalid_body" }, 400);
        }
        body = JSON.stringify({ ...parsed, returnOrigin });
      }
    }
    const targetPath = `${url.pathname}${method === "GET" ? url.search : ""}`;
    const upstream = await ctx.shardCall(request.url, account, targetPath, { method, body });
    const text = await upstream.text();
    if (upstream.ok && url.pathname === "/mcp/oauth-start") {
      const data = JSON.parse(text) as { state?: unknown; expiresAt?: unknown };
      if (typeof data.state !== "string" || typeof data.expiresAt !== "number") {
        return ctx.corsJson({ error: "oauth_start_invalid" }, 502);
      }
      const registered = await oauthRouteCall(ctx, new URL(request.url).origin, "/oauth-route/register", {
        state: data.state,
        shardId: account.shardId,
        storageOwner: account.storageOwner,
        expiresAt: data.expiresAt,
      });
      if (!registered.ok) {
        return ctx.corsJson({ error: "oauth_callback_route_unavailable" }, 503);
      }
    }
    if (upstream.ok && url.pathname === "/mcp/oauth-complete" && body) {
      try {
        const parsed = JSON.parse(body) as { state?: unknown };
        if (typeof parsed.state === "string") {
          const consumed = await oauthRouteCall(ctx, new URL(request.url).origin, "/oauth-route/consume", {
            state: parsed.state,
          });
          if (!consumed.ok && consumed.status !== 404) {
            return ctx.corsJson({ error: "oauth_route_cleanup_unavailable", retryable: true }, 503);
          }
        }
      } catch {
        // The account shard already validated the body; route cleanup is best effort.
      }
    }
    return new Response(text, {
      status: upstream.status,
      headers: { ...ctx.corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (error) {
    // Everything the shard itself decides — auth states, a provider that did
    // not connect — came back as a Response above. Reaching here means the
    // call into Gera's own backend threw (a deploy reset mid-request, an
    // overloaded object, an internal fault), which says nothing about the MCP
    // server; labelling it "upstream unreachable" sent people to check a
    // provider that was fine. The path and a coarse reason are logged; never
    // the body.
    const reason = shardFailureReason(error);
    console.error("account MCP relay failed", url.pathname, reason, error instanceof Error ? error.message : "error");
    return ctx.corsJson({ error: "account_shard_unavailable", reason, transient: true, retryable: true }, 502);
  }
}

/**
 * POST /mcp/oauth-refresh — refreshes a browser MCP grant inside its account
 * shard and durably records a rotating response before returning it. The body
 * is never logged; platform identity and invite checks match sync/rotations.
 */
export async function relayBrowserOAuthRefresh(ctx: McpRelayContext, request: Request): Promise<Response> {
  try {
    if (request.method !== "POST") {
      return ctx.corsJson({ error: "not_found" }, 404);
    }
    const account = await ctx.requireInvitedAccount(request);
    if (account instanceof Response) {
      return account;
    }
    const body = await request.text();
    if (body.length > MCP_OAUTH_REFRESH_BODY_LIMIT) {
      return ctx.corsJson({ error: "body_too_large" }, 413);
    }
    const upstream = await ctx.shardCall(request.url, account, "/mcp/oauth-refresh", { method: "POST", body });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...ctx.corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("browser oauth refresh relay failed", error instanceof Error ? error.message : "error");
    return ctx.corsJson({ error: "upstream_unreachable", transient: true }, 502);
  }
}

/** Public provider redirect; state routes to one account shard and is consumed once. */
export async function relayMcpOAuthCallback(ctx: McpRelayContext, request: Request, url: URL): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }
  const state = url.searchParams.get("state") ?? "";
  if (!/^[a-f0-9]{64}$/.test(state)) {
    return new Response("OAuth state is invalid or expired.", { status: 400 });
  }
  const origin = new URL(request.url).origin;
  const route = await oauthRouteCall(ctx, origin, "/oauth-route/resolve", { state });
  if (!route.ok) {
    return new Response(
      route.status === 404
        ? "OAuth state is invalid, expired, or already used."
        : "OAuth callback routing is temporarily unavailable. Retry shortly.",
      { status: route.status === 404 ? 400 : 503 },
    );
  }
  const target = (await route.json()) as { shardId?: unknown; storageOwner?: unknown };
  if (typeof target.shardId !== "string" || typeof target.storageOwner !== "string") {
    return new Response("OAuth callback route is unavailable.", { status: 503 });
  }
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Rork-DO-Class": "ChatStore",
    "X-Rork-DO-Id": target.shardId,
    "X-Gera-Email": encodeURIComponent(target.storageOwner),
  });
  let upstream: Response;
  try {
    upstream = await ctx.durable.fetch(
      new Request(new URL("/mcp/oauth-callback", origin).toString(), {
        method: "POST",
        headers,
        body: JSON.stringify({
          state,
          code: (url.searchParams.get("code") ?? "").slice(0, 8_000),
          error: (url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "").slice(0, 300),
          issuer: (url.searchParams.get("iss") ?? "").slice(0, 2_000),
        }),
      }),
    );
  } catch {
    return new Response("OAuth callback could not reach the account store. Retry from Gera.", { status: 503 });
  }
  const data = (await upstream.json().catch(() => ({}))) as { redirectUrl?: unknown; error?: unknown };
  const redirectUrl = typeof data.redirectUrl === "string" ? safePublicHttpsUrl(data.redirectUrl) : null;
  if (redirectUrl) {
    return new Response(null, {
      status: 302,
      headers: { Location: redirectUrl.toString(), "Cache-Control": "no-store" },
    });
  }
  return new Response(
    upstream.ok ? "OAuth sign-in completed. You can close this window." : "OAuth sign-in failed. Return to Gera and retry.",
    { status: upstream.ok ? 200 : 400, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

// ---------------------------------------------------------------------------
// Plain Streamable HTTP relay (browser transport).

/** JSON-RPC bodies bigger than this are refused; tool args stay well under it. */
const MCP_BODY_LIMIT = 262_144;

/** Hop-by-hop, caller-identity, and platform headers never forwarded to MCP targets. */
const MCP_DROP_HEADERS = new Set<string>([
  "host",
  "origin",
  "referer",
  "cookie",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "accept-encoding",
  "user-agent",
  "x-real-ip",
  "cdn-loop",
  "priority",
  "dnt",
  "authorization",
  "x-gera-upstream-authorization",
  "x-gera-upstream-url",
]);

const MCP_DROP_PREFIXES = ["cf-", "sec-", "x-forwarded-", "x-rork-", "x-gera-"];

/**
 * Forwards MCP Streamable HTTP POSTs — and plain GETs (GitHub Actions job
 * logs sit behind a redirect to blob storage that sends no CORS headers, so
 * browsers cannot follow it). Redirects are manual: same-origin hops retain
 * auth, while a cross-origin GET follows with every caller credential removed;
 * cross-origin POST redirects are refused. Bodies are size-capped, only https
 * targets on public hosts are allowed, and nothing beyond host/path/status is
 * ever logged.
 */
export async function relayMcp(ctx: McpRelayContext, request: Request, url: URL): Promise<Response> {
  if (request.method !== "POST" && request.method !== "GET") {
    return ctx.corsJson({ error: "method_not_allowed" }, 405);
  }
  const accessProblem = await ctx.relayAccessProblem(request);
  if (accessProblem) {
    return accessProblem;
  }
  const target = request.headers.get("X-Gera-Upstream-Url") ?? url.searchParams.get("url") ?? "";
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return ctx.corsJson({ error: "invalid_url" }, 400);
  }
  if (parsed.protocol !== "https:") {
    return ctx.corsJson({ error: "https_required" }, 400);
  }
  if (parsed.username || parsed.password) {
    return ctx.corsJson({ error: "credentials_not_allowed" }, 400);
  }
  if (isForbiddenHost(parsed.hostname)) {
    return ctx.corsJson({ error: "host_not_allowed" }, 400);
  }

  const body = request.method === "POST" ? await request.text() : "";
  if (body.length > MCP_BODY_LIMIT) {
    return ctx.corsJson({ error: "body_too_large" }, 413);
  }

  const headers: Record<string, string> = {};
  const upstreamAuthorization = request.headers.get("X-Gera-Upstream-Authorization");
  request.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (MCP_DROP_HEADERS.has(lower) || MCP_DROP_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      return;
    }
    headers[lower] = value;
  });
  if (upstreamAuthorization) {
    headers.authorization = upstreamAuthorization;
  }
  // MCP servers reply 406 unless Accept lists both types (probed live) —
  // normalize weak values like */* instead of forwarding them. GETs are not
  // MCP traffic; their Accept passes through untouched.
  if (request.method === "POST" && (!headers.accept || !headers.accept.includes("text/event-stream"))) {
    headers.accept = "application/json, text/event-stream";
  }
  headers["user-agent"] = "Gera-AI-Relay/1.0";

  let upstream: Response | null = null;
  let current = parsed;
  let method: "GET" | "POST" = request.method === "POST" ? "POST" : "GET";
  let forwardBody: string | undefined = method === "POST" ? body : undefined;
  let forwardHeaders = { ...headers };
  for (let hop = 0; hop <= 5; hop += 1) {
    try {
      upstream = await fetch(current.toString(), {
        method,
        headers: forwardHeaders,
        body: forwardBody,
        redirect: "manual",
      });
    } catch (error) {
      console.error("mcp relay unreachable", current.hostname, error instanceof Error ? error.message : "fetch failed");
      return ctx.corsJson({ error: "upstream_unreachable" }, 502);
    }
    if (upstream.status < 300 || upstream.status >= 400) {
      break;
    }
    const location = upstream.headers.get("location");
    if (!location) {
      return ctx.corsJson({ error: "redirect_without_location" }, 502);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return ctx.corsJson({ error: "invalid_redirect" }, 502);
    }
    if (next.protocol !== "https:" || next.username || next.password || isForbiddenHost(next.hostname)) {
      return ctx.corsJson({ error: "redirect_not_allowed" }, 502);
    }
    if (next.origin !== current.origin) {
      if (method === "POST") {
        return ctx.corsJson({ error: "cross_origin_redirect_refused" }, 502);
      }
      // GitHub's signed Actions blob needs no API credential. Dropping every
      // caller-controlled header is safer than guessing which custom name is a key.
      forwardHeaders = {
        accept: forwardHeaders.accept ?? "*/*",
        "user-agent": "Gera-AI-Relay/1.0",
      };
    }
    if (upstream.status === 303 && method === "POST") {
      method = "GET";
      forwardBody = undefined;
      delete forwardHeaders["content-type"];
    }
    current = next;
    upstream = null;
  }
  if (!upstream) {
    return ctx.corsJson({ error: "too_many_redirects" }, 502);
  }

  console.log("mcp relay", parsed.hostname, upstream.status);
  const responseHeaders: Record<string, string> = {
    ...ctx.corsHeaders,
    "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
  };
  const sessionId = upstream.headers.get("Mcp-Session-Id");
  if (sessionId) {
    responseHeaders["Mcp-Session-Id"] = sessionId;
  }
  const protocolVersion = upstream.headers.get("MCP-Protocol-Version");
  if (protocolVersion) {
    responseHeaders["MCP-Protocol-Version"] = protocolVersion;
  }
  const challenge = upstream.headers.get("WWW-Authenticate");
  if (challenge) {
    responseHeaders["WWW-Authenticate"] = challenge;
  }
  // Stream the body through so long-running SSE tool calls arrive as sent.
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
