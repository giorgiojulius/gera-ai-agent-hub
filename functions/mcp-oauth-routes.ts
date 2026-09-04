// Account-shard OAuth routes for MCP servers: the browser sign-in state
// machine (`mcp_oauth_pending`: pending → awaiting_confirmation → exchanging
// → completed / failed, with exchange_retryable / exchange_unknown for
// interrupted redemptions), the legacy grant store/clear/refresh endpoints
// and the GitHub device flow. Every proof (PKCE verifier, one-time code,
// browser nonce, callback challenge, device code) sits sealed in the shard
// and is opened only here; provider tokens never appear in a response.
//
// Handlers are plain functions over `McpOAuthRouteContext` (the credential
// store seam plus a synchronous SQL transaction and the GitHub client id), so
// ChatStore's dispatch stays one line per route.

import { capStr, isRecord, isValidId, json, OAUTH_REF_PREFIX } from "./chat-shared";
import {
  chainRotationBases,
  cloudOAuthToken,
  refreshCloudOAuthGrant,
  type CloudOAuthToken,
  type RefreshedOAuth,
} from "./mcp-cloud";
import { exchangeAuthorizationCode, newOAuthState, OAuthCodeExchangeError } from "./mcp-oauth-flow";
import { clearOAuthScopes, recordGrantedScopes } from "./mcp-oauth-scopes";
import {
  githubConnectorIds,
  markOAuthReady,
  markOAuthRefreshStarted,
  oauthGrantState,
  persistCanonicalOAuthGrant,
  profileOAuthTokens,
  readRotation,
  recordOAuthFailure,
  type OAuthStoreContext,
} from "./mcp-oauth-store";
import { githubOAuthFormHeaders } from "./native-github";
import { fetchPublicHttps } from "./network-safety";
import { deviceCodeScope, OAUTH_PENDING_SECRET_FIELDS, oauthPendingFieldScope, oauthPendingScope, sealGrantPayload } from "./secret-rows";
import { openFields } from "./secret-vault";

export type McpOAuthRouteContext = OAuthStoreContext & {
  /** Synchronous SQL transaction — the code exchange commits grant, scopes and pending row atomically. */
  transactionSync<T>(closure: () => T): T;
  /** GitHub OAuth App client id for the device flow; empty → `github_oauth_not_configured`. */
  githubClientId: string;
};

type GitHubDeviceRow = {
  owner_email: string;
  flow_id: string;
  server_id: string;
  device_code: string;
  user_code: string;
  verification_uri: string;
  client_id: string;
  expires_at: number;
  interval_ms: number;
  next_poll_at: number;
  status: string;
  error: string;
  updated_at: number;
};

/** One `mcp_oauth_pending` row as stored (proof columns sealed). */
export type OAuthPendingRow = {
  owner_email: string;
  state: string;
  server_id: string;
  mcp_url: string;
  token_endpoint: string;
  client_id: string;
  verifier: string;
  redirect_uri: string;
  resource: string;
  issuer: string;
  return_origin: string;
  browser_nonce: string;
  callback_challenge: string;
  authorization_code: string;
  expires_at: number;
  status: string;
  error: string;
  created_at: number;
  updated_at: number;
};

function sameOAuthEndpoint(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    a.hash = "";
    b.hash = "";
    return a.toString().replace(/\/$/, "") === b.toString().replace(/\/$/, "");
  } catch {
    return false;
  }
}

/** Length-independent string equality for proof comparison (no early exit on the first mismatch). */
function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

function oauthPending(ctx: McpOAuthRouteContext, owner: string, state: string): OAuthPendingRow | undefined {
  return ctx.sql
    .exec<OAuthPendingRow>("SELECT * FROM mcp_oauth_pending WHERE owner_email = ? AND state = ?", owner, state)
    .toArray()[0];
}

/** The pending row with its proofs (verifier, code, browser nonce, callback challenge) decrypted. */
function revealOAuthPending(ctx: McpOAuthRouteContext, owner: string, row: OAuthPendingRow): Promise<OAuthPendingRow> {
  return openFields(ctx.vault, row, OAUTH_PENDING_SECRET_FIELDS, oauthPendingScope(ctx.subject(owner), row.state));
}

/**
 * The popup's return URL. For `confirm` the row must already be revealed
 * (`revealOAuthPending`) — the challenge travels to the popup in the clear,
 * but it sits sealed in storage like every other proof of the flow.
 */
