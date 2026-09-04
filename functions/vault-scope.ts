// Which subject the account shard's vault scopes are bound to.
//
// Rows start life scoped to the shard's storage owner (the first verified
// email alias). The Worker stamps the immutable Rork Auth subject into every
// relayed request (`X-Gera-Account-Id`); the shard adopts it on first sight —
// or asks the AccessRegistry for it when an internal call (project agent,
// `/mcp/resolve`, `/mcp/auth-lease`, cron fire) arrives first — and runs the
// one-time sweep (vault-scope-sweep.ts) that re-seals every credential into
// `acct:<account_id>`. From then on `subject()` names the account, and a
// value sealed under the owner scope is unreadable outside the sweep.
//
// Fail-closed on identity: a request whose account id disagrees with the one
// this shard adopted is refused (409) — the registry binds one storage owner
// to exactly one subject, so a mismatch is a bug or an attack, never a rename.

import { json, type ChatSql } from "./chat-shared";
import type { SecretVault } from "./secret-vault";
import { SecretVaultError } from "./secret-vault";
import { accountSubject, sweepVaultScope, type ScopeStorage } from "./vault-scope-sweep";

export { accountSubject } from "./vault-scope-sweep";

/** KV key of the scope marker; absent until the first sweep completes. */
export const VAULT_SCOPE_KEY = "vaultScope";
export const ACCOUNT_ID_HEADER = "X-Gera-Account-Id";
export const VAULT_SCOPE_VERSION = 2;

/** Written once the shard's credential rows are sealed under the account scope. */
export type VaultScopeMarker = {
  version: typeof VAULT_SCOPE_VERSION;
  accountId: string;
  sweptAt: number;
  /** Values the sweep could open under neither scope — left in place, reported. */
  unreadable: number;
};

function isMarker(value: unknown): value is VaultScopeMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === VAULT_SCOPE_VERSION &&
    typeof (value as { accountId?: unknown }).accountId === "string" &&
    (value as { accountId: string }).accountId.length > 0
  );
}

/** Rork Auth subjects are opaque; only shape sanity is checked, never format. */
export function isValidAccountId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.includes("\0") && !value.includes(":");
}

/**
 * The shard's live view of its vault scope. Loaded once under
 * `blockConcurrencyWhile` before the first request; flipped by the sweep.
 * Both ChatStore and RunManager hold the same instance, so a grant the run
 * loop rotates is sealed under exactly the scope the sync route reads.
 */
export class CredentialScope {
  private marker: VaultScopeMarker | null = null;

  /** The account this shard's rows are sealed for; null until the sweep ran. */
  get accountId(): string | null {
    return this.marker?.accountId ?? null;
  }

  get migrated(): boolean {
    return this.marker !== null;
  }

  get unreadable(): number {
    return this.marker?.unreadable ?? 0;
  }

  /** The scope subject for `owner`'s rows: the account once migrated, the owner before. */
  subject(owner: string): string {
    return this.marker ? accountSubject(this.marker.accountId) : owner;
  }

  async load(storage: Pick<ScopeStorage, "get">): Promise<void> {
    const stored = await storage.get<unknown>(VAULT_SCOPE_KEY);
    this.marker = isMarker(stored) ? stored : null;
  }

  adopt(marker: VaultScopeMarker): void {
    this.marker = marker;
  }

  /** Diagnostics: counts and the scope kind only — never the account id itself. */
  describe(): { scope: "account" | "owner"; unreadable: number } {
    return { scope: this.marker ? "account" : "owner", unreadable: this.unreadable };
  }
}

/** The account id the Worker stamped on this request; "" when absent or malformed. */
export function readAccountId(request: Request): string {
  const raw = request.headers.get(ACCOUNT_ID_HEADER) ?? "";
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    value = raw;
  }
  value = value.trim();
  return isValidAccountId(value) ? value : "";
}

/** The Durable Object namespace binding (`env.DO`) — only `fetch` is needed. */
export type RegistryBinding = { fetch(request: Request): Promise<Response> };

