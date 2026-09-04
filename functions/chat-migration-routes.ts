// Migration and legacy-global registry routes for the ChatStore object —
// export/import paging between the legacy global object and per-account
// shards, plus the global-only schedule index and webhook-token registry.
// Extracted from chat-store.ts verbatim; handlers receive a narrow context
// instead of the whole Durable Object so this module stays platform-neutral.

import {
  asNum,
  asStr,
  capStr,
  CHAT_PAYLOAD_LIMIT,
  DIAG_DETAIL_LIMIT,
  DIAG_MESSAGE_LIMIT,
  DIAG_ROWS_LIMIT,
  DIAG_SCOPE_LIMIT,
  EXPORT_PAGE_BYTES,
  EXPORT_PAGE_CHATS,
  HOOKS_HEADER,
  isRecord,
  isValidId,
  json,
  NEXT_DUE_HEADER,
  TITLE_LIMIT,
  type ChatRow,
  type ChatSql,
  type TombstoneRow,
} from "./chat-shared";
import { HOOK_TOKEN_PATTERN, HOOKS_INDEX_CAP } from "./automation-schedule";

/** The slice of ChatStore these routes are allowed to touch. */
export type ChatStoreRouteContext = {
  sql: ChatSql;
  diagMeta(owner: string): { seen_at: number; cleared_at: number };
  nextDueForOwner(owner: string, knownPayload?: string): Promise<number>;
  hooksIndexValue(payload: string | null | undefined): string;
  /** `done: true` import — records the shard's owner and unlocks account routes. */
  markShardInitialized(owner: string): Promise<void>;
  shardOwner(): Promise<string>;
  hasOwnerStorage(owner: string): Promise<boolean>;
  prepareProfilePayload(owner: string, payload: string): Promise<string | null>;
  exportOwnerStorage(owner: string): Promise<Array<{ serverId: string; value: unknown }>>;
  importOwnerStorage(owner: string, rows: Array<{ serverId: string; value: unknown }>): Promise<void>;
};

type MigrationTable = {
  wireName: string;
  tableName: string;
  columns: readonly string[];
};

const MIGRATION_TABLES: readonly MigrationTable[] = [
  { wireName: "mcpServerSecrets", tableName: "mcp_server_secrets", columns: ["server_id", "payload", "updated_at"] },
  { wireName: "mcpOAuthGrants", tableName: "mcp_oauth_grants", columns: ["server_id", "payload", "updated_at"] },
  { wireName: "mcpOAuthRevocations", tableName: "mcp_oauth_revocations", columns: ["server_id", "revoked_at"] },
  { wireName: "mcpOAuthStates", tableName: "mcp_oauth_states", columns: ["server_id", "state", "error_code", "retry_after", "updated_at"] },
  { wireName: "mcpOAuthClients", tableName: "mcp_oauth_clients", columns: ["registration_endpoint", "redirect_uri", "client_id", "expires_at", "updated_at"] },
  { wireName: "mcpOAuthScopes", tableName: "mcp_oauth_scopes", columns: ["server_id", "requested", "granted", "required", "step_up_code", "updated_at"] },
  {
    wireName: "mcpOAuthPending",
    tableName: "mcp_oauth_pending",
    columns: ["state", "server_id", "mcp_url", "token_endpoint", "client_id", "verifier", "redirect_uri", "resource", "issuer", "return_origin", "browser_nonce", "callback_challenge", "authorization_code", "expires_at", "status", "error", "created_at", "updated_at"],
  },
  {
    wireName: "mcpGithubPending",
    tableName: "mcp_github_device_pending",
    columns: ["flow_id", "server_id", "device_code", "user_code", "verification_uri", "client_id", "expires_at", "interval_ms", "next_poll_at", "status", "error", "created_at", "updated_at"],
  },
  {
    wireName: "automationRunReceipts",
    tableName: "automation_run_receipts",
    columns: ["id", "automation_id", "conversation_id", "name", "agent_id", "model_id", "user_text", "status", "started_at", "finished_at", "error"],
  },
  {
    wireName: "agentRuns",
    tableName: "agent_runs",
    columns: ["conversation_id", "run_id", "kind", "status", "started_at", "heartbeat_at", "finished_at", "title", "model_id", "assistant_message_id", "ephemeral", "acked", "snapshot", "result", "error"],
  },
  {
    wireName: "agentRunReceipts",
    tableName: "agent_run_receipts",
    columns: ["run_id", "conversation_id", "request_hash", "status", "history_on_server", "result", "error", "created_at", "updated_at"],
  },
  { wireName: "agentRunMedia", tableName: "agent_run_media", columns: ["run_id", "idx", "chunk", "kind", "data", "created_at"] },
] as const;

