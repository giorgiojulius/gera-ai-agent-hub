// Model lineage: which gateway models are newer versions of the same line.
//
// Gera keeps a short curated list of "seed" models per creation tab. When the
// gateway ships a newer version of a seed's line (grok-4.6 → grok-4.7,
// gpt-5.6-sol → gpt-6-sol, claude-opus-5 → claude-opus-5.5), pickers, saved
// picks and background runs move to it automatically — no code change needed.
//
// A line ("family") is the model id with every version number masked:
// `spacexai/grok-4.6` → `spacexai/grok-#`. Variant words stay part of the
// family, so `-fast`, `-reasoning`, `-lite`, `-max-prime` never replace the
// base line. Pre-release builds (preview / beta / exp / free / stealth) are
// never picked as a successor.
//
// Media lines (image / video / speech) also have to keep every capability the
// app relies on: a successor must accept the same inputs, the same video
// operations and image sources, and the clip length Gera requests. A newer
// build that drops any of them is skipped — the pick stays on the proven one.
//
// Platform-neutral: imported by the web client and by the worker.

/** Video facts from the gateway's `video_capabilities`. */
export type LineageVideoCaps = {
  operations: string[];
  imageSources: string[];
  durations: number[];
};

/** Minimal catalog facts lineage needs (subset of the gateway `/v1/models` row). */
export type LineageModel = {
  id: string;
  /** Gateway `type` ("language", "image", "video", "speech", …). */
  type?: string;
  /** Unix seconds of the public release, when the gateway reports it. */
  released?: number;
  /** Input modalities (lowercase) — server catalog shape. */
  inputs?: string[];
  /** Input modalities — web catalog shape. */
  modalities?: { input?: string[] };
  /** Parsed `video_capabilities`, when the gateway lists them. */
  video?: LineageVideoCaps;
};

const MEDIA_TYPES = new Set(["image", "video", "speech"]);

/** Veo accepts only 4/6/8-second runs; every other video line gets 5 seconds. */
export function requestedVideoSeconds(modelId: string): number {
  return modelId.toLowerCase().includes("/veo") ? 6 : 5;
}

/** Parses the gateway `video_capabilities` object; undefined when absent. */
export function parseVideoCaps(raw: unknown): LineageVideoCaps | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase()) : [];
  const limits = source.input_limits && typeof source.input_limits === "object" ? (source.input_limits as Record<string, unknown>) : {};
  const image = limits.image && typeof limits.image === "object" ? (limits.image as Record<string, unknown>) : {};
  return {
    operations: strings(source.supported_operations),
    imageSources: strings(image.supported_sources),
    durations: Array.isArray(source.supported_durations_seconds)
      ? source.supported_durations_seconds.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
      : [],
  };
}

function inputsOf(model: LineageModel): string[] | undefined {
  const list = model.inputs ?? model.modalities?.input;
  return Array.isArray(list) ? list.map((item) => item.toLowerCase()) : undefined;
}

function covers(have: readonly string[], need: readonly string[]): boolean {
  return need.every((item) => have.includes(item));
}

/**
 * Whether `candidate` can replace `current` in a media tab without losing a
 * capability: same-or-wider inputs, every video operation and image source
 * `current` offers, and the clip length Gera requests from the candidate.
 * Chat lines are not checked here (their own rules apply); missing facts on
 * the candidate where `current` has them → not a safe successor.
 */
export function keepsMediaCapabilities(current: LineageModel | undefined, candidate: LineageModel): boolean {
  const type = current?.type ?? candidate.type ?? "";
  if (!MEDIA_TYPES.has(type)) {
    return true;
  }
  const currentInputs = current ? inputsOf(current) : undefined;
  if (currentInputs && currentInputs.length > 0) {
    const candidateInputs = inputsOf(candidate);
    if (!candidateInputs || !covers(candidateInputs, currentInputs)) {
      return false;
    }
  }
  if (type === "video") {
    const caps = candidate.video;
    const currentCaps = current?.video;
    if (currentCaps) {
      if (!caps) {
        return false;
      }
      if (!covers(caps.operations, currentCaps.operations) || !covers(caps.imageSources, currentCaps.imageSources)) {
        return false;
      }
    }
    if (caps && caps.durations.length > 0 && !caps.durations.includes(requestedVideoSeconds(candidate.id))) {
      return false;
    }
    if (currentCaps && currentCaps.durations.length > 0 && (!caps || caps.durations.length === 0)) {
      return false;
    }
  }
  return true;
}

