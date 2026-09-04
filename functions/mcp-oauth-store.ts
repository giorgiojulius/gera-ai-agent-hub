// The account shard's credential store for MCP servers: sealed API keys /
// headers (`mcp_server_secrets`), OAuth grants (`mcp_oauth_grants`),
// revocation tombstones, the `mcp_oauth_states` state machine (ready →
// refreshing → refresh_unknown / retryable_error / step_up_required /
// reauth_required) and the legacy KV rotation escrow (`oauthref:<owner>:<id>`).
//
// One implementation for ChatStore (`/mcp/*` routes, cloud automations) and
// RunManager (interactive runs) — both used to carry a private copy of these
// transitions. Everything is a plain function over `OAuthStoreContext`, so the
// logic is unit-testable with SQL stubs and never touches a Durable Object
// class directly. Token material is opened per call and never logged.

import { capStr, isPlaceholderCredential, isRecord, isValidId, OAUTH_REF_PREFIX, type ChatSql } from "./chat-shared";
import {
  chainRotationBases,
  cloudMcpServersForAutomation,
  cloudOAuthTokens,
  ensureFreshCloudOAuth,
  forceRefreshCloudOAuthOutcome,
  normalizeOAuthOverride,
  overlayOAuthRotations,
  type CloudMcpServer,
  type CloudOAuthRefreshFailure,
  type CloudOAuthToken,
  type OAuthRotation,
  type RefreshedOAuth,
} from "./mcp-cloud";
import { recordRequiredScopes } from "./mcp-oauth-scopes";
import { normalizeMcpToolLoading, type McpToolLoadingMode } from "./mcp-toolset";
import { openGrantPayload, openRotationValue, openServerSecret, sealGrantPayload, type ServerSecret } from "./secret-rows";
import { SecretVault, SecretVaultError } from "./secret-vault";

/** The Durable Object KV surface the legacy rotation escrow lives in. */
export type OAuthEscrowStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
};

export type OAuthStoreContext = {
  sql: ChatSql;
  storage: OAuthEscrowStorage;
  /** Encrypts every credential row in this shard. */
  vault: SecretVault;
  /** Vault scope subject for `owner`'s rows (the Rork Auth account once migrated). */
  subject(owner: string): string;
};

/** Non-secret snapshot of why one connector id can or cannot authenticate. */
export type OAuthDiagnostic = {
  id: string;
  grantPresent: boolean;
  grantRow: boolean;
  revoked: boolean;
  secret: boolean;
  state: string;
};

/**
 * Parses one `mcp_server_secrets` row as stored (fields still sealed).
 * Returns null — after deleting the row — for a poisoned legacy row where
 * the browser's `gera-account:` marker was stored as a manual token and
 * shadowed the real OAuth grant on every call.
 */
export function parseServerSecretRow(
  ctx: OAuthStoreContext,
  owner: string,
  serverId: string,
  payload: string,
): ServerSecret | null {
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(payload) as unknown;
    value = isRecord(parsed) ? parsed : {};
  } catch {
    return null;
  }
  const rawToken = typeof value.token === "string" ? value.token : "";
  const headersJson = typeof value.headersJson === "string" && value.headersJson ? value.headersJson : "";
  const token = rawToken && (ctx.vault.isSealed(rawToken) || !isPlaceholderCredential(rawToken)) ? rawToken : "";
  if (rawToken && !token && !headersJson) {
    ctx.sql.exec("DELETE FROM mcp_server_secrets WHERE owner_email = ? AND server_id = ?", owner, serverId);
    return null;
  }
  if (!token && !headersJson) {
    return null;
  }
  return { ...(token ? { token } : {}), ...(headersJson ? { headersJson } : {}) };
}

/** The stored (still sealed) key/header row, healing poisoned legacy rows. */
export function storedMcpServerSecret(ctx: OAuthStoreContext, owner: string, serverId: string): ServerSecret | null {
  const row = ctx.sql
    .exec<{ payload: string }>(
      "SELECT payload FROM mcp_server_secrets WHERE owner_email = ? AND server_id = ?",
      owner,
      serverId,
    )
    .toArray()[0];
  return row ? parseServerSecretRow(ctx, owner, serverId, row.payload) : null;
}

