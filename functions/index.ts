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
// in a dedicated internal header and is restored only after that gate. Generic
// relay payloads are never stored or logged; rotating MCP refresh results use a
// dedicated account-shard escrow so a web deploy cannot lose the replacement.
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

import { AccessRegistry } from "./access-registry";
import { verifyCronSignature } from "./cron-auth";
import { TRACKER_JS } from "./desk-pageviews";
import { handleKnowledgeRoute, probeRorkStorage } from "./knowledge-storage";
import { githubRequestHeaders } from "./native-github";
import {
  relayAccountMcp,
  relayBrowserOAuthRefresh,
  relayMcp,
  relayMcpOAuthCallback,
  relayOAuthRotations,
  type McpRelayContext,
} from "./mcp-relay";
import { relayPageViews, relayProjects, relaySlackEvents, relaySlackOAuthCallback, type ProjectRelayContext } from "./project-relay";
import {
  relayRepoPreviewPublic,
  relayRepoPreviews,
  type RepoPreviewRelayContext,
  sweepRepoPreviewRegistry,
} from "./repo-preview-relay";
import { fetchPublicHttps, isForbiddenHost } from "./network-safety";
import { SecretVault } from "./secret-vault";
import { performSurf, type SurfCommand, type SurfJar } from "./selfsurf";
import { chatShardId, migrateOwnerToShard, sweepGlobalMigrations } from "./shard-migration";

export { AccessRegistry };
export { ArenaStore } from "./arena-store";
export { ChatStore } from "./chat-store";
export { ProjectStore } from "./project-store";
export { RepoPreviewStore } from "./repo-preview-store";
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
  /** Rork auth host — same API surface; backs up the API base for storage credentials. */
  EXPO_PUBLIC_RORK_AUTH_URL?: string;
  RORK_AUTH_URL?: string;
  /** Public app key the Gera client sends to Rork Auth; pins the auth relay to this app. */
  EXPO_PUBLIC_RORK_APP_KEY?: string;
  /** Stable private salt for opaque repository-preview account shards. */
  RORK_AUTH_SECRET_KEY?: string;
  /**
   * Key material for encrypting stored credentials at rest (OAuth grants,
   * pasted keys, bot tokens) inside the Durable Objects — see secret-vault.ts.
   * Base64 or hex of at least 32 random bytes; without a valid key every
   * credential read and write fails closed with `secrets_key_unavailable`.
   */
  SECRETS_ENCRYPTION_KEY?: string;
  /** Comma-separated previous keys, decrypt-only, while a rotation completes. */
  SECRETS_ENCRYPTION_KEY_PREVIOUS?: string;
  /** Present only on the isolated black-box acceptance Worker. */
  STAGING_VERSION?: string;
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
    "Authorization, Content-Type, X-Intercom-Region, X-Gera-Upstream-Authorization, X-Gera-Upstream-Url, X-Gera-GitHub-Accept",
  "Access-Control-Expose-Headers":
    "Mcp-Session-Id, MCP-Protocol-Version, WWW-Authenticate, X-Gera-Relay-Auth, X-OAuth-Scopes, X-Accepted-OAuth-Scopes, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After, Link, Content-Disposition",
  "Access-Control-Max-Age": "86400",
};

function corsJson(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function readBoundedText(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let result = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    result += decoder.decode(chunk.value, { stream: true });
  }
  return result + decoder.decode();
}

const AUTH_RELAY_PREFIX = "/auth-relay";
const AUTH_RELAY_PATHS: ReadonlySet<string> = new Set(["/oauth/initiate", "/oauth/token", "/oauth/refresh"]);
const AUTH_RELAY_MAX_BODY = 16 * 1024;

/**
 * CORS relay for the three Rork Auth endpoints the Gera client calls.
 *
 * Only a build whose document has an opaque origin uses it: the sandboxed
 * Repo Preview sends `Origin: null`, which api.rork.com's CORS answers with
 * `https://rork.com`, so the browser drops the response ("Failed to fetch").
 * The relay is pinned to this app's public key so it is not an open proxy,
 * forwards the JSON body verbatim, and never logs a body — codes, verifiers
 * and refresh tokens pass through untouched.
 */
