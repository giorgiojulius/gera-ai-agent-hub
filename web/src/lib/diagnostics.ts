import { authedFetch, parseOrThrow, setBackendFailureObserver, type BackendFailure } from "@/lib/backend";
import {
  diagnosticContextOf,
  formatContextValue,
  redactSecrets,
  type DiagnosticContext,
} from "@/lib/diagnostic-context";
import { newId } from "@/lib/env";

/**
 * Error journal: API failures, run crashes, and uncaught exceptions.
 * Entries live in an in-memory session mirror for instant UI and sync to
 * the account's cloud journal — the same per-account database that stores
 * chats — so the journal follows the account across devices. Nothing is
 * written to localStorage.
 *
 * Every row carries the FULL picture: the route that failed (method, path,
 * status, telling response headers, redacted body), the structured context
 * the thrower attached (server id, error code, per-id auth diagnostics), the
 * error's cause chain, and the stack. Credentials are scrubbed before any of
 * it is stored — the journal is metadata, never token material.
 */
export type DiagnosticEntry = {
  id: string;
  at: number;
  /** Where it happened: api | chat | app | promise | mcp | sync … */
  scope: string;
  message: string;
  /** Route, context, cause chain and stack for the expandable row. */
  detail?: string;
};

const MAX_ENTRIES = 200;
const MESSAGE_CHARS = 300;
/** Mirrors the server's DIAG_DETAIL_LIMIT; longer text is cut server-side anyway. */
const DETAIL_CHARS = 4_000;
/** Identical consecutive errors within this window collapse into one row. */
const COLLAPSE_MS = 8_000;
/** Upload queue caps; the oldest pending entries drop first when exceeded. */
const PENDING_LIMIT = 80;
/** 20 × (4 000 + 300 + JSON overhead) stays well under the relay's 256 KB append body cap. */
const BATCH_LIMIT = 20;
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

/** Test-only: empties the in-memory journal and cancels a pending upload. */
export function resetDiagnosticsForTests(): void {
  entries = [];
  seenAt = 0;
  pending = [];
  pulling = false;
  if (flushTimer !== null) {
    if (typeof window !== "undefined") {
      window.clearTimeout(flushTimer);
    }
    flushTimer = null;
  }
}

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

/** Scope of MCP policy decisions (confirmed / declined / blocked tool calls) — an audit trail, not errors. */
export const MCP_POLICY_SCOPE = "mcp-policy";

