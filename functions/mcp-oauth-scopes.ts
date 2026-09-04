// Per-connector OAuth scope bookkeeping in the account shard — which scopes
// the last authorize request asked for, which the provider granted, and
// which an `insufficient_scope` challenge demanded since. Metadata only:
// no token material ever lands in this table. The state machine in
// `mcp_oauth_states` keeps deciding whether a grant may be used; this table
// decides what the NEXT sign-in must ask for.
//
// Lifecycle:
//   oauth-start    → requested = pin ∪ (pending step-up ? granted ∪ required) | discovered
//   oauth-complete → granted = token `scope` (RFC 6749 §5.1) ?? requested; required cleared
//   403 insufficient_scope (any run) → required = challenge scope, step_up_code set
//   oauth-clear / disconnect → row deleted

import type { ChatSql } from "./chat-shared";
import { formatScopes, mergeScopes, parseScopeString } from "./mcp-auth-challenge";

export type OAuthScopeRecord = {
  /** Scopes the last authorize request carried. */
  requested: string[];
  /** Scopes the provider reported granted (or the requested ones when it stayed silent). */
  granted: string[];
  /** Scopes a step-up challenge demanded; empty once a sign-in completed after it. */
  required: string[];
  /** `insufficient_scope` while a step-up is pending, else ''. */
  stepUpCode: string;
  updatedAt: number;
};

/** What McpStudio needs to offer "Sign in again with wider access". */
export type PendingStepUp = { scopes: string[]; code: string };

type ScopeRow = {
  requested: string;
  granted: string;
  required: string;
  step_up_code: string;
  updated_at: number;
};

export function ensureOAuthScopeTable(sql: ChatSql): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS mcp_oauth_scopes (
      owner_email TEXT NOT NULL,
      server_id TEXT NOT NULL,
      requested TEXT NOT NULL DEFAULT '',
      granted TEXT NOT NULL DEFAULT '',
      required TEXT NOT NULL DEFAULT '',
      step_up_code TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_email, server_id)
    )
  `);
}

export function readOAuthScopes(sql: ChatSql, owner: string, serverId: string): OAuthScopeRecord | null {
  const row = sql
    .exec<ScopeRow>(
      "SELECT requested, granted, required, step_up_code, updated_at FROM mcp_oauth_scopes WHERE owner_email = ? AND server_id = ?",
      owner,
      serverId,
    )
    .toArray()[0];
  if (!row) {
    return null;
  }
  return {
    requested: parseScopeString(row.requested),
    granted: parseScopeString(row.granted),
    required: parseScopeString(row.required),
    stepUpCode: row.step_up_code,
    updatedAt: row.updated_at,
  };
}

/** The authorize request went out with these scopes; granted/required stay as they were. */
export function recordRequestedScopes(sql: ChatSql, owner: string, serverId: string, requested: readonly string[], now: number = Date.now()): void {
  sql.exec(
    `INSERT INTO mcp_oauth_scopes (owner_email, server_id, requested, granted, required, step_up_code, updated_at)
     VALUES (?, ?, ?, '', '', '', ?)
     ON CONFLICT(owner_email, server_id) DO UPDATE SET
       requested = excluded.requested,
       updated_at = excluded.updated_at`,
    owner,
    serverId,
    formatScopes(requested),
    now,
  );
}

/**
 * A sign-in completed. `granted` is the token response's `scope` when the
 * provider sent one (it may be narrower than requested), otherwise the
 * requested list. Any pending step-up is satisfied by definition — the user
 * just consented to the union — so it clears here and only here.
 */
export function recordGrantedScopes(sql: ChatSql, owner: string, serverId: string, granted: readonly string[] | null, now: number = Date.now()): void {
  const current = readOAuthScopes(sql, owner, serverId);
  const effective = granted && granted.length > 0 ? [...granted] : current?.requested ?? [];
  sql.exec(
    `INSERT INTO mcp_oauth_scopes (owner_email, server_id, requested, granted, required, step_up_code, updated_at)
     VALUES (?, ?, ?, ?, '', '', ?)
     ON CONFLICT(owner_email, server_id) DO UPDATE SET
       granted = excluded.granted,
       required = '',
       step_up_code = '',
       updated_at = excluded.updated_at`,
    owner,
    serverId,
    formatScopes(current?.requested ?? effective),
    formatScopes(effective),
    now,
  );
}

/** A tools/call (or handshake) answered insufficient_scope: remember what it wanted. */
export function recordRequiredScopes(sql: ChatSql, owner: string, serverId: string, required: readonly string[], code: string, now: number = Date.now()): void {
  const current = readOAuthScopes(sql, owner, serverId);
  const merged = mergeScopes(current?.required, required);
  sql.exec(
    `INSERT INTO mcp_oauth_scopes (owner_email, server_id, requested, granted, required, step_up_code, updated_at)
     VALUES (?, ?, '', '', ?, ?, ?)
     ON CONFLICT(owner_email, server_id) DO UPDATE SET
       required = excluded.required,
       step_up_code = excluded.step_up_code,
       updated_at = excluded.updated_at`,
    owner,
    serverId,
    formatScopes(merged),
    code.slice(0, 80),
    now,
  );
}

export function clearOAuthScopes(sql: ChatSql, owner: string, serverId: string): void {
  sql.exec("DELETE FROM mcp_oauth_scopes WHERE owner_email = ? AND server_id = ?", owner, serverId);
}

/** Non-null while a step-up challenge has not been answered by a new sign-in. */
export function pendingStepUp(sql: ChatSql, owner: string, serverId: string): PendingStepUp | null {
  const record = readOAuthScopes(sql, owner, serverId);
  if (!record || (!record.stepUpCode && record.required.length === 0)) {
    return null;
  }
  return { scopes: record.required, code: record.stepUpCode || "insufficient_scope" };
}

/**
 * Explicit scopes for the next authorize request, or null when discovery
 * should decide (no pin, no pending step-up). A pending step-up asks for the
 * union of the pin, everything already granted and everything the server
 * demanded — a narrower re-consent would silently lose working tools.
 */
export function planAuthorizationScopes(input: { pinned: readonly string[]; record: OAuthScopeRecord | null }): string[] | null {
  const stepUp = Boolean(input.record && (input.record.stepUpCode || input.record.required.length > 0));
  if (input.pinned.length === 0 && !stepUp) {
    return null;
  }
  return mergeScopes(
    input.pinned,
    stepUp ? input.record?.granted : undefined,
    stepUp ? input.record?.required : undefined,
  );
}
