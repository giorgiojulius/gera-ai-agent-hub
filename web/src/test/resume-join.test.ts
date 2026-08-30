/**
 * Seamless reload recovery: the overlap-aware stitcher that splices a cut
 * reply with its continuation, and the boot plan that decides — before the
 * first render — which cut reply silently recovers (no chip, no toast).
 */

import { describe, expect, it } from "vitest";

import { RESUME_FRESH_MS, joinResumedText, planBootAutoResume } from "@/lib/resume";
import type { ChatMessage, Conversation } from "@/lib/types";

describe("joinResumedText", () => {
  it("dedupes the verbatim overlap the model repeats", () => {
    expect(joinResumedText("The capital of Fra", "of France is Paris.")).toBe(
      "The capital of France is Paris.",
    );
  });

  it("keeps the head unchanged while the stream is still inside the repeat", () => {
    expect(joinResumedText("The capital of Fra", "of Fra")).toBe("The capital of Fra");
  });

  it("stitches a mid-word cut", () => {
    expect(joinResumedText("The capital of Fra", "France is Paris.")).toBe(
      "The capital of France is Paris.",
    );
  });

  it("continues a cut sentence on the same line when there is no overlap", () => {
    expect(joinResumedText("The answer is", "42.")).toBe("The answer is 42.");
  });

  it("starts a new paragraph after a finished sentence", () => {
    expect(joinResumedText("Done.", "Next, deploy it.")).toBe("Done.\n\nNext, deploy it.");
  });

  it("puts block markdown on its own line", () => {
    expect(joinResumedText("The steps are", "- install\n- run")).toBe(
      "The steps are\n\n- install\n- run",
    );
  });

  it("strips the tail's leading blank lines before stitching", () => {
    expect(joinResumedText("first,", "\n\nand second")).toBe("first, and second");
  });

  it("handles empty sides", () => {
    expect(joinResumedText("kept", "")).toBe("kept");
    expect(joinResumedText("", "fresh")).toBe("fresh");
  });
});

const user: ChatMessage = { id: "u1", role: "user", content: "question", createdAt: 1 };

const cut = (over: Partial<ChatMessage>): ChatMessage => ({
  id: "a1",
  role: "assistant",
  content: "partial answer",
  interrupted: true,
  createdAt: 2,
  ...over,
});

const thread = (over: Partial<Conversation>): Conversation => ({
  id: "c1",
  title: "t",
  modelId: "spacexai/grok-4.6:xhigh",
  messages: [user, cut({})],
  createdAt: 1,
  updatedAt: 1_000,
  ...over,
});

/** 60s after updatedAt — well inside the freshness window. */
const now = 61_000;

describe("planBootAutoResume", () => {
  it("re-marks a fresh text partial as pending for a silent continue", () => {
    const plan = planBootAutoResume([thread({})], "c1", now);
    expect(plan.resume).toEqual({ kind: "continue", messageId: "a1" });
    const last = plan.conversations[0].messages[plan.conversations[0].messages.length - 1];
    expect(last.pending).toBe(true);
    expect(last.interrupted).toBeUndefined();
    expect(last.content).toBe("partial answer");
  });

  it("plans a retry when the cut happened before any text arrived", () => {
    const plan = planBootAutoResume(
      [thread({ messages: [user, cut({ content: "" })] })],
      "c1",
      now,
    );
    expect(plan.resume).toEqual({ kind: "retry", messageId: "a1" });
  });

  it("keeps the manual chip for stale interruptions", () => {
    const plan = planBootAutoResume([thread({})], "c1", 1_000 + RESUME_FRESH_MS);
    expect(plan.resume).toBeNull();
    expect(plan.conversations[0].messages[1].interrupted).toBe(true);
  });

  it("does not touch non-active threads", () => {
    const plan = planBootAutoResume([thread({})], "other", now);
    expect(plan.resume).toBeNull();
    expect(plan.conversations[0].messages[1].interrupted).toBe(true);
  });

  it("leaves julius panels to their own pick UI", () => {
    const julius = { decision: "manual", status: "choice" } as unknown as ChatMessage["julius"];
    const plan = planBootAutoResume([thread({ messages: [user, cut({ julius })] })], "c1", now);
    expect(plan.resume).toBeNull();
  });

  it("never auto-refires empty media or research turns", () => {
    const media = planBootAutoResume(
      [thread({ modelId: "openai/gpt-image-2", messages: [user, cut({ content: "" })] })],
      "c1",
      now,
    );
    expect(media.resume).toBeNull();
    const research = planBootAutoResume(
      [
        thread({
          messages: [
            user,
            cut({
              content: "",
              research: { status: "error", steps: [], sources: [], startedAt: 1 },
            }),
          ],
        }),
      ],
      "c1",
      now,
    );
    expect(research.resume).toBeNull();
  });
});
