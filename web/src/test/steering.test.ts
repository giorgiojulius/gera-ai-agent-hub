import { describe, expect, it } from "vitest";

import {
  drainSteering,
  isSteerableRun,
  moveQueuedItem,
  offerSteering,
  registerSteerableRun,
  retractSteering,
  stripSteerFlags,
  syncSteeringOrder,
  unregisterSteerableRun,
  watchSteering,
} from "@/lib/steering";
import type { QueuedMessage } from "@/lib/types";

function makeItem(id: string, text = "follow-up"): QueuedMessage {
  return {
    id,
    text,
    attachments: [],
    mode: "chat",
    deepResearch: false,
    julius: false,
    createdAt: 0,
  };
}

describe("steering registry", () => {
  it("rejects offers when no run is registered — falls back to the queue", () => {
    expect(offerSteering("no-run", makeItem("a"))).toBe(false);
    expect(drainSteering("no-run")).toEqual([]);
    expect(isSteerableRun("no-run")).toBe(false);
    expect(isSteerableRun(null)).toBe(false);
  });

  it("accepts offers into a live run and drains them in send order", () => {
    registerSteerableRun("run-1");
    expect(isSteerableRun("run-1")).toBe(true);
    expect(offerSteering("run-1", makeItem("a"))).toBe(true);
    expect(offerSteering("run-1", makeItem("b"))).toBe(true);
    expect(drainSteering("run-1").map((item) => item.id)).toEqual(["a", "b"]);
    // The inbox is emptied by the drain but stays open for later offers.
    expect(drainSteering("run-1")).toEqual([]);
    unregisterSteerableRun("run-1");
  });

  it("keeps accepting between step boundaries until the run settles", () => {
    registerSteerableRun("run-2");
    drainSteering("run-2");
    expect(offerSteering("run-2", makeItem("late"))).toBe(true);
    expect(drainSteering("run-2").map((item) => item.id)).toEqual(["late"]);
    unregisterSteerableRun("run-2");
    expect(offerSteering("run-2", makeItem("after-settle"))).toBe(false);
    expect(isSteerableRun("run-2")).toBe(false);
  });

  it("retracts a pending item when the user removes the chip", () => {
    registerSteerableRun("run-3");
    offerSteering("run-3", makeItem("keep"));
    offerSteering("run-3", makeItem("drop"));
    retractSteering("run-3", "drop");
    expect(drainSteering("run-3").map((item) => item.id)).toEqual(["keep"]);
    // Retracting something unknown is a no-op, not an error.
    retractSteering("run-3", "ghost");
    retractSteering("other", "ghost");
    unregisterSteerableRun("run-3");
  });

  it("registration is idempotent and never drops already-offered items", () => {
    registerSteerableRun("run-4");
    offerSteering("run-4", makeItem("x"));
    registerSteerableRun("run-4");
    expect(drainSteering("run-4").map((item) => item.id)).toEqual(["x"]);
    unregisterSteerableRun("run-4");
  });

  it("returns unconsumed items on unregister so stale steer flags can be cleared", () => {
    registerSteerableRun("run-5");
    offerSteering("run-5", makeItem("consumed"));
    drainSteering("run-5");
    offerSteering("run-5", makeItem("late-1"));
    offerSteering("run-5", makeItem("late-2"));
    // The run settles before the next boundary — both fall back to the queue.
    expect(unregisterSteerableRun("run-5").map((item) => item.id)).toEqual(["late-1", "late-2"]);
    // Closing an already-closed inbox reports nothing left behind.
    expect(unregisterSteerableRun("run-5")).toEqual([]);
  });

  it("keeps inboxes per conversation — parallel threads never cross", () => {
    registerSteerableRun("thread-a");
    registerSteerableRun("thread-b");
    offerSteering("thread-a", makeItem("for-a"));
    offerSteering("thread-b", makeItem("for-b"));
    expect(drainSteering("thread-a").map((item) => item.id)).toEqual(["for-a"]);
    expect(drainSteering("thread-b").map((item) => item.id)).toEqual(["for-b"]);
    unregisterSteerableRun("thread-a");
    unregisterSteerableRun("thread-b");
  });

  it("pings the watcher the moment an offer lands, and stops after unsubscribe", () => {
    registerSteerableRun("run-w");
    let pings = 0;
    const unwatch = watchSteering("run-w", () => {
      pings += 1;
    });
    offerSteering("run-w", makeItem("a"));
    expect(pings).toBe(1);
    unwatch();
    offerSteering("run-w", makeItem("b"));
    expect(pings).toBe(1);
    unregisterSteerableRun("run-w");
  });

  it("a drain fired from inside the ping already sees the just-offered item", () => {
    registerSteerableRun("run-p");
    let seen: string[] = [];
    watchSteering("run-p", () => {
      seen = drainSteering("run-p").map((item) => item.id);
    });
    offerSteering("run-p", makeItem("now"));
    expect(seen).toEqual(["now"]);
    unregisterSteerableRun("run-p");
  });

  it("watching a non-steerable run is a safe no-op", () => {
    let pings = 0;
    const unwatch = watchSteering("ghost", () => {
      pings += 1;
    });
    unwatch();
    expect(pings).toBe(0);
  });

  it("unregister clears watchers so a later run never gets stale pings", () => {
    registerSteerableRun("run-s");
    let pings = 0;
    watchSteering("run-s", () => {
      pings += 1;
    });
    unregisterSteerableRun("run-s");
    registerSteerableRun("run-s");
    offerSteering("run-s", makeItem("late"));
    expect(pings).toBe(0);
    unregisterSteerableRun("run-s");
  });
});

