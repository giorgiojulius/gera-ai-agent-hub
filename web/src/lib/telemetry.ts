// Automatic model-usage telemetry — the fuel for the admin-only arena
// standings. Fire-and-forget by design: events are buffered, batched, capped
// and silently dropped on failure — telemetry must never break a chat.
// Only model id, mode, outcome and token counts travel — never message
// content; incognito turns report nothing (enforced at the call site).
import { authedFetch } from "@/lib/backend";
import type { TurnUsage } from "@/lib/types";

export type UsageEvent = {
  modelId: string;
  mode: string;
  ok: boolean;
  promptTokens: number;
  completionTokens: number;
  /** Media units for per-asset modes: images, video seconds, or TTS characters. */
  units?: number;
};

const FLUSH_MS = 15_000;
const MAX_BUFFER = 40;

let buffer: UsageEvent[] = [];
let timer: number | null = null;

/** Sends everything buffered right now; losses are acceptable by design. */
function flush(keepalive = false): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (buffer.length === 0) {
    return;
  }
  const events = buffer;
  buffer = [];
  void authedFetch("/arena/usage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
    keepalive,
  }).catch(() => {
    // Dropped — usage stats are best-effort telemetry, not billing.
  });
}

/**
 * Queues usage events for the next batched send. Safe to call from anywhere —
 * never throws, never blocks the turn that produced the events.
 */
export function reportModelUsage(events: UsageEvent[]): void {
  if (events.length === 0 || typeof window === "undefined") {
    return;
  }
  buffer.push(...events);
  if (buffer.length >= MAX_BUFFER) {
    flush();
    return;
  }
  if (timer === null) {
    timer = window.setTimeout(() => {
      timer = null;
      flush();
    }, FLUSH_MS);
  }
}

/**
 * Maps one settled turn to usage events:
 * - one event per answering model (Julius turns fan out to several);
 * - internal helper calls (router, planner, titles) as mode "service" so the
 *   cheap helper model never poses as real adoption in the standings;
 * - media generation as its own mode (image/video/audio) carrying per-asset
 *   units — image count, video seconds, TTS characters;
 * - a single zero-token event for the selected model when nothing was
 *   metered at all (failures before the first call).
 */
export function turnUsageEvents(params: {
  usage: TurnUsage | undefined;
  mode: string;
  fallbackModelId: string;
  ok: boolean;
}): UsageEvent[] {
  const { usage, mode, fallbackModelId, ok } = params;
  const events: UsageEvent[] = [];
  for (const [modelId, tokens] of Object.entries(usage?.byModel ?? {})) {
    events.push({ modelId, mode, ok, promptTokens: tokens.prompt, completionTokens: tokens.completion });
  }
  for (const [modelId, tokens] of Object.entries(usage?.serviceByModel ?? {})) {
    events.push({
      modelId,
      mode: "service",
      ok: true, // helper calls that failed simply don't report usage
      promptTokens: tokens.prompt,
      completionTokens: tokens.completion,
    });
  }
  for (const [modelId, tally] of Object.entries(usage?.media ?? {})) {
    if (tally.images) {
      events.push({ modelId, mode: "image", ok, promptTokens: 0, completionTokens: 0, units: tally.images });
    }
    if (tally.videoSeconds) {
      events.push({
        modelId,
        mode: "video",
        ok,
        promptTokens: 0,
        completionTokens: 0,
        units: tally.videoSeconds,
      });
    }
    if (tally.speechChars) {
      events.push({
        modelId,
        mode: "audio",
        ok,
        promptTokens: 0,
        completionTokens: 0,
        units: tally.speechChars,
      });
    }
  }
  if (events.length === 0) {
    return fallbackModelId
      ? [{ modelId: fallbackModelId, mode, ok, promptTokens: 0, completionTokens: 0 }]
      : [];
  }
  return events;
}

// The tail of a session still counts: flush pending events when the tab
// hides or closes (keepalive lets the request outlive the page).
if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("pagehide", () => flush(true));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      flush(true);
    }
  });
}