/** Presence only — no key needed, safe inside synchronous profile shaping. */
export function hasMcpServerSecret(ctx: OAuthStoreContext, owner: string, serverId: string): boolean {
  return storedMcpServerSecret(ctx, owner, serverId) !== null;
}

/** Reads one saved API-key/header pair decrypted; it never leaves the account shard. */
export async function mcpServerSecret(ctx: OAuthStoreContext, owner: string, serverId: string): Promise<ServerSecret> {
  const stored = storedMcpServerSecret(ctx, owner, serverId);
  if (!stored) {
    return {};
  }
  return openServerSecret(ctx.vault, ctx.subject(owner), serverId, stored);
}

/** Overlays server-only keys/headers onto redacted profile connector rows. */
export async function mcpConfigsWithSecrets(ctx: OAuthStoreContext, owner: string, raw: unknown): Promise<unknown[]> {
  if (!Array.isArray(raw)) return [];
  const out: unknown[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== "string") {
      out.push(item);
      continue;
    }
    out.push({ ...item, ...(await mcpServerSecret(ctx, owner, item.id)) });
  }
  return out;
}

/**
 * All connector ids that resolve to the native GitHub integration for this
 * account: the canonical "github" id plus any profile card whose catalogId
 * points at it. Used to clear stale pasted/legacy tokens after a fresh
 * device-flow sign-in — the auth lease prefers manual secrets, so leaving
 * one behind would shadow the new grant forever.
 */
export function githubConnectorIds(ctx: OAuthStoreContext, owner: string): string[] {
  const ids = new Set<string>(["github"]);
  const row = ctx.sql.exec<{ payload: string }>("SELECT payload FROM profiles WHERE owner_email = ?", owner).toArray()[0];
  if (row) {
    try {
      const profile = JSON.parse(row.payload) as Record<string, unknown>;
      const settings = isRecord(profile.settings) ? profile.settings : {};
      const servers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
      for (const item of servers) {
        if (!isRecord(item) || typeof item.id !== "string" || !isValidId(item.id)) {
          continue;
        }
        const catalogId = typeof item.catalogId === "string" ? item.catalogId : "";
        if (item.id === "github" || catalogId === "github") {
          ids.add(item.id);
        }
      }
    } catch {
      // Malformed legacy profile: fall back to the canonical id only.
    }
  }
  return [...ids];
}

/**
 * Reads the physically stored OAuth grant for one connector id, honoring
 * revocation tombstones but IGNORING blocked `mcp_oauth_states` rows. A
 * user-initiated health check must be able to try a freshly committed grant
 * even when an older failure left a stale reauth/step-up marker behind —
 * otherwise a successful re-sign-in stays invisible forever.
 */
export async function rawOAuthGrant(ctx: OAuthStoreContext, owner: string, serverId: string): Promise<CloudOAuthToken | null> {
  const revoked = ctx.sql
    .exec<{ present: number }>(
      "SELECT 1 AS present FROM mcp_oauth_revocations WHERE owner_email = ? AND server_id = ? LIMIT 1",
      owner,
      serverId,
    )
    .toArray()[0];
  if (revoked) {
    return null;
  }
  const row = ctx.sql
    .exec<{ payload: string }>(
      "SELECT payload FROM mcp_oauth_grants WHERE owner_email = ? AND server_id = ?",
      owner,
      serverId,
    )
    .toArray()[0];
  if (!row) {
    return null;
  }
  return openGrantPayload(ctx.vault, ctx.subject(owner), serverId, row.payload);
}

/**
 * Non-secret snapshot of everything that decides whether one id can
 * authenticate: usable grant, raw grant row (even when tombstoned), an
 * active revocation tombstone, a stored manual secret, and the state
 * marker. Powers `server_auth_missing` detail — never token material.
 */
