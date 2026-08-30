import { authedFetch } from "@/lib/backend";
import { newId } from "@/lib/env";

/**
 * Error journal: API failures, run crashes, and uncaught exceptions.
 * Entries live in an in-memory session mirror for instant UI and sync to
 * the account's cloud journal — the same per-account database that stores
 * chats — so the journal follows the account across devices. Nothing is
 * written to localStorage.
 */
export type DiagnosticEntry = {
  id: string;
  at: number;
  /** Where it happened: api | chat | app | promise | mcp | sync … */
  scope: string;
  message: string;
  /** Response body / stack excerpt for the expandable row. */
  detail?: string;
};

const MAX_ENTRIES = 200;
const MESSAGE_CHARS = 300;
const DETAIL_CHARS = 1_200;
/** Identical consecutive errors within this window collapse into one row. */
const COLLAPSE_MS = 8_000;
/** Upload queue caps; the oldest pending entries drop first when exceeded. */
const PENDING_LIMIT = 80;
const BATCH_LIMIT = 40;
const FLUSH_DELAY_MS = 2_500;

/** Browser noise that is not actionable for anyone. */
const IGNORED_PATTERNS = ["ResizeObserver loop", "Script error."];

/** Keys from the retired localStorage journal — wiped once on boot. */
const LEGACY_KEYS = ["gera.diagnostics.v1", "gera.diagnostics-seen.v1"];

let entries: DiagnosticEntry[] = [];
let seenAt = 0;
let pending: DiagnosticEntry[] = [];
let flushTimer: number | null = null;
let pulling = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Newest first. The array reference is stable until the journal changes. */
export function listDiagnostics(): DiagnosticEntry[] {
  return entries;
}

export function unseenDiagnosticsCount(): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.at > seenAt) {
      count += 1;
    }
  }
  return count;
}

/**
 * Fire-and-forget POST to the journal API. Failures are silent by design —
 * journaling the journal's own errors would recurse.
 */
function post(path: string, payload: unknown): void {
  void authedFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => undefined);
}

export function markDiagnosticsSeen(): void {
  if (unseenDiagnosticsCount() === 0) {
    return; // No-op keeps subscribers quiet and render loops impossible.
  }
  seenAt = Date.now();
  notify();
  post("/diag/seen", { at: seenAt });
}

/** Clears the cloud journal for the whole account (every device). */
export function clearDiagnostics(): void {
  pending = [];
  seenAt = Date.now();
  if (entries.length > 0) {
    entries = [];
    notify();
  }
  post("/diag/clear", {});
}

function scheduleFlush(): void {
  if (typeof window === "undefined" || flushTimer !== null || pending.length === 0) {
    return;
  }
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushPending();
  }, FLUSH_DELAY_MS);
}

/**
 * Uploads queued entries. Network/server failures re-queue and wait for the
 * next trigger (new error, journal pull, dialog open) — no retry storms.
 */
async function flushPending(): Promise<void> {
  if (pending.length === 0) {
    return;
  }
  const batch = pending.slice(0, BATCH_LIMIT);
  pending = pending.slice(batch.length);
  let ok = false;
  let dropped = false;
  try {
    const response = await authedFetch("/diag/append", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: batch }),
    });
    ok = response.ok;
    // Signed out / not invited: keep the session-only journal, stop pushing.
    dropped = response.status === 401 || response.status === 403;
  } catch {
    ok = false;
  }
  if (!ok && !dropped) {
    pending = [...batch, ...pending].slice(0, PENDING_LIMIT);
    return;
  }
  if (pending.length > 0) {
    scheduleFlush();
  }
}

function isEntry(item: unknown): item is DiagnosticEntry {
  if (typeof item !== "object" || item === null) {
    return false;
  }
  const entry = item as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.at === "number" &&
    typeof entry.scope === "string" &&
    typeof entry.message === "string" &&
    (entry.detail === undefined || typeof entry.detail === "string")
  );
}

/**
 * Pulls the account journal and merges it into the session mirror (the badge
 * then also covers errors recorded on other devices), then pushes anything
 * still queued. Called from the account menu mount and on dialog open.
 */
export async function syncDiagnostics(): Promise<void> {
  if (pulling) {
    return;
  }
  pulling = true;
  try {
    const response = await authedFetch("/diag/list");
    if (response.ok) {
      const data = (await response.json()) as { entries?: unknown; seenAt?: unknown };
      const server = Array.isArray(data.entries) ? data.entries.filter(isEntry) : [];
      const merged = new Map<string, DiagnosticEntry>();
      for (const entry of [...entries, ...server]) {
        merged.set(entry.id, entry);
      }
      const next = [...merged.values()].sort((a, b) => b.at - a.at).slice(0, MAX_ENTRIES);
      const serverSeen = typeof data.seenAt === "number" ? data.seenAt : 0;
      const seenChanged = serverSeen > seenAt;
      if (seenChanged) {
        seenAt = serverSeen;
      }
      const listChanged =
        next.length !== entries.length || next.some((entry, index) => entries[index]?.id !== entry.id);
      if (listChanged) {
        entries = next;
      }
      if (listChanged || seenChanged) {
        notify();
      }
    }
  } catch {
    // Offline or signed out — the session mirror keeps working.
  } finally {
    pulling = false;
  }
  void flushPending();
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error).slice(0, MESSAGE_CHARS);
  } catch {
    return String(error);
  }
}

/**
 * Records one error. User-initiated aborts (Stop button) and known browser
 * noise are skipped; identical bursts collapse into the latest row.
 */
export function logDiagnostic(scope: string, error: unknown, detail?: string): void {
  if (error instanceof DOMException && error.name === "AbortError") {
    return;
  }
  const message = messageOf(error).trim().slice(0, MESSAGE_CHARS);
  if (!message || IGNORED_PATTERNS.some((pattern) => message.includes(pattern))) {
    return;
  }
  const last = entries[0];
  if (last && last.scope === scope && last.message === message && Date.now() - last.at < COLLAPSE_MS) {
    return;
  }
  const stack = error instanceof Error && error.stack ? error.stack : undefined;
  const entry: DiagnosticEntry = {
    id: newId(),
    at: Date.now(),
    scope,
    message,
    detail: (detail ?? stack)?.slice(0, DETAIL_CHARS),
  };
  entries = [entry, ...entries].slice(0, MAX_ENTRIES);
  pending = [...pending, entry].slice(-PENDING_LIMIT);
  notify();
  scheduleFlush();
}

let installed = false;

/** Hooks window-level error events once per session. */
export function installGlobalDiagnostics(): void {
  if (installed || typeof window === "undefined") {
    return;
  }
  installed = true;
  try {
    for (const key of LEGACY_KEYS) {
      localStorage.removeItem(key);
    }
  } catch {
    // Storage unavailable — nothing to clean up.
  }
  window.addEventListener("error", (event) => {
    logDiagnostic(
      "app",
      event.error ?? event.message,
      event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
    );
  });
  window.addEventListener("unhandledrejection", (event) => {
    logDiagnostic("promise", event.reason);
  });
}