describe("stripSteerFlags", () => {
  it("clears every stale ⚡ once the run settles — including server-accepted ones", () => {
    const list: QueuedMessage[] = [
      { ...makeItem("a"), steer: true },
      makeItem("b"),
      { ...makeItem("c"), steer: true },
    ];
    const stripped = stripSteerFlags(list);
    expect(stripped?.every((item) => item.steer === undefined)).toBe(true);
    // Order and items stay — only the flags come off.
    expect(stripped?.map((item) => item.id)).toEqual(["a", "b", "c"]);
    // The source list is never mutated — React state stays the owner.
    expect(list[0].steer).toBe(true);
  });

  it("returns null when nothing carries a flag so callers skip the write", () => {
    expect(stripSteerFlags([makeItem("a"), makeItem("b")])).toBeNull();
    expect(stripSteerFlags([])).toBeNull();
  });
});

describe("queue reordering", () => {
  it("moves the dragged item to the target's position — both directions, purely", () => {
    const list = [makeItem("a"), makeItem("b"), makeItem("c")];
    expect(moveQueuedItem(list, "a", "c")?.map((item) => item.id)).toEqual(["b", "c", "a"]);
    expect(moveQueuedItem(list, "c", "a")?.map((item) => item.id)).toEqual(["c", "a", "b"]);
    // The source list is never mutated — React state stays the owner.
    expect(list.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("returns null for unknown ids and no-op moves so callers skip the write", () => {
    const list = [makeItem("a"), makeItem("b")];
    expect(moveQueuedItem(list, "a", "a")).toBeNull();
    expect(moveQueuedItem(list, "ghost", "b")).toBeNull();
    expect(moveQueuedItem(list, "a", "ghost")).toBeNull();
    expect(moveQueuedItem([], "a", "b")).toBeNull();
  });

  it("re-ranks the live steering inbox to match the visible queue order", () => {
    registerSteerableRun("run-6");
    offerSteering("run-6", makeItem("first"));
    offerSteering("run-6", makeItem("second"));
    offerSteering("run-6", makeItem("third"));
    syncSteeringOrder("run-6", ["third", "first"]);
    // Known ids follow the given order; unknown ones sink to the end, stable.
    expect(drainSteering("run-6").map((item) => item.id)).toEqual(["third", "first", "second"]);
    unregisterSteerableRun("run-6");
  });

  it("sync is a no-op without an open inbox — plain queues need no sync", () => {
    expect(() => syncSteeringOrder("missing", ["x", "y"])).not.toThrow();
    registerSteerableRun("run-7");
    offerSteering("run-7", makeItem("solo"));
    // A single item can't be misordered — sync leaves it untouched.
    syncSteeringOrder("run-7", []);
    expect(drainSteering("run-7").map((item) => item.id)).toEqual(["solo"]);
    unregisterSteerableRun("run-7");
  });
});
