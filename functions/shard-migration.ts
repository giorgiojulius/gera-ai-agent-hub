// Shard migration — copies one account's rows from the legacy global
// ChatStore object into that account's own per-account shard (Durable
// Object id `acct:<email>`), page by page. Driven two ways:
// - lazily by the Worker when a shard answers 428 (the account's first
//   request after the sharding rollout), and
// - proactively by the cron sweep, so dormant accounts (and their scheduled
//   automations) move without anyone opening the app.
// Imports are LWW-guarded on the shard side, so a concurrent double
// migration or an already-syncing client can never be clobbered by a stale
// page. The global object is never written for an owner again once the
// Worker routes that owner to a shard, so exports read a static snapshot.

type MigrationEnv = { DO: { fetch(request: Request): Promise<Response> } };

/** Hard stop for the paging loop — 400 pages ≈ 1 GB, far above any account. */
const MAX_EXPORT_PAGES = 400;

/** Deterministic per-account shard id — one Durable Object per account. */
export function chatShardId(email: string): string {
  return `acct:${encodeURIComponent(email)}`;
}

function chatStoreCall(
  env: MigrationEnv,
  origin: string,
  doId: string,
  path: string,
  body: unknown,
): Promise<Response> {
  const headers = new Headers();
  headers.set("X-Rork-DO-Class", "ChatStore");
  headers.set("X-Rork-DO-Id", doId);
  headers.set("Content-Type", "application/json");
  return env.DO.fetch(
    new Request(new URL(path, origin).toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

/** Logs must never carry a full address — first two chars + domain only. */
function maskOwner(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? `${email.slice(0, 2)}…${email.slice(at)}` : "…";
}

/**
 * A finalized shard reports its next automation due time — write it into
 * the global schedule index so migrated accounts keep firing on time even
 * if nobody ever opens the app again.
 */
async function reportNextDue(
  env: MigrationEnv,
  origin: string,
  owner: string,
  imported: Response,
): Promise<void> {
  let nextDueAt = Number(imported.headers.get("X-Gera-Next-Due") ?? "");
  if (!Number.isFinite(nextDueAt)) {
    const body = (await imported.json().catch(() => ({}))) as { nextDueAt?: unknown };
    nextDueAt = typeof body.nextDueAt === "number" ? body.nextDueAt : 0;
  }
  const response = await chatStoreCall(env, origin, "global", "/schedule-set", {
    owner,
    nextDueAt: Number.isFinite(nextDueAt) ? Math.max(0, Math.floor(nextDueAt)) : 0,
  });
  if (!response.ok) {
    console.error("schedule set after migration failed", response.status);
  }
}

async function ownerCounts(
  env: MigrationEnv,
  origin: string,
  doId: string,
  owner: string,
): Promise<Record<string, number>> {
  const response = await chatStoreCall(env, origin, doId, "/owner-counts", { owner });
  const data = (await response.json().catch(() => ({}))) as { counts?: unknown };
  if (!response.ok || !data.counts || typeof data.counts !== "object" || Array.isArray(data.counts)) {
    throw new Error(`owner counts failed (${response.status})`);
  }
  const counts: Record<string, number> = {};
  for (const [table, value] of Object.entries(data.counts as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error("owner counts invalid");
    }
    counts[table] = value;
  }
  return counts;
}

async function remapPendingOAuthRoutes(
  env: MigrationEnv,
  origin: string,
  owner: string,
  shardId: string,
  page: Record<string, unknown>,
): Promise<void> {
  const migrationRows = page.migrationRows;
  if (!migrationRows || typeof migrationRows !== "object" || Array.isArray(migrationRows)) {
    return;
  }
  const batch = migrationRows as { table?: unknown; rows?: unknown };
  if (batch.table !== "mcpOAuthPending" || !Array.isArray(batch.rows)) {
    return;
  }
  for (const item of batch.rows) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const state = typeof row.state === "string" ? row.state : "";
    const status = typeof row.status === "string" ? row.status : "";
    const expiresAt = typeof row.expires_at === "number" ? row.expires_at : 0;
    if (
      !/^[a-f0-9]{64}$/.test(state) ||
      expiresAt <= Date.now() ||
      !["pending", "awaiting_confirmation", "exchanging", "exchange_retryable", "exchange_unknown"].includes(status)
    ) {
      continue;
    }
    const response = await env.DO.fetch(
      new Request(new URL("/oauth-route/register", origin).toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Rork-DO-Class": "AccessRegistry",
          "X-Rork-DO-Id": "global",
          "X-Gera-Internal-Route": "oauth",
        },
        body: JSON.stringify({ state, shardId, storageOwner: owner, expiresAt }),
      }),
    );
    if (!response.ok) {
      throw new Error(`OAuth route migration failed (${response.status})`);
    }
  }
}