async function relayAuth(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return corsJson({ error: "method_not_allowed" }, 405);
  }
  const path = url.pathname.slice(AUTH_RELAY_PREFIX.length);
  if (!AUTH_RELAY_PATHS.has(path)) {
    return corsJson({ error: "not_found" }, 404);
  }
  const appKey = env.EXPO_PUBLIC_RORK_APP_KEY ?? "";
  const authBase = (env.EXPO_PUBLIC_RORK_AUTH_URL ?? env.RORK_AUTH_URL ?? "").replace(/\/+$/, "");
  if (!appKey || !/^https:\/\/[^/\s]+$/.test(authBase)) {
    return corsJson({ error: "auth_relay_unconfigured" }, 503);
  }
  const raw = await readBoundedText(request, AUTH_RELAY_MAX_BODY);
  if (raw === null) {
    return corsJson({ error: "payload_too_large" }, 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return corsJson({ error: "invalid_json" }, 400);
  }
  if (!body || typeof body !== "object" || (body as { app_key?: unknown }).app_key !== appKey) {
    return corsJson({ error: "app_key_mismatch" }, 403);
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${authBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: raw,
    });
  } catch (error) {
    console.error("auth relay: upstream unreachable", error instanceof Error ? error.message : "error");
    return corsJson({ error: "auth_upstream_unreachable" }, 502);
  }
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function relayAuthRequired(): Response {
  const response = corsJson({ error: "sign_in_required" }, 401);
  response.headers.set("X-Gera-Relay-Auth", "required");
  return response;
}

/** Browser-facing generic relays are available only to invited Gera accounts. */
async function relayAccessProblem(request: Request, env: Env): Promise<Response | null> {
  const account = await requireInvitedAccount(request, env);
  if (!(account instanceof Response)) {
    return null;
  }
  const response = account.status === 401 ? relayAuthRequired() : account;
  response.headers.set("X-Gera-Relay-Auth", account.status === 401 ? "required" : "forbidden");
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
    // Registration, code exchange, device polling and refresh now run inside
    // the account shard. A browser-facing token relay would violate the
    // server-owned credential boundary, so old bundles fail closed here.
    // error_description surfaces verbatim in the old bundle's sign-in dialogs.
    return corsJson(
      {
        error: "server_owned_oauth_required",
        error_description:
          "Gera was updated — reload this page (Cmd/Ctrl+Shift+R) and start the sign-in again.",
      },
      410,
    );
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

async function sameBootstrapSecret(expected: string, presented: string): Promise<boolean> {
  if (!expected || !presented) return false;
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(presented)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

/** One operator-only escape hatch for pre-principal legacy owners. */
async function relayPrincipalBootstrap(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST" || !env.RORK_AUTH_SECRET_KEY) {
    return corsJson({ error: "not_found" }, 404);
  }
  const presented = request.headers.get("X-Gera-Bootstrap-Secret") ?? "";
  if (!(await sameBootstrapSecret(env.RORK_AUTH_SECRET_KEY, presented))) {
    return corsJson({ error: "unauthorized" }, 401);
  }
  const body = await request.text();
  if (body.length > 4_096) {
    return corsJson({ error: "body_too_large" }, 413);
  }
  const upstream = await env.DO.fetch(
    new Request(new URL("/principal/bootstrap", request.url).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Rork-DO-Class": "AccessRegistry",
        "X-Rork-DO-Id": "global",
        "X-Gera-Internal-Route": "principal-bootstrap",
      },
      body,
    }),
  );
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
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
  const principal = await resolveAccountPrincipal(request, env);
  if (principal instanceof Response) {
    return principal;
  }

  const subPath = url.pathname.slice("/access".length) || "/";
  const target = new URL(request.url);
  target.pathname = subPath;
  const wrapped = new Request(target.toString(), request);
  // Never forward caller-supplied internal routing markers into the DO.
  wrapped.headers.delete("X-Gera-Internal-Route");
  wrapped.headers.delete("X-Gera-Principal-Create");
  wrapped.headers.set("X-Rork-DO-Class", "AccessRegistry");
  wrapped.headers.set("X-Rork-DO-Id", "global");
  wrapped.headers.set("X-Gera-User-Id", encodeURIComponent(userId));
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

