/**
 * Publish-safe recovery: a page reload (app update mid-run) must lose
 * nothing. These cover the pure pieces — the pending→interrupted heal on
 * load and the follow-up queue's storage round-trip.
 */

import { describe, expect, it } from "vitest";

import { normalizeStoredQueue, reviveMessage, slimQueuedForStorage } from "@/lib/history";
import type { ChatMessage, QueuedMessage } from "@/lib/types";

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: "m1",
  role: "assistant",
  content: "partial answer",
  createdAt: 1,
  ...over,
});

describe("reviveMessage publish recovery", () => {
  it("flips a pending run into an honest interrupted marker", () => {
    const out = reviveMessage(msg({ pending: true }));
    expect(out.interrupted).toBe(true);
    expect(out.pending).toBeUndefined();
    expect(out.content).toBe("partial answer");
  });

  it("keeps delivered media turns as complete", () => {
    const out = reviveMessage(msg({ pending: true, content: "", images: ["idb:a"] }));
    expect(out.interrupted).toBeUndefined();
    expect(out.pending).toBeUndefined();
  });

  it("leaves settled messages untouched", () => {
    const message = msg({});
    expect(reviveMessage(message)).toBe(message);
  });

  it("heals a pending run together with its running research trail", () => {
    const out = reviveMessage(
      msg({
        pending: true,
        research: { status: "running", steps: [], sources: [], startedAt: 1 },
      }),
    );
    expect(out.interrupted).toBe(true);
    expect(out.research?.status).toBe("error");
  });
});

const queuedItem = (over: Partial<QueuedMessage>): QueuedMessage => ({
  id: "q1",
  text: "follow-up",
  attachments: [],
  mode: "chat",
  deepResearch: false,
  julius: false,
  createdAt: 1,
  ...over,
});

describe("follow-up queue persistence", () => {
  it("round-trips a queue and strips the dead steer flag", () => {
    const stored = slimQueuedForStorage({ c1: [queuedItem({ steer: true })] });
    const restored = normalizeStoredQueue(JSON.parse(JSON.stringify(stored)) as unknown);
    expect(restored.c1).toHaveLength(1);
    expect(restored.c1[0].text).toBe("follow-up");
    expect(restored.c1[0].steer).toBeUndefined();
  });

  it("keeps vault refs and text attachments, drops raw base64 without text", () => {
    const slimmed = slimQueuedForStorage({
      c1: [
        queuedItem({
          attachments: [
            { id: "a1", name: "pic.png", mime: "image/png", dataUrl: "idb:abc" },
            {
              id: "a2",
              name: "notes.txt",
              mime: "text/plain",
              dataUrl: "data:text/plain;base64,eA==",
              text: "hello",
            },
            { id: "a3", name: "raw.png", mime: "image/png", dataUrl: "data:image/png;base64,xxxx" },
          ],
        }),
      ],
    });
    const files = slimmed.c1[0].attachments;
    expect(files.map((file) => file.id)).toEqual(["a1", "a2"]);
    expect(files[1].dataUrl).toBe("");
  });

  it("drops junk and unrestorable entries on load", () => {
    const restored = normalizeStoredQueue({
      c1: [{ text: "" }, { nope: true }, 42],
      c2: "junk",
      c3: [{ text: "ok", attachments: [{ name: "x", dataUrl: "" }] }],
    });
    expect(restored.c1).toBeUndefined();
    expect(restored.c2).toBeUndefined();
    expect(restored.c3?.[0].attachments).toEqual([]);
    expect(restored.c3?.[0].mode).toBe("chat");
  });

  it("survives non-object input", () => {
    expect(normalizeStoredQueue(null)).toEqual({});
    expect(normalizeStoredQueue([1, 2])).toEqual({});
    expect(normalizeStoredQueue("x")).toEqual({});
  });
});
