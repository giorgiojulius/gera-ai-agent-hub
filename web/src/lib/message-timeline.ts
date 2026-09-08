import type { ToolCallRecord } from "@/lib/types";

/**
 * One slice of an assistant reply in reading order: prose the model wrote, or
 * the batch of tool calls it issued at that point of the text.
 */
export type MessageSegment =
  | { kind: "text"; id: string; text: string }
  | { kind: "tools"; id: string; calls: ToolCallRecord[] };

/** A batch this long or longer collapses into one summary row by default. */
export const TOOL_GROUP_COLLAPSE_AT = 4;

function clampOffset(call: ToolCallRecord, length: number): number {
  const raw = typeof call.textOffset === "number" && Number.isFinite(call.textOffset) ? call.textOffset : 0;
  return Math.max(0, Math.min(length, Math.floor(raw)));
}

/**
 * Interleaves the reply text with its tool calls the way they happened. Each
 * record carries the length of the text already written when the model issued
 * it (`textOffset`); consecutive calls issued at the same point form one
 * batch, and the text between two batches is the commentary that led from one
 * to the next. Records without an offset (legacy replies, prepended failure
 * notes) sit before the text, which is exactly the old layout.
 */
export function buildMessageTimeline(content: string, calls: ToolCallRecord[]): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const pushText = (start: number, end: number): void => {
    const text = content.slice(start, end).trim();
    if (text.length > 0) {
      segments.push({ kind: "text", id: `text:${start}`, text });
    }
  };
  if (calls.length === 0) {
    pushText(0, content.length);
    return segments;
  }
  // Records arrive in issue order, so offsets never decrease — the stable sort
  // only guards against a merged history (resumed runs) and keeps batch order.
  const ordered = calls
    .map((call, index) => ({ call, index, offset: clampOffset(call, content.length) }))
    .sort((a, b) => a.offset - b.offset || a.index - b.index);
  let cursor = 0;
  let batch: ToolCallRecord[] = [];
  let batchOffset = 0;
  const flush = (): void => {
    if (batch.length === 0) {
      return;
    }
    pushText(cursor, batchOffset);
    segments.push({ kind: "tools", id: `tools:${batch[0].id}`, calls: batch });
    cursor = batchOffset;
    batch = [];
  };
  for (const entry of ordered) {
    if (batch.length > 0 && entry.offset !== batchOffset) {
      flush();
    }
    if (batch.length === 0) {
      batchOffset = entry.offset;
    }
    batch.push(entry.call);
  }
  flush();
  pushText(cursor, content.length);
  return segments;
}

/**
 * "mcp_github_get_job_logs ×8 · mcp_github_get_contents ×2" — distinct labels
 * in first-seen order with repeat counts, for a collapsed batch header.
 */
export function summarizeToolLabels(labels: string[]): string {
  const counts = new Map<string, number>();
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label)).join(" · ");
}
