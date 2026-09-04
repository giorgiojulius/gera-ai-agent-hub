// One-time re-scoping of every credential row in an account shard from the
// legacy `…:<storageOwner>:…` vault scope to `…:acct:<account_id>:…`.
//
// The AAD of a sealed value names the row it belongs to. Binding it to the
// immutable Rork Auth subject instead of the (alias-shaped) storage owner
// means a value copied into a shard whose owner string happens to match still
// fails to open unless the account matches too. The old scope is opened ONLY
// here: after the sweep, every reader uses `CredentialScope.subject()`.
//
// Idempotent and resumable: each value is first tried under the new scope
// (already migrated — nothing to do), then under the old scope (re-sealed),
// otherwise it is left untouched and counted as unreadable. Unreadable rows
// are never deleted — `/diag/vault` reports the count so the user can
// reconnect exactly those servers. Runs under `blockConcurrencyWhile`, so no
// request observes a half-migrated shard.

import { OAUTH_REF_PREFIX, type ChatSql } from "./chat-shared";
import {
  deviceCodeScope,
  GRANT_SECRET_FIELDS,
  grantScope,
  OAUTH_PENDING_SECRET_FIELDS,
  oauthPendingScope,
  rotationScope,
  SERVER_SECRET_FIELDS,
  serverSecretScope,
} from "./secret-rows";
import { fieldScope, isSealedEnvelope, type SecretVault, SecretVaultError } from "./secret-vault";

/** The vault scope subject for an account: replaces the storage owner inside every scope string. */
export function accountSubject(accountId: string): string {
  return `acct:${accountId}`;
}

/** Tables whose credential rows gain an `account_id` column. */
export const ACCOUNT_SCOPED_TABLES = [
  "mcp_oauth_grants",
  "mcp_server_secrets",
  "mcp_oauth_pending",
  "mcp_github_device_pending",
] as const;

/** Minimal KV surface the sweep needs (the real DurableObjectStorage satisfies it). */
export type ScopeStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
};

export type VaultScopeSweepReport = {
  /** Values re-sealed from the owner scope into the account scope. */
  resealed: number;
  /** Values that already opened under the account scope. */
  current: number;
  /** Values that opened under neither scope — kept in place, reported. */
  unreadable: number;
};

type Outcome = "current" | "resealed" | "unreadable";

/**
 * Adds `account_id TEXT NOT NULL DEFAULT ''` to every credential table.
 * SQLite has no IF NOT EXISTS for columns; the duplicate-column error is the
 * signal that an earlier sweep already added it.
 */
export function ensureAccountIdColumns(sql: ChatSql): void {
  for (const table of ACCOUNT_SCOPED_TABLES) {
    try {
      sql.exec(`ALTER TABLE ${table} ADD COLUMN account_id TEXT NOT NULL DEFAULT ''`);
    } catch (error) {
      if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
    }
  }
}

/**
 * Re-scopes one sealed value. Plaintext (a pre-vault value the legacy sweep
 * never met) is sealed straight into the new scope — the same thing the
 * legacy sweep would have done under the old one.
 */
export async function rescopeValue(
  vault: SecretVault,
  stored: string,
  oldScope: string,
  newScope: string,
): Promise<{ value: string; outcome: Outcome }> {
  if (stored === "") {
    return { value: stored, outcome: "current" };
  }
  if (!vault.isSealed(stored)) {
    return { value: await vault.seal(stored, newScope), outcome: "resealed" };
  }
  try {
    await vault.open(stored, newScope);
    return { value: stored, outcome: "current" };
  } catch (error) {
    if (!(error instanceof SecretVaultError)) {
      throw error;
    }
  }
  try {
    const plain = await vault.open(stored, oldScope);
    return { value: await vault.seal(plain, newScope), outcome: "resealed" };
  } catch (error) {
    if (!(error instanceof SecretVaultError)) {
      throw error;
    }
    return { value: stored, outcome: "unreadable" };
  }
}

/** Re-scopes the listed string fields of a JSON payload; the payload's other fields are kept verbatim. */
async function rescopePayload(
  vault: SecretVault,
  payload: string,
  fields: readonly string[],
  oldScope: string,
  newScope: string,
  report: VaultScopeSweepReport,
): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  let changed = false;
  for (const field of fields) {
    const current = record[field];
    if (typeof current !== "string" || current === "") {
      continue;
    }
    const next = await rescopeValue(vault, current, fieldScope(oldScope, field), fieldScope(newScope, field));
    report[next.outcome] += 1;
    if (next.outcome === "resealed") {
      record[field] = next.value;
      changed = true;
    }
  }
  return changed ? JSON.stringify(record) : null;
}