export function oauthDiagnostic(ctx: OAuthStoreContext, owner: string, serverId: string): OAuthDiagnostic {
  const grantRow = ctx.sql
    .exec<{ present: number }>(
      "SELECT 1 AS present FROM mcp_oauth_grants WHERE owner_email = ? AND server_id = ? LIMIT 1",
      owner,
      serverId,
    )
    .toArray()[0];
  const revoked = ctx.sql
    .exec<{ present: number }>(
      "SELECT 1 AS present FROM mcp_oauth_revocations WHERE owner_email = ? AND server_id = ? LIMIT 1",
      owner,
      serverId,
    )
    .toArray()[0];
  return {
    id: serverId,
    grantPresent: Boolean(grantRow && !revoked),
    grantRow: Boolean(grantRow),
    revoked: Boolean(revoked),
    secret: hasMcpServerSecret(ctx, owner, serverId),
    state: oauthGrantState(ctx, owner, serverId),
  };
}

/** Current `mcp_oauth_states` marker for one connector id ("ready" when none). */
export function oauthGrantState(ctx: OAuthStoreContext, owner: string, serverId: string): string {
  return (
    ctx.sql
      .exec<{ state: string }>(
        "SELECT state FROM mcp_oauth_states WHERE owner_email = ? AND server_id = ?",
        owner,
        serverId,
      )
      .toArray()[0]?.state ?? "ready"
  );
}

/** True for the two markers that block leases, relays and runs until a new sign-in. */
export function isBlockedOAuthState(state: string): boolean {
  return state === "reauth_required" || state === "step_up_required";
}

export function markOAuthReady(ctx: OAuthStoreContext, owner: string, serverId: string): void {
  ctx.sql.exec(
    `INSERT OR REPLACE INTO mcp_oauth_states
      (owner_email, server_id, state, error_code, retry_after, updated_at)
     VALUES (?, ?, 'ready', '', 0, ?)`,
    owner,
    serverId,
    Date.now(),
  );
}

/** Enters `refreshing`; a pending `refresh_unknown` (ambiguous rotation) keeps its marker and code. */
export async function markOAuthRefreshStarted(ctx: OAuthStoreContext, owner: string, serverId: string): Promise<void> {
  const now = Date.now();
  ctx.sql.exec(
    `INSERT INTO mcp_oauth_states
      (owner_email, server_id, state, error_code, retry_after, updated_at)
     VALUES (?, ?, 'refreshing', '', 0, ?)
     ON CONFLICT(owner_email, server_id) DO UPDATE SET
       state = CASE
         WHEN mcp_oauth_states.state = 'refresh_unknown' THEN 'refresh_unknown'
         ELSE 'refreshing'
       END,
       error_code = CASE
         WHEN mcp_oauth_states.state = 'refresh_unknown' THEN mcp_oauth_states.error_code
         ELSE ''
       END,
       retry_after = 0,
       updated_at = excluded.updated_at`,
    owner,
    serverId,
    now,
  );
}

/**
 * Records a failed refresh: transient → `retryable_error` (or
 * `refresh_unknown` when the provider may have rotated the grant anyway);
 * otherwise `step_up_required` for consent/scope codes — and for
 * `invalid_grant` right after an unknown rotation — else `reauth_required`.
 */
