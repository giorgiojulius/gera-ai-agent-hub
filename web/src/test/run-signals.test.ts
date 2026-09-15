// Cross-tab run signals: a run started in one tab is announced through
// localStorage; siblings subscribe to the storage event, ignore their own
// echoes, and a same-tab nudge arrives without a storage round-trip.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  announceRunStarted,
  parseRunSignal,
  requestLocalRunReconcile,
  RUN_SIGNAL_KEY,
  runSignalTabId,
  subscribeRunSignals,
  type RunSignalNotice,
} from "@/lib/run-signals";

type Listener = (event: Event) => void;

/** Minimal window: storage + a real event target, so StorageEvent/CustomEvent dispatch works. */
function makeWindow(): { storage: Storage; window: EventTarget & { localStorage: Storage } } {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  } as Storage;
  const listeners = new Map<string, Set<Listener>>();
  const target = {
    localStorage: storage,
    addEventListener: (type: string, listener: Listener) => {
      const set = listeners.get(type) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (event: Event) => {
      for (const listener of listeners.get(event.type) ?? []) {
        listener(event);
      }
      return true;
    },
  } as unknown as EventTarget & { localStorage: Storage };
  return { storage, window: target };
}

/** Node has no StorageEvent — a plain Event carrying the two fields the code reads. */
function storageEvent(key: string, newValue: string): Event {
  return Object.assign(new Event("storage"), { key, newValue });
}

let storage: Storage;
beforeEach(() => {
  const made = makeWindow();
  storage = made.storage;
  vi.stubGlobal("localStorage", made.storage);
  vi.stubGlobal("window", made.window);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("run signals", () => {
  it("announces a run start with this tab's identity", () => {
    announceRunStarted("chat-1");
    const signal = parseRunSignal(storage.getItem(RUN_SIGNAL_KEY));
    expect(signal?.conversationId).toBe("chat-1");
    expect(signal?.tab).toBe(runSignalTabId());
    expect(typeof signal?.at).toBe("number");
  });

  it("rejects malformed values", () => {
    expect(parseRunSignal(null)).toBeNull();
    expect(parseRunSignal("not json")).toBeNull();
    expect(parseRunSignal(JSON.stringify({ conversationId: 1, at: 2, tab: "x" }))).toBeNull();
  });

  it("delivers sibling announcements and ignores its own echo", () => {
    const seen: RunSignalNotice[] = [];
    const stop = subscribeRunSignals((notice) => seen.push(notice));
    const fire = (value: object, key: string = RUN_SIGNAL_KEY) =>
      window.dispatchEvent(storageEvent(key, JSON.stringify(value)));
    fire({ conversationId: "from-other", at: 1, tab: "other-tab" });
    fire({ conversationId: "echo", at: 2, tab: runSignalTabId() });
    fire({ conversationId: "wrong-key", at: 3, tab: "other-tab" }, "gera.something.else");
    stop();
    fire({ conversationId: "after-unsubscribe", at: 4, tab: "other-tab" });
    expect(seen).toEqual([{ source: "sibling", conversationId: "from-other" }]);
  });

  it("relays a same-tab reconcile request with its thread", () => {
    const seen: RunSignalNotice[] = [];
    const stop = subscribeRunSignals((notice) => seen.push(notice));
    requestLocalRunReconcile("chat-9");
    requestLocalRunReconcile(null);
    stop();
    expect(seen).toEqual([
      { source: "local", conversationId: "chat-9" },
      { source: "local", conversationId: null },
    ]);
  });

  it("stays quiet when storage is unavailable", () => {
    storage.setItem = () => {
      throw new Error("quota");
    };
    expect(() => announceRunStarted("chat-1")).not.toThrow();
  });
});