export type VaultScopeSweepInput = {
  sql: ChatSql;
  storage: ScopeStorage;
  vault: SecretVault;
  /** The shard's storage owner — the legacy scope subject. */
  owner: string;
  /** The new scope subject (`acct:<account_id>`). */
  subject: string;
  accountId: string;
};

/**
 * Re-seals every credential value of `owner` into the account scope and
 * stamps `account_id` on the rows it visited. Never deletes a row.
 */
export async function sweepVaultScope(input: VaultScopeSweepInput): Promise<VaultScopeSweepReport> {
  const { sql, storage, vault, owner, subject, accountId } = input;
  const report: VaultScopeSweepReport = { resealed: 0, current: 0, unreadable: 0 };
  ensureAccountIdColumns(sql);

  for (const row of sql
    .exec<{ server_id: string; payload: string }>(
      "SELECT server_id, payload FROM mcp_oauth_grants WHERE owner_email = ?",
      owner,
    )
    .toArray()) {
    const next = await rescopePayload(
      vault,
      row.payload,
      GRANT_SECRET_FIELDS,
      grantScope(owner, row.server_id),
      grantScope(subject, row.server_id),
      report,
    );
    sql.exec(
      "UPDATE mcp_oauth_grants SET payload = ?, account_id = ? WHERE owner_email = ? AND server_id = ?",
      next ?? row.payload,
      accountId,
      owner,
      row.server_id,
    );
  }

  for (const row of sql
    .exec<{ server_id: string; payload: string }>(
      "SELECT server_id, payload FROM mcp_server_secrets WHERE owner_email = ?",
      owner,
    )
    .toArray()) {
    const next = await rescopePayload(
      vault,
      row.payload,
      SERVER_SECRET_FIELDS,
      serverSecretScope(owner, row.server_id),
      serverSecretScope(subject, row.server_id),
      report,
    );
    sql.exec(
      "UPDATE mcp_server_secrets SET payload = ?, account_id = ? WHERE owner_email = ? AND server_id = ?",
      next ?? row.payload,
      accountId,
      owner,
      row.server_id,
    );
  }

  for (const row of sql
    .exec<{ state: string; verifier: string; authorization_code: string; browser_nonce: string; callback_challenge: string }>(
      `SELECT state, verifier, authorization_code, browser_nonce, callback_challenge
       FROM mcp_oauth_pending WHERE owner_email = ?`,
      owner,
    )
    .toArray()) {
    const values: Record<string, string> = {
      verifier: row.verifier,
      authorization_code: row.authorization_code,
      browser_nonce: row.browser_nonce,
      callback_challenge: row.callback_challenge,
    };
    for (const field of OAUTH_PENDING_SECRET_FIELDS) {
      const next = await rescopeValue(
        vault,
        values[field],
        fieldScope(oauthPendingScope(owner, row.state), field),
        fieldScope(oauthPendingScope(subject, row.state), field),
      );
      if (values[field] !== "") {
        report[next.outcome] += 1;
      }
      values[field] = next.value;
    }
    sql.exec(
      `UPDATE mcp_oauth_pending
       SET verifier = ?, authorization_code = ?, browser_nonce = ?, callback_challenge = ?, account_id = ?
       WHERE owner_email = ? AND state = ?`,
      values.verifier,
      values.authorization_code,
      values.browser_nonce,
      values.callback_challenge,
      accountId,
      owner,
      row.state,
    );
  }

  for (const row of sql
    .exec<{ flow_id: string; device_code: string }>(
      "SELECT flow_id, device_code FROM mcp_github_device_pending WHERE owner_email = ?",
      owner,
    )
    .toArray()) {
    const next = await rescopeValue(
      vault,
      row.device_code,
      deviceCodeScope(owner, row.flow_id),
      deviceCodeScope(subject, row.flow_id),
    );
    if (row.device_code !== "") {
      report[next.outcome] += 1;
    }
    sql.exec(
      "UPDATE mcp_github_device_pending SET device_code = ?, account_id = ? WHERE owner_email = ? AND flow_id = ?",
      next.value,
      accountId,
      owner,
      row.flow_id,
    );
  }

  // Legacy rotation escrow in KV: `oauthref:<owner>:<serverId>` → { sealed }.
  const prefix = `${OAUTH_REF_PREFIX}${owner}:`;
  for (const [key, value] of await storage.list<unknown>({ prefix })) {
    const serverId = key.slice(prefix.length);
    if (!serverId || !isSealedEnvelope(value)) {
      continue; // plaintext escrow is refused by every reader already; nothing to re-scope
    }
    const next = await rescopeValue(vault, value.sealed, rotationScope(owner, serverId), rotationScope(subject, serverId));
    report[next.outcome] += 1;
    if (next.outcome === "resealed") {
      await storage.put(key, { sealed: next.value });
    }
  }

  return report;
}
