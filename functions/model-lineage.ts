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
// Platform-neutral: imported by the web client and by the worker.

/** Minimal catalog facts lineage needs (subset of the gateway `/v1/models` row). */
export type LineageModel = {
  id: string;
  /** Gateway `type` ("language", "image", "video", "speech", …). */
  type?: string;
  /** Unix seconds of the public release, when the gateway reports it. */
  released?: number;
};

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

function compareVersions(a: number[], b: number[]): number {
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

/** `id` or `id:effort` → same shape on the newest model of the line. */
export function latestSelection(models: readonly LineageModel[], selectionId: string): string {
  const split = selectionId.lastIndexOf(":");
  const effort = split > 0 ? selectionId.slice(split + 1) : "";
  const hasEffort = effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh";
  const catalogId = hasEffort ? selectionId.slice(0, split) : selectionId;
  const latest = latestInFamily(models, catalogId);
  return hasEffort ? `${latest}:${effort}` : latest;
}