/**
 * Asks the AccessRegistry which subject owns `owner`'s shard. Null when the
 * registry has no principal for it yet (pre-rollout account that has not
 * signed in since) or is unreachable — the caller keeps the owner scope.
 */
export async function lookupAccountId(binding: RegistryBinding, owner: string): Promise<string | null> {
  try {
    const response = await binding.fetch(
      new Request("https://gera.internal/principal/lookup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Rork-DO-Class": "AccessRegistry",
          "X-Rork-DO-Id": "global",
          "X-Gera-Internal-Route": "principal-lookup",
        },
        body: JSON.stringify({ storageOwner: owner }),
      }),
    );
    if (!response.ok) {
      return null;
    }
    const data = (await response.json().catch(() => null)) as { userId?: unknown } | null;
    const userId = typeof data?.userId === "string" ? data.userId.trim() : "";
    return isValidAccountId(userId) ? userId : null;
  } catch (error) {
    console.error("account lookup unreachable", error instanceof Error ? error.message : "error");
    return null;
  }
}

/** How long a failed registry lookup is remembered before the shard asks again. */
export const LOOKUP_RETRY_MS = 5 * 60_000;

export type VaultScopeContext = {
  sql: ChatSql;
  storage: ScopeStorage;
  vault: SecretVault;
  scope: CredentialScope;
  /** Serializes the sweep against every other request of the object. */
  blockConcurrencyWhile<T>(work: () => Promise<T>): Promise<T>;
  /** Registry binding for the lookup path; absent in tests without a registry. */
  registry?: RegistryBinding;
  now?: () => number;
};

/** Per-object memory of the last failed lookup (never persisted). */
const lookupMisses = new WeakMap<CredentialScope, number>();

/**
 * Runs before every account route: adopts the account id (header, else
 * registry lookup) and performs the sweep the first time one is known.
 * Returns a refusal Response when the request's account id contradicts the
 * shard's, or a vault failure aborted the sweep; null to proceed.
 */
export async function ensureVaultScope(ctx: VaultScopeContext, request: Request, owner: string): Promise<Response | null> {
  const requested = readAccountId(request);
  if (ctx.scope.migrated) {
    if (requested && requested !== ctx.scope.accountId) {
      console.error("account id mismatch on migrated shard");
      return json({ error: "wrong_account" }, 409);
    }
    return null;
  }
  if (!ctx.vault.enabled) {
    return null; // nothing can be re-sealed without a key; readers fail closed on their own
  }
  const now = ctx.now ?? (() => Date.now());
  let accountId = requested;
  if (!accountId) {
    if (!ctx.registry) {
      return null;
    }
    const missedAt = lookupMisses.get(ctx.scope);
    if (missedAt !== undefined && now() - missedAt < LOOKUP_RETRY_MS) {
      return null;
    }
    const found = await lookupAccountId(ctx.registry, owner);
    if (!found) {
      lookupMisses.set(ctx.scope, now());
      return null;
    }
    accountId = found;
  }
  try {
    await ctx.blockConcurrencyWhile(async () => {
      if (ctx.scope.migrated) {
        return; // a concurrent request finished the sweep first
      }
      const report = await sweepVaultScope({
        sql: ctx.sql,
        storage: ctx.storage,
        vault: ctx.vault,
        owner,
        subject: accountSubject(accountId),
        accountId,
      });
      const marker: VaultScopeMarker = {
        version: VAULT_SCOPE_VERSION,
        accountId,
        sweptAt: now(),
        unreadable: report.unreadable,
      };
      await ctx.storage.put(VAULT_SCOPE_KEY, marker);
      ctx.scope.adopt(marker);
      console.log("vault scope migrated", "resealed", report.resealed, "current", report.current, "unreadable", report.unreadable);
    });
  } catch (error) {
    if (error instanceof SecretVaultError) {
      console.error("vault scope sweep failed", error.code);
      return json({ error: error.code }, 503);
    }
    throw error;
  }
  if (ctx.scope.migrated && requested && requested !== ctx.scope.accountId) {
    return json({ error: "wrong_account" }, 409);
  }
  return null;
}
