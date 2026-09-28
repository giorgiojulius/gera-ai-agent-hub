// Gateway model facts the server needs at run time: whether a model accepts
// image input (so images an MCP tool returns can be shown to it) and the
// model's own output ceiling (`max_tokens`, sent with every completion so the
// provider default never shortens a reply).
//
// The web client passes the same facts from its loaded catalog (`vision` and
// `maxOutputTokens` in the run config); background runs (automations, project
// agents) and older clients fall back to this per-isolate cache of the
// gateway's public model list. Unknown model or unreachable gateway → false /
// undefined: the model then only sees the text stub for an image, and the
// engine continues a reply the provider default cut instead of capping it.

import { normalizeOutputTokens, parseSelection, TOOLKIT_URL } from "./agent-engine";
import { latestInFamily, type LineageVideoCaps, latestSelection, parseVideoCaps } from "./model-lineage";

/** How long one fetched catalog is trusted. */
export const MODEL_CATALOG_TTL_MS = 10 * 60_000;

type CatalogEntry = {
  id: string;
  inputs: string[];
  maxOutputTokens?: number;
  type?: string;
  released?: number;
  video?: LineageVideoCaps;
};
type CatalogCache = { fetchedAt: number; byId: Map<string, CatalogEntry> };

const caches = new Map<string, Promise<CatalogCache> | CatalogCache>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses the gateway `/v1/models` body into id → input modalities + output ceiling; tolerant of missing fields. */
export function parseModelCatalog(payload: unknown): Map<string, CatalogEntry> {
  const byId = new Map<string, CatalogEntry>();
  const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  for (const raw of data) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id) {
      continue;
    }
    const modalities = isRecord(raw.modalities) ? raw.modalities : {};
    const inputs = Array.isArray(modalities.input)
      ? modalities.input.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase())
      : [];
    const maxOutputTokens = normalizeOutputTokens(raw.max_tokens);
    const video = parseVideoCaps(raw.video_capabilities);
    byId.set(raw.id, {
      ...(video ? { video } : {}),
      id: raw.id,
      inputs,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(typeof raw.type === "string" ? { type: raw.type } : {}),
      ...(typeof raw.released === "number" && Number.isFinite(raw.released) ? { released: raw.released } : {}),
    });
  }
  return byId;
}

async function loadCatalog(url: string, fetchImpl: typeof fetch): Promise<CatalogCache> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) {
    throw new Error(`models ${response.status}`);
  }
  return { fetchedAt: Date.now(), byId: parseModelCatalog(await response.json()) };
}

/** Cached catalog for `url`; a failed load is not cached (the next call retries). */
async function catalogFor(url: string, fetchImpl: typeof fetch): Promise<CatalogCache | null> {
  const cached = caches.get(url);
  if (cached && !(cached instanceof Promise) && Date.now() - cached.fetchedAt < MODEL_CATALOG_TTL_MS) {
    return cached;
  }
  if (cached instanceof Promise) {
    return cached.catch(() => null);
  }
  const loading = loadCatalog(url, fetchImpl);
  caches.set(url, loading);
  try {
    const loaded = await loading;
    caches.set(url, loaded);
    return loaded;
  } catch (error) {
    caches.delete(url);
    console.error("model catalog unavailable", error instanceof Error ? error.message : "error");
    return null;
  }
}

export type ModelCatalogOptions = {
  /** Catalog endpoint; defaults to the toolkit's gateway mirror. */
  url?: string;
  fetch?: typeof fetch;
};

/**
 * True when the gateway catalog lists image input for the picked model
 * (`modalities.input` contains "image"). Unknown → false.
 */
export async function modelAcceptsImages(selectionId: string, options: ModelCatalogOptions = {}): Promise<boolean> {
  const { catalogId } = parseSelection(selectionId);
  const catalog = await catalogFor(options.url ?? `${TOOLKIT_URL}/v2/vercel/v1/models`, options.fetch ?? fetch);
  const entry = catalog?.byId.get(catalogId);
  return entry ? entry.inputs.includes("image") : false;
}

/**
 * The picked model's output ceiling (tokens) per the gateway catalog
 * (`max_tokens`). Unknown model, missing field or unreachable gateway →
 * undefined: the request then carries no cap and a cut reply is continued.
 */
export async function modelMaxOutputTokens(
  selectionId: string,
  options: ModelCatalogOptions = {},
): Promise<number | undefined> {
  const { catalogId } = parseSelection(selectionId);
  const catalog = await catalogFor(options.url ?? `${TOOLKIT_URL}/v2/vercel/v1/models`, options.fetch ?? fetch);
  return catalog?.byId.get(catalogId)?.maxOutputTokens;
}

/**
 * The saved selection moved onto the newest release of its model line per
 * the gateway catalog (`spacexai/grok-4.6:xhigh` → `spacexai/grok-4.7:xhigh`
 * once the gateway lists it). Background runs (automations, project agents)
 * use it so a stored pick never sticks to an old version. Unreachable
 * catalog or unknown line → the selection unchanged.
 */
export async function latestModelSelection(selectionId: string, options: ModelCatalogOptions = {}): Promise<string> {
  if (!selectionId) {
    return selectionId;
  }
  const catalog = await catalogFor(options.url ?? `${TOOLKIT_URL}/v2/vercel/v1/models`, options.fetch ?? fetch);
  if (!catalog || !catalog.byId.has(parseSelection(selectionId).catalogId)) {
    return selectionId;
  }
  return latestSelection([...catalog.byId.values()], selectionId);
}

/**
 * A media seed (`bytedance/seedance-2.5`) on the newest release of its line
 * that keeps every capability the seed has (inputs, video operations, image
 * sources, requested clip length — see keepsMediaCapabilities). Unreachable
 * catalog or a seed the catalog no longer lists → the seed unchanged.
 */
export async function latestMediaModel(seed: string, options: ModelCatalogOptions = {}): Promise<string> {
  const catalog = await catalogFor(options.url ?? `${TOOLKIT_URL}/v2/vercel/v1/models`, options.fetch ?? fetch);
  if (!catalog || !catalog.byId.has(seed)) {
    return seed;
  }
  return latestInFamily([...catalog.byId.values()], seed);
}

/** Clip lengths the catalog lists for a video model; empty when unknown. */
export async function videoDurationsFor(modelId: string, options: ModelCatalogOptions = {}): Promise<number[]> {
  const catalog = await catalogFor(options.url ?? `${TOOLKIT_URL}/v2/vercel/v1/models`, options.fetch ?? fetch);
  return catalog?.byId.get(modelId)?.video?.durations ?? [];
}

/** Test seam: forgets every cached catalog. */
export function resetModelCatalogCache(): void {
  caches.clear();
}
