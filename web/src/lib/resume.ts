/**
 * Seamless publish/reload recovery for chat turns.
 *
 * A deploy (or any reload) kills in-flight streams. Instead of surfacing
 * banners and toasts, the app quietly picks the freshest casualty back up:
 * the partial reply stays in its bubble and the continuation streams into it
 * as if nothing happened. This module owns the pure pieces — the boot-time
 * plan (decided before the first render, so no "interrupted" chip ever
 * flashes) and the overlap-aware text stitcher.
 */

import { modeOfModelId } from "@/lib/models";
import type { Conversation } from "@/lib/types";

/** Only interruptions younger than this auto-recover; older ones keep the manual chip. */
export const RESUME_FRESH_MS = 10 * 60_000;

/**
 * User-role note injected only into the resume API call — never shown in the
 * thread. It asks the model to repeat the last few words verbatim so the
 * stitcher can splice the continuation without a visible seam.
 */
export const RESUME_NOTE =
  "[recovery note] Your previous assistant reply above was cut off mid-generation by a page reload — the user never saw anything after the cut. Continue that reply seamlessly: first repeat, verbatim, the last few words before the cut (a handful of words, at most one short line — the app stitches the overlap together automatically), then keep writing from exactly that point. Do not restart the reply, do not summarize what was already said, no apologies or meta-comments about the interruption. If the cut happened inside a code block, keep writing the code directly: the original code fence is still open, so do not open a new fence — just close it when the code ends. If the reply was already essentially complete, repeat its last few words and add only the brief missing ending.";

/** Overlaps shorter than this are too coincidence-prone to dedupe. */
const MIN_OVERLAP = 3;
/** The model is told to repeat at most one short line — cap the overlap scan. */
const MAX_OVERLAP = 320;

/** Markdown constructs that must start on their own line. */
const BLOCK_START = /^(```|~~~|#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|\||<)/u;
/** Head endings that read as a finished sentence or block. */
const CLOSED_END = /(```|[.!?…:;)\]}»”"'|*_])$/u;

/**
 * Stitches a cut-off reply with its streamed continuation without a visible
 * seam. The model repeats the last few words verbatim (see RESUME_NOTE), so
 * the longest head-suffix/tail-prefix overlap is deduped; without an overlap
 * a mid-sentence cut continues on the same line and a finished sentence or a
 * block construct starts a new paragraph. Called on every stream chunk — it
 * self-corrects as the tail grows.
 */
export function joinResumedText(head: string, tail: string): string {
  const base = head.replace(/\s+$/u, "");
  const next = tail.replace(/^\n+/u, "");
  if (base.length === 0) {
    return next;
  }
  if (next.length === 0) {
    return base;
  }
  // Streaming warm-up: everything received so far is still inside the
  // verbatim repeat — show the head unchanged (the text never jumps).
  if (next.length < MAX_OVERLAP && base.endsWith(next)) {
    return base;
  }
  const cap = Math.min(base.length, next.length, MAX_OVERLAP);
  for (let k = cap; k >= MIN_OVERLAP; k -= 1) {
    if (base.endsWith(next.slice(0, k))) {
      return base + next.slice(k);
    }
  }
  if (BLOCK_START.test(next) || CLOSED_END.test(base)) {
    return `${base}\n\n${next}`;
  }
  return `${base} ${next}`;
}

/** What boot recovery should do with the freshest cut reply, if anything. */
export type BootResume =
  | { kind: "continue"; messageId: string }
  | { kind: "retry"; messageId: string };

export interface BootRecoveryPlan {
  conversations: Conversation[];
  /** Silent recovery to fire right after boot; null keeps the manual chip. */
  resume: BootResume | null;
}

/**
 * Decides — before the first render — whether the active thread's last reply
 * (cut by a reload) should silently recover. Eligible messages are re-marked
 * `pending` so the "interrupted" chip never flashes; boot recovery then
 * continues a text partial or re-runs an empty chat turn. Julius panels,
 * media/research turns with nothing delivered, stale cuts, and non-active
 * threads keep the honest in-thread chip instead of silently spending
 * tokens.
 */
export function planBootAutoResume(
  conversations: Conversation[],
  activeId: string | null,
  now: number = Date.now(),
): BootRecoveryPlan {
  const active = conversations.find((item) => item.id === activeId);
  const last = active?.messages[active.messages.length - 1];
  if (
    !active ||
    !last ||
    last.role !== "assistant" ||
    last.interrupted !== true ||
    last.julius !== undefined ||
    now - active.updatedAt >= RESUME_FRESH_MS
  ) {
    return { conversations, resume: null };
  }
  const hasText = last.content.trim().length > 0;
  const isChatTurn = (modeOfModelId(active.modelId) ?? "chat") === "chat";
  const kind: BootResume["kind"] | null = hasText
    ? "continue"
    : last.research === undefined && isChatTurn
      ? "retry"
      : null;
  if (kind === null) {
    return { conversations, resume: null };
  }
  const messages = active.messages.map((item) =>
    item.id === last.id ? { ...item, interrupted: undefined, pending: true } : item,
  );
  return {
    conversations: conversations.map((item) =>
      item.id === active.id ? { ...item, messages } : item,
    ),
    resume: { kind, messageId: last.id },
  };
}
