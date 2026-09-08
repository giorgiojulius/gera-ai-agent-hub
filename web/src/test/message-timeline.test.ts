import { describe, expect, it } from "vitest";

import { rebaseToolOffset } from "../../../functions/run-protocol";
import { buildMessageTimeline, summarizeToolLabels, TOOL_GROUP_COLLAPSE_AT } from "@/lib/message-timeline";
import type { ToolCallRecord } from "@/lib/types";

function call(id: string, textOffset?: number, extra: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return { id, name: `tool_${id}`, arguments: "{}", status: "done", ...(textOffset === undefined ? {} : { textOffset }), ...extra };
}

describe("buildMessageTimeline", () => {
  it("interleaves prose and tool batches in the order they happened", () => {
    const content = "Step one.\n\nStep two.\n\nDone.";
    const timeline = buildMessageTimeline(content, [
      call("a", "Step one.".length),
      call("b", "Step one.".length),
      call("c", "Step one.\n\nStep two.".length),
    ]);
    expect(timeline).toEqual([
      { kind: "text", id: "text:0", text: "Step one." },
      { kind: "tools", id: "tools:a", calls: [call("a", 9), call("b", 9)] },
      { kind: "text", id: "text:9", text: "Step two." },
      { kind: "tools", id: "tools:c", calls: [call("c", 20)] },
      { kind: "text", id: "text:20", text: "Done." },
    ]);
  });

  it("puts legacy records without offsets before the text — the old layout", () => {
    const timeline = buildMessageTimeline("Final answer.", [call("a"), call("b")]);
    expect(timeline.map((segment) => segment.kind)).toEqual(["tools", "text"]);
    expect(timeline[1]).toEqual({ kind: "text", id: "text:0", text: "Final answer." });
  });

  it("sorts stably by offset so a resumed run's merged history stays chronological", () => {
    const timeline = buildMessageTimeline("AB", [call("late", 2), call("fail"), call("early", 1), call("early2", 1)]);
    expect(timeline.map((segment) => (segment.kind === "tools" ? segment.calls.map((item) => item.id) : segment.text))).toEqual([
      ["fail"],
      "A",
      ["early", "early2"],
      "B",
      ["late"],
    ]);
  });

  it("clamps offsets beyond a truncated content and drops blank slices", () => {
    const timeline = buildMessageTimeline("Kept text", [call("a", 500), call("b", -4)]);
    expect(timeline).toEqual([
      { kind: "tools", id: "tools:b", calls: [call("b", -4)] },
      { kind: "text", id: "text:0", text: "Kept text" },
      { kind: "tools", id: "tools:a", calls: [call("a", 500)] },
    ]);
    expect(buildMessageTimeline("   ", [])).toEqual([]);
    expect(buildMessageTimeline("", [call("a", 0)])).toEqual([{ kind: "tools", id: "tools:a", calls: [call("a", 0)] }]);
  });

  it("streams: the trailing slice grows while earlier batches keep their place", () => {
    const calls = [call("a", 6)];
    expect(buildMessageTimeline("Hello.", calls)).toEqual([
      { kind: "text", id: "text:0", text: "Hello." },
      { kind: "tools", id: "tools:a", calls },
    ]);
    expect(buildMessageTimeline("Hello.\n\nWor", calls)[2]).toEqual({ kind: "text", id: "text:6", text: "Wor" });
  });
});

describe("summarizeToolLabels", () => {
  it("counts repeats in first-seen order", () => {
    expect(summarizeToolLabels(["logs", "logs", "contents", "logs", "scene"])).toBe("logs ×3 · contents · scene");
    expect(summarizeToolLabels([])).toBe("");
  });

  it("collapses only batches of four or more", () => {
    expect(TOOL_GROUP_COLLAPSE_AT).toBe(4);
  });
});

describe("rebaseToolOffset (resumed runs)", () => {
  it("pins the offset to the shown text on first sight and replays it afterwards", () => {
    const memo = new Map<string, number>();
    const first = rebaseToolOffset({ id: "c1", name: "t", arguments: "{}", status: "running", textOffset: 12 }, 40, memo);
    expect(first.textOffset).toBe(40);
    // Later emissions of the same record (done, with a result) keep the pinned value
    // even though the shown text has grown since.
    const later = rebaseToolOffset({ id: "c1", name: "t", arguments: "{}", status: "done", result: "ok", textOffset: 12 }, 90, memo);
    expect(later).toMatchObject({ status: "done", result: "ok", textOffset: 40 });
    // Records without an offset (failure notes) pass through untouched.
    const note = { id: "mcpfail_0", name: "t", arguments: "{}", status: "error" as const };
    expect(rebaseToolOffset(note, 90, memo)).toBe(note);
  });
});