function oauthReturnUrl(
  ctx: McpOAuthRouteContext,
  row: OAuthPendingRow,
  status: "confirm" | "complete" | "error" | "replayed",
): string {
  const target = new URL("/oauth/callback", row.return_origin);
  target.searchParams.set("state", row.state);
  target.searchParams.set("serverId", row.server_id);
  target.searchParams.set("status", status);
  if (status === "confirm" && row.callback_challenge && !ctx.vault.isSealed(row.callback_challenge)) {
    target.searchParams.set("challenge", row.callback_challenge);
  }
  if (status === "error" && row.error) {
    target.searchParams.set("error", capStr(row.error, 180));
  }
  return target.toString();
}

function githubDeviceRow(ctx: McpOAuthRouteContext, owner: string, flowId: string): GitHubDeviceRow | undefined {
  return ctx.sql
    .exec<GitHubDeviceRow>("SELECT * FROM mcp_github_device_pending WHERE owner_email = ? AND flow_id = ?", owner, flowId)
    .toArray()[0];
}

/** POST /mcp/github-device-start — starts GitHub device authorization while keeping device_code in the shard. */
export async function handleGitHubDeviceStart(ctx: McpOAuthRouteContext, owner: string): Promise<Response> {
  const clientId = ctx.githubClientId.trim();
  if (!clientId) {
    return json({ error: "github_oauth_not_configured" }, 503);
  }
  const response = await fetchPublicHttps("https://github.com/login/device/code", {
    method: "POST",
    headers: githubOAuthFormHeaders(),
    body: new URLSearchParams({
      client_id: clientId,
      scope: "repo read:org read:user user:email gist notifications workflow read:project",
    }).toString(),
    signal: AbortSignal.timeout(12_000),
  });
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const deviceCode = typeof data?.device_code === "string" ? data.device_code : "";
  const userCode = typeof data?.user_code === "string" ? data.user_code : "";
  if (!response.ok || !deviceCode || !userCode) {
    const error = typeof data?.error === "string" ? data.error : `github_device_http_${response.status}`;
    return json({ error }, response.status >= 500 ? 503 : 400);
  }
  const intervalMs = Math.max(5_000, Number(data?.interval ?? 5) * 1_000);
  const expiresAt = Date.now() + Math.max(60, Number(data?.expires_in ?? 900)) * 1_000;
  const verificationUri =
    typeof data?.verification_uri === "string" && data.verification_uri
      ? data.verification_uri
      : "https://github.com/login/device";
  const flowId = newOAuthState();
  ctx.sql.exec(
    "DELETE FROM mcp_github_device_pending WHERE owner_email = ? AND (server_id = 'github' OR expires_at < ?)",
    owner,
    Date.now(),
  );
  ctx.sql.exec(
    `INSERT INTO mcp_github_device_pending
      (owner_email, flow_id, server_id, device_code, user_code, verification_uri, client_id,
       expires_at, interval_ms, next_poll_at, status, error, created_at, updated_at)
     VALUES (?, ?, 'github', ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?)`,
    owner,
    flowId,
    await ctx.vault.seal(deviceCode, deviceCodeScope(ctx.subject(owner), flowId)),
    userCode,
    verificationUri,
    clientId,
    expiresAt,
    intervalMs,
    Date.now() + intervalMs,
    Date.now(),
    Date.now(),
  );
  return json({ flowId, userCode, verificationUri, intervalMs, expiresAt });
}