type AccountPrincipal = {
  userId: string;
  currentEmail: string;
  storageOwner: string;
  shardId: string;
  accessEmail: string;
  status: "invited" | "none";
  role: "admin" | "member" | null;
};

type PrincipalCacheEntry = { account: AccountPrincipal; expiresAt: number };
const principalCache = new Map<string, PrincipalCacheEntry>();

function principalRegistryCall(
  env: Env,
  requestUrl: string,
  userId: string,
  currentEmail: string,
  allowCreate: boolean,
): Promise<Response> {
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Rork-DO-Class": "AccessRegistry",
    "X-Rork-DO-Id": "global",
    "X-Gera-User-Id": encodeURIComponent(userId),
    "X-Gera-Email": encodeURIComponent(currentEmail),
  });
  if (allowCreate) {
    headers.set("X-Gera-Principal-Create", "empty-owner");
  }
  return env.DO.fetch(
    new Request(new URL("/principal/resolve", requestUrl).toString(), {
      method: "POST",
      headers,
      body: "{}",
    }),
  );
}

/** Metadata-only probes; any ambiguity fails closed before a subject owns an old email shard. */
async function ownerHasLegacyData(env: Env, requestUrl: string, owner: string): Promise<boolean> {
  for (const doId of ["global", chatShardId(owner)]) {
    const response = await env.DO.fetch(
      new Request(new URL("/owner-state", requestUrl).toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Rork-DO-Class": "ChatStore",
          "X-Rork-DO-Id": doId,
        },
        body: JSON.stringify({ owner }),
      }),
    );
    const data = (await response.json().catch(() => ({}))) as { hasData?: unknown };
    if (!response.ok || typeof data.hasData !== "boolean") {
      throw new Error("owner state unavailable");
    }
    if (data.hasData) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves the immutable verified app subject to its permanent account shard.
 * Existing users keep their email-named DO and row owner, so rollout performs
 * no risky cross-object copy. A changed email only becomes an alias.
 */
async function resolveAccountPrincipal(request: Request, env: Env): Promise<AccountPrincipal | Response> {
  const userId = request.headers.get("X-Rork-User-Id") ?? "";
  const currentEmail = (request.headers.get("X-Rork-User-Email") ?? "").trim().toLowerCase();
  if (!userId || !currentEmail) {
    return corsJson({ error: "sign_in_required" }, 401);
  }
  const cacheKey = `${userId}\u0000${currentEmail}`;
  const cached = principalCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.account;
  }
  let response: Response;
  let raw: Partial<AccountPrincipal> & { error?: unknown };
  try {
    response = await principalRegistryCall(env, request.url, userId, currentEmail, false);
    raw = (await response.json().catch(() => ({}))) as Partial<AccountPrincipal> & { error?: unknown };
    if (response.status === 404 && raw.error === "principal_unclaimed") {
      // Invited members (the seed admin included) claim their own legacy shard
      // on first contact — the invite registry is the operator-approved list of
      // identities, so this cannot lock out existing users after rollout. The
      // recycled-email fail-closed gate stays for everyone not on the list.
      const invited = await isInvitedCached(env, request.url, currentEmail);
      if (!invited) {
        const hasLegacyData = await ownerHasLegacyData(env, request.url, currentEmail);
        if (hasLegacyData) {
          return corsJson({ error: "legacy_owner_verification_required" }, 409);
        }
      }
      response = await principalRegistryCall(env, request.url, userId, currentEmail, true);
      raw = (await response.json().catch(() => ({}))) as Partial<AccountPrincipal> & { error?: unknown };
    }
  } catch (error) {
    console.error("principal registry unreachable", error instanceof Error ? error.message : "error");
    return corsJson({ error: "identity_unavailable" }, 503);
  }
  if (!response.ok) {
    return corsJson(
      { error: typeof raw.error === "string" ? raw.error : "identity_unavailable" },
      response.status,
    );
  }
  if (
    raw.userId !== userId ||
    raw.currentEmail !== currentEmail ||
    typeof raw.storageOwner !== "string" ||
    !raw.storageOwner ||
    typeof raw.shardId !== "string" ||
    !raw.shardId ||
    typeof raw.accessEmail !== "string" ||
    !raw.accessEmail ||
    (raw.status !== "invited" && raw.status !== "none")
  ) {
    return corsJson({ error: "identity_unavailable" }, 503);
  }
  const account: AccountPrincipal = {
    userId,
    currentEmail,
    storageOwner: raw.storageOwner,
    shardId: raw.shardId,
    accessEmail: raw.accessEmail,
    status: raw.status,
    role: raw.role === "admin" || raw.role === "member" ? raw.role : null,
  };
  if (principalCache.size > 5_000) {
    principalCache.clear();
  }
  principalCache.set(cacheKey, {
    account,
    expiresAt: Date.now() + (account.status === "invited" ? INVITE_OK_TTL_MS : INVITE_MISS_TTL_MS),
  });
  return account;
}