const MIGRATION_PAGE_ROWS = 24;
type ExportCursor = { phase: "chats"; key: string } | { phase: "table"; index: number; rowId: number };

function decodeExportCursor(raw: string): ExportCursor {
  if (!raw) return { phase: "chats", key: "" };
  try {
    const parsed = JSON.parse(raw) as Partial<ExportCursor>;
    if (parsed.phase === "chats" && typeof parsed.key === "string") {
      return { phase: "chats", key: parsed.key };
    }
    if (
      parsed.phase === "table" &&
      typeof parsed.index === "number" &&
      Number.isInteger(parsed.index) &&
      typeof parsed.rowId === "number" &&
      Number.isFinite(parsed.rowId)
    ) {
      return { phase: "table", index: Math.max(0, parsed.index), rowId: Math.max(0, parsed.rowId) };
    }
  } catch {
    // Pre-versioned migration cursors were raw chat ids.
  }
  return { phase: "chats", key: raw };
}

function encodeExportCursor(cursor: ExportCursor): string {
  return JSON.stringify(cursor);
}

const OWNER_DATA_TABLES = [
  "profiles",
  "chats",
  "tombstones",
  "diagnostics",
  "diag_meta",
  "server_runs",
  "mcp_server_secrets",
  "mcp_oauth_grants",
  "mcp_oauth_revocations",
  "mcp_oauth_states",
  "mcp_oauth_clients",
  "mcp_oauth_scopes",
  "mcp_oauth_pending",
  "mcp_github_device_pending",
  "automation_run_receipts",
  "agent_runs",
  "agent_run_receipts",
  "agent_run_media",
  "schedule",
  "hooks",
  "migrated_owners",
] as const;

