// Gateway model facts the server needs at run time — today: whether a model
// accepts image input, so images an MCP tool returns can be shown to it.
//
// The web client passes the same fact from its loaded catalog (`vision` in the
// run config); background runs (automations, project agents) and older clients
// fall back to this per-isolate cache of the gateway's public model list.
// Unknown model or unreachable gateway → false: the model then only sees the
// text stub for an image, never an input part it might reject.

import { parseSelection, TOOLKIT_URL } from "./agent-engine";

/** How long one fetched catalog is trusted. */
export const MODEL_CATALOG_TTL_MS = 10 * 60_000;

type CatalogEntry = { id: string; inputs: string[] };
type CatalogCache = { fetchedAt: number; byId: Map<string, CatalogEntry> };

const caches = new Map<string, Promise<CatalogCache> | CatalogCache>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses the gateway `/v1/models` body into id → input modalities; tolerant of missing fields. */
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
    byId.set(raw.id, { id: raw.id, inputs });
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

/** Test seam: forgets every cached catalog. */
export function resetModelCatalogCache(): void {
  caches.clear();
}
