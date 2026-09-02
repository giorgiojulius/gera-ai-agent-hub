// Shared plumbing for the ChatStore Durable Object and its route modules —
// size caps, wire row types, and the small coercion helpers every handler
// leans on. Platform-neutral on purpose: the web app's unit tests import
// this module directly, so nothing Cloudflare-specific may appear here.

/** One chat's serialized payload cap — matches the client's slimming limit. */
export const CHAT_PAYLOAD_LIMIT = 900_000;
/** The settings+hub profile blob cap; the client slims MCP tool lists first. */
export const PROFILE_PAYLOAD_LIMIT = 900_000;
/** Server-rotated OAuth grants: `oauthref:<owner>:<serverId>` → { bases, token }. */
export const OAUTH_REF_PREFIX = "oauthref:";
export const TITLE_LIMIT = 160;
export const ID_LIMIT = 80;
/** Caps per request — the client loops with `more` until drained. */
export const HAVE_LIMIT = 1_000;
export const PUSH_LIMIT = 20;
export const DELETE_LIMIT = 200;
export const PULL_MAX_CHATS = 25;
export const PULL_BYTE_BUDGET = 2_600_000;
export const WANT_LIMIT = 40;
export const TOMBSTONES_LIMIT = 200;
export const MAX_CHATS_PER_OWNER = 500;
/** Tombstones older than this are GC'd — long enough for dormant devices. */
export const TOMBSTONE_TTL_MS = 1000 * 60 * 60 * 24 * 60;
/** Timestamps further in the future than this are clamped (broken clocks). */
export const FUTURE_SLACK_MS = 1000 * 60 * 60 * 24;
/** Per-account error-journal caps; only the newest rows survive the trim. */
export const DIAG_ROWS_LIMIT = 300;
export const DIAG_BATCH_LIMIT = 40;
export const DIAG_MESSAGE_LIMIT = 300;
/** Full route + context + cause chain + stack per row; the client mirrors this cap. */
export const DIAG_DETAIL_LIMIT = 4_000;
export const DIAG_SCOPE_LIMIT = 24;
export const DIAG_LIST_LIMIT = 200;
/** Trigger machinery: per-fire batch caps + run-now force flags. */
export const FIRE_MAX_JOBS = 2;
export const FIRE_BUDGET_MS = 240_000;
export const FORCE_RUN_PREFIX = "forceRun:";
/** Shard responses carry the next due instant for the schedule index. */
export const NEXT_DUE_HEADER = "X-Gera-Next-Due";
/** Shard responses mirror the webhook-token registry the same way. */
export const HOOKS_HEADER = "X-Gera-Hooks";
/** Export paging for the one-time shard migration. */
export const EXPORT_PAGE_CHATS = 12;
export const EXPORT_PAGE_BYTES = 2_500_000;

export type ChatMetaRow = { id: string; updated_at: number };
export type ChatRow = { id: string; title: string; updated_at: number; payload: string };
export type TombstoneRow = { id: string; deleted_at: number };

export type HaveEntry = { id: string; updatedAt: number };
export type PushEntry = { id: string; title: string; updatedAt: number; payload: string };
export type DeleteEntry = { id: string; deletedAt: number };

/** What a SQL row cell can hold — mirrors the platform's SqlStorageValue. */
export type SqlRowValue = ArrayBuffer | string | number | null;

/**
 * Structural view of the Durable Object's SQL storage. Route modules accept
 * this instead of the platform type so they stay platform-neutral (and
 * therefore importable from web unit tests); the real `storage.sql` object
 * satisfies it as-is.
 */
export type ChatSql = {
  exec<T extends Record<string, SqlRowValue>>(
    query: string,
    ...bindings: unknown[]
  ): { toArray(): T[] };
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asNum(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function capStr(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

export function readEmail(request: Request): string {
  const raw = request.headers.get("X-Gera-Email") ?? "";
  try {
    return decodeURIComponent(raw).trim().toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

export function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
  });
}

export function isValidId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= ID_LIMIT;
}

/** Coarse class of a failed call into a Durable Object — never the raw platform text. */
export type ShardFailureReason = "redeploy" | "overloaded" | "internal";

/**
 * Classifies why a call into an account shard threw instead of answering. A
 * Worker deploy resets every Durable Object and aborts the requests in flight
 * ("reset because its code was updated"); an overloaded object queues too
 * long; anything else is an internal fault. Only this coarse class leaves
 * the Worker — the platform's message stays in the server log — and none of
 * it says anything about the MCP server the shard was talking to.
 */
export function shardFailureReason(error: unknown): ShardFailureReason {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/code was updated|reset because/i.test(message)) {
    return "redeploy";
  }
  if (/overloaded|queued for too long|too many (?:requests|subrequests)/i.test(message)) {
    return "overloaded";
  }
  return "internal";
}

/**
 * True for the browser's internal "credential lives on the server" marker
 * (`gera-account:<serverId>`, optionally Bearer-prefixed). It is NOT a real
 * credential: if it is ever persisted as a manual token it shadows the actual
 * OAuth grant and every provider call fails — GitHub even escalates repeated
 * bad-credential attempts to HTTP 403. Fail closed: never store, never serve.
 */
export function isPlaceholderCredential(token: string): boolean {
  return /^(bearer\s+)?gera-account:/i.test(token.trim());
}