/** GET /mcp/github-device-status?flowId= — polls GitHub server-side and commits the resulting grant before success. */
export async function handleGitHubDeviceStatus(ctx: McpOAuthRouteContext, request: Request, owner: string): Promise<Response> {
  const flowId = new URL(request.url).searchParams.get("flowId") ?? "";
  const row = githubDeviceRow(ctx, owner, flowId);
  if (!row) {
    return json({ status: "missing" }, 404);
  }
  if (row.status === "completed") {
    return json({ status: "completed" });
  }
  if (row.status === "polling" && row.updated_at < Date.now() - 30_000) {
    ctx.sql.exec(
      "UPDATE mcp_github_device_pending SET status = 'failed', error = 'step_up_required', updated_at = ? WHERE owner_email = ? AND flow_id = ?",
      Date.now(),
      owner,
      flowId,
    );
    return json({ status: "failed", error: "step_up_required" });
  }
  if (row.status === "failed") {
    return json({ status: "failed", error: row.error });
  }
  const now = Date.now();
  if (row.expires_at <= now) {
    ctx.sql.exec(
      "UPDATE mcp_github_device_pending SET status = 'failed', error = 'expired_token', updated_at = ? WHERE owner_email = ? AND flow_id = ?",
      now,
      owner,
      flowId,
    );
    return json({ status: "failed", error: "expired_token" });
  }
  if (row.next_poll_at > now || row.status === "polling") {
    return json({ status: "pending", retryAfterMs: Math.max(250, row.next_poll_at - now) });
  }
  ctx.sql.exec(
    "UPDATE mcp_github_device_pending SET status = 'polling', next_poll_at = ?, updated_at = ? WHERE owner_email = ? AND flow_id = ? AND status = 'pending'",
    now + row.interval_ms,
    now,
    owner,
    flowId,
  );
  const deviceCode = await ctx.vault.open(row.device_code, deviceCodeScope(ctx.subject(owner), flowId));
  let response: Response;
  try {
    response = await fetchPublicHttps("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: githubOAuthFormHeaders(),
      body: new URLSearchParams({
        client_id: row.client_id,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    ctx.sql.exec(
      "UPDATE mcp_github_device_pending SET status = 'pending', error = 'temporarily_unavailable', updated_at = ? WHERE owner_email = ? AND flow_id = ?",
      Date.now(),
      owner,
      flowId,
    );
    return json({ status: "pending", retryAfterMs: row.interval_ms }, 503);
  }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok && typeof data?.access_token === "string" && data.access_token) {
    const expiresIn = Number(data.expires_in ?? 0);
    const token: CloudOAuthToken = {
      accessToken: data.access_token,
      refreshToken:
        typeof data.refresh_token === "string" && data.refresh_token
          ? data.refresh_token
          : undefined,
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1_000 : undefined,
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      clientId: row.client_id,
      mcpUrl: "https://api.github.com",
    };
    ctx.sql.exec(
      "INSERT OR REPLACE INTO mcp_oauth_grants (owner_email, server_id, payload, updated_at) VALUES (?, 'github', ?, ?)",
      owner,
      await sealGrantPayload(ctx.vault, ctx.subject(owner), "github", token),
      Date.now(),
    );
    // Latest credential wins: a fresh sign-in supersedes any pasted PAT or
    // legacy-migrated token, which the auth lease would otherwise prefer
    // forever (stale read-only/dead tokens made GitHub look read-only).
    // Clear tombstones and blocked markers for EVERY id this account's
    // GitHub connector can resolve through — an instance-id tombstone or a
    // stale reauth marker must never outlive a successful re-sign-in.
    for (const staleId of githubConnectorIds(ctx, owner)) {
      ctx.sql.exec("DELETE FROM mcp_oauth_revocations WHERE owner_email = ? AND server_id = ?", owner, staleId);
      ctx.sql.exec("DELETE FROM mcp_server_secrets WHERE owner_email = ? AND server_id = ?", owner, staleId);
      markOAuthReady(ctx, owner, staleId);
    }
    ctx.sql.exec(
      "UPDATE mcp_github_device_pending SET status = 'completed', error = '', updated_at = ? WHERE owner_email = ? AND flow_id = ?",
      Date.now(),
      owner,
      flowId,
    );
    return json({ status: "completed" });
  }
  const code = typeof data?.error === "string" ? data.error : `github_device_http_${response.status}`;
  if (code === "authorization_pending" || code === "slow_down") {
    const intervalMs = code === "slow_down" ? row.interval_ms + 5_000 : row.interval_ms;
    ctx.sql.exec(
      "UPDATE mcp_github_device_pending SET status = 'pending', interval_ms = ?, next_poll_at = ?, error = '', updated_at = ? WHERE owner_email = ? AND flow_id = ?",
      intervalMs,
      Date.now() + intervalMs,
      Date.now(),
      owner,
      flowId,
    );
    return json({ status: "pending", retryAfterMs: intervalMs });
  }
  ctx.sql.exec(
    "UPDATE mcp_github_device_pending SET status = 'failed', error = ?, updated_at = ? WHERE owner_email = ? AND flow_id = ?",
    capStr(code, 180),
    Date.now(),
    owner,
    flowId,
  );
  return json({ status: "failed", error: code }, 400);
}

/** GET /mcp/oauth-status?state= — browser polling surface: status only, never a provider token or verifier. */
export function handleOAuthStatus(ctx: McpOAuthRouteContext, request: Request, owner: string): Response {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const row = oauthPending(ctx, owner, state);
  if (!row) {
    return json({ status: "missing" }, 404);
  }
  if (row.status === "exchanging" && row.updated_at < Date.now() - 30_000) {
    ctx.sql.exec(
      "UPDATE mcp_oauth_pending SET status = 'exchange_unknown', error = 'oauth_exchange_interrupted', updated_at = ? WHERE owner_email = ? AND state = ? AND status = 'exchanging'",
      Date.now(),
      owner,
      state,
    );
    return json({ status: "pending", retryable: true, error: "oauth_exchange_interrupted" });
  }
  if (row.expires_at < Date.now() && row.status !== "completed" && row.status !== "failed") {
    ctx.sql.exec(
      "UPDATE mcp_oauth_pending SET status = 'failed', error = 'oauth_state_expired', updated_at = ? WHERE owner_email = ? AND state = ?",
      Date.now(),
      owner,
      state,
    );
    return json({ status: "failed", error: "oauth_state_expired" });
  }
  const retryable = row.status === "exchange_retryable" || row.status === "exchange_unknown";
  return json({
    status: row.status === "completed" ? "completed" : row.status === "failed" ? "failed" : "pending",
    ...(row.error && (row.status === "failed" || retryable) ? { error: row.error } : {}),
    ...(retryable ? { retryable: true } : {}),
  });
}

/** POST /mcp/oauth-callback — provider callback: stores the one-time code; the durable grant commit happens in `complete`. */
export async function handleOAuthCallback(ctx: McpOAuthRouteContext, request: Request, owner: string): Promise<Response> {
  let body: { state?: unknown; code?: unknown; error?: unknown; issuer?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const state = typeof body.state === "string" ? body.state : "";
  const providerError = typeof body.error === "string" ? capStr(body.error, 180) : "";
  const issuer = typeof body.issuer === "string" ? body.issuer : "";
  const code = typeof body.code === "string" ? body.code : "";
  const row = oauthPending(ctx, owner, state);
  if (!row) {
    return json({ error: "oauth_state_unknown" }, 404);
  }
  if (row.status === "completed") {
    return json({ ok: true, replayed: true, redirectUrl: oauthReturnUrl(ctx, row, "complete") });
  }
  if (row.status === "failed") {
    return json({ error: row.error || "oauth_failed", redirectUrl: oauthReturnUrl(ctx, row, "error") }, 409);
  }
  if (row.expires_at < Date.now()) {
    ctx.sql.exec(
      "UPDATE mcp_oauth_pending SET status = 'failed', error = 'oauth_state_expired', updated_at = ? WHERE owner_email = ? AND state = ?",
      Date.now(),
      owner,
      state,
    );
    const expired = oauthPending(ctx, owner, state) ?? row;
    return json({ error: "oauth_state_expired", redirectUrl: oauthReturnUrl(ctx, expired, "error") }, 400);
  }
  const replayable = ["awaiting_confirmation", "exchanging", "exchange_retryable", "exchange_unknown"].includes(row.status);
  if (replayable) {
    const stored = await revealOAuthPending(ctx, owner, row);
    if (
      !providerError &&
      code &&
      code === stored.authorization_code &&
      (!issuer || sameOAuthEndpoint(issuer, row.issuer)) &&
      stored.callback_challenge
    ) {
      return json({ ok: true, replayed: true, redirectUrl: oauthReturnUrl(ctx, stored, "confirm") });
    }
    return json({ error: "oauth_callback_replayed", redirectUrl: oauthReturnUrl(ctx, row, "replayed") }, 409);
  }
  if (row.status !== "pending") {
    return json({ error: "oauth_callback_replayed", redirectUrl: oauthReturnUrl(ctx, row, "replayed") }, 409);
  }
  if (issuer && !sameOAuthEndpoint(issuer, row.issuer)) {
    ctx.sql.exec(
      "UPDATE mcp_oauth_pending SET status = 'failed', error = 'oauth_issuer_mismatch', updated_at = ? WHERE owner_email = ? AND state = ?",
      Date.now(),
      owner,
      state,
    );
    const failed = oauthPending(ctx, owner, state) ?? row;
    return json({ error: "oauth_issuer_mismatch", redirectUrl: oauthReturnUrl(ctx, failed, "error") }, 400);
  }
  if (providerError) {
    ctx.sql.exec(
      "UPDATE mcp_oauth_pending SET status = 'failed', error = ?, updated_at = ? WHERE owner_email = ? AND state = ?",
      providerError,
      Date.now(),
      owner,
      state,
    );
    const failed = oauthPending(ctx, owner, state) ?? row;
    return json({ error: "oauth_denied", redirectUrl: oauthReturnUrl(ctx, failed, "error") }, 400);
  }
  if (!code || code.length > 8_000) {
    return json({ error: "oauth_code_missing" }, 400);
  }
  // The public callback stores the one-time code but does not redeem it.
  // Completion requires two proofs that never travel in the authorization
  // URL together: browserNonce from the initiating app storage and this
  // callback challenge delivered only to the provider-returned popup.
  const callbackChallenge = newOAuthState();
  ctx.sql.exec(
    `UPDATE mcp_oauth_pending
     SET status = 'awaiting_confirmation', authorization_code = ?, callback_challenge = ?, updated_at = ?
     WHERE owner_email = ? AND state = ? AND status = 'pending'`,
    await ctx.vault.seal(code, oauthPendingFieldScope(ctx.subject(owner), state, "authorization_code")),
    await ctx.vault.seal(callbackChallenge, oauthPendingFieldScope(ctx.subject(owner), state, "callback_challenge")),
    Date.now(),
    owner,
    state,
  );
  const awaiting = oauthPending(ctx, owner, state) ?? row;
  return json({
    ok: true,
    redirectUrl: oauthReturnUrl(ctx, await revealOAuthPending(ctx, owner, awaiting), "confirm"),
  });
}

/** POST /mcp/oauth-complete — authenticated popup confirmation performs the only provider code exchange. */
export async function handleOAuthComplete(ctx: McpOAuthRouteContext, request: Request, owner: string): Promise<Response> {
  let body: { state?: unknown; browserNonce?: unknown; callbackChallenge?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const state = typeof body.state === "string" ? body.state : "";
  const browserNonce = typeof body.browserNonce === "string" ? body.browserNonce : "";
  const callbackChallenge = typeof body.callbackChallenge === "string" ? body.callbackChallenge : "";
  const row = oauthPending(ctx, owner, state);
  if (!row) {
    return json({ error: "oauth_state_unknown" }, 404);
  }
  if (row.status === "completed") {
    return json({ ok: true, status: "completed", replayed: true });
  }
  if (row.status === "failed") {
    return json({ error: row.error || "oauth_failed" }, 409);
  }
  const retryableStatus = row.status === "exchange_retryable" || row.status === "exchange_unknown";
  if (row.status === "exchanging" && row.updated_at >= Date.now() - 30_000) {
    return json({ error: "oauth_exchange_busy", retryable: true }, 409);
  }
  if (row.status !== "awaiting_confirmation" && row.status !== "exchanging" && !retryableStatus) {
    return json({ error: "oauth_not_ready" }, 409);
  }
  // Both proofs sit sealed in storage; they are compared only after the
  // shard itself has opened them for exactly this state.
  const pending = await revealOAuthPending(ctx, owner, row);
  if (
    row.expires_at < Date.now() ||
    !browserNonce ||
    !callbackChallenge ||
    !constantTimeEqual(browserNonce, pending.browser_nonce) ||
    !constantTimeEqual(callbackChallenge, pending.callback_challenge)
  ) {
    return json({ error: row.expires_at < Date.now() ? "oauth_state_expired" : "oauth_confirmation_mismatch" }, 403);
  }
  const priorWasUnknown = row.status === "exchange_unknown" || row.status === "exchanging";
  ctx.sql.exec(
    `UPDATE mcp_oauth_pending SET status = 'exchanging', error = '', updated_at = ?
     WHERE owner_email = ? AND state = ? AND status IN ('awaiting_confirmation', 'exchange_retryable', 'exchange_unknown', 'exchanging')`,
    Date.now(),
    owner,
    state,
  );
  try {
    const { grantedScopes, ...token } = await exchangeAuthorizationCode({
      tokenEndpoint: row.token_endpoint,
      clientId: row.client_id,
      code: pending.authorization_code,
      verifier: pending.verifier,
      redirectUri: row.redirect_uri,
      resource: row.resource || undefined,
      mcpUrl: row.mcp_url,
    });
    const committedAt = Date.now();
    // Sealed before the synchronous transaction — no await inside it.
    const sealedGrant = await sealGrantPayload(ctx.vault, ctx.subject(owner), row.server_id, {
      ...token,
      authorizationState: state,
    });
    ctx.transactionSync(() => {
      ctx.sql.exec(
        "INSERT OR REPLACE INTO mcp_oauth_grants (owner_email, server_id, payload, updated_at) VALUES (?, ?, ?, ?)",
        owner,
        row.server_id,
        sealedGrant,
        committedAt,
      );
      ctx.sql.exec("DELETE FROM mcp_oauth_revocations WHERE owner_email = ? AND server_id = ?", owner, row.server_id);
      markOAuthReady(ctx, owner, row.server_id);
      // The user just consented: whatever a step-up demanded is now granted.
      recordGrantedScopes(ctx.sql, owner, row.server_id, grantedScopes ?? null, committedAt);
      ctx.sql.exec(
        `UPDATE mcp_oauth_pending
         SET status = 'completed', error = '', verifier = '', browser_nonce = '',
             callback_challenge = '', authorization_code = '', updated_at = ?
         WHERE owner_email = ? AND state = ?`,
        committedAt,
        owner,
        state,
      );
    });
    await ctx.storage.delete(`${OAUTH_REF_PREFIX}${owner}:${row.server_id}`);
    return json({ ok: true, status: "completed" });
  } catch (error) {
    const exchangeError = error instanceof OAuthCodeExchangeError ? error : null;
    if (!exchangeError || exchangeError.transient) {
      const status = exchangeError?.ambiguous === false ? "exchange_retryable" : "exchange_unknown";
      const code = exchangeError?.code ?? "oauth_exchange_interrupted";
      ctx.sql.exec(
        "UPDATE mcp_oauth_pending SET status = ?, error = ?, updated_at = ? WHERE owner_email = ? AND state = ? AND status = 'exchanging'",
        status,
        capStr(code, 180),
        Date.now(),
        owner,
        state,
      );
      return json({ error: code, retryable: true }, 503);
    }
    const code = priorWasUnknown && exchangeError.code === "invalid_grant"
      ? "step_up_required"
      : exchangeError.code;
    ctx.transactionSync(() => {
      ctx.sql.exec(
        `UPDATE mcp_oauth_pending
         SET status = 'failed', error = ?, verifier = '', browser_nonce = '',
             callback_challenge = '', authorization_code = '', updated_at = ?
         WHERE owner_email = ? AND state = ?`,
        capStr(code, 180),
        Date.now(),
        owner,
        state,
      );
    });
    return json({ error: code }, 400);
  }
}

/** POST /mcp/oauth-store — stores a newly authorized or legacy-migrated grant only in the account shard. */
export async function handleOAuthStore(ctx: McpOAuthRouteContext, request: Request, owner: string): Promise<Response> {
  let body: { serverId?: unknown; token?: unknown; grants?: unknown; mode?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  if (body.mode === "replace") {
    return json(
      {
        error: "server_owned_oauth_required",
        error_description:
          "Gera was updated — reload this page (Cmd/Ctrl+Shift+R) and start the sign-in again.",
      },
      410,
    );
  }
  const entries: Array<[string, unknown]> = [];
  if (typeof body.serverId === "string") {
    entries.push([body.serverId, body.token]);
  }
  if (isRecord(body.grants)) {
    entries.push(...Object.entries(body.grants));
  }
  let stored = 0;
  const settledIds: string[] = [];
  for (const [serverId, raw] of entries.slice(0, 20)) {
    const token = cloudOAuthToken(raw);
    if (!isValidId(serverId) || !token) {
      continue;
    }
    const revoked = ctx.sql
      .exec<{ revoked_at: number }>(
        "SELECT revoked_at FROM mcp_oauth_revocations WHERE owner_email = ? AND server_id = ?",
        owner,
        serverId,
      )
      .toArray()[0];
    const existing = ctx.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM mcp_oauth_grants WHERE owner_email = ? AND server_id = ?",
        owner,
        serverId,
      )
      .toArray()[0];
    if (revoked || existing) {
      settledIds.push(serverId);
      continue;
    }
    let canonical = token;
    const rotationKey = `${OAUTH_REF_PREFIX}${owner}:${serverId}`;
    const rotation = await readRotation(ctx, owner, serverId, await ctx.storage.get<unknown>(rotationKey));
    if (rotation?.bases.includes(token.accessToken)) {
      canonical = rotation.token;
    }
    ctx.sql.exec(
      "INSERT OR REPLACE INTO mcp_oauth_grants (owner_email, server_id, payload, updated_at) VALUES (?, ?, ?, ?)",
      owner,
      serverId,
      // Sealed under the account scope like every other grant row — a row
      // sealed under the legacy owner scope would be unreadable after the sweep.
      await sealGrantPayload(ctx.vault, ctx.subject(owner), serverId, canonical),
      Date.now(),
    );
    ctx.sql.exec("DELETE FROM mcp_oauth_revocations WHERE owner_email = ? AND server_id = ?", owner, serverId);
    markOAuthReady(ctx, owner, serverId);
    await ctx.storage.delete(rotationKey);
    settledIds.push(serverId);
    stored += 1;
  }
  if (settledIds.length > 0) {
    const row = ctx.sql.exec<{ payload: string }>("SELECT payload FROM profiles WHERE owner_email = ?", owner).toArray()[0];
    if (row) {
      try {
        const profile = JSON.parse(row.payload) as Record<string, unknown>;
        if (isRecord(profile.mcpOAuth)) {
          const legacy = { ...profile.mcpOAuth };
          for (const serverId of settledIds) {
            delete legacy[serverId];
          }
          if (Object.keys(legacy).length > 0) {
            profile.mcpOAuth = legacy;
          } else {
            delete profile.mcpOAuth;
          }
          ctx.sql.exec(
            "UPDATE profiles SET payload = ?, updated_at = ? WHERE owner_email = ?",
            JSON.stringify(profile),
            Date.now(),
            owner,
          );
        }
      } catch {
        // Keep a malformed profile untouched; canonical rows are already safe.
      }
    }
    return json({ ok: true, stored, settledIds });
  }
  return json({ error: "invalid_grant" }, 400);
}

/** POST /mcp/oauth-clear — removes a grant from the server; no browser credential can resurrect it. */
export async function handleOAuthClear(ctx: McpOAuthRouteContext, request: Request, owner: string): Promise<Response> {
  let body: { serverId?: unknown; catalogId?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const serverId = typeof body.serverId === "string" ? body.serverId : "";
  const catalogId = typeof body.catalogId === "string" ? body.catalogId : "";
  if (!isValidId(serverId) || (catalogId && !isValidId(catalogId))) {
    return json({ error: "invalid_server" }, 400);
  }
  if (body.reason !== "disconnect") {
    // Only an explicit user disconnect may create a durable revocation.
    // Older bundles auto-cleared on a stale/expired BROWSER copy, which
    // tombstoned and destroyed a perfectly fresh server-owned grant — every
    // new GitHub sign-in was poisoned minutes later (server_auth_missing).
    // Automatic housekeeping is a browser-local concern; ack without damage.
    return json({ ok: true, ignored: true });
  }
  const ids = [...new Set([serverId, ...(catalogId && catalogId !== serverId ? [catalogId] : [])])];
  for (const id of ids) {
    ctx.sql.exec(
      "INSERT OR REPLACE INTO mcp_oauth_revocations (owner_email, server_id, revoked_at) VALUES (?, ?, ?)",
      owner,
      id,
      Date.now(),
    );
    ctx.sql.exec("DELETE FROM mcp_oauth_grants WHERE owner_email = ? AND server_id = ?", owner, id);
    ctx.sql.exec("DELETE FROM mcp_server_secrets WHERE owner_email = ? AND server_id = ?", owner, id);
    ctx.sql.exec("DELETE FROM mcp_oauth_states WHERE owner_email = ? AND server_id = ?", owner, id);
    clearOAuthScopes(ctx.sql, owner, id);
    await ctx.storage.delete(`${OAUTH_REF_PREFIX}${owner}:${id}`);
  }
  const row = ctx.sql.exec<{ payload: string }>("SELECT payload FROM profiles WHERE owner_email = ?", owner).toArray()[0];
  if (row) {
    try {
      const profile = JSON.parse(row.payload) as Record<string, unknown>;
      const legacy = profile.mcpOAuth;
      if (isRecord(legacy) && ids.some((id) => id in legacy)) {
        const oauth = { ...legacy };
        for (const id of ids) {
          delete oauth[id];
        }
        profile.mcpOAuth = oauth;
        ctx.sql.exec(
          "UPDATE profiles SET payload = ?, updated_at = ? WHERE owner_email = ?",
          JSON.stringify(profile),
          Date.now(),
          owner,
        );
      }
    } catch {
      // Malformed legacy profile remains unusable.
    }
  }
  return json({ ok: true });
}

/**
 * POST /mcp/oauth-refresh — deployment-safe browser refresh. The provider's
 * rotating response is committed to this account shard before it is returned
 * to the tab. If a publish reload loses that response, the next bundle sends
 * the old base again and receives the durable tip without redeeming twice.
 */
export async function handleBrowserOAuthRefresh(ctx: McpOAuthRouteContext, request: Request, owner: string): Promise<Response> {
  let body: { serverId?: unknown; token?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const serverId = typeof body.serverId === "string" ? body.serverId : "";
  const incoming = cloudOAuthToken(body.token);
  if (!isValidId(serverId) || !incoming?.refreshToken || !incoming.tokenEndpoint || !incoming.clientId) {
    return json({ error: "invalid_grant" }, 400);
  }
  const blockedState = oauthGrantState(ctx, owner, serverId);
  if (blockedState === "reauth_required" || blockedState === "step_up_required") {
    return json({ error: blockedState }, blockedState === "step_up_required" ? 403 : 401);
  }

  const key = `${OAUTH_REF_PREFIX}${owner}:${serverId}`;
  let existing = await readRotation(ctx, owner, serverId, await ctx.storage.get<unknown>(key));
  const profileGrant = (await profileOAuthTokens(ctx, owner))[serverId];
  if (existing?.bases.includes(incoming.accessToken)) {
    const profileStillOnChain =
      Boolean(profileGrant) &&
      (profileGrant?.accessToken === existing.token.accessToken || existing.bases.includes(profileGrant?.accessToken ?? ""));
    if (!profileStillOnChain) {
      // A sign-out or fresh sign-in in the durable profile outranks a stale
      // tab. Escrow repairs deploy loss, never resurrects a removed account grant.
      return json({ error: "stale_grant" }, 409);
    }
    markOAuthReady(ctx, owner, serverId);
    return json({ ok: true, credentialStored: true, replayed: true });
  }

  if (
    existing &&
    existing.token.accessToken !== incoming.accessToken &&
    profileGrant?.accessToken === incoming.accessToken
  ) {
    // The durable profile proves this is a fresh sign-in outside the old
    // chain. Retire the obsolete escrow before refreshing the new grant.
    await ctx.storage.delete(key);
    existing = null;
  }
  if (profileGrant && profileGrant.accessToken !== incoming.accessToken) {
    return json({ error: "stale_grant" }, 409);
  }

  const appliedChains = new Map<string, string[]>();
  const grant = existing?.token.accessToken === incoming.accessToken ? existing.token : incoming;
  if (existing?.token.accessToken === grant.accessToken) {
    appliedChains.set(serverId, existing.bases);
  }
  const profileAnchor = profileGrant?.accessToken ?? null;
  const server = {
    id: serverId,
    name: serverId,
    kind: "mcp" as const,
    url: grant.mcpUrl ?? grant.tokenEndpoint,
    headers: {},
    omitMcpHeaders: false,
    disabledTools: [],
    oauth: grant,
  };
  const persist = async (rotated: RefreshedOAuth): Promise<void> => {
    const latestProfile = (await profileOAuthTokens(ctx, owner))[serverId];
    if (
      (profileAnchor !== null && latestProfile?.accessToken !== profileAnchor && latestProfile?.accessToken !== rotated.token.accessToken) ||
      (profileAnchor === null && latestProfile && latestProfile.accessToken !== rotated.baseAccessToken && latestProfile.accessToken !== rotated.token.accessToken)
    ) {
      throw new Error("stale OAuth refresh result");
    }
    const latestOverride = await readRotation(ctx, owner, serverId, await ctx.storage.get<unknown>(key));
    if (latestOverride?.bases.includes(rotated.baseAccessToken)) {
      throw new Error("OAuth refresh already committed");
    }
    if (
      latestOverride &&
      latestOverride.token.accessToken !== rotated.baseAccessToken &&
      latestOverride.token.accessToken !== rotated.token.accessToken
    ) {
      throw new Error("stale OAuth refresh result");
    }
    if (latestOverride) {
      appliedChains.set(serverId, latestOverride.bases);
    }
    const bases = chainRotationBases(appliedChains, rotated);
    await persistCanonicalOAuthGrant(ctx, owner, rotated);
    appliedChains.set(serverId, bases);
  };

  try {
    const outcome = await refreshCloudOAuthGrant(server, persist, (id) => markOAuthRefreshStarted(ctx, owner, id));
    if (outcome.ok === false) {
      await recordOAuthFailure(ctx, owner, serverId, outcome);
      const status = outcome.transient ? (outcome.status === 429 ? 429 : 503) : 400;
      return json({ error: outcome.code, transient: outcome.transient }, status);
    }
    return json({ ok: true, credentialStored: true, replayed: false });
  } catch {
    // A sibling request may have durably committed the shared provider
    // response first. Return that winner; otherwise keep the caller's local
    // grant untouched and let a later retry reconcile it.
    const winner = await readRotation(ctx, owner, serverId, await ctx.storage.get<unknown>(key));
    if (winner?.bases.includes(incoming.accessToken)) {
      markOAuthReady(ctx, owner, serverId);
      return json({ ok: true, credentialStored: true, replayed: true });
    }
    return json({ error: "refresh_commit_unavailable", transient: true }, 503);
  }
}

/**
 * GET /mcp/oauth-rotations — compatibility endpoint. Older browsers called it
 * as a last resort before dropping a sign-in whose refresh was rejected; it
 * intentionally returns proof only, because provider grants never leave the
 * account shard in browser-facing responses.
 */
export function handleOAuthRotations(): Response {
  return json({ rotations: [], serverOwned: true });
}