async function requireInvitedAccount(request: Request, env: Env): Promise<AccountPrincipal | Response> {
  const resolved = await resolveAccountPrincipal(request, env);
  if (resolved instanceof Response) {
    return resolved;
  }
  return resolved.status === "invited" ? resolved : corsJson({ error: "invite_required" }, 403);
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
  principal: string | (Pick<AccountPrincipal, "storageOwner" | "shardId"> & Partial<Pick<AccountPrincipal, "userId">>),
  path: string,
  options: { method: "GET" | "POST"; body?: string },
): Promise<Response> {
  const origin = new URL(requestUrl).origin;
  const storageOwner = typeof principal === "string" ? principal : principal.storageOwner;
  const shardId = typeof principal === "string" ? chatShardId(principal) : principal.shardId;
  // The verified immutable subject rides along so the shard can bind its
  // credential vault to the account (vault-scope.ts); cron fires carry none.
  const accountId = typeof principal === "string" ? "" : principal.userId ?? "";
  const dispatch = (): Promise<Response> => {
    const headers = new Headers();
    headers.set("X-Rork-DO-Class", "ChatStore");
    headers.set("X-Rork-DO-Id", shardId);
    headers.set("X-Gera-Email", encodeURIComponent(storageOwner));
    if (accountId) {
      headers.set("X-Gera-Account-Id", encodeURIComponent(accountId));
    }
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
    await migrateOwnerToShard(env, origin, storageOwner, shardId);
    upstream = await dispatch();
  }
  // Shards report their next automation due instant on profile-carrying
  // responses — mirror it into the global schedule index.
  const nextDueRaw = upstream.headers.get("X-Gera-Next-Due");
  if (nextDueRaw !== null) {
    await scheduleSet(env, origin, storageOwner, Number(nextDueRaw));
  }
  // Same trick for webhook triggers: shards report their token registry
  // rows so the public /hooks/<token> route can find the right shard.
  const hooksRaw = upstream.headers.get("X-Gera-Hooks");
  if (hooksRaw !== null) {
    await hooksSet(env, origin, storageOwner, hooksRaw);
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

    const account = await resolveAccountPrincipal(request, env);
    if (account instanceof Response) {
      return account;
    }
    const email = account.storageOwner;

    if (request.method === "POST" && url.pathname === "/share/create") {
      const body = await request.text();
      if (body.length > SHARE_BODY_LIMIT) {
        return corsJson({ error: "chat_too_large" }, 413);
      }
      if (account.status !== "invited") {
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
    const account = await requireInvitedAccount(request, env);
    if (account instanceof Response) {
      return account;
    }
    const email = account.storageOwner;

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
  const account = await requireInvitedAccount(request, env);
  if (account instanceof Response) {
    return account;
  }
  const body = await request.text();
  if (body.length > SURF_BODY_LIMIT) {
    return corsJson({ error: "body_too_large" }, 413);
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
    const account = await requireInvitedAccount(request, env);
    if (account instanceof Response) {
      return account;
    }
    const sub = url.pathname;
    const isGet = request.method === "GET";
    const allowedGet = sub === "/runs/active" || sub === "/runs/stream" || sub === "/runs/media";
    const allowedPost =
      sub === "/runs/start" ||
      sub === "/runs/steer" ||
      sub === "/runs/retract" ||
      sub === "/runs/stop" ||
      sub === "/runs/ack" ||
      sub === "/runs/answer";
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
    const upstream = await shardCall(env, request.url, account, `${sub}${url.search}`, {
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
    const account = await requireInvitedAccount(request, env);
    if (account instanceof Response) {
      return account;
    }
    const body = await request.text();
    if (body.length > CHAT_SYNC_BODY_LIMIT) {
      return corsJson({ error: "body_too_large" }, 413);
    }
    const upstream = await shardCall(env, request.url, account, "/sync", { method: "POST", body });
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

/** The Worker helpers the MCP relay module (mcp-relay.ts) runs on. */
function mcpRelayContext(env: Env): McpRelayContext<AccountPrincipal> {
  return {
    durable: env.DO,
    corsHeaders: CORS_HEADERS,
    corsJson,
    requireInvitedAccount: (request) => requireInvitedAccount(request, env),
    shardCall: (requestUrl, account, path, options) => shardCall(env, requestUrl, account, path, options),
    relayAccessProblem: (request) => relayAccessProblem(request, env),
  };
}

function projectRelayContext(env: Env): ProjectRelayContext<AccountPrincipal> {
  return {
    durable: env.DO,
    corsHeaders: CORS_HEADERS,
    corsJson,
    requireInvitedAccount: (request) => requireInvitedAccount(request, env),
    isInvitedCached: (requestUrl, email) => isInvitedCached(env, requestUrl, email),
    accountAuthorizationLease: (requestUrl, account, serverId, force) =>
      accountAuthorizationLease(env, requestUrl, account, serverId, force),
  };
}

function repoPreviewRelayContext(env: Env): RepoPreviewRelayContext<AccountPrincipal> {
  return {
    durable: env.DO,
    authSecretKey: env.RORK_AUTH_SECRET_KEY,
    corsHeaders: CORS_HEADERS,
    corsJson,
    readBoundedText,
    requireInvitedAccount: (request) => requireInvitedAccount(request, env),
    accountAuthorizationLease: (requestUrl, account, serverId, force) =>
      accountAuthorizationLease(env, requestUrl, account, serverId, force),
  };
}

async function accountAuthorizationLease(
  env: Env,
  requestUrl: string,
  account: AccountPrincipal,
  serverId: string,
  force: boolean,
): Promise<string | null> {
  const response = await shardCall(env, requestUrl, account, "/mcp/auth-lease", {
    method: "POST",
    body: JSON.stringify({ serverId, catalogId: "github", force }),
  });
  const data = (await response.json().catch(() => ({}))) as { authorization?: unknown };
  return response.ok && typeof data.authorization === "string" ? data.authorization : null;
}

/** Account-owned GitHub relay. Provider tokens stay between Worker and account shard. */
async function relayGitHubAccount(request: Request, url: URL, env: Env): Promise<Response> {
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    return corsJson({ error: "method_not_allowed" }, 405);
  }
  const account = await requireInvitedAccount(request, env);
  if (account instanceof Response) {
    return account;
  }
  const serverId = url.searchParams.get("serverId") ?? "github";
  const rawPath = url.searchParams.get("path") ?? "";
  if (!serverId || serverId.length > 80 || !rawPath.startsWith("/") || rawPath.length > 4_000) {
    return corsJson({ error: "invalid_github_request" }, 400);
  }
  let target: URL;
  try {
    target = new URL(rawPath, "https://api.github.com");
  } catch {
    return corsJson({ error: "invalid_github_request" }, 400);
  }
  if (
    target.origin !== "https://api.github.com" ||
    target.pathname.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return corsJson({ error: "invalid_github_request" }, 400);
  }
  const body = request.method === "GET" ? undefined : await readBoundedText(request, 2_000_000);
  if (body === null) {
    return corsJson({ error: "body_too_large" }, 413);
  }
  const execute = async (force: boolean): Promise<Response | null> => {
    const authorization = await accountAuthorizationLease(env, request.url, account, serverId, force);
    if (!authorization) {
      return null;
    }
    return fetchPublicHttps(target.toString(), {
      method: request.method,
      // Shared builder: includes the User-Agent GitHub requires from servers.
      // Without it every relayed call came back 403 and the account card
      // could never resolve who the grant belongs to.
      headers: githubRequestHeaders(
        authorization,
        body !== undefined,
        request.headers.get("X-Gera-GitHub-Accept") ?? "application/vnd.github+json",
      ),
      body,
      signal: AbortSignal.timeout(30_000),
    }, { allowCrossOriginGet: request.method === "GET" });
  };
  let upstream = await execute(false);
  if (!upstream) {
    return corsJson({ error: "github_sign_in_required" }, 401);
  }
  if (upstream.status === 401) {
    upstream = (await execute(true)) ?? upstream;
  }
  const headers = new Headers({ ...CORS_HEADERS });
  for (const name of [
    "Content-Type",
    "Content-Disposition",
    "X-OAuth-Scopes",
    "X-Accepted-OAuth-Scopes",
    "X-RateLimit-Remaining",
    "X-RateLimit-Reset",
    "Retry-After",
    "Link",
  ]) {
    const value = upstream.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

/** Error-journal bodies stay small (≤20 rows × ≈4.4 KB); anything bigger is a bug or abuse. */
const DIAG_BODY_LIMIT = 262_144;

/**
 * /diag/* — per-account error journal (the in-app Diagnostics screen).
 * Same trust chain as chat sync: platform-verified identity + invite, then
 * the ChatStore DO owns the rows.
 */
async function relayDiagnostics(request: Request, url: URL, env: Env): Promise<Response> {
  try {
    const account = await requireInvitedAccount(request, env);
    if (account instanceof Response) {
      return account;
    }
    const sub = url.pathname.slice("/diag".length) || "/";
    // /vault is the account's secret-free self-check: sealed-row counts only.
    const isList = request.method === "GET" && (sub === "/list" || sub === "/vault");
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
    const upstream = await shardCall(env, request.url, account, `/diag${sub}`, {
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
    const account = await requireInvitedAccount(request, env);
    if (account instanceof Response) {
      return account;
    }
    const body = await request.text();
    if (body.length > RUN_NOW_BODY_LIMIT) {
      return corsJson({ error: "body_too_large" }, 413);
    }
    const upstream = await shardCall(env, request.url, account, "/run-now", { method: "POST", body });
    if (upstream.ok) {
      // Fire immediately — the cron tick is only the safety net.
      ctx.waitUntil(fireShard(env, new URL(request.url).origin, account.storageOwner));
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

/**
 * /knowledge/* — per-account cloud storage for large knowledge files. The
 * client keeps a short excerpt in the synced profile blob and stores the
 * full text as an R2 object under the caller's private prefix; these routes
 * mint short-lived presigned URLs (see knowledge-storage.ts). Same identity
 * + invite gate as chat sync.
 */
async function relayKnowledge(request: Request, url: URL, env: Env): Promise<Response> {
  const account = await requireInvitedAccount(request, env);
  if (account instanceof Response) {
    return account;
  }
  const { status, body } = await handleKnowledgeRoute(request, url, env, account.storageOwner);
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
          // Preview cleanup is bounded and resource-protecting, so it runs
          // before automation work that may legitimately occupy the tick.
          await sweepRepoPreviewRegistry(repoPreviewRelayContext(env), url.origin);
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
      // Secret-free: reports only whether the credential vault has a usable
      // key ("enabled" implies base64/hex of ≥ 32 random bytes) — the first
      // thing to check when a save returns secrets_key_unavailable. Never the
      // key, its id, or its length.
      const vault = SecretVault.fromEnv(env);
      return corsJson(
        { ok: true, now: new Date().toISOString(), secretVault: vault.enabled ? "enabled" : vault.disabledReason },
        200,
      );
    }
    if (url.pathname === "/storage/ping") {
      // Secret-free: reports only whether credentials mint, the bucket, and
      // which Rork API host answered — the first thing to check when a Repo
      // Preview or knowledge upload reports storage_unavailable.
      if (request.method !== "GET") {
        return corsJson({ error: "method_not_allowed" }, 405);
      }
      const probe = await probeRorkStorage(env);
      return corsJson(probe, probe.ok ? 200 : 503);
    }
    if (url.pathname.startsWith(`${AUTH_RELAY_PREFIX}/`)) {
      return relayAuth(request, url, env);
    }
    if (url.pathname === "/__staging/account-version") {
      if (!env.STAGING_VERSION || request.method !== "GET") {
        return corsJson({ error: "not_found" }, 404);
      }
      const account = await requireInvitedAccount(request, env);
      if (account instanceof Response) {
        return account;
      }
      const upstream = await shardCall(env, request.url, account, "/staging/version", { method: "GET" });
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
    if (url.pathname.startsWith("/repo-preview/") || url.pathname.startsWith("/repo-preview-hook/")) {
      return relayRepoPreviewPublic(repoPreviewRelayContext(env), request, url);
    }
    if (url.pathname === "/repo-previews" || url.pathname.startsWith("/repo-previews/")) {
      return relayRepoPreviews(repoPreviewRelayContext(env), request, url);
    }
    if (url.pathname === "/access/bootstrap-principal") {
      return relayPrincipalBootstrap(request, env);
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
    if (url.pathname === "/mcp/oauth/callback") {
      return relayMcpOAuthCallback(mcpRelayContext(env), request, url);
    }
    if (url.pathname === "/github-proxy") {
      return relayGitHubAccount(request, url, env);
    }
    if (url.pathname === "/mcp/oauth-rotations") {
      return relayOAuthRotations(mcpRelayContext(env), request);
    }
    if (url.pathname === "/mcp/oauth-refresh") {
      return relayBrowserOAuthRefresh(mcpRelayContext(env), request);
    }
    if (
      url.pathname === "/mcp/oauth-start" ||
      url.pathname === "/mcp/oauth-status" ||
      url.pathname === "/mcp/oauth-complete" ||
      url.pathname === "/mcp/github-device-start" ||
      url.pathname === "/mcp/github-device-status" ||
      url.pathname === "/mcp/oauth-store" ||
      url.pathname === "/mcp/oauth-clear" ||
      url.pathname === "/mcp/check" ||
      url.pathname === "/mcp/inventory" ||
      url.pathname === "/mcp/prompt-get" ||
      url.pathname === "/mcp/resource-read"
    ) {
      return relayAccountMcp(mcpRelayContext(env), request, url);
    }
    if (url.pathname === "/automations/run-now") {
      return relayRunNow(request, url, env, ctx);
    }
    if (url.pathname === "/projects" || url.pathname.startsWith("/projects/")) {
      return relayProjects(projectRelayContext(env), request, url, ctx);
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
      return relayMcp(mcpRelayContext(env), request, url);
    }
    if (url.pathname.startsWith("/intercom/")) {
      return relayIntercom(request, url, env);
    }
    if (url.pathname === "/slack/oauth/callback") {
      return relaySlackOAuthCallback(projectRelayContext(env), request, url);
    }
    if (url.pathname.startsWith("/slack/events/")) {
      return relaySlackEvents(projectRelayContext(env), request, url, ctx);
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
      return relayPageViews(projectRelayContext(env), request, url);
    }
    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      return corsJson({ ok: true, service: "gera-functions" }, 200);
    }
    // Unknown routes fail loudly. A blanket 200 here once let a preview build
    // without EXPO_PUBLIC_RORK_AUTH_URL believe its root-relative
    // POST /oauth/initiate had succeeded, so it opened a blank sign-in popup.
    return corsJson({ error: "not_found" }, 404);
  },
};
