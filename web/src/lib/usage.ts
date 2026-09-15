import type { MediaTally, ModelTokens, TurnUsage } from "@/lib/types";

/**
 * Turn-level usage metering. Every LLM call site (chat loop, tool router,
 * research planner, Julius phases) reports its usage here; the agent store
 * opens a capture around a whole turn and stores the tally on the message.
 *
 * Internal helper calls (router, planner, titles) report with
 * kind "service" and land in `serviceByModel` — they stay priced in the run
 * cost but never pose as real model adoption in the arena standings.
 * Media generation reports per-asset units into `media`.
 *
 * Browser-side helper calls attribute top-of-stack: concurrent runs (e.g. two
 * background automations) may occasionally credit a router call to the other
 * run's tally. Server runs replay their usage with an explicit capture
 * (`reportUsageTo`), so parallel threads never swap their token bills.
 */
const active: TurnUsage[] = [];

function emptyUsage(): TurnUsage {
  return { prompt: 0, completion: 0, calls: 0, byModel: {} };
}

/**
 * A standalone tally that is NOT on the capture stack — for replaying usage
 * that arrives after the fact (a finished server run applied at boot) without
 * ever intercepting the live turns' top-of-stack reports.
 */
export function detachedUsageTally(): TurnUsage {
  return emptyUsage();
}

/** The tally when at least one call was metered, else undefined. */
export function settledUsage(tally: TurnUsage): TurnUsage | undefined {
  return tally.calls > 0 ? tally : undefined;
}

export function beginUsageCapture(): TurnUsage {
  const capture = emptyUsage();
  active.push(capture);
  return capture;
}

