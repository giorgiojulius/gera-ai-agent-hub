import type { QueuedMessage } from "@/lib/types";

/**
 * Mid-run steering registry.
 *
 * A plain chat agent loop registers its conversation here while it runs.
 * Messages offered meanwhile are injected into the live model context
 * immediately: the loop watches for offers, softly cuts its in-flight stream
 * at the next token, keeps the draft on screen, and continues the same reply
 * with the guidance woven in — nothing restarts, nothing is thrown away.
 * Runs that cannot take mid-run guidance (research, Julius panels, media
 * generation) simply never register, so offers honestly return false and the
 * message stays in the ordinary queue.
 *
 * Lives outside React state so the in-flight loop and the UI never race over
 * ownership: the loop drains, the UI mirrors chips from the queue.
 */
const inboxes = new Map<string, QueuedMessage[]>();

/** Live-run listeners, pinged the instant an offer lands so the loop reacts mid-stream. */
const watchers = new Map<string, Set<() => void>>();

/** Opens the steering inbox for a run. Idempotent; keeps anything already offered. */
export function registerSteerableRun(conversationId: string): void {
  if (!inboxes.has(conversationId)) {
    inboxes.set(conversationId, []);
  }
}

/**
 * Closes the inbox when the run settles and returns whatever the run never
 * consumed. Those items stay in the visible queue and dispatch as normal
 * follow-ups right after — nothing is lost; the caller strips their steer
 * flags so they never pose as live steering for a future run.
 */
export function unregisterSteerableRun(conversationId: string): QueuedMessage[] {
  const leftovers = inboxes.get(conversationId) ?? [];
  inboxes.delete(conversationId);
  watchers.delete(conversationId);
  return leftovers;
}

/** True while a live run can absorb steering for this conversation. */
export function isSteerableRun(conversationId: string | null): boolean {
  return conversationId !== null && inboxes.has(conversationId);
}

/** Hands a message to the live run; false when no steerable run is open. */
export function offerSteering(conversationId: string, item: QueuedMessage): boolean {
  const inbox = inboxes.get(conversationId);
  if (!inbox) {
    return false;
  }
  inbox.push(item);
  // Ping AFTER the push so a drain fired by the ping already sees the item.
  for (const listener of watchers.get(conversationId) ?? []) {
    listener();
  }
  return true;
}

/**
 * The live loop subscribes to hear the INSTANT new steering lands, so it can
 * cut its in-flight stream at the next token instead of waiting for the round
 * to finish. Returns an unsubscribe; a no-op for non-steerable runs.
 */
export function watchSteering(conversationId: string, listener: () => void): () => void {
  if (!inboxes.has(conversationId)) {
    return () => {};
  }
  const set = watchers.get(conversationId) ?? new Set<() => void>();
  set.add(listener);
  watchers.set(conversationId, set);
  return () => {
    set.delete(listener);
  };
}

/** The loop takes everything pending at a step boundary, in send order. */
export function drainSteering(conversationId: string): QueuedMessage[] {
  const inbox = inboxes.get(conversationId);
  if (!inbox || inbox.length === 0) {
    return [];
  }
  return inbox.splice(0, inbox.length);
}

/**
 * Strips every ⚡ flag from a settled thread's queue. Once no run is live in
 * the thread, no queued item may pose as "riding the live run" — including
 * items a server run accepted but never consumed because the guidance landed
 * in the instant the loop was already finishing. A stale flag renders a chip
 * that lies about steering and deadens its "Send now". Returns null when
 * nothing would change so callers can skip the state write.
 */
export function stripSteerFlags(list: QueuedMessage[]): QueuedMessage[] | null {
  if (!list.some((item) => item.steer === true)) {
    return null;
  }
  return list.map((item) => (item.steer === true ? { ...item, steer: undefined } : item));
}

/** Takes a not-yet-consumed item back (user removed the chip). */
export function retractSteering(conversationId: string, itemId: string): void {
  const inbox = inboxes.get(conversationId);
  if (!inbox) {
    return;
  }
  const index = inbox.findIndex((item) => item.id === itemId);
  if (index >= 0) {
    inbox.splice(index, 1);
  }
}

/**
 * Pure reorder for the visible follow-up queue (drag-and-drop): the dragged
 * item takes the target's position. Returns null when nothing would change
 * so callers can skip the state write.
 */
export function moveQueuedItem(
  list: QueuedMessage[],
  fromId: string,
  toId: string,
): QueuedMessage[] | null {
  const fromIndex = list.findIndex((item) => item.id === fromId);
  const toIndex = list.findIndex((item) => item.id === toId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return null;
  }
  const next = [...list];
  const moved = next.splice(fromIndex, 1)[0];
  if (!moved) {
    return null;
  }
  next.splice(toIndex, 0, moved);
  return next;
}

/**
 * Re-ranks a live run's steering inbox to match the visible queue order, so a
 * drag-and-drop reorder also changes mid-run injection order. Ids the order
 * list doesn't know sink to the end keeping their relative order (stable
 * sort). No-op when no inbox is open — plain queued items need no sync.
 */
export function syncSteeringOrder(conversationId: string, orderedIds: string[]): void {
  const inbox = inboxes.get(conversationId);
  if (!inbox || inbox.length < 2) {
    return;
  }
  const rank = new Map(orderedIds.map((id, index) => [id, index]));
  inbox.sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}
