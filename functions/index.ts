// functions/index.ts — Gera backend: invite-only access registry + Intercom
// REST relay + MCP OAuth relay + MCP Streamable HTTP relay.
//
// Intercom's REST API (api.intercom.io) sends no CORS headers, so the browser
// app cannot call it directly (probed live). This Worker forwards an
// allow-listed set of Intercom REST endpoints and adds CORS on the way back.
// The /oauth-proxy route does the same for MCP OAuth discovery, dynamic
// client registration, and token exchanges. Every MCP JSON-RPC request from
// the app flows through /mcp-proxy because most servers reject browser CORS.
// All three relays require an invited Gera identity: Gera's JWT remains in
// Authorization for platform verification, while a provider credential rides
// in a dedicated internal header and is restored only after that gate. Tokens
// are never stored or logged.
//
// /access/* routes are invite-only gatekeeping: the platform verifies the
// caller's Rork Auth JWT and stamps X-Rork-User-* headers; the entrypoint
// requires them and forwards to the AccessRegistry Durable Object, which owns
// the invites allowlist and the waitlist in durable SQLite.
//
// /share routes power public chat links: invited users publish a read-only
// snapshot (create/mine/revoke need the platform-verified identity), while
// GET /share?id=... is deliberately open — anyone with the link, no account.
//
// POST /chats/sync is cloud sync: one account, one chat history PLUS one
// settings/agents/automations/MCP/hub profile blob across preview,
// production, and devices. Identity + invite required. Every account lives
// in its OWN ChatStore Durable Object shard (id acct:<email>) — that is
// what lets the backend scale horizontally. A shard answers 428 until its
// one-time migration out of the legacy global object; the relay migrates
// and retries transparently (see shard-migration.ts).
//
// /diag/* is the per-account error journal behind the in-app Diagnostics
// screen — same trust chain as chat sync (identity + invite), rows live in
// the account's ChatStore shard: POST /diag/append|seen|clear, GET /diag/list.
//
// Cloud automations: platform Durable Objects cannot set alarms (facets),
// so the global object keeps a tiny schedule index (owner → next due) that
// every shard response refreshes via the X-Gera-Next-Due header. The cron
// tick (rork.json `crons`, every 5 minutes — platform minimum) fires due
// shards immediately and arms exact-time sleepers for slots inside the
// coming window; POST /automations/run-now fires one immediately. The same
// tick also sweeps not-yet-migrated accounts out of the legacy global
// object — once drained that part is a cheap no-op.
//
// POST /surf is SelfSurf — the autonomous browser: the Worker performs one
// HTTP navigation per call (redirects, cookie jar, HTML parsing) for the
// signed-in, invited caller. See selfsurf.ts for the engine.
//
// /runs/* are interactive server-side agent runs (chat / deep research /
// Julius) living in the account's ChatStore shard: start / steer / retract /
// stop / ack + active / stream / media. The stream response passes through
// as a live SSE stream. See run-manager.ts for the run lifecycle.

import { verifyCronSignature } from "./cron-auth";
import { TRACKER_JS } from "./desk-pageviews";
import { handleKnowledgeRoute } from "./knowledge-storage";
import { decodeSlackInstallState } from "./native-slack";
import { isForbiddenHost } from "./network-safety";
import { performSurf, type SurfCommand, type SurfJar } from "./selfsurf";
import { chatShardId, migrateOwnerToShard, sweepGlobalMigrations } from "./shard-migration";

export { AccessRegistry } from "./access-registry";
export { ArenaStore } from "./arena-store";
export { ChatStore } from "./chat-store";
export { ProjectStore } from "./project-store";
export { ShareStore } from "./share-store";

type Env = {
  DO: { fetch(request: Request): Promise<Response> };
  /** Injected by Rork once a cron is declared in rork.json. */
  CRON_SECRET?: string;
  /** Rork toolkit AI key — server-side calls must send it as a Bearer token. */
  EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY?: string;
  RORK_TOOLKIT_SECRET_KEY?: string;
  /** Rork API base — the storage temp-credentials endpoint lives there. */
  EXPO_PUBLIC_RORK_API_BASE_URL?: string;
};

type ExecutionCtx = { waitUntil(promise: Promise<unknown>): void };

const INTERCOM_HOSTS: Record<string, string> = {
  us: "https://api.intercom.io",
  eu: "https://api.eu.intercom.io",
};

const INTERCOM_VERSION = "2.11";

const ALLOWED_ROUTES: Array<{ method: string; pattern: RegExp }> = [
  { method: "GET", pattern: /^\/me$/ },
  { method: "GET", pattern: /^\/admins$/ },
  { method: "GET", pattern: /^\/conversations$/ },
  { method: "GET", pattern: /^\/conversations\/[A-Za-z0-9_-]+$/ },
  { method: "POST", pattern: /^\/conversations\/search$/ },
  { method: "POST", pattern: /^\/conversations\/[A-Za-z0-9_-]+\/reply$/ },
  { method: "POST", pattern: /^\/messages$/ },
  { method: "POST", pattern: /^\/contacts\/search$/ },
  { method: "GET", pattern: /^\/contacts\/[A-Za-z0-9_-]+$/ },
];

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, X-Intercom-Region, X-Gera-Upstream-Authorization, X-Gera-Upstream-Url",
  "Access-Control-Expose-Headers":
    "Mcp-Session-Id, MCP-Protocol-Version, WWW-Authenticate, X-Gera-Relay-Auth",
  "Access-Control-Max-Age": "86400",
};