/**
 * Moves one owner: export pages from the global object, import them into
 * the owner's shard, then mark the owner migrated in the global ledger.
 * Idempotent end to end — safe to run twice concurrently.
 */
export async function migrateOwnerToShard(
  env: MigrationEnv,
  origin: string,
  email: string,
  destinationShard?: string,
): Promise<void> {
  const owner = email.trim().toLowerCase();
  if (!owner) {
    throw new Error("empty owner");
  }
  const shard = destinationShard?.trim() || chatShardId(owner);
  let cursor = "";
  let finished = false;
  for (let page = 0; page < MAX_EXPORT_PAGES; page += 1) {
    const exported = await chatStoreCall(env, origin, "global", "/export", {
      owner,
      ...(cursor ? { cursor } : {}),
    });
    if (!exported.ok) {
      throw new Error(`export failed (${exported.status})`);
    }
    const data = (await exported.json()) as { done?: boolean; cursor?: string } & Record<string, unknown>;
    const imported = await chatStoreCall(env, origin, shard, "/import", {
      ...data,
      owner,
      // Ownership is unlocked only after source/destination verification.
      done: false,
    });
    if (!imported.ok) {
      throw new Error(`import failed (${imported.status})`);
    }
    await remapPendingOAuthRoutes(env, origin, owner, shard, data);
    if (data.done === true) {
      finished = true;
      break;
    }
    const nextCursor = typeof data.cursor === "string" ? data.cursor : "";
    if (!nextCursor || nextCursor === cursor) {
      throw new Error("export cursor made no forward progress");
    }
    cursor = nextCursor;
  }
  if (!finished) {
    throw new Error("export paging never finished");
  }
  const [sourceCounts, destinationCounts] = await Promise.all([
    ownerCounts(env, origin, "global", owner),
    ownerCounts(env, origin, shard, owner),
  ]);
  for (const [table, sourceCount] of Object.entries(sourceCounts)) {
    if ((destinationCounts[table] ?? 0) < sourceCount) {
      throw new Error(`migration verification failed (${table})`);
    }
  }
  const finalized = await chatStoreCall(env, origin, shard, "/import", { owner, done: true });
  if (!finalized.ok) {
    throw new Error(`import finalize failed (${finalized.status})`);
  }
  await reportNextDue(env, origin, owner, finalized);
  const marked = await chatStoreCall(env, origin, "global", "/mark-migrated", { owner });
  if (!marked.ok) {
    throw new Error(`mark-migrated failed (${marked.status})`);
  }
  console.log("shard migration: moved", maskOwner(owner));
}

/**
 * Cron-fired sweep: drains not-yet-migrated owners out of the legacy global
 * object a few at a time, so even accounts that never open the app again get
 * their shard (and their automation alarms) without waiting for a sign-in.
 * Once the global ledger reports no owners left this becomes a cheap no-op.
 */
export async function sweepGlobalMigrations(env: MigrationEnv, origin: string): Promise<void> {
  const response = await chatStoreCall(env, origin, "global", "/owners", { limit: 5 });
  if (!response.ok) {
    console.error("migration sweep: owners list failed", response.status);
    return;
  }
  const data = (await response.json()) as { owners?: unknown };
  const owners = (Array.isArray(data.owners) ? data.owners : []).filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  for (const owner of owners) {
    try {
      await migrateOwnerToShard(env, origin, owner);
    } catch (error) {
      console.error(
        "migration sweep failed for",
        maskOwner(owner),
        error instanceof Error ? error.message : "error",
      );
    }
  }
}