const PRERELEASE = /(?:^|[-.])(?:preview|beta|alpha|exp|experimental|free|canary)(?:$|[-.])/;
const PRERELEASE_PROVIDERS = new Set(["stealth"]);
/** Dated snapshots (`qwen3.8-max-0902`) are pinned builds, not a line's head. */
const DATED_SNAPSHOT = /-\d{4}(?:-\d{2}){0,2}$/;

function splitId(id: string): { provider: string; name: string } {
  const slash = id.indexOf("/");
  return slash > 0 ? { provider: id.slice(0, slash), name: id.slice(slash + 1) } : { provider: "", name: id };
}

/** `spacexai/grok-4.6` → `spacexai/grok-#`; ids without a version are their own family. */
export function modelFamily(id: string): string {
  const { provider, name } = splitId(id.toLowerCase());
  const masked = name.replace(/\d+(?:\.\d+)*/g, "#");
  return provider ? `${provider}/${masked}` : masked;
}

/** Numeric version parts in order of appearance: `gpt-5.6-sol` → [5, 6]. */
export function modelVersion(id: string): number[] {
  const { name } = splitId(id);
  const parts: number[] = [];
  for (const chunk of name.match(/\d+(?:\.\d+)*/g) ?? []) {
    for (const piece of chunk.split(".")) {
      parts.push(Number(piece));
    }
  }
  return parts;
}

/** Negative / zero / positive like a sort comparator over version parts. */
export function compareVersions(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) {
      return left - right;
    }
  }
  return 0;
}

/** Preview / beta / free / stealth / dated snapshot builds are never auto-picked. */
export function isPrereleaseModel(id: string): boolean {
  const { provider, name } = splitId(id.toLowerCase());
  return PRERELEASE_PROVIDERS.has(provider) || PRERELEASE.test(name) || DATED_SNAPSHOT.test(name);
}

/**
 * Newest catalog model of the same line as `catalogId`: same family, same
 * gateway type, not a pre-release, and not older (release date first,
 * version number second). Returns `catalogId` itself when nothing newer is
 * listed or the catalog is empty — never a model from another line.
 */
export function latestInFamily(models: readonly LineageModel[], catalogId: string): string {
  if (models.length === 0) {
    return catalogId;
  }
  const family = modelFamily(catalogId);
  const current = models.find((model) => model.id === catalogId);
  let best: LineageModel | undefined = current;
  let bestVersion = modelVersion(catalogId);
  for (const model of models) {
    if (model.id === catalogId || modelFamily(model.id) !== family || isPrereleaseModel(model.id)) {
      continue;
    }
    if (current?.type && model.type && model.type !== current.type) {
      continue;
    }
    if (!keepsMediaCapabilities(current, model)) {
      continue;
    }
    const version = modelVersion(model.id);
    const released = model.released ?? 0;
    const bestReleased = best?.released ?? 0;
    // A newer line head must not be older than the current pick and must
    // carry a higher version — a re-listed old build never "upgrades" a pick.
    if (compareVersions(version, bestVersion) <= 0) {
      continue;
    }
    if (best && released > 0 && bestReleased > 0 && released < bestReleased) {
      continue;
    }
    best = model;
    bestVersion = version;
  }
  return best?.id ?? catalogId;
}

/**
 * Whether `id` is `seed` or a newer release of the seed's line (same family,
 * version not lower, not a pre-release). Lets exact-id capability lists keep
 * working after a pick moved to the line's next release.
 */
export function isSameLineAtLeast(id: string, seed: string): boolean {
  if (id === seed) {
    return true;
  }
  return (
    modelFamily(id) === modelFamily(seed) &&
    !isPrereleaseModel(id) &&
    compareVersions(modelVersion(id), modelVersion(seed)) >= 0
  );
}

/** `id` or `id:effort` → same shape on the newest model of the line. */
export function latestSelection(models: readonly LineageModel[], selectionId: string): string {
  const split = selectionId.lastIndexOf(":");
  const effort = split > 0 ? selectionId.slice(split + 1) : "";
  const hasEffort = effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh";
  const catalogId = hasEffort ? selectionId.slice(0, split) : selectionId;
  const latest = latestInFamily(models, catalogId);
  return hasEffort ? `${latest}:${effort}` : latest;
}