export async function recordOAuthFailure(
  ctx: OAuthStoreContext,
  owner: string,
  serverId: string,
  outcome: CloudOAuthRefreshFailure,
): Promise<void> {
  const previousState = oauthGrantState(ctx, owner, serverId);
  const stepUpCodes = new Set(["interaction_required", "consent_required", "insufficient_scope", "invalid_scope"]);
  const followsUnknownRotation = previousState === "refresh_unknown" && outcome.code === "invalid_grant";
  const state = outcome.transient
    ? outcome.ambiguous ? "refresh_unknown" : "retryable_error"
    : followsUnknownRotation || stepUpCodes.has(outcome.code)
      ? "step_up_required"
      : "reauth_required";
  ctx.sql.exec(
    `INSERT OR REPLACE INTO mcp_oauth_states
      (owner_email, server_id, state, error_code, retry_after, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    owner,
    serverId,
    state,
    capStr(outcome.code, 120),
    outcome.transient ? Date.now() + 30_000 : 0,
    Date.now(),
  );
  if (state === "step_up_required" && outcome.requiredScopes) {
    // The next sign-in widens its request by these; only a completed sign-in clears them.
    recordRequiredScopes(ctx.sql, owner, serverId, outcome.requiredScopes, outcome.code);
  }
}

/**
 * Usable OAuth grants for the account: durable rows (legacy profile grants
 * migrate once) minus revocation tombstones and blocked state markers.
 * Rows this vault key cannot open authenticate nothing and are skipped.
 */
export async function profileOAuthTokens(ctx: OAuthStoreContext, owner: string): Promise<Record<string, CloudOAuthToken>> {
  const tokens: Record<string, CloudOAuthToken> = {};
  const profileRow = ctx.sql.exec<{ payload: string }>("SELECT payload FROM profiles WHERE owner_email = ?", owner).toArray()[0];
  if (profileRow) {
    try {
      const parsed = JSON.parse(profileRow.payload) as unknown;
      Object.assign(tokens, cloudOAuthTokens(isRecord(parsed) ? parsed.mcpOAuth : undefined));
    } catch {
      // A malformed legacy profile cannot authenticate any connector.
    }
  }
  const rows = ctx.sql
    .exec<{ server_id: string; payload: string }>(
      "SELECT server_id, payload FROM mcp_oauth_grants WHERE owner_email = ?",
      owner,
    )
    .toArray();
  for (const row of rows) {
    // Sealed at rest; a row this key cannot open authenticates nothing and
    // surfaces as a missing grant rather than a failed request.
    try {
      const token = await openGrantPayload(ctx.vault, ctx.subject(owner), row.server_id, row.payload);
      if (token) {
        tokens[row.server_id] = token;
      }
    } catch (error) {
      if (!(error instanceof SecretVaultError)) throw error;
      console.error("oauth grant unreadable", row.server_id, error.code);
    }
  }
  const revoked = ctx.sql
    .exec<{ server_id: string }>("SELECT server_id FROM mcp_oauth_revocations WHERE owner_email = ?", owner)
    .toArray();
  for (const row of revoked) {
    delete tokens[row.server_id];
  }
  const blocked = ctx.sql
    .exec<{ server_id: string }>(
      "SELECT server_id FROM mcp_oauth_states WHERE owner_email = ? AND state IN ('reauth_required', 'step_up_required')",
      owner,
    )
    .toArray();
  for (const row of blocked) {
    delete tokens[row.server_id];
  }
  return tokens;
}

/** Reads a legacy rotation escrow entry; unreadable envelopes count as absent. */
export async function readRotation(
  ctx: OAuthStoreContext,
  owner: string,
  serverId: string,
  raw: unknown,
): Promise<OAuthRotation | null> {
  if (raw === undefined || raw === null) {
    return null;
  }
  try {
    return normalizeOAuthOverride(serverId, await openRotationValue(ctx.vault, ctx.subject(owner), serverId, raw));
  } catch (error) {
    if (error instanceof SecretVaultError) {
      console.error("oauth rotation escrow unreadable", serverId, error.code);
      return null;
    }
    throw error;
  }
}

/** Rejects a late refresh when the canonical grant changed while the provider request awaited. */
export async function assertOAuthRotationCurrent(ctx: OAuthStoreContext, owner: string, rotated: RefreshedOAuth): Promise<void> {
  const tokens = await profileOAuthTokens(ctx, owner);
  const key = `${OAUTH_REF_PREFIX}${owner}:${rotated.serverId}`;
  const existing = await readRotation(ctx, owner, rotated.serverId, await ctx.storage.get<unknown>(key));
  if (existing) {
    overlayOAuthRotations(tokens, [existing]);
  }
  const currentAccess = tokens[rotated.serverId]?.accessToken;
  if (currentAccess !== rotated.baseAccessToken && currentAccess !== rotated.token.accessToken) {
    throw new Error("stale OAuth refresh result");
  }
}

/** Writes the rotated pair as the canonical grant: row, tombstone gone, state ready, escrow dropped. */
async function commitCanonicalGrant(ctx: OAuthStoreContext, owner: string, rotated: RefreshedOAuth): Promise<void> {
  ctx.sql.exec(
    "INSERT OR REPLACE INTO mcp_oauth_grants (owner_email, server_id, payload, updated_at) VALUES (?, ?, ?, ?)",
    owner,
    rotated.serverId,
    await sealGrantPayload(ctx.vault, ctx.subject(owner), rotated.serverId, rotated.token),
    Date.now(),
  );
  ctx.sql.exec("DELETE FROM mcp_oauth_revocations WHERE owner_email = ? AND server_id = ?", owner, rotated.serverId);
  markOAuthReady(ctx, owner, rotated.serverId);
  await ctx.storage.delete(`${OAUTH_REF_PREFIX}${owner}:${rotated.serverId}`);
}

/** Atomically promotes one provider rotation into the SQL source of truth. */
export async function persistCanonicalOAuthGrant(ctx: OAuthStoreContext, owner: string, rotated: RefreshedOAuth): Promise<void> {
  await assertOAuthRotationCurrent(ctx, owner, rotated);
  await commitCanonicalGrant(ctx, owner, rotated);
}

export type OwnerMcpServers = { servers: CloudMcpServer[]; toolLoading: McpToolLoadingMode };

/**
 * The owner's connected generic MCP servers for the given ids with auth
 * attached and expiring grants refreshed (forced for ids in `force`).
 * Null when the account has no profile yet.
 */
export async function resolveOwnerMcpServers(
  ctx: OAuthStoreContext,
  owner: string,
  ids: string[],
  force: Set<string>,
): Promise<OwnerMcpServers | null> {
  const profileRow = ctx.sql.exec<{ payload: string }>("SELECT payload FROM profiles WHERE owner_email = ?", owner).toArray()[0];
  let parsed: unknown = null;
  if (profileRow) {
    try {
      parsed = JSON.parse(profileRow.payload);
    } catch {
      parsed = null;
    }
  }
  if (!isRecord(parsed) || !isRecord(parsed.settings)) {
    return null;
  }
  const oauthTokens = await profileOAuthTokens(ctx, owner);
  const prefix = `${OAUTH_REF_PREFIX}${owner}:`;
  const overrideRows = await ctx.storage.list<unknown>({ prefix });
  const rotations: OAuthRotation[] = [];
  for (const [key, value] of overrideRows) {
    const rotation = await readRotation(ctx, owner, key.slice(prefix.length), value);
    if (rotation) {
      rotations.push(rotation);
    }
  }
  const { appliedChains } = overlayOAuthRotations(oauthTokens, rotations);
  const servers = cloudMcpServersForAutomation(
    await mcpConfigsWithSecrets(ctx, owner, parsed.settings.mcpServers),
    ids,
    oauthTokens,
  ).filter((server) => server.kind === "mcp");
  const refreshed: RefreshedOAuth[] = [];
  const unavailable = new Set<string>();
  const persistOAuth = async (rotated: RefreshedOAuth): Promise<void> => {
    await persistCanonicalOAuthGrant(ctx, owner, rotated);
    const bases = chainRotationBases(appliedChains, rotated);
    appliedChains.set(rotated.serverId, bases);
  };
  for (const server of servers) {
    if (!server.oauth) {
      continue;
    }
    const outcome = force.has(server.id)
      ? await forceRefreshCloudOAuthOutcome(server, refreshed, persistOAuth, (id) => markOAuthRefreshStarted(ctx, owner, id))
      : await ensureFreshCloudOAuth(server, refreshed, persistOAuth, (id) => markOAuthRefreshStarted(ctx, owner, id));
    if (outcome?.ok === false) {
      await recordOAuthFailure(ctx, owner, server.id, outcome);
      if (!outcome.transient || force.has(server.id)) {
        unavailable.add(server.id);
      }
    }
  }
  return {
    servers: servers.filter((server) => !unavailable.has(server.id)),
    toolLoading: normalizeMcpToolLoading(parsed.settings.mcpToolLoading),
  };
}

export type OAuthTokensWithRotations = {
  tokens: Record<string, CloudOAuthToken>;
  appliedChains: Map<string, string[]>;
  /** Ids whose sign-in is blocked (renew / wider access), with the marker. */
  blocked: Map<string, string>;
};

/**
 * Interactive-run variant: usable grants with the legacy rotation escrow
 * overlaid (an override applies while the grant is anywhere on its chain),
 * plus the blocked markers so arming can explain left-out servers. Dead or
 * unreadable escrow entries are pruned here.
 */
export async function oauthTokensWithRotations(ctx: OAuthStoreContext, owner: string): Promise<OAuthTokensWithRotations> {
  const profileRow = ctx.sql.exec<{ payload: string }>("SELECT payload FROM profiles WHERE owner_email = ?", owner).toArray()[0];
  let parsed: unknown = null;
  if (profileRow) {
    try {
      parsed = JSON.parse(profileRow.payload);
    } catch {
      parsed = null;
    }
  }
  const tokens = cloudOAuthTokens(isRecord(parsed) ? parsed.mcpOAuth : undefined);
  const durableRows = ctx.sql
    .exec<{ server_id: string; payload: string }>(
      "SELECT server_id, payload FROM mcp_oauth_grants WHERE owner_email = ?",
      owner,
    )
    .toArray();
  for (const row of durableRows) {
    // Sealed at rest; a row this key cannot open authenticates nothing and
    // surfaces as a missing grant rather than a crashed run.
    try {
      const token = await openGrantPayload(ctx.vault, ctx.subject(owner), row.server_id, row.payload);
      if (token) tokens[row.server_id] = token;
    } catch (error) {
      if (!(error instanceof SecretVaultError)) throw error;
      console.error("oauth grant unreadable", row.server_id, error.code);
    }
  }
  const revoked = ctx.sql
    .exec<{ server_id: string }>("SELECT server_id FROM mcp_oauth_revocations WHERE owner_email = ?", owner)
    .toArray();
  for (const row of revoked) {
    delete tokens[row.server_id];
  }
  const blockedRows = ctx.sql
    .exec<{ server_id: string; state: string }>(
      "SELECT server_id, state FROM mcp_oauth_states WHERE owner_email = ? AND state IN ('reauth_required', 'step_up_required')",
      owner,
    )
    .toArray();
  const blocked = new Map<string, string>();
  for (const row of blockedRows) {
    delete tokens[row.server_id];
    blocked.set(row.server_id, row.state);
  }
  const prefix = `${OAUTH_REF_PREFIX}${owner}:`;
  const rows = await ctx.storage.list<unknown>({ prefix });
  const rotations: OAuthRotation[] = [];
  for (const [key, value] of rows) {
    const serverId = key.slice(prefix.length);
    let opened: unknown = null;
    try {
      opened = await openRotationValue(ctx.vault, ctx.subject(owner), serverId, value);
    } catch (error) {
      if (!(error instanceof SecretVaultError)) throw error;
    }
    const rotation = normalizeOAuthOverride(serverId, opened);
    if (rotation) {
      rotations.push(rotation);
    } else {
      await ctx.storage.delete(key); // malformed or unreadable — cannot authenticate anything
    }
  }
  const { appliedChains, staleIds } = overlayOAuthRotations(tokens, rotations);
  for (const id of staleIds) {
    await ctx.storage.delete(`${prefix}${id}`); // caught up or replaced by a fresh sign-in
  }
  return { tokens, appliedChains, blocked };
}

/**
 * Persists a grant rotated during an interactive run — losing it would
 * strand later runs AND the browser's synced copy. The chain stays anchored
 * to the browser-synced token, so sync (and the browser's rescue call) can
 * recognize the rotation and hand the fresh pair back.
 */
export async function persistRefreshedGrant(
  ctx: OAuthStoreContext,
  owner: string,
  rotated: RefreshedOAuth,
  appliedChains: Map<string, string[]>,
): Promise<void> {
  // SQL is the canonical grant source. Calling the same resolver used by
  // run arming also overlays a still-live legacy rotation, so old accounts
  // migrate safely without letting the deleted profile.mcpOAuth field make
  // every new server-owned grant look stale.
  const { tokens: currentTokens } = await oauthTokensWithRotations(ctx, owner);
  const currentAccess = currentTokens[rotated.serverId]?.accessToken;
  if (currentAccess !== rotated.baseAccessToken && currentAccess !== rotated.token.accessToken) {
    throw new Error("stale OAuth refresh result");
  }
  const bases = chainRotationBases(appliedChains, rotated);
  await commitCanonicalGrant(ctx, owner, rotated);
  appliedChains.set(rotated.serverId, bases);
}