/** Internal metadata-only probe used before an immutable subject may claim a legacy email. */
export async function handleOwnerState(store: ChatStoreRouteContext, request: Request): Promise<Response> {
  let body: { owner?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const owner = asStr(body.owner).trim().toLowerCase();
  if (!owner) {
    return json({ error: "invalid_owner" }, 400);
  }
  if ((await store.shardOwner()) === owner || await store.hasOwnerStorage(owner)) {
    return json({ hasData: true });
  }
  for (const table of OWNER_DATA_TABLES) {
    const row = store.sql
      .exec<{ present: number }>(`SELECT 1 AS present FROM ${table} WHERE owner_email = ? LIMIT 1`, owner)
      .toArray()[0];
    if (row) {
      return json({ hasData: true });
    }
  }
  return json({ hasData: false });
}

const VERIFIED_MIGRATION_TABLES = [
  "profiles",
  "chats",
  "tombstones",
  "server_runs",
  ...MIGRATION_TABLES.map((item) => item.tableName),
] as const;

/** Internal row-count proof checked before the legacy source is marked migrated. */
export async function handleOwnerCounts(store: ChatStoreRouteContext, request: Request): Promise<Response> {
  let body: { owner?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const owner = asStr(body.owner).trim().toLowerCase();
  if (!owner) {
    return json({ error: "invalid_owner" }, 400);
  }
  const counts: Record<string, number> = {};
  for (const table of VERIFIED_MIGRATION_TABLES) {
    counts[table] = store.sql
      .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table} WHERE owner_email = ?`, owner)
      .toArray()[0]?.count ?? 0;
  }
  counts.oauth_storage = (await store.exportOwnerStorage(owner)).length;
  return json({ counts });
}

/**
 * Streams one owner's rows out of this (legacy global) object so the
 * Worker can copy them into the owner's per-account shard. The first page
 * carries the small tables; chats page by bytes via the `cursor` id.
 * Also used by the shard selftest to read a shard's state back.
 */
export async function handleExport(store: ChatStoreRouteContext, request: Request): Promise<Response> {
  let body: { owner?: unknown; cursor?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const owner = asStr(body.owner).trim().toLowerCase();
  if (!owner) {
    return json({ error: "invalid_owner" }, 400);
  }
  const rawCursor = asStr(body.cursor);
  const cursor = decodeExportCursor(rawCursor);
  const out: Record<string, unknown> = {};
  if (!rawCursor) {
    const profile = store.sql
      .exec<{ payload: string; updated_at: number }>(
        "SELECT payload, updated_at FROM profiles WHERE owner_email = ?",
        owner,
      )
      .toArray()[0];
    if (profile) {
      const safePayload = await store.prepareProfilePayload(owner, profile.payload);
      if (safePayload !== null) {
        if (safePayload !== profile.payload) {
          store.sql.exec(
            "UPDATE profiles SET payload = ? WHERE owner_email = ? AND updated_at = ?",
            safePayload,
            owner,
            profile.updated_at,
          );
        }
        out.profile = { payload: safePayload, updatedAt: profile.updated_at };
      } else {
        out.profile = null;
      }
    } else {
      out.profile = null;
    }
    out.serverRuns = store.sql
      .exec<{ automation_id: string; last_run_at: number }>(
        "SELECT automation_id, last_run_at FROM server_runs WHERE owner_email = ?",
        owner,
      )
      .toArray()
      .map((row) => ({ automationId: row.automation_id, lastRunAt: row.last_run_at }));
    out.diagnostics = store.sql
      .exec<{ id: string; at: number; scope: string; message: string; detail: string }>(
        `SELECT id, at, scope, message, detail FROM diagnostics WHERE owner_email = ? ORDER BY at DESC LIMIT ${DIAG_ROWS_LIMIT}`,
        owner,
      )
      .toArray();
    const meta = store.sql
      .exec<{ seen_at: number; cleared_at: number }>(
        "SELECT seen_at, cleared_at FROM diag_meta WHERE owner_email = ?",
        owner,
      )
      .toArray()[0];
    out.diagMeta = meta ? { seenAt: meta.seen_at, clearedAt: meta.cleared_at } : null;
    out.tombstones = store.sql
      .exec<TombstoneRow>("SELECT id, deleted_at FROM tombstones WHERE owner_email = ?", owner)
      .toArray()
      .map((row) => ({ id: row.id, deletedAt: row.deleted_at }));
    out.oauthStorage = await store.exportOwnerStorage(owner);
  }

  if (cursor.phase === "chats") {
    const rows = store.sql
      .exec<ChatRow>(
        "SELECT id, title, updated_at, payload FROM chats WHERE owner_email = ? AND id > ? ORDER BY id LIMIT ?",
        owner,
        cursor.key,
        EXPORT_PAGE_CHATS + 1,
      )
      .toArray();
    const chats: Array<{ id: string; title: string; updatedAt: number; payload: string }> = [];
    let bytes = 0;
    for (const row of rows) {
      if (chats.length > 0 && bytes + row.payload.length > EXPORT_PAGE_BYTES) {
        break;
      }
      chats.push({ id: row.id, title: row.title, updatedAt: row.updated_at, payload: row.payload });
      bytes += row.payload.length;
      if (chats.length >= EXPORT_PAGE_CHATS) {
        break;
      }
    }
    const hasMoreChats = chats.length < rows.length;
    out.chats = chats;
    out.done = false;
    out.cursor = hasMoreChats
      ? encodeExportCursor({ phase: "chats", key: chats[chats.length - 1]?.id ?? cursor.key })
      : encodeExportCursor({ phase: "table", index: 0, rowId: 0 });
    return json(out);
  }

  const definition = MIGRATION_TABLES[cursor.index];
  if (!definition) {
    return json({ ...out, done: true, cursor: rawCursor });
  }
  const rows = store.sql
    .exec<Record<string, string | number | null>>(
      `SELECT rowid AS migration_rowid, ${definition.columns.join(", ")} FROM ${definition.tableName}
       WHERE owner_email = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
      owner,
      cursor.rowId,
      MIGRATION_PAGE_ROWS + 1,
    )
    .toArray();
  const selected: Array<Record<string, string | number | null>> = [];
  let bytes = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length;
    if (selected.length > 0 && bytes + size > EXPORT_PAGE_BYTES) {
      break;
    }
    selected.push(row);
    bytes += size;
    if (selected.length >= MIGRATION_PAGE_ROWS) {
      break;
    }
  }
  const hasMoreRows = selected.length < rows.length;
  const lastRowId = asNum(selected[selected.length - 1]?.migration_rowid, cursor.rowId);
  const nextIndex = hasMoreRows ? cursor.index : cursor.index + 1;
  out.migrationRows = { table: definition.wireName, rows: selected };
  out.done = !hasMoreRows && nextIndex >= MIGRATION_TABLES.length;
  out.cursor = encodeExportCursor({
    phase: "table",
    index: nextIndex,
    rowId: hasMoreRows ? lastRowId : 0,
  });
  return json(out);
}