/** Closes a capture; returns it only when at least one call was metered. */
export function endUsageCapture(capture: TurnUsage): TurnUsage | undefined {
  const index = active.indexOf(capture);
  if (index !== -1) {
    active.splice(index, 1);
  }
  return capture.calls > 0 ? capture : undefined;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function detailCount(usage: Record<string, unknown>, detailKey: string, field: string): number {
  const details = usage[detailKey];
  if (!details || typeof details !== "object") {
    return 0;
  }
  return asCount((details as Record<string, unknown>)[field]);
}

/** What one LLM call reported: tokens plus cache/reasoning details when present. */
export type ParsedUsage = {
  prompt: number;
  completion: number;
  cached: number;
  reasoning: number;
};

/**
 * Normalizes a gateway usage payload. Accepts OpenAI-style
 * (prompt_tokens/completion_tokens + details) and Anthropic-style
 * (input_tokens/output_tokens + cache_read_input_tokens) shapes.
 * Cached and reasoning counts are subsets of prompt/completion per the
 * OpenAI-compatible spec — kept for honest pricing, never double-added.
 */
export function parseUsagePayload(usage: unknown): ParsedUsage | null {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const raw = usage as Record<string, unknown>;
  const prompt = asCount(raw.prompt_tokens) || asCount(raw.input_tokens);
  const completion = asCount(raw.completion_tokens) || asCount(raw.output_tokens);
  if (prompt === 0 && completion === 0) {
    return null;
  }
  const cached = Math.min(
    prompt,
    detailCount(raw, "prompt_tokens_details", "cached_tokens") || asCount(raw.cache_read_input_tokens),
  );
  const reasoning = Math.min(completion, detailCount(raw, "completion_tokens_details", "reasoning_tokens"));
  return { prompt, completion, cached, reasoning };
}

function addTokens(map: Record<string, ModelTokens>, modelId: string, parsed: ParsedUsage): void {
  const key = modelId.trim() || "unknown";
  const entry = map[key] ?? { prompt: 0, completion: 0, calls: 0 };
  map[key] = {
    prompt: entry.prompt + parsed.prompt,
    completion: entry.completion + parsed.completion,
    calls: entry.calls + 1,
    ...(entry.cached || parsed.cached ? { cached: (entry.cached ?? 0) + parsed.cached } : {}),
    ...(entry.reasoning || parsed.reasoning ? { reasoning: (entry.reasoning ?? 0) + parsed.reasoning } : {}),
  };
}

/**
 * Reports one completed LLM call. Pass kind "service" for internal helper
 * calls (tool router, research planner, thread titles) — they count toward
 * the run cost but are excluded from model adoption statistics.
 */
export function reportUsage(modelId: string, usage: unknown, kind?: "service"): void {
  const target = active[active.length - 1];
  if (!target) {
    return;
  }
  reportUsageTo(target, modelId, usage, kind);
}

/**
 * Reports one LLM call into a specific capture — for usage that arrives after
 * the fact (a server run's terminal event) while other turns may have opened
 * their own captures meanwhile.
 */
export function reportUsageTo(target: TurnUsage, modelId: string, usage: unknown, kind?: "service"): void {
  const parsed = parseUsagePayload(usage);
  if (!parsed) {
    return;
  }
  target.prompt += parsed.prompt;
  target.completion += parsed.completion;
  target.calls += 1;
  if (kind === "service") {
    const map = target.serviceByModel ?? {};
    addTokens(map, modelId, parsed);
    target.serviceByModel = map;
    return;
  }
  addTokens(target.byModel, modelId, parsed);
}

/**
 * Reports generated media (billed per asset, not tokens): image count,
 * video seconds, or TTS characters. Prices resolve at display time from
 * gateway list rates.
 */
export function reportMediaUsage(
  modelId: string,
  units: { images?: number; videoSeconds?: number; speechChars?: number },
): void {
  const target = active[active.length - 1];
  const images = asCount(units.images);
  const videoSeconds = asCount(units.videoSeconds);
  const speechChars = asCount(units.speechChars);
  if (!target || (images === 0 && videoSeconds === 0 && speechChars === 0)) {
    return;
  }
  const key = modelId.trim() || "unknown";
  const map = target.media ?? {};
  const entry = map[key] ?? { calls: 0 };
  map[key] = {
    calls: entry.calls + 1,
    ...(entry.images || images ? { images: (entry.images ?? 0) + images } : {}),
    ...(entry.videoSeconds || videoSeconds
      ? { videoSeconds: (entry.videoSeconds ?? 0) + videoSeconds }
      : {}),
    ...(entry.speechChars || speechChars ? { speechChars: (entry.speechChars ?? 0) + speechChars } : {}),
  };
  target.media = map;
  // Media-only turns must still settle as metered — a capture with assets
  // but zero LLM calls would otherwise be dropped by endUsageCapture.
  target.calls += 1;
}

function mergeTokenMaps(
  base: Record<string, ModelTokens> | undefined,
  extra: Record<string, ModelTokens> | undefined,
): Record<string, ModelTokens> | undefined {
  if (!base && !extra) {
    return undefined;
  }
  const merged: Record<string, ModelTokens> = { ...(base ?? {}) };
  for (const [modelId, tokens] of Object.entries(extra ?? {})) {
    const current = merged[modelId] ?? { prompt: 0, completion: 0, calls: 0 };
    merged[modelId] = {
      prompt: current.prompt + tokens.prompt,
      completion: current.completion + tokens.completion,
      calls: current.calls + tokens.calls,
      ...(current.cached || tokens.cached ? { cached: (current.cached ?? 0) + (tokens.cached ?? 0) } : {}),
      ...(current.reasoning || tokens.reasoning
        ? { reasoning: (current.reasoning ?? 0) + (tokens.reasoning ?? 0) }
        : {}),
    };
  }
  return merged;
}

function mergeMediaMaps(
  base: Record<string, MediaTally> | undefined,
  extra: Record<string, MediaTally> | undefined,
): Record<string, MediaTally> | undefined {
  if (!base && !extra) {
    return undefined;
  }
  const merged: Record<string, MediaTally> = { ...(base ?? {}) };
  for (const [modelId, tally] of Object.entries(extra ?? {})) {
    const current = merged[modelId] ?? { calls: 0 };
    merged[modelId] = {
      calls: current.calls + tally.calls,
      ...(current.images || tally.images ? { images: (current.images ?? 0) + (tally.images ?? 0) } : {}),
      ...(current.videoSeconds || tally.videoSeconds
        ? { videoSeconds: (current.videoSeconds ?? 0) + (tally.videoSeconds ?? 0) }
        : {}),
      ...(current.speechChars || tally.speechChars
        ? { speechChars: (current.speechChars ?? 0) + (tally.speechChars ?? 0) }
        : {}),
    };
  }
  return merged;
}

/** Sums two tallies (e.g. a manual Julius pick adding onto the original run). */
export function mergeUsage(base: TurnUsage | undefined, extra: TurnUsage | undefined): TurnUsage | undefined {
  if (!base) {
    return extra;
  }
  if (!extra) {
    return base;
  }
  const serviceByModel = mergeTokenMaps(base.serviceByModel, extra.serviceByModel);
  const media = mergeMediaMaps(base.media, extra.media);
  return {
    prompt: base.prompt + extra.prompt,
    completion: base.completion + extra.completion,
    calls: base.calls + extra.calls,
    byModel: mergeTokenMaps(base.byModel, extra.byModel) ?? {},
    ...(serviceByModel ? { serviceByModel } : {}),
    ...(media ? { media } : {}),
  };
}