export function unseenDiagnosticsCount(): number {
  let count = 0;
  for (const entry of entries) {
    // Policy rows are records of the user's own decisions; they never light the badge.
    if (entry.at > seenAt && entry.scope !== MCP_POLICY_SCOPE) {
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
  if (
    typeof window === "undefined" ||
    typeof window.setTimeout !== "function" ||
    flushTimer !== null ||
    pending.length === 0
  ) {
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

/** Counts only — how many stored credential values are sealed, under the current key, or still plaintext. */
export type VaultTally = { total: number; sealed: number; current: number; plaintext: number };

/**
 * The account's secret-free view of its credential vault: whether the server
 * key is active, whether this account's storage has been swept under it, and
 * per-table sealed-row counts. Never a value, a key, or a key id.
 */
export type VaultStatus = {
  /** "enabled", or the coarse reason the server key is unusable. */
  vault: string;
  swept: boolean;
  rows: Record<string, VaultTally>;
  /** Which subject the scopes are bound to: the Rork Auth account, or (pre-migration) the storage owner. */
  scope?: "account" | "owner";
  /** Credential values the account-scope sweep could not open — reconnect those servers. */
  unreadable?: number;
};

function isTally(value: unknown): value is VaultTally {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const tally = value as Record<string, unknown>;
  return ["total", "sealed", "current", "plaintext"].every((key) => typeof tally[key] === "number");
}

export async function fetchVaultStatus(): Promise<VaultStatus> {
  const response = await authedFetch("/diag/vault");
  const data = await parseOrThrow<{ vault?: unknown; swept?: unknown; rows?: unknown; scope?: unknown; unreadable?: unknown }>(
    response,
    "Could not check the credential vault",
  );
  const rows: Record<string, VaultTally> = {};
  if (typeof data.rows === "object" && data.rows !== null) {
    for (const [name, tally] of Object.entries(data.rows as Record<string, unknown>)) {
      if (isTally(tally)) {
        rows[name] = tally;
      }
    }
  }
  return {
    vault: typeof data.vault === "string" && data.vault ? data.vault : "unknown",
    swept: data.swept === true,
    rows,
    ...(data.scope === "account" || data.scope === "owner" ? { scope: data.scope } : {}),
    ...(typeof data.unreadable === "number" && data.unreadable > 0 ? { unreadable: data.unreadable } : {}),
  };
}

/** Sums the per-table tallies into one line's worth of numbers. */
export function summarizeVault(status: VaultStatus): VaultTally {
  const sum: VaultTally = { total: 0, sealed: 0, current: 0, plaintext: 0 };
  for (const tally of Object.values(status.rows)) {
    sum.total += tally.total;
    sum.sealed += tally.sealed;
    sum.current += tally.current;
    sum.plaintext += tally.plaintext;
  }
  return sum;
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

function contextLines(context: DiagnosticContext | null | undefined): string[] {
  if (!context) {
    return [];
  }
  return Object.entries(context)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${formatContextValue(value)}`);
}

/** `error.cause` without assuming an ES2022 lib target. */
function causeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as { cause?: unknown }).cause : undefined;
}

/** Cause chain (error.cause, nested) as "caused by" lines; bounded so a cycle cannot spin. */
function causeLines(error: unknown): string[] {
  const lines: string[] = [];
  let current: unknown = error instanceof Error ? causeOf(error) : undefined;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      lines.push(`caused by: ${current.name}: ${current.message}`);
      for (const line of contextLines(diagnosticContextOf(current))) {
        lines.push(`  ${line}`);
      }
      current = causeOf(current);
    } else {
      lines.push(`caused by: ${formatContextValue(current)}`);
      break;
    }
  }
  return lines;
}

/**
 * Everything the journal can honestly say about one error: its class, the
 * structured context attached at the throw site, the cause chain, and the
 * stack. Pure text, already redacted, not yet truncated.
 */
export function describeError(error: unknown, extra?: string | DiagnosticContext): string {
  const sections: string[] = [];
  if (typeof extra === "string") {
    if (extra.trim()) {
      sections.push(extra.trim());
    }
  } else if (extra) {
    sections.push(...contextLines(extra));
  }
  if (error instanceof Error && error.name && error.name !== "Error") {
    sections.push(`type: ${error.name}`);
  }
  sections.push(...contextLines(diagnosticContextOf(error)));
  sections.push(...causeLines(error));
  if (error instanceof Error && error.stack) {
    const stack = error.stack.startsWith(`${error.name}: ${error.message}`)
      ? error.stack.slice(`${error.name}: ${error.message}`.length).replace(/^\n/, "")
      : error.stack;
    if (stack.trim()) {
      sections.push(`stack:\n${stack}`);
    }
  } else if (error !== null && typeof error === "object" && !(error instanceof Error)) {
    try {
      sections.push(`value: ${JSON.stringify(error)}`);
    } catch {
      // Unserializable thrown object; the message already carries String(error).
    }
  }
  return redactSecrets(sections.join("\n"));
}

/**
 * Records one error. User-initiated aborts (Stop button) and known browser
 * noise are skipped; identical bursts (same scope, message AND detail)
 * collapse into the latest row. `detail` may be free text or a context map
 * (route, ids, codes) — either way the error's own context, cause chain and
 * stack are appended so the row is complete on its own.
 */
export function logDiagnostic(scope: string, error: unknown, detail?: string | DiagnosticContext): void {
  if (error instanceof DOMException && error.name === "AbortError") {
    return;
  }
  const message = redactSecrets(messageOf(error).trim()).slice(0, MESSAGE_CHARS);
  if (!message || IGNORED_PATTERNS.some((pattern) => message.includes(pattern))) {
    return;
  }
  const fullDetail = describeError(error, detail);
  const entryDetail = fullDetail ? fullDetail.slice(0, DETAIL_CHARS) : undefined;
  const last = entries[0];
  if (
    last &&
    last.scope === scope &&
    last.message === message &&
    (last.detail ?? "") === (entryDetail ?? "") &&
    Date.now() - last.at < COLLAPSE_MS
  ) {
    return;
  }
  const entry: DiagnosticEntry = {
    id: newId(),
    at: Date.now(),
    scope,
    message,
    detail: entryDetail,
  };
  entries = [entry, ...entries].slice(0, MAX_ENTRIES);
  pending = [...pending, entry].slice(-PENDING_LIMIT);
  notify();
  try {
    scheduleFlush();
  } catch {
    // A missing timer in tests or odd runtimes must never hide the journal row.
  }
}

/** Path without its query string — the row headline stays short and comparable. */
function pathnameOf(path: string): string {
  const arrow = path.indexOf(" → ");
  const own = arrow >= 0 ? path.slice(0, arrow) : path;
  const query = own.indexOf("?");
  return query >= 0 ? own.slice(0, query) : own;
}

/**
 * Journal sink for every failed backend round-trip (installed into the
 * backend client below). One row per failure: `HTTP <status> · <METHOD> <path>`
 * with the full route, telling headers, the redacted body and what was asked.
 */
export function recordBackendFailure(failure: BackendFailure): void {
  const headline =
    failure.status === null
      ? `network · ${failure.method} ${pathnameOf(failure.path)}`
      : `HTTP ${failure.status} · ${failure.method} ${pathnameOf(failure.path)}`;
  const context: DiagnosticContext = {
    route: `${failure.method} ${failure.path}`,
    status: failure.status ?? "no response",
    durationMs: failure.durationMs,
    ...(failure.request ? { request: failure.request } : {}),
    ...(Object.keys(failure.headers).length > 0 ? { headers: failure.headers } : {}),
    ...(failure.body ? { body: failure.body } : {}),
  };
  if (failure.status === null && failure.error !== undefined) {
    const reason = failure.error instanceof Error ? failure.error : new Error(messageOf(failure.error));
    logDiagnostic("api", withMessage(reason, headline), context);
    return;
  }
  logDiagnostic("api", headline, context);
}

/** Keeps the network error's stack/cause but headlines the row with the route. */
function withMessage(error: Error, headline: string): Error {
  const wrapped = new Error(`${headline} · ${error.message}`);
  (wrapped as { cause?: unknown }).cause = error;
  wrapped.name = error.name === "Error" ? "NetworkError" : error.name;
  wrapped.stack = error.stack;
  return wrapped;
}

setBackendFailureObserver(recordBackendFailure);

/**
 * Which build this browser is running — the hashed main bundle name. Lets a
 * report prove whether a fix has actually reached the tab (stale bundles
 * reproduce fixed bugs and look identical otherwise).
 */
export function bundleLabel(): string {
  if (typeof document === "undefined") {
    return "unknown";
  }
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  const src = script?.getAttribute("src") ?? "";
  const name = src.split("/").pop() ?? "";
  return name || (import.meta.env.DEV ? "dev server" : "unknown");
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
    logDiagnostic("app", event.error ?? event.message, {
      ...(event.filename ? { source: `${event.filename}:${event.lineno}:${event.colno}` } : {}),
      page: redactSecrets(window.location.pathname + window.location.search),
      bundle: bundleLabel(),
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    logDiagnostic("promise", event.reason, {
      page: redactSecrets(window.location.pathname + window.location.search),
      bundle: bundleLabel(),
    });
  });
}
