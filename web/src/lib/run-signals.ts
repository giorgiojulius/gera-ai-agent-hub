// Cross-tab run signals. One account may have Gera open in several tabs (or
// windows); every run executes on the server, so a thread started in tab A is
// just as live for tab B — but tab B only learned about it when the finished
// reply arrived via sync, and a message sent there meanwhile bounced off as
// "another reply is running". Tabs now announce run starts through a
// localStorage key (the `storage` event fans out to every other tab of the
// same origin for free) and siblings attach to the live stream at once.
//
// Nothing here carries content: the key holds a conversation id, a timestamp
// and the announcing tab's random id (so a tab ignores its own echoes).

const SIGNAL_KEY = "gera.run-signal.v1";
/** Same-tab nudge (a 409 "run_active" this tab just hit) — no storage round-trip. */
const LOCAL_EVENT = "gera:runs-changed";

export type RunSignal = {
  conversationId: string;
  at: number;
  tab: string;
};

/** Why a reconcile was requested — the handler treats the two differently. */
export type RunSignalSource = "sibling" | "local";

export type RunSignalNotice = {
  source: RunSignalSource;
  /** Thread the signal is about; null when the request is a blanket recheck. */
  conversationId: string | null;
};

let tabId = "";

/** Stable per-tab identity for the lifetime of this document. */
export function runSignalTabId(): string {
  if (!tabId) {
    tabId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  return tabId;
}

/** Parses a raw signal value; null for anything malformed. */
export function parseRunSignal(raw: string | null): RunSignal | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RunSignal>;
    if (
      typeof parsed.conversationId !== "string" ||
      typeof parsed.at !== "number" ||
      typeof parsed.tab !== "string"
    ) {
      return null;
    }
    return { conversationId: parsed.conversationId, at: parsed.at, tab: parsed.tab };
  } catch {
    return null;
  }
}

/**
 * Tells sibling tabs that a run just started in this thread. Fire-and-forget;
 * storage being unavailable only means the siblings catch up on their next
 * focus.
 */
export function announceRunStarted(conversationId: string): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    const signal: RunSignal = { conversationId, at: Date.now(), tab: runSignalTabId() };
    localStorage.setItem(SIGNAL_KEY, JSON.stringify(signal));
  } catch {
    // Quota / private mode — siblings reconcile on focus instead.
  }
}

/**
 * Asks THIS tab to reconcile live runs now — after the server answered
 * "run_active" for a thread this tab did not know was running.
 */
export function requestLocalRunReconcile(conversationId: string | null): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent<string | null>(LOCAL_EVENT, { detail: conversationId }));
}

/**
 * Subscribes to run signals from other tabs (storage) and from this tab
 * (local event).
 */
export function subscribeRunSignals(listener: (notice: RunSignalNotice) => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== SIGNAL_KEY) {
      return;
    }
    const signal = parseRunSignal(event.newValue);
    if (!signal || signal.tab === runSignalTabId()) {
      return;
    }
    listener({ source: "sibling", conversationId: signal.conversationId });
  };
  const onLocal = (event: Event): void => {
    const detail = (event as CustomEvent<string | null>).detail;
    listener({ source: "local", conversationId: typeof detail === "string" ? detail : null });
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(LOCAL_EVENT, onLocal);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(LOCAL_EVENT, onLocal);
  };
}

export const RUN_SIGNAL_KEY = SIGNAL_KEY;