function corsJson(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function relayAuthRequired(): Response {
  const response = corsJson({ error: "sign_in_required" }, 401);
  response.headers.set("X-Gera-Relay-Auth", "required");
  return response;
}

/** Browser-facing generic relays are available only to invited Gera accounts. */
async function relayAccessProblem(request: Request, env: Env): Promise<Response | null> {
  const userId = request.headers.get("X-Rork-User-Id");
  const email = (request.headers.get("X-Rork-User-Email") ?? "").trim().toLowerCase();
  if (!userId || !email) {
    return relayAuthRequired();
  }
  if (await isInvitedCached(env, request.url, email)) {
    return null;
  }
  const response = corsJson({ error: "invite_required" }, 403);
  response.headers.set("X-Gera-Relay-Auth", "forbidden");
  return response;
}

async function relayIntercom(request: Request, url: URL, env: Env): Promise<Response> {
  const accessProblem = await relayAccessProblem(request, env);
  if (accessProblem) {
    return accessProblem;
  }
  const apiPath = url.pathname.slice("/intercom".length) || "/";
  const allowed = ALLOWED_ROUTES.some((route) => route.method === request.method && route.pattern.test(apiPath));
  if (!allowed) {
    return corsJson({ error: "path_not_allowed" }, 403);
  }
  const authorization = request.headers.get("X-Gera-Upstream-Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return corsJson({ error: "missing_token" }, 401);
  }
  const regionHeader = (request.headers.get("X-Intercom-Region") ?? "us").toLowerCase();
  const host = INTERCOM_HOSTS[regionHeader] ?? INTERCOM_HOSTS.us;

  const init: RequestInit = {
    method: request.method,
    headers: {
      Authorization: authorization,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Intercom-Version": INTERCOM_VERSION,
    },
  };
  if (request.method === "POST") {
    init.body = await request.text();
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${host}${apiPath}${url.search}`, init);
  } catch (error) {
    console.error("intercom relay unreachable", apiPath, error instanceof Error ? error.message : "fetch failed");
    return corsJson({ error: "upstream_unreachable" }, 502);
  }

  const text = await upstream.text();
  console.log("intercom relay", request.method, apiPath, upstream.status);
  return new Response(text, {
    status: upstream.status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

/** Discovery paths the OAuth relay may GET; anything else is refused. */
const OAUTH_DISCOVERY_PREFIXES = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
];

const OAUTH_BODY_LIMIT = 16_384;

/**
 * Forwards OAuth discovery GETs and registration/token POSTs for the browser
 * app, adding CORS on the way back. No Authorization header is ever forwarded
 * (MCP OAuth uses public clients), bodies are size-capped, and only https
 * targets on public hosts are allowed. Bodies and tokens are never logged.
 */
async function relayOAuth(request: Request, url: URL, env: Env): Promise<Response> {
  const accessProblem = await relayAccessProblem(request, env);
  if (accessProblem) {
    return accessProblem;
  }
  const target = request.headers.get("X-Gera-Upstream-Url") ?? url.searchParams.get("url") ?? "";
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return corsJson({ error: "invalid_url" }, 400);
  }
  if (parsed.protocol !== "https:") {
    return corsJson({ error: "https_required" }, 400);
  }
  if (parsed.username || parsed.password) {
    return corsJson({ error: "credentials_not_allowed" }, 400);
  }
  if (isForbiddenHost(parsed.hostname)) {
    return corsJson({ error: "host_not_allowed" }, 400);
  }

  let init: RequestInit;
  if (request.method === "GET") {
    if (!OAUTH_DISCOVERY_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix))) {
      return corsJson({ error: "path_not_allowed" }, 403);
    }
    init = { method: "GET", headers: { Accept: "application/json" }, redirect: "manual" };
  } else if (request.method === "POST") {
    const contentType = request.headers.get("Content-Type") ?? "";
    const allowedType =
      contentType.includes("application/json") || contentType.includes("application/x-www-form-urlencoded");
    if (!allowedType) {
      return corsJson({ error: "content_type_not_allowed" }, 400);
    }
    const body = await request.text();
    if (body.length > OAUTH_BODY_LIMIT) {
      return corsJson({ error: "body_too_large" }, 413);
    }
    init = {
      method: "POST",
      headers: { "Content-Type": contentType, Accept: "application/json" },
      body,
      redirect: "manual",
    };
  } else {
    return corsJson({ error: "method_not_allowed" }, 405);
  }

  let upstream: Response | null = null;
  let current = parsed;
  let currentInit = init;
  for (let hop = 0; hop <= 5; hop += 1) {
    try {
      upstream = await fetch(current.toString(), currentInit);
    } catch (error) {
      console.error(
        "oauth relay unreachable",
        current.hostname,
        error instanceof Error ? error.message : "fetch failed",
      );
      return corsJson({ error: "upstream_unreachable" }, 502);
    }
    if (upstream.status < 300 || upstream.status >= 400) {
      break;
    }
    const location = upstream.headers.get("location");
    if (!location) {
      return corsJson({ error: "redirect_without_location" }, 502);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return corsJson({ error: "invalid_redirect" }, 502);
    }
    if (next.protocol !== "https:" || next.username || next.password || isForbiddenHost(next.hostname)) {
      return corsJson({ error: "redirect_not_allowed" }, 502);
    }
    if (currentInit.method === "POST" && next.origin !== current.origin) {
      return corsJson({ error: "cross_origin_redirect_refused" }, 502);
    }
    if (upstream.status === 303) {
      currentInit = { method: "GET", headers: { Accept: "application/json" }, redirect: "manual" };
    }
    current = next;
    upstream = null;
  }
  if (!upstream) {
    return corsJson({ error: "too_many_redirects" }, 502);
  }

  const text = await upstream.text();
  console.log("oauth relay", request.method, parsed.hostname, upstream.status);
  const responseHeaders: Record<string, string> = {
    ...CORS_HEADERS,
    "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
  };
  const challenge = upstream.headers.get("WWW-Authenticate");
  if (challenge) {
    responseHeaders["WWW-Authenticate"] = challenge;
  }
  return new Response(text, { status: upstream.status, headers: responseHeaders });
}

/**
 * HTTP header values are ByteStrings: UTF-8 bytes (e.g. Cyrillic names)
 * surface as Latin-1 mojibake. Re-decode when the value looks like that;
 * genuine Latin-1 text fails strict UTF-8 decoding and stays untouched.
 */
function decodeHeaderText(value: string): string {
  if (!/[\u0080-\u00ff]/.test(value) || /[\u0100-\uffff]/.test(value)) {
    return value;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(value, (char) => char.charCodeAt(0)));
  } catch {
    return value;
  }
}

/**
 * Routes /access/* to the AccessRegistry DO. Identity comes exclusively from
 * the platform-verified X-Rork-User-* headers (the platform strips inbound
 * spoofs and re-injects them only when the Bearer JWT verifies), so an
 * unauthenticated caller can never reach the registry.
 */
async function relayAccess(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return corsJson({ error: "method_not_allowed" }, 405);
  }
  const userId = request.headers.get("X-Rork-User-Id");
  const email = (request.headers.get("X-Rork-User-Email") ?? "").trim().toLowerCase();
  if (!userId || !email) {
    return corsJson({ error: "sign_in_required" }, 401);
  }

  const subPath = url.pathname.slice("/access".length) || "/";
  const target = new URL(request.url);
  target.pathname = subPath;
  const wrapped = new Request(target.toString(), request);
  wrapped.headers.set("X-Rork-DO-Class", "AccessRegistry");
  wrapped.headers.set("X-Rork-DO-Id", "global");
  wrapped.headers.set("X-Gera-Email", encodeURIComponent(decodeHeaderText(email)));
  wrapped.headers.set("X-Gera-Name", encodeURIComponent(decodeHeaderText(request.headers.get("X-Rork-User-Name") ?? "")));

  let upstream: Response;
  try {
    upstream = await env.DO.fetch(wrapped);
  } catch (error) {
    console.error("access registry unreachable", error instanceof Error ? error.message : "fetch failed");
    return corsJson({ error: "upstream_unreachable" }, 502);
  }
  const text = await upstream.text();
  console.log("access", request.method, subPath, upstream.status);
  return new Response(text, {
    status: upstream.status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

/** Share snapshots above this are refused — links must stay light. */
const SHARE_BODY_LIMIT = 1_500_000;

const SHARE_ID_PATTERN = /^[A-Za-z0-9]{8,32}$/;

/** Dispatches one call to the ShareStore DO (singleton "global"). */
function shareStoreFetch(
  env: Env,
  requestUrl: string,
  pathWithQuery: string,
  options: { method: "GET" | "POST"; body?: string; email?: string },
): Promise<Response> {
  const target = new URL(pathWithQuery, new URL(requestUrl).origin);
  const headers = new Headers();
  headers.set("X-Rork-DO-Class", "ShareStore");
  headers.set("X-Rork-DO-Id", "global");
  if (options.email) {
    headers.set("X-Gera-Email", encodeURIComponent(options.email));
  }
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  return env.DO.fetch(new Request(target.toString(), { method: options.method, headers, body: options.body }));
}

/** Publishing is for invited members only — asks the AccessRegistry DO. */
async function isInvited(env: Env, requestUrl: string, email: string): Promise<boolean> {
  const target = new URL("/status", new URL(requestUrl).origin);
  const headers = new Headers();
  headers.set("X-Rork-DO-Class", "AccessRegistry");
  headers.set("X-Rork-DO-Id", "global");
  headers.set("X-Gera-Email", encodeURIComponent(email));
  try {
    const response = await env.DO.fetch(new Request(target.toString(), { method: "GET", headers }));
    if (!response.ok) {
      return false;
    }
    const data = (await response.json()) as { status?: string };
    return data.status === "invited";
  } catch (error) {
    console.error("invite check unreachable", error instanceof Error ? error.message : "fetch failed");
    return false;
  }
}

/**
 * Per-isolate invite cache — the gate runs on every synced request, so at
 * scale it must not hammer the AccessRegistry singleton. Honest trade-off:
 * revoking an invite takes up to a minute to propagate.
 */
const INVITE_OK_TTL_MS = 60_000;
const INVITE_MISS_TTL_MS = 15_000;
const inviteCache = new Map<string, { ok: boolean; exp: number }>();

async function isInvitedCached(env: Env, requestUrl: string, email: string): Promise<boolean> {
  const now = Date.now();
  const hit = inviteCache.get(email);
  if (hit && hit.exp > now) {
    return hit.ok;
  }
  const ok = await isInvited(env, requestUrl, email);
  if (inviteCache.size > 5_000) {
    inviteCache.clear();
  }
  inviteCache.set(email, { ok, exp: now + (ok ? INVITE_OK_TTL_MS : INVITE_MISS_TTL_MS) });
  return ok;
}

/**
 * One call to an account's ChatStore shard. The first touch after the
 * sharding rollout answers 428 — the relay migrates the account out of the
 * legacy global object and retries once.
 */
async function shardCall(
  env: Env,
  requestUrl: string,
  email: string,
  path: string,
  options: { method: "GET" | "POST"; body?: string },
): Promise<Response> {
  const origin = new URL(requestUrl).origin;
  const dispatch = (): Promise<Response> => {
    const headers = new Headers();
    headers.set("X-Rork-DO-Class", "ChatStore");
    headers.set("X-Rork-DO-Id", chatShardId(email));
    headers.set("X-Gera-Email", encodeURIComponent(email));
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    return env.DO.fetch(
      new Request(new URL(path, origin).toString(), {
        method: options.method,
        headers,
        body: options.body,
      }),
    );
  };
  let upstream = await dispatch();
  if (upstream.status === 428) {
    await migrateOwnerToShard(env, origin, email);
    upstream = await dispatch();
  }
  // Shards report their next automation due instant on profile-carrying
  // responses — mirror it into the global schedule index.
  const nextDueRaw = upstream.headers.get("X-Gera-Next-Due");
  if (nextDueRaw !== null) {
    await scheduleSet(env, origin, email, Number(nextDueRaw));
  }
  // Same trick for webhook triggers: shards report their token registry
  // rows so the public /hooks/<token> route can find the right shard.
  const hooksRaw = upstream.headers.get("X-Gera-Hooks");
  if (hooksRaw !== null) {
    await hooksSet(env, origin, email, hooksRaw);
  }
  return upstream;
}

/** Upserts (or clears, when 0) one owner's row in the schedule index. */
async function scheduleSet(env: Env, origin: string, email: string, nextDueAt: number): Promise<void> {
  try {
    const headers = new Headers();
    headers.set("X-Rork-DO-Class", "ChatStore");
    headers.set("X-Rork-DO-Id", "global");
    headers.set("Content-Type", "application/json");
    const response = await env.DO.fetch(
      new Request(new URL("/schedule-set", origin).toString(), {
        method: "POST",
        headers,
        body: JSON.stringify({
          owner: email,
          nextDueAt: Number.isFinite(nextDueAt) ? Math.max(0, Math.floor(nextDueAt)) : 0,
        }),
      }),
    );
    if (!response.ok) {
      console.error("schedule set failed", response.status);
    }
  } catch (error) {
    console.error("schedule set unreachable", error instanceof Error ? error.message : "error");
  }
}

/** One shard fire — errors are logged, never thrown (the cron tick rescues). */
async function fireShard(env: Env, origin: string, owner: string): Promise<void> {
  try {
    const fire = await shardCall(env, origin, owner, "/fire", { method: "POST", body: "{}" });
    if (!fire.ok) {
      console.error("automation fire failed", fire.status);
    }
  } catch (error) {
    console.error("automation fire crashed", error instanceof Error ? error.message : "error");
  }
}

/** How far ahead one cron tick looks; slots inside get exact-time sleepers. */
const FIRE_WINDOW_MS = 300_000;
const FIRE_READY_LIMIT = 10;
const FIRE_SLEEPER_LIMIT = 20;

/**
 * Cron tick: fire owners due now; arm exact-time sleepers for slots inside
 * the coming window. If a sleeper dies with the invocation, the schedule
 * row stays due and the next tick fires it late — shard claims make every
 * path at-most-once.
 */
async function fireDueAutomations(env: Env, origin: string): Promise<void> {
  const headers = new Headers();
  headers.set("X-Rork-DO-Class", "ChatStore");
  headers.set("X-Rork-DO-Id", "global");
  headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await env.DO.fetch(
      new Request(new URL("/schedule-due", origin).toString(), {
        method: "POST",
        headers,
        body: JSON.stringify({ windowMs: FIRE_WINDOW_MS }),
      }),
    );
  } catch (error) {
    console.error("schedule-due unreachable", error instanceof Error ? error.message : "error");
    return;
  }
  if (!response.ok) {
    console.error("schedule-due failed", response.status);
    return;
  }
  const data = (await response.json()) as { due?: Array<{ owner?: unknown; at?: unknown }> };
  const due = (Array.isArray(data.due) ? data.due : [])
    .map((item) => ({
      owner: typeof item.owner === "string" ? item.owner : "",
      at: typeof item.at === "number" ? item.at : 0,
    }))
    .filter((item) => item.owner.length > 0);
  const now = Date.now();
  const ready = due.filter((item) => item.at <= now).slice(0, FIRE_READY_LIMIT);
  const upcoming = due.filter((item) => item.at > now).slice(0, FIRE_SLEEPER_LIMIT);
  if (ready.length > 0 || upcoming.length > 0) {
    console.log("automation tick:", ready.length, "ready,", upcoming.length, "armed");
  }
  await Promise.allSettled([
    ...ready.map((item) => fireShard(env, origin, item.owner)),
    // Exact-time sleepers: fire at the slot inside this same invocation.
    ...upcoming.map(
      (item) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            void fireShard(env, origin, item.owner).finally(() => resolve());
          }, Math.max(0, item.at - Date.now()));
        }),
    ),
  ]);
}

/**
 * /share routes. GET /share?id= is public by design — a share link must open
 * for people without any account. Create/mine/revoke require the platform-
 * verified identity headers; create additionally requires an invite.
 */
async function relayShares(request: Request, url: URL, env: Env): Promise<Response> {
  try {
    if (request.method === "GET" && url.pathname === "/share") {
      const id = url.searchParams.get("id") ?? "";
      if (!SHARE_ID_PATTERN.test(id)) {
        return corsJson({ error: "invalid_id" }, 400);
      }
      const upstream = await shareStoreFetch(env, request.url, `/get?id=${id}`, { method: "GET" });
      const text = await upstream.text();
      console.log("share get", id, upstream.status);
      return new Response(text, {
        status: upstream.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const userId = request.headers.get("X-Rork-User-Id");
    const email = (request.headers.get("X-Rork-User-Email") ?? "").trim().toLowerCase();
    if (!userId || !email) {
      return corsJson({ error: "sign_in_required" }, 401);
    }

    if (request.method === "POST" && url.pathname === "/share/create") {
      const body = await request.text();
      if (body.length > SHARE_BODY_LIMIT) {
        return corsJson({ error: "chat_too_large" }, 413);
      }
      if (!(await isInvitedCached(env, request.url, email))) {
        return corsJson({ error: "invite_required" }, 403);
      }
      const upstream = await shareStoreFetch(env, request.url, "/create", { method: "POST", body, email });
      const text = await upstream.text();
      console.log("share create", upstream.status);
      return new Response(text, {
        status: upstream.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET" && url.pathname === "/share/mine") {
      const upstream = await shareStoreFetch(env, request.url, "/mine", { method: "GET", email });
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (request.method === "POST" && url.pathname === "/share/revoke") {
      const body = await request.text();
      if (body.length > 4096) {
        return corsJson({ error: "invalid_body" }, 400);
      }
      const upstream = await shareStoreFetch(env, request.url, "/revoke", { method: "POST", body, email });
      const text = await upstream.text();
      console.log("share revoke", upstream.status);
      return new Response(text, {
        status: upstream.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    return corsJson({ error: "not_found" }, 404);
  } catch (error) {
    console.error("share relay failed", error instanceof Error ? error.message : "error");
    return corsJson({ error: "upstream_unreachable" }, 502);
  }
}

/** Arena vote bodies carry two model ids, a short prompt, and two costs. */
const ARENA_BODY_LIMIT = 16_384;

/** Dispatches one call to the ArenaStore DO (singleton "global"). */
function arenaStoreFetch(
  env: Env,
  requestUrl: string,
  path: string,
  options: { method: "GET" | "POST"; body?: string; email: string },
): Promise<Response> {
  const target = new URL(path, new URL(requestUrl).origin);
  const headers = new Headers();
  headers.set("X-Rork-DO-Class", "ArenaStore");
  headers.set("X-Rork-DO-Id", "global");
  headers.set("X-Gera-Email", encodeURIComponent(options.email));
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  return env.DO.fetch(new Request(target.toString(), { method: options.method, headers, body: options.body }));
}

/** Clearing the shared battle journal is admin-only — asks the AccessRegistry DO. */
async function isAdminAccount(env: Env, requestUrl: string, email: string): Promise<boolean> {
  const target = new URL("/status", new URL(requestUrl).origin);
  const headers = new Headers();
  headers.set("X-Rork-DO-Class", "AccessRegistry");
  headers.set("X-Rork-DO-Id", "global");
  headers.set("X-Gera-Email", encodeURIComponent(email));
  try {
    const response = await env.DO.fetch(new Request(target.toString(), { method: "GET", headers }));
    if (!response.ok) {
      return false;
    }
    const data = (await response.json()) as { role?: string };
    return data.role === "admin";
  } catch (error) {
    console.error("admin check unreachable", error instanceof Error ? error.message : "fetch failed");
    return false;
  }
}

/** Usage batches are tiny JSON events; this bound is generous. */
const USAGE_BODY_LIMIT = 64_000;

/**
 * /arena/* — the model arena backend. Automatic side: every invited member's
 * app POSTs usage telemetry (model id, mode, outcome, token counts — never
 * message content) to /arena/usage; reading standings, the duel journal and
 * clearing are all admin-only. Ratings and shares are recomputed client-side
 * from raw rows, so formulas can change without touching stored data.
 */
async function relayArena(request: Request, url: URL, env: Env): Promise<Response> {
  try {
    const userId = request.headers.get("X-Rork-User-Id");
    const email = (request.headers.get("X-Rork-User-Email") ?? "").trim().toLowerCase();
    if (!userId || !email) {
      return corsJson({ error: "sign_in_required" }, 401);
    }
    if (!(await isInvitedCached(env, request.url, email))) {
      return corsJson({ error: "invite_required" }, 403);
    }

    // Hot path first: automatic telemetry from every member's client.
    if (request.method === "POST" && url.pathname === "/arena/usage") {
      const body = await request.text();
      if (body.length > USAGE_BODY_LIMIT) {
        return corsJson({ error: "body_too_large" }, 413);
      }
      const upstream = await arenaStoreFetch(env, request.url, "/usage", { method: "POST", body, email });
      const text = await upstream.text();
      if (!upstream.ok) {
        console.log("arena usage ingest failed", upstream.status);
      }
      return new Response(text, {
        status: upstream.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET" && url.pathname === "/arena/usage/stats") {
      if (!(await isAdminAccount(env, request.url, email))) {
        return corsJson({ error: "admin_required" }, 403);
      }
      const upstream = await arenaStoreFetch(env, request.url, `/usage/stats${url.search}`, {
        method: "GET",
        email,
      });
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET" && url.pathname === "/arena/battles") {
      if (!(await isAdminAccount(env, request.url, email))) {
        return corsJson({ error: "admin_required" }, 403);
      }
      const upstream = await arenaStoreFetch(env, request.url, "/list", { method: "GET", email });
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (request.method === "POST" && url.pathname === "/arena/log") {
      if (!(await isAdminAccount(env, request.url, email))) {
        return corsJson({ error: "admin_required" }, 403);
      }
      const body = await request.text();
      if (body.length > ARENA_BODY_LIMIT) {
        return corsJson({ error: "body_too_large" }, 413);
      }
      const upstream = await arenaStoreFetch(env, request.url, "/log", { method: "POST", body, email });
      const text = await upstream.text();
      console.log("arena log", upstream.status);
      return new Response(text, {
        status: upstream.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (request.method === "POST" && url.pathname === "/arena/clear") {
      if (!(await isAdminAccount(env, request.url, email))) {
        return corsJson({ error: "admin_required" }, 403);
      }
      const upstream = await arenaStoreFetch(env, request.url, "/clear", { method: "POST", body: "{}", email });
      const text = await upstream.text();
      console.log("arena clear", upstream.status);
      return new Response(text, {
        status: upstream.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (request.method === "POST" && url.pathname === "/arena/usage/clear") {
      if (!(await isAdminAccount(env, request.url, email))) {
        return corsJson({ error: "admin_required" }, 403);
      }
      const upstream = await arenaStoreFetch(env, request.url, "/usage/clear", {
        method: "POST",
        body: "{}",
        email,
      });
      const text = await upstream.text();
      console.log("arena usage clear", upstream.status);
      return new Response(text, {
        status: upstream.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    return corsJson({ error: "not_found" }, 404);
  } catch (error) {
    console.error("arena relay failed", error instanceof Error ? error.message : "error");
    return corsJson({ error: "upstream_unreachable" }, 502);
  }
}

/** Project route bodies: messages are 8k chars; agent configs stay small. */
const PROJECT_BODY_LIMIT = 300_000;

/** Allow-listed project shard sub-routes and their methods. */
const PROJECT_SUB_ROUTES: Record<string, "GET" | "POST"> = {
  "/overview": "GET",
  "/messages": "GET",
  "/message": "POST",
  "/read": "POST",
  "/channels/create": "POST",
  "/members/add": "POST",
  "/members/remove": "POST",
  "/members/role": "POST",
  "/agents/upsert": "POST",
  "/agents/delete": "POST",
  "/agents/slack-create-app": "POST",
  "/agents/slack-install-url": "POST",
  "/slack-config": "POST",
  "/screens/upsert": "POST",
  "/screens/delete": "POST",
  "/intercom/inbox": "POST",
  "/intercom/thread": "POST",
  "/intercom/details": "POST",
  "/intercom/reply": "POST",
  "/intercom/suggest": "POST",
  "/intercom/suggest/rate": "POST",
  "/intercom/action": "POST",
  "/intercom/ask-gera": "POST",
  "/intercom/stats": "POST",
  "/intercom/stats/refresh": "POST",
  "/intercom/stats/link": "POST",
  "/intercom/slack-related": "POST",
  "/intercom/ask-status": "POST",
  "/tracking/setup": "POST",
  "/screen-chat": "GET",
  "/screen-chat/send": "POST",
  "/project/rename": "POST",
  "/project/delete": "POST",
};

/** Dispatches one call to a ProjectStore DO instance (registry or shard). */
function projectStoreFetch(
  env: Env,
  requestUrl: string,
  doId: string,
  path: string,
  options: { method: "GET" | "POST"; body?: string; email?: string; headers?: Record<string, string> },
): Promise<Response> {
  const target = new URL(path, new URL(requestUrl).origin);
  const headers = new Headers();
  headers.set("X-Rork-DO-Class", "ProjectStore");
  headers.set("X-Rork-DO-Id", doId);
  if (options.email) {
    headers.set("X-Gera-Email", encodeURIComponent(options.email));
  }
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    headers.set(key, value);
  }
  return env.DO.fetch(new Request(target.toString(), { method: options.method, headers, body: options.body }));
}

/**
 * Post-commit side effects of project writes, run via waitUntil so the
 * response returns instantly:
 * - /message: fire the queued agent replies (the shard runs the engine and
 *   fills the placeholder; polling clients pick the text up when it lands);
 * - membership / rename / delete: mirror the change into the registry
 *   singleton so GET /projects stays correct for everyone involved.
 */
async function projectPostEffects(
  env: Env,
  requestUrl: string,
  projectId: string,
  email: string,
  sub: string,
  requestBody: string,
  responseText: string,
): Promise<void> {
  try {
    if (sub === "/message") {
      const data = JSON.parse(responseText) as { jobs?: unknown };
      const jobs = Array.isArray(data.jobs) ? data.jobs.filter((id): id is string => typeof id === "string") : [];
      for (const jobId of jobs.slice(0, 3)) {
        const run = await projectStoreFetch(env, requestUrl, `proj:${projectId}`, "/agent-run", {
          method: "POST",
          email,
          body: JSON.stringify({ jobId }),
        });
        if (!run.ok) {
          console.error("project agent-run failed", run.status);
        }
      }
      return;
    }
    if (sub === "/screen-chat/send" || sub === "/intercom/ask-gera") {
      // The desk assistant reply (and "Ask Gera" research) runs inside the
      // shard, same as channel jobs.
      const data = JSON.parse(responseText) as { jobs?: unknown };
      const jobs = Array.isArray(data.jobs) ? data.jobs.filter((id): id is string => typeof id === "string") : [];
      for (const jobId of jobs.slice(0, 1)) {
        const run = await projectStoreFetch(env, requestUrl, `proj:${projectId}`, "/screen-run", {
          method: "POST",
          email,
          body: JSON.stringify({ jobId }),
        });
        if (!run.ok) {
          console.error("project screen-run failed", run.status);
        }
      }
      return;
    }
    const upsert = (payload: unknown): Promise<Response> =>
      projectStoreFetch(env, requestUrl, "registry", "/reg/upsert", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    if (sub === "/members/add" || sub === "/members/role") {
      const body = JSON.parse(requestBody) as { email?: unknown; role?: unknown };
      const target = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (target) {
        await upsert({
          projectId,
          rows: [{ email: target, role: body.role === "admin" ? "admin" : "member" }],
        });
      }
      return;
    }
    if (sub === "/members/remove") {
      const body = JSON.parse(requestBody) as { email?: unknown };
      const target = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (target) {
        await upsert({ projectId, drop: [target] });
      }
      return;
    }
    if (sub === "/project/rename") {
      const data = JSON.parse(responseText) as { name?: unknown };
      if (typeof data.name === "string" && data.name.length > 0) {
        await upsert({ projectId, name: data.name });
      }
      return;
    }
    if (sub === "/project/delete") {
      await projectStoreFetch(env, requestUrl, "registry", "/reg/drop-project", {
        method: "POST",
        body: JSON.stringify({ projectId }),
      });
    }
  } catch (error) {
    console.error("project post-effects failed", sub, error instanceof Error ? error.message : "error");
  }
}

const SLACK_EVENT_BODY_LIMIT = 64_000;

/**
 * /slack/events/:projectId/:agentId — the public Slack Events API endpoint
 * that turns a project agent into a mentionable Slack bot. No Gera identity
 * here by design (Slack is the caller): the project shard proves authenticity
 * with the per-agent signing secret (v0 HMAC over the raw body + 5-minute
 * timestamp window + event-id dedup). The relay answers Slack within its 3s
 * budget and fires the queued mention run via waitUntil — the same pattern
 * as channel agent replies. Bodies and tokens are never logged.
 */
async function relaySlackEvents(request: Request, url: URL, env: Env, ctx: ExecutionCtx): Promise<Response> {
  try {
    if (request.method !== "POST") {
      return corsJson({ error: "method_not_allowed" }, 405);
    }
    const segments = url.pathname.split("/").filter(Boolean);
    const projectId = (segments[2] ?? "").slice(0, 64);
    const agentId = (segments[3] ?? "").slice(0, 64);
    if (segments.length !== 4 || !/^[a-zA-Z0-9]+$/.test(projectId) || !/^[a-zA-Z0-9]+$/.test(agentId)) {
      return corsJson({ error: "not_found" }, 404);
    }
    const body = await request.text();
    if (body.length > SLACK_EVENT_BODY_LIMIT) {
      return corsJson({ error: "body_too_large" }, 413);
    }
    const upstream = await projectStoreFetch(env, request.url, `proj:${projectId}`, "/slack-event", {
      method: "POST",
      body,
      headers: {
        "X-Gera-Slack-Agent": agentId,
        "X-Slack-Signature": request.headers.get("X-Slack-Signature") ?? "",
        "X-Slack-Request-Timestamp": request.headers.get("X-Slack-Request-Timestamp") ?? "",
      },
    });
    const text = await upstream.text();
    console.log("slack events relay", upstream.status);
    if (upstream.ok) {
      try {
        const data = JSON.parse(text) as { jobs?: unknown };
        const jobs = Array.isArray(data.jobs)
          ? data.jobs.filter((id): id is string => typeof id === "string")
          : [];
        for (const jobId of jobs.slice(0, 1)) {
          ctx.waitUntil(
            projectStoreFetch(env, request.url, `proj:${projectId}`, "/slack-run", {
              method: "POST",
              body: JSON.stringify({ jobId }),
            }).then((run) => {
              if (!run.ok) {
                console.error("slack bot run dispatch failed", run.status);
              }
            }),
          );
        }
      } catch {
        // non-JSON upstream body — pass it through untouched
      }
    }
    return new Response(text, {
      status: upstream.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("slack events relay failed", error instanceof Error ? error.message : "error");
    return corsJson({ error: "internal" }, 500);
  }
}

const PAGE_VIEW_BODY_LIMIT = 16_000;

/**
 * POST /pv/:projectId — the public "Recent page views" beacon. The caller is
 * the customer's website (Gera's pv.js snippet), so there is no Gera identity
 * by design; the project shard verifies the write-only tracking key inside
 * the payload. Bodies are size-capped and never logged.
 */
async function relayPageViews(request: Request, url: URL, env: Env): Promise<Response> {
  try {
    if (request.method !== "POST") {
      return corsJson({ error: "method_not_allowed" }, 405);
    }
    const segments = url.pathname.split("/").filter(Boolean);
    const projectId = (segments[1] ?? "").slice(0, 64);
    if (segments.length !== 2 || !/^[a-zA-Z0-9]+$/.test(projectId)) {
      return corsJson({ error: "not_found" }, 404);
    }
    const body = await request.text();
    if (body.length > PAGE_VIEW_BODY_LIMIT) {
      return corsJson({ error: "body_too_large" }, 413);
    }
    const upstream = await projectStoreFetch(env, request.url, `proj:${projectId}`, "/pv-ingest", {
      method: "POST",
      body,
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("pv relay failed", error instanceof Error ? error.message : "error");
    return corsJson({ error: "internal" }, 500);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Tiny human-readable page for the Slack install tab — no assets, honest copy. */
function slackCallbackPage(ok: boolean, title: string, message: string): Response {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{margin:0;display:grid;place-items:center;min-height:100vh;background:#141210;color:#f4eee3;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}
  main{max-width:26rem;padding:2.5rem 1.5rem;text-align:center}
  .dot{display:inline-flex;width:3rem;height:3rem;border-radius:9999px;align-items:center;justify-content:center;font-size:1.35rem;background:${ok ? "rgba(16,185,129,.16)" : "rgba(245,158,11,.16)"}}
  h1{font-size:1.15rem;margin:1rem 0 .5rem}
  p{margin:0;color:#b5ac9c}
</style></head>
<body><main>
  <span class="dot">${ok ? "\u2713" : "!"}</span>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
</main></body></html>`;
  return new Response(body, {
    status: ok ? 200 : 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * GET /slack/oauth/callback — Slack lands here after the admin authorizes the
 * bot install. The state's plain part only routes to the project shard; the
 * shard verifies the HMAC (keyed by the app's client secret) and swaps the
 * code for the bot token server-side. Renders a small human page — this tab
 * was opened from the agent editor, which picks the result up by polling.
 */
async function relaySlackOAuthCallback(request: Request, url: URL, env: Env): Promise<Response> {
  try {
    if (request.method !== "GET") {
      return corsJson({ error: "method_not_allowed" }, 405);
    }
    const denied = url.searchParams.get("error");
    if (denied) {
      return slackCallbackPage(
        false,
        "Install cancelled",
        `Slack reported "${denied}" — nothing was installed. Close this tab and retry from Gera.`,
      );
    }
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const payload = decodeSlackInstallState(state);
    if (!code || !payload) {
      return slackCallbackPage(
        false,
        "Invalid install link",
        "This link is malformed or expired — go back to Gera and click Install again.",
      );
    }
    const upstream = await projectStoreFetch(env, request.url, `proj:${payload.projectId}`, "/slack-oauth", {
      method: "POST",
      body: JSON.stringify({ agentId: payload.agentId, code, state }),
    });
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    console.log("slack oauth callback", upstream.status);
    if (!upstream.ok) {
      const message =
        typeof data.message === "string" && data.message.length > 0
          ? data.message
          : `The install could not be completed (${typeof data.error === "string" ? data.error : upstream.status}). Retry from Gera.`;
      return slackCallbackPage(false, "Install failed", message);
    }
    const team = typeof data.team === "string" && data.team.length > 0 ? data.team : "your workspace";
    return slackCallbackPage(
      true,
      "Slack bot installed",
      `The bot is now in ${team}. Back in Gera the editor updates by itself — /invite the bot to a channel and @mention it.`,
    );
  } catch (error) {
    console.error("slack oauth callback failed", error instanceof Error ? error.message : "error");
    return slackCallbackPage(false, "Install failed", "Unexpected error — try again from Gera.");
  }
}

/**
 * /projects/* — team workspaces: scoped agents (e.g. read-only repo guides,
 * Intercom support desks) plus Slack-style channels with threads. Identity +
 * invite gate here; membership and roles are enforced inside each project's
 * ProjectStore shard. Agent replies fire via waitUntil after the message
 * commits, so posting never blocks on an LLM run.
 */
async function relayProjects(request: Request, url: URL, env: Env, ctx: ExecutionCtx): Promise<Response> {
  try {
    const userId = request.headers.get("X-Rork-User-Id");
    const email = (request.headers.get("X-Rork-User-Email") ?? "").trim().toLowerCase();
    if (!userId || !email) {
      return corsJson({ error: "sign_in_required" }, 401);
    }
    if (!(await isInvitedCached(env, request.url, email))) {
      return corsJson({ error: "invite_required" }, 403);
    }

    if (request.method === "GET" && url.pathname === "/projects") {
      const upstream = await projectStoreFetch(
        env,
        request.url,
        "registry",
        `/reg/list?email=${encodeURIComponent(email)}`,
        { method: "GET" },
      );
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (request.method === "POST" && url.pathname === "/projects/create") {
      const raw = await request.text();
      if (raw.length > 4_096) {
        return corsJson({ error: "body_too_large" }, 413);
      }
      let parsed: { name?: unknown; ownerName?: unknown };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        return corsJson({ error: "invalid_json" }, 400);
      }
      const name = typeof parsed.name === "string" ? parsed.name.trim().slice(0, 60) : "";
      if (!name) {
        return corsJson({ error: "invalid_name" }, 400);
      }
      const projectId = `p${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const init = await projectStoreFetch(env, request.url, `proj:${projectId}`, "/init", {
        method: "POST",
        email,
        body: JSON.stringify({
          projectId,
          name,
          ownerName: typeof parsed.ownerName === "string" ? parsed.ownerName.slice(0, 60) : "",
        }),
      });
      if (!init.ok) {
        const text = await init.text();
        return new Response(text, {
          status: init.status,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      await projectStoreFetch(env, request.url, "registry", "/reg/upsert", {
        method: "POST",
        body: JSON.stringify({ projectId, name, rows: [{ email, role: "owner" }] }),
      });
      console.log("project created");
      return corsJson({ ok: true, id: projectId, name }, 200);
    }

    const match = /^\/projects\/(p[a-f0-9]{20})(\/.+)$/.exec(url.pathname);
    if (!match) {
      return corsJson({ error: "not_found" }, 404);
    }
    const projectId = match[1];
    const sub = match[2];
    const expected = PROJECT_SUB_ROUTES[sub];
    if (!expected || request.method !== expected) {
      return corsJson({ error: "not_found" }, 404);
    }
    let body: string | undefined;
    if (expected === "POST") {
      body = await request.text();
      if (body.length > PROJECT_BODY_LIMIT) {
        return corsJson({ error: "body_too_large" }, 413);
      }
    }
    const upstream = await projectStoreFetch(env, request.url, `proj:${projectId}`, `${sub}${url.search}`, {
      method: expected,
      email,
      body,
    });
    const text = await upstream.text();
    if (upstream.ok && expected === "POST") {
      ctx.waitUntil(projectPostEffects(env, request.url, projectId, email, sub, body ?? "", text));
    }
    if (upstream.ok && sub === "/members/add") {
      // Honest hint: project membership does not grant Gera access — the
      // added email still needs an app invite to sign in at all.
      try {
        const data = JSON.parse(text) as Record<string, unknown>;
        const added = typeof data.email === "string" ? data.email : "";
        const invited = added ? await isInvitedCached(env, request.url, added) : false;
        return corsJson({ ...data, invited }, upstream.status);
      } catch {
        // fall through to the raw response
      }
    }
    const quiet =
      sub === "/messages" ||
      sub === "/overview" ||
      sub === "/read" ||
      sub === "/message" ||
      sub === "/screen-chat" ||
      sub === "/screen-chat/send" ||
      sub === "/intercom/inbox" ||
      sub === "/intercom/thread" ||
      sub === "/intercom/details" ||
      sub === "/intercom/suggest" ||
      sub === "/intercom/stats" ||
      sub === "/intercom/slack-related" ||
      sub === "/intercom/ask-status";
    if (!quiet) {
      console.log("projects", request.method, sub, upstream.status);
    }
    return new Response(text, {
      status: upstream.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("projects relay failed", error instanceof Error ? error.message : "error");
    return corsJson({ error: "upstream_unreachable" }, 502);
  }
}

/** Surf command bodies (URL + fields + cookie jar) stay small by design. */
const SURF_BODY_LIMIT = 160_000;

/**
 * POST /surf — one SelfSurf navigation for the signed-in, invited account.
 * The browser cannot fetch arbitrary sites (CORS), so the Worker performs the
 * HTTP hop: redirects, cookie jar, HTML parsing. The jar lives in the client's
 * per-turn session — nothing is stored or logged here.
 */
async function relaySurf(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return corsJson({ error: "method_not_allowed" }, 405);
  }
  const userId = request.headers.get("X-Rork-User-Id");
  const email = (request.headers.get("X-Rork-User-Email") ?? "").trim().toLowerCase();
  if (!userId || !email) {
    return corsJson({ error: "sign_in_required" }, 401);
  }
  const body = await request.text();
  if (body.length > SURF_BODY_LIMIT) {
    return corsJson({ error: "body_too_large" }, 413);
  }
  if (!(await isInvitedCached(env, request.url, email))) {
    return corsJson({ error: "invite_required" }, 403);
  }

  let parsed: {
    action?: unknown;
    url?: unknown;
    method?: unknown;
    fields?: unknown;
    jar?: unknown;
    referer?: unknown;
  };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return corsJson({ error: "invalid_json" }, 400);
  }
  const action = parsed.action === "submit" ? "submit" : parsed.action === "open" ? "open" : null;
  if (!action || typeof parsed.url !== "string" || parsed.url.length === 0 || parsed.url.length > 4_000) {
    return corsJson({ error: "invalid_command" }, 400);
  }
  const fields: Record<string, string> = {};
  if (parsed.fields && typeof parsed.fields === "object" && !Array.isArray(parsed.fields)) {
    let count = 0;
    for (const [key, value] of Object.entries(parsed.fields as Record<string, unknown>)) {
      if (count >= 60) {
        break;
      }
      if (typeof key === "string" && key.length > 0 && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
        fields[key] = String(value);
        count += 1;
      }
    }
  }
  const jar: SurfJar =
    parsed.jar && typeof parsed.jar === "object" && !Array.isArray(parsed.jar) ? (parsed.jar as SurfJar) : {};
  const command: SurfCommand = {
    action,
    url: parsed.url,
    method: parsed.method === "POST" ? "POST" : "GET",
    fields,
    referer: typeof parsed.referer === "string" && parsed.referer.startsWith("http") ? parsed.referer : undefined,
  };

  try {
    const page = await performSurf(command, jar);
    let host = "";
    try {
      host = new URL(page.url).hostname;
    } catch {
      host = "?";
    }
    console.log("surf", action, host, page.status);
    return corsJson({ page, jar }, 200);
  } catch (error) {
    console.error("surf failed", error instanceof Error ? error.message : "error");
    return corsJson({ error: "surf_failed" }, 502);
  }
}

/** Sync bodies are capped — the client batches pushes well below this. */
const CHAT_SYNC_BODY_LIMIT = 4_000_000;

/** Run starts carry resolved attachments inline — a generous but hard cap. */
const RUNS_START_BODY_LIMIT = 8_000_000;
const RUNS_SMALL_BODY_LIMIT = 2_000_000;

/**
 * /runs/* — interactive server-side agent runs in the account's ChatStore
 * shard: start / steer / retract / stop / ack (POST), active / stream /
 * media (GET). Same trust chain as chat sync (platform identity + invite).
 * The live stream response passes through AS A STREAM — buffering it would
 * defeat the whole live channel.
 */
async function relayRuns(request: Request, url: URL, env: Env): Promise<Response> {
  try {
    const userId = request.headers.get("X-Rork-User-Id");
    const email = (request.headers.get("X-Rork-User-Email") ?? "").trim().toLowerCase();
    if (!userId || !email) {
      return corsJson({ error: "sign_in_required" }, 401);
    }
    const sub = url.pathname;
    const isGet = request.method === "GET";
    const allowedGet = sub === "/runs/active" || sub === "/runs/stream" || sub === "/runs/media";
    const allowedPost =
      sub === "/runs/start" ||
      sub === "/runs/steer" ||
      sub === "/runs/retract" ||
      sub === "/runs/stop" ||
      sub === "/runs/ack";
    if (isGet ? !allowedGet : !(request.method === "POST" && allowedPost)) {
      return corsJson({ error: "not_found" }, 404);
    }
    let body: string | undefined;
    if (!isGet) {
      body = await request.text();
      const limit = sub === "/runs/start" ? RUNS_START_BODY_LIMIT : RUNS_SMALL_BODY_LIMIT;
      if (body.length > limit) {
        return corsJson({ error: "body_too_large" }, 413);
      }
    }
    if (!(await isInvitedCached(env, request.url, email))) {
      return corsJson({ error: "invite_required" }, 403);
    }
    const upstream = await shardCall(env, request.url, email, `${sub}${url.search}`, {
      method: isGet ? "GET" : "POST",
      body,
    });
    if (sub === "/runs/stream" && upstream.ok) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": upstream.headers.get("Content-Type") ?? "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }
    const text = await upstream.text();
    if (sub !== "/runs/stream" && sub !== "/runs/active") {
      console.log("runs", request.method, sub, upstream.status);
    }
    return new Response(text, {
      status: upstream.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("runs relay failed", error instanceof Error ? error.message : "error");
    return corsJson({ error: "upstream_unreachable" }, 502);
  }
}

/**
 * POST /chats/sync — cloud chat history for the signed-in, invited account.
 * The client and the ChatStore DO speak a want-driven protocol; identity
 * comes exclusively from the platform-verified X-Rork-User-* headers.
 */
async function relayChatSync(request: Request, url: URL, env: Env): Promise<Response> {
  try {
    if (request.method !== "POST" || url.pathname !== "/chats/sync") {
      return corsJson({ error: "not_found" }, 404);
    }
    const userId = request.headers.get("X-Rork-User-Id");
    const email = (request.headers.get("X-Rork-User-Email") ?? "").trim().toLowerCase();
    if (!userId || !email) {
      return corsJson({ error: "sign_in_required" }, 401);
    }
    const body = await request.text();
    if (body.length > CHAT_SYNC_BODY_LIMIT) {
      return corsJson({ error: "body_too_large" }, 413);
    }
    if (!(await isInvitedCached(env, request.url, email))) {
      return corsJson({ error: "invite_required" }, 403);
    }
    const upstream = await shardCall(env, request.url, email, "/sync", { method: "POST", body });
    const text = await upstream.text();
    console.log("chats sync", upstream.status);
    return new Response(text, {
      status: upstream.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("chat sync relay failed", error instanceof Error ? error.message : "error");
    return corsJson({ error: "upstream_unreachable" }, 502);
  }
}

/**
 * GET /mcp/oauth-rotations — server-rotated MCP grants for the signed-in
 * account. The browser adopts these instead of dropping a sign-in whose
 * refresh token was already rotated by a server run. Same trust chain as
 * chat sync: platform-verified identity + invite, then the account shard.
 */
async function relayOAuthRotations(request: Request, url: URL, env: Env): Promise<Response> {
  try {
    if (request.method !== "GET") {
      return corsJson({ error: "not_found" }, 404);
    }
    const userId = request.headers.get("X-Rork-User-Id");
    const email = (request.headers.get("X-Rork-User-Email") ?? "").trim().toLowerCase();
    if (!userId || !email) {
      return corsJson({ error: "sign_in_required" }, 401);
    }
    if (!(await isInvitedCached(env, request.url, email))) {
      return corsJson({ error: "invite_required" }, 403);
    }
    const upstream = await shardCall(env, request.url, email, "/mcp/oauth-rotations", { method: "GET" });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("oauth rotations relay failed", error instanceof Error ? error.message : "error");
    return corsJson({ error: "upstream_unreachable" }, 502);
  }
}

/** Error-journal bodies stay tiny; anything bigger is a bug or abuse. */
const DIAG_BODY_LIMIT = 131_072;

/**
 * /diag/* — per-account error journal (the in-app Diagnostics screen).
 * Same trust chain as chat sync: platform-verified identity + invite, then
 * the ChatStore DO owns the rows.
 */
async function relayDiagnostics(request: Request, url: URL, env: Env): Promise<Response> {
  try {
    const userId = request.headers.get("X-Rork-User-Id");
    const email = (request.headers.get("X-Rork-User-Email") ?? "").trim().toLowerCase();
    if (!userId || !email) {
      return corsJson({ error: "sign_in_required" }, 401);
    }
    const sub = url.pathname.slice("/diag".length) || "/";
    const isList = request.method === "GET" && sub === "/list";
    const isWrite =
      request.method === "POST" && (sub === "/append" || sub === "/seen" || sub === "/clear");
    if (!isList && !isWrite) {
      return corsJson({ error: "not_found" }, 404);
    }
    let body: string | undefined;
    if (isWrite) {
      body = await request.text();
      if (body.length > DIAG_BODY_LIMIT) {
        return corsJson({ error: "body_too_large" }, 413);
      }
    }
    if (!(await isInvitedCached(env, request.url, email))) {
      return corsJson({ error: "invite_required" }, 403);
    }
    const upstream = await shardCall(env, request.url, email, `/diag${sub}`, {
      method: request.method === "GET" ? "GET" : "POST",
      body,
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("diag relay failed", error instanceof Error ? error.message : "error");
    return corsJson({ error: "upstream_unreachable" }, 502);
  }
}

/** Inbound webhook deliveries: body cap, token shape, per-token rate cap. */
const HOOK_BODY_LIMIT = 65_536;
const HOOK_TOKEN_PATTERN = /^wh_[A-Za-z0-9]{20,64}$/;
const HOOK_RATE_LIMIT = 12;
const HOOK_RATE_WINDOW_MS = 60_000;
const HOOKS_INDEX_CAP = 20;
/** Per-isolate delivery timestamps — approximate but honest abuse damping. */
const hookRate = new Map<string, number[]>();

function hookRateExceeded(token: string): boolean {
  const now = Date.now();
  const stamps = (hookRate.get(token) ?? []).filter((at) => now - at < HOOK_RATE_WINDOW_MS);
  if (stamps.length >= HOOK_RATE_LIMIT) {
    hookRate.set(token, stamps);
    return true;
  }
  stamps.push(now);
  if (hookRate.size > 2_000) {
    hookRate.clear();
  }
  hookRate.set(token, stamps);
  return false;
}

/** Mirrors one shard's webhook-token registry rows into the global object. */
async function hooksSet(env: Env, origin: string, email: string, raw: string): Promise<void> {
  let hooks: Array<{ t: string; a: string }> = [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      hooks = parsed
        .filter((item): item is { t: string; a: string } => {
          const row = item as { t?: unknown; a?: unknown };
          return (
            Boolean(row) &&
            typeof row.t === "string" &&
            HOOK_TOKEN_PATTERN.test(row.t) &&
            typeof row.a === "string" &&
            row.a.length > 0
          );
        })
        .slice(0, HOOKS_INDEX_CAP);
    }
  } catch {
    return; // malformed header — leave the registry untouched
  }
  try {
    const headers = new Headers();
    headers.set("X-Rork-DO-Class", "ChatStore");
    headers.set("X-Rork-DO-Id", "global");
    headers.set("Content-Type", "application/json");
    const response = await env.DO.fetch(
      new Request(new URL("/hooks-set", origin).toString(), {
        method: "POST",
        headers,
        body: JSON.stringify({ owner: email, hooks }),
      }),
    );
    if (!response.ok) {
      console.error("hooks set failed", response.status);
    }
  } catch (error) {
    console.error("hooks set unreachable", error instanceof Error ? error.message : "error");
  }
}

/** Asks the global registry which account + automation owns a webhook token. */
async function hooksResolve(
  env: Env,
  origin: string,
  token: string,
): Promise<{ owner: string; automationId: string } | "unknown" | "unreachable"> {
  try {
    const headers = new Headers();
    headers.set("X-Rork-DO-Class", "ChatStore");
    headers.set("X-Rork-DO-Id", "global");
    headers.set("Content-Type", "application/json");
    const response = await env.DO.fetch(
      new Request(new URL("/hooks-resolve", origin).toString(), {
        method: "POST",
        headers,
        body: JSON.stringify({ token }),
      }),
    );
    if (response.status === 404) {
      return "unknown";
    }
    if (!response.ok) {
      return "unreachable";
    }
    const data = (await response.json()) as { owner?: unknown; automationId?: unknown };
    if (typeof data.owner === "string" && data.owner && typeof data.automationId === "string" && data.automationId) {
      return { owner: data.owner, automationId: data.automationId };
    }
    return "unknown";
  } catch (error) {
    console.error("hooks resolve unreachable", error instanceof Error ? error.message : "error");
    return "unreachable";
  }
}

/**
 * /hooks/<token> — public inbound webhook triggers for cloud automations.
 * No Rork identity here by design: the long random token IS the credential
 * (same model as a GitHub webhook URL). POST queues the delivery on the
 * owner's shard and fires it immediately; GET answers whether the hook is
 * registered so users can test the URL from a browser. The shard re-checks
 * the token against the live profile, so a stale registry row cannot fire
 * anything. Payloads are never logged.
 */
async function relayHook(request: Request, url: URL, env: Env, ctx: ExecutionCtx): Promise<Response> {
  const token = url.pathname.slice("/hooks/".length);
  if (!HOOK_TOKEN_PATTERN.test(token)) {
    return corsJson({ error: "unknown_hook" }, 404);
  }
  if (request.method !== "POST" && request.method !== "GET") {
    return corsJson({ error: "method_not_allowed" }, 405);
  }
  if (request.method === "POST" && hookRateExceeded(token)) {
    return corsJson(
      { error: "rate_limited", hint: `Max ${HOOK_RATE_LIMIT} deliveries per minute per hook.` },
      429,
    );
  }
  const body = request.method === "POST" ? await request.text() : "";
  if (body.length > HOOK_BODY_LIMIT) {
    return corsJson({ error: "body_too_large", limitBytes: HOOK_BODY_LIMIT }, 413);
  }
  const resolved = await hooksResolve(env, new URL(request.url).origin, token);
  if (resolved === "unreachable") {
    return corsJson({ error: "upstream_unreachable" }, 502);
  }
  if (resolved === "unknown") {
    return corsJson(
      {
        error: "unknown_hook",
        hint: "No automation is registered for this URL — check the webhook trigger on the Automations page and make sure the account synced after enabling it.",
      },
      404,
    );
  }
  if (request.method === "GET") {
    console.log("hook ping", resolved.automationId);
    return corsJson(
      { ok: true, hint: "Webhook is registered. POST a payload to this URL to fire the automation." },
      200,
    );
  }
  try {
    const upstream = await shardCall(env, request.url, resolved.owner, "/hook-fire", {
      method: "POST",
      body: JSON.stringify({
        automationId: resolved.automationId,
        token,
        payload: body,
        contentType: request.headers.get("Content-Type") ?? "",
        event:
          request.headers.get("X-GitHub-Event") ??
          request.headers.get("X-Gitlab-Event") ??
          request.headers.get("X-Event-Key") ??
          "",
        delivery: request.headers.get("X-GitHub-Delivery") ?? request.headers.get("X-Request-Id") ?? "",
      }),
    });
    if (upstream.ok) {
      // Fire immediately — the cron tick is only the safety net.
      ctx.waitUntil(fireShard(env, new URL(request.url).origin, resolved.owner));
    }
    const text = await upstream.text();
    console.log("hook deliver", resolved.automationId, upstream.status);
    return new Response(text, {
      status: upstream.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("hook relay failed", error instanceof Error ? error.message : "error");
    return corsJson({ error: "upstream_unreachable" }, 502);
  }
}

/** Automation trigger bodies only ever carry one id. */
const RUN_NOW_BODY_LIMIT = 4_096;

/**
 * POST /automations/run-now — fires one cloud automation immediately: the
 * account's shard flags the automation and rings its Durable Object alarm,
 * so the manual run flows through the exact same pipeline as a scheduled
 * exact-time trigger.
 */
async function relayRunNow(request: Request, url: URL, env: Env, ctx: ExecutionCtx): Promise<Response> {
  try {
    if (request.method !== "POST") {
      return corsJson({ error: "method_not_allowed" }, 405);
    }
    const userId = request.headers.get("X-Rork-User-Id");
    const email = (request.headers.get("X-Rork-User-Email") ?? "").trim().toLowerCase();
    if (!userId || !email) {
      return corsJson({ error: "sign_in_required" }, 401);
    }
    const body = await request.text();
    if (body.length > RUN_NOW_BODY_LIMIT) {
      return corsJson({ error: "body_too_large" }, 413);
    }
    if (!(await isInvitedCached(env, request.url, email))) {
      return corsJson({ error: "invite_required" }, 403);
    }
    const upstream = await shardCall(env, request.url, email, "/run-now", { method: "POST", body });
    if (upstream.ok) {
      // Fire immediately — the cron tick is only the safety net.
      ctx.waitUntil(fireShard(env, new URL(request.url).origin, email));
    }
    const text = await upstream.text();
    console.log("automation run-now", upstream.status);
    return new Response(text, {
      status: upstream.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("run-now relay failed", error instanceof Error ? error.message : "error");
    return corsJson({ error: "upstream_unreachable" }, 502);
  }
}

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
async function relayMcp(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method !== "POST" && request.method !== "GET") {
    return corsJson({ error: "method_not_allowed" }, 405);
  }
  const accessProblem = await relayAccessProblem(request, env);
  if (accessProblem) {
    return accessProblem;
  }
  const target = request.headers.get("X-Gera-Upstream-Url") ?? url.searchParams.get("url") ?? "";
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return corsJson({ error: "invalid_url" }, 400);
  }
  if (parsed.protocol !== "https:") {
    return corsJson({ error: "https_required" }, 400);
  }
  if (parsed.username || parsed.password) {
    return corsJson({ error: "credentials_not_allowed" }, 400);
  }
  if (isForbiddenHost(parsed.hostname)) {
    return corsJson({ error: "host_not_allowed" }, 400);
  }

  const body = request.method === "POST" ? await request.text() : "";
  if (body.length > MCP_BODY_LIMIT) {
    return corsJson({ error: "body_too_large" }, 413);
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
      return corsJson({ error: "upstream_unreachable" }, 502);
    }
    if (upstream.status < 300 || upstream.status >= 400) {
      break;
    }
    const location = upstream.headers.get("location");
    if (!location) {
      return corsJson({ error: "redirect_without_location" }, 502);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return corsJson({ error: "invalid_redirect" }, 502);
    }
    if (next.protocol !== "https:" || next.username || next.password || isForbiddenHost(next.hostname)) {
      return corsJson({ error: "redirect_not_allowed" }, 502);
    }
    if (next.origin !== current.origin) {
      if (method === "POST") {
        return corsJson({ error: "cross_origin_redirect_refused" }, 502);
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
    return corsJson({ error: "too_many_redirects" }, 502);
  }

  console.log("mcp relay", parsed.hostname, upstream.status);
  const responseHeaders: Record<string, string> = {
    ...CORS_HEADERS,
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

/**
 * /knowledge/* — per-account cloud storage for large knowledge files. The
 * client keeps a short excerpt in the synced profile blob and stores the
 * full text as an R2 object under the caller's private prefix; these routes
 * mint short-lived presigned URLs (see knowledge-storage.ts). Same identity
 * + invite gate as chat sync.
 */
async function relayKnowledge(request: Request, url: URL, env: Env): Promise<Response> {
  const userId = request.headers.get("X-Rork-User-Id");
  const email = (request.headers.get("X-Rork-User-Email") ?? "").trim().toLowerCase();
  if (!userId || !email) {
    return corsJson({ error: "sign_in_required" }, 401);
  }
  if (!(await isInvitedCached(env, request.url, email))) {
    return corsJson({ error: "invite_required" }, 403);
  }
  const { status, body } = await handleKnowledgeRoute(request, url, env, email);
  return corsJson(body, status);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionCtx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/cron/automations") {
      if (request.method !== "POST") {
        return corsJson({ error: "method_not_allowed" }, 405);
      }
      const body = await request.text();
      const signature = request.headers.get("X-Rork-Cron-Signature");
      if (!env.CRON_SECRET || !(await verifyCronSignature(env.CRON_SECRET, body, signature))) {
        console.error("cron automations: bad signature");
        return corsJson({ error: "bad_signature" }, 401);
      }
      // Answer QStash fast; sweep + fire continue after the response.
      ctx.waitUntil(
        (async () => {
          await sweepGlobalMigrations(env, url.origin);
          await fireDueAutomations(env, url.origin);
        })().catch((error) =>
          console.error("cron tick crashed", error instanceof Error ? error.message : "error"),
        ),
      );
      return corsJson({ ok: true }, 200);
    }

    if (request.method === "OPTIONS") {
      // Echo whatever headers the browser asks for: MCP requests carry
      // MCP-Protocol-Version, Mcp-Session-Id, and custom X-* auth headers.
      const requested = request.headers.get("Access-Control-Request-Headers");
      return new Response(null, {
        status: 204,
        headers: requested ? { ...CORS_HEADERS, "Access-Control-Allow-Headers": requested } : CORS_HEADERS,
      });
    }
    if (url.pathname === "/ping") {
      return corsJson({ ok: true, now: new Date().toISOString() }, 200);
    }
    if (url.pathname === "/access" || url.pathname.startsWith("/access/")) {
      return relayAccess(request, url, env);
    }
    if (url.pathname === "/share" || url.pathname.startsWith("/share/")) {
      return relayShares(request, url, env);
    }
    if (url.pathname === "/arena" || url.pathname.startsWith("/arena/")) {
      return relayArena(request, url, env);
    }
    if (url.pathname === "/chats/sync") {
      return relayChatSync(request, url, env);
    }
    if (url.pathname.startsWith("/runs/")) {
      return relayRuns(request, url, env);
    }
    if (url.pathname === "/diag" || url.pathname.startsWith("/diag/")) {
      return relayDiagnostics(request, url, env);
    }
    if (url.pathname === "/mcp/oauth-rotations") {
      return relayOAuthRotations(request, url, env);
    }
    if (url.pathname === "/automations/run-now") {
      return relayRunNow(request, url, env, ctx);
    }
    if (url.pathname === "/projects" || url.pathname.startsWith("/projects/")) {
      return relayProjects(request, url, env, ctx);
    }
    if (url.pathname.startsWith("/hooks/")) {
      return relayHook(request, url, env, ctx);
    }
    if (url.pathname === "/surf") {
      return relaySurf(request, url, env);
    }
    if (url.pathname.startsWith("/knowledge/")) {
      return relayKnowledge(request, url, env);
    }
    if (url.pathname === "/oauth-proxy") {
      return relayOAuth(request, url, env);
    }
    if (url.pathname === "/mcp-proxy") {
      return relayMcp(request, url, env);
    }
    if (url.pathname.startsWith("/intercom/")) {
      return relayIntercom(request, url, env);
    }
    if (url.pathname === "/slack/oauth/callback") {
      return relaySlackOAuthCallback(request, url, env);
    }
    if (url.pathname.startsWith("/slack/events/")) {
      return relaySlackEvents(request, url, env, ctx);
    }
    if (url.pathname === "/pv.js") {
      // The page-view tracker for customer sites — static, cacheable, CORS-open.
      return new Response(TRACKER_JS, {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }
    if (url.pathname.startsWith("/pv/")) {
      return relayPageViews(request, url, env);
    }
    return corsJson({ ok: true, service: "gera-functions" }, 200);
  },
};