/** Legacy-global-only: a deterministic batch of owners that still need a shard. */
export async function handleOwners(store: ChatStoreRouteContext, request: Request): Promise<Response> {
  let body: { limit?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  const limit = Math.min(20, Math.max(1, Math.round(asNum(body.limit, 5))));
  const rows = store.sql
    .exec<{ owner_email: string }>(
      `WITH
        owner_group_1 AS (
          SELECT owner_email FROM profiles
          UNION SELECT owner_email FROM chats
          UNION SELECT owner_email FROM diagnostics
          UNION SELECT owner_email FROM diag_meta
          UNION SELECT owner_email FROM tombstones
        ),
        owner_group_2 AS (
          SELECT owner_email FROM server_runs
          UNION SELECT owner_email FROM mcp_server_secrets
          UNION SELECT owner_email FROM mcp_oauth_grants
          UNION SELECT owner_email FROM mcp_oauth_revocations
          UNION SELECT owner_email FROM mcp_oauth_states
        ),
        owner_group_3 AS (
          SELECT owner_email FROM mcp_oauth_clients
          UNION SELECT owner_email FROM mcp_oauth_pending
          UNION SELECT owner_email FROM mcp_github_device_pending
          UNION SELECT owner_email FROM automation_run_receipts
          UNION SELECT owner_email FROM agent_runs
        ),
        owner_group_4 AS (
          SELECT owner_email FROM agent_run_receipts
          UNION SELECT owner_email FROM agent_run_media
        ),
        all_owners AS (
          SELECT owner_email FROM owner_group_1
          UNION SELECT owner_email FROM owner_group_2
          UNION SELECT owner_email FROM owner_group_3
          UNION SELECT owner_email FROM owner_group_4
        )
       SELECT owner_email FROM all_owners
       WHERE owner_email NOT IN (SELECT owner_email FROM migrated_owners)
       ORDER BY owner_email
       LIMIT ?`,
      limit,
    )
    .toArray();
  return json({ owners: rows.map((row) => row.owner_email) });
}

export async function handleMarkMigrated(store: ChatStoreRouteContext, request: Request): Promise<Response> {
  let body: { owner?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const owner = asStr(body.owner).trim().toLowerCase();
  if (!owner) {
    return json({ error: "invalid_owner" }, 400);
  }
  store.sql.exec(
    "INSERT OR REPLACE INTO migrated_owners (owner_email, migrated_at) VALUES (?, ?)",
    owner,
    Date.now(),
  );
  return json({ ok: true });
}

function importMigrationRows(store: ChatStoreRouteContext, owner: string, raw: unknown): void {
  if (!isRecord(raw) || typeof raw.table !== "string" || !Array.isArray(raw.rows)) {
    return;
  }
  const definition = MIGRATION_TABLES.find((item) => item.wireName === raw.table);
  if (!definition) {
    return;
  }
  const placeholders = ["?", ...definition.columns.map(() => "?")].join(", ");
  for (const item of raw.rows) {
    if (!isRecord(item)) {
      continue;
    }
    const values: Array<string | number | null> = [];
    let valid = true;
    for (const column of definition.columns) {
      const value = item[column];
      if (value === null || typeof value === "string" || typeof value === "number") {
        values.push(value as string | number | null);
      } else {
        valid = false;
        break;
      }
    }
    if (!valid) {
      continue;
    }
    store.sql.exec(
      `INSERT OR IGNORE INTO ${definition.tableName} (owner_email, ${definition.columns.join(", ")}) VALUES (${placeholders})`,
      owner,
      ...values,
    );
  }
}

/**
 * Imports one export page into this shard. Every row is LWW-guarded, so a
 * duplicate concurrent migration — or a client that already synced fresher
 * data — can never be clobbered by a stale page. `done: true` marks the
 * shard initialized and arms the automation alarm.
 */
export async function handleImport(store: ChatStoreRouteContext, request: Request): Promise<Response> {
  let body: {
    owner?: unknown;
    profile?: unknown;
    serverRuns?: unknown;
    diagnostics?: unknown;
    diagMeta?: unknown;
    tombstones?: unknown;
    chats?: unknown;
    migrationRows?: unknown;
    oauthStorage?: unknown;
    done?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const owner = asStr(body.owner).trim().toLowerCase();
  if (!owner) {
    return json({ error: "invalid_owner" }, 400);
  }

  if (Array.isArray(body.oauthStorage)) {
    const rows = body.oauthStorage
      .filter((item): item is { serverId: string; value: unknown } =>
        isRecord(item) && typeof item.serverId === "string" && isValidId(item.serverId),
      )
      .map((item) => ({ serverId: item.serverId, value: item.value }));
    await store.importOwnerStorage(owner, rows);
  }
  if (isRecord(body.profile) && typeof body.profile.payload === "string") {
    const safePayload = await store.prepareProfilePayload(owner, body.profile.payload);
    const incomingAt = asNum(body.profile.updatedAt, 0);
    const existing = store.sql
      .exec<{ updated_at: number }>("SELECT updated_at FROM profiles WHERE owner_email = ?", owner)
      .toArray()[0];
    if (safePayload !== null && (!existing || incomingAt > existing.updated_at)) {
      store.sql.exec(
        "INSERT OR REPLACE INTO profiles (owner_email, payload, updated_at) VALUES (?, ?, ?)",
        owner,
        safePayload,
        incomingAt,
      );
    }
  }
  importMigrationRows(store, owner, body.migrationRows);
  for (const item of Array.isArray(body.serverRuns) ? body.serverRuns : []) {
    if (!isRecord(item) || !isValidId(item.automationId)) {
      continue;
    }
    const lastRunAt = asNum(item.lastRunAt, 0);
    const existing = store.sql
      .exec<{ last_run_at: number }>(
        "SELECT last_run_at FROM server_runs WHERE owner_email = ? AND automation_id = ?",
        owner,
        item.automationId,
      )
      .toArray()[0];
    if (!existing || lastRunAt > existing.last_run_at) {
      store.sql.exec(
        "INSERT OR REPLACE INTO server_runs (owner_email, automation_id, last_run_at) VALUES (?, ?, ?)",
        owner,
        item.automationId,
        lastRunAt,
      );
    }
  }
  for (const item of Array.isArray(body.diagnostics) ? body.diagnostics : []) {
    if (!isRecord(item) || !isValidId(item.id)) {
      continue;
    }
    store.sql.exec(
      "INSERT OR IGNORE INTO diagnostics (owner_email, id, at, scope, message, detail) VALUES (?, ?, ?, ?, ?, ?)",
      owner,
      item.id,
      asNum(item.at, 0),
      capStr(asStr(item.scope) || "app", DIAG_SCOPE_LIMIT),
      capStr(asStr(item.message), DIAG_MESSAGE_LIMIT),
      capStr(asStr(item.detail), DIAG_DETAIL_LIMIT),
    );
  }
  if (isRecord(body.diagMeta)) {
    const meta = store.diagMeta(owner);
    store.sql.exec(
      "INSERT OR REPLACE INTO diag_meta (owner_email, seen_at, cleared_at) VALUES (?, ?, ?)",
      owner,
      Math.max(meta.seen_at, asNum(body.diagMeta.seenAt, 0)),
      Math.max(meta.cleared_at, asNum(body.diagMeta.clearedAt, 0)),
    );
  }
  for (const item of Array.isArray(body.tombstones) ? body.tombstones : []) {
    if (!isRecord(item) || !isValidId(item.id)) {
      continue;
    }
    const deletedAt = asNum(item.deletedAt, 0);
    const existing = store.sql
      .exec<{ deleted_at: number }>(
        "SELECT deleted_at FROM tombstones WHERE owner_email = ? AND id = ?",
        owner,
        item.id,
      )
      .toArray()[0];
    if (!existing || deletedAt > existing.deleted_at) {
      store.sql.exec(
        "INSERT OR REPLACE INTO tombstones (owner_email, id, deleted_at) VALUES (?, ?, ?)",
        owner,
        item.id,
        deletedAt,
      );
    }
  }
  for (const item of Array.isArray(body.chats) ? body.chats : []) {
    if (!isRecord(item) || !isValidId(item.id) || typeof item.payload !== "string") {
      continue;
    }
    if (item.payload.length > CHAT_PAYLOAD_LIMIT) {
      continue;
    }
    const updatedAt = asNum(item.updatedAt, 0);
    const existing = store.sql
      .exec<{ updated_at: number }>(
        "SELECT updated_at FROM chats WHERE owner_email = ? AND id = ?",
        owner,
        item.id,
      )
      .toArray()[0];
    if (existing && existing.updated_at >= updatedAt) {
      continue;
    }
    store.sql.exec(
      "INSERT OR REPLACE INTO chats (owner_email, id, title, payload, updated_at) VALUES (?, ?, ?, ?, ?)",
      owner,
      item.id,
      capStr(asStr(item.title) || "Chat", TITLE_LIMIT),
      item.payload,
      updatedAt,
    );
  }

  if (body.done === true) {
    await store.markShardInitialized(owner);
    // The shard is live — report next due + webhook registry for the index.
    const nextDueAt = await store.nextDueForOwner(owner);
    const profRow = store.sql
      .exec<{ payload: string }>("SELECT payload FROM profiles WHERE owner_email = ?", owner)
      .toArray()[0];
    return json({ ok: true, nextDueAt }, 200, {
      [NEXT_DUE_HEADER]: String(nextDueAt),
      [HOOKS_HEADER]: store.hooksIndexValue(profRow?.payload),
    });
  }
  return json({ ok: true });
}

/** Legacy-global-only: upsert/clear one owner's schedule index row. */
export async function handleScheduleSet(store: ChatStoreRouteContext, request: Request): Promise<Response> {
  let body: { owner?: unknown; nextDueAt?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const owner = asStr(body.owner).trim().toLowerCase();
  if (!owner) {
    return json({ error: "invalid_owner" }, 400);
  }
  const nextDueAt = asNum(body.nextDueAt, 0);
  if (nextDueAt <= 0) {
    store.sql.exec("DELETE FROM schedule WHERE owner_email = ?", owner);
  } else {
    store.sql.exec(
      "INSERT OR REPLACE INTO schedule (owner_email, next_due_at) VALUES (?, ?)",
      owner,
      Math.floor(nextDueAt),
    );
  }
  return json({ ok: true });
}

/** Legacy-global-only: owners due now or within the window, soonest first. */
export async function handleScheduleDue(store: ChatStoreRouteContext, request: Request): Promise<Response> {
  let body: { windowMs?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  const windowMs = Math.min(600_000, Math.max(0, asNum(body.windowMs, 0)));
  const rows = store.sql
    .exec<{ owner_email: string; next_due_at: number }>(
      "SELECT owner_email, next_due_at FROM schedule WHERE next_due_at <= ? ORDER BY next_due_at LIMIT 30",
      Date.now() + windowMs,
    )
    .toArray();
  return json({ due: rows.map((row) => ({ owner: row.owner_email, at: row.next_due_at })) });
}

/**
 * Legacy-global-only: replace one owner's webhook registry rows (token →
 * shard routing for the public /hooks/<token> route). First-claim-wins on
 * token collisions: a row owned by another account is never overwritten,
 * so a synced profile cannot hijack someone else's delivery URL.
 */
export async function handleHooksSet(store: ChatStoreRouteContext, request: Request): Promise<Response> {
  let body: { owner?: unknown; hooks?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const owner = asStr(body.owner).trim().toLowerCase();
  if (!owner) {
    return json({ error: "invalid_owner" }, 400);
  }
  store.sql.exec("DELETE FROM hooks WHERE owner_email = ?", owner);
  const list = Array.isArray(body.hooks) ? body.hooks.slice(0, HOOKS_INDEX_CAP) : [];
  for (const item of list) {
    if (!isRecord(item)) {
      continue;
    }
    const token = asStr(item.t);
    const automationId = asStr(item.a);
    if (!HOOK_TOKEN_PATTERN.test(token) || !isValidId(automationId)) {
      continue;
    }
    const existing = store.sql
      .exec<{ owner_email: string }>("SELECT owner_email FROM hooks WHERE token = ?", token)
      .toArray()[0];
    if (existing && existing.owner_email !== owner) {
      console.error("hooks set: token collision — keeping the first claim");
      continue;
    }
    store.sql.exec(
      "INSERT OR REPLACE INTO hooks (token, owner_email, automation_id) VALUES (?, ?, ?)",
      token,
      owner,
      automationId,
    );
  }
  return json({ ok: true });
}

/** Legacy-global-only: token → owner + automation for the public hook route. */
export async function handleHooksResolve(store: ChatStoreRouteContext, request: Request): Promise<Response> {
  let body: { token?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const token = asStr(body.token);
  if (!HOOK_TOKEN_PATTERN.test(token)) {
    return json({ error: "unknown_hook" }, 404);
  }
  const row = store.sql
    .exec<{ owner_email: string; automation_id: string }>(
      "SELECT owner_email, automation_id FROM hooks WHERE token = ?",
      token,
    )
    .toArray()[0];
  if (!row) {
    return json({ error: "unknown_hook" }, 404);
  }
  return json({ owner: row.owner_email, automationId: row.automation_id });
}
