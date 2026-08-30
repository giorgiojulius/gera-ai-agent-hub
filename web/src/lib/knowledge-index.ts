/**
 * Semantic layer for agent knowledge: chunk vectors from the gateway
 * embeddings API, cached in IndexedDB by content hash, fused with keyword
 * scores at retrieval time (reciprocal-rank fusion). Cloud-stored docs are
 * resolved to their full R2 text first (knowledge-store.ts). Honest failure
 * mode: any error — offline, gateway down, IndexedDB unavailable — degrades
 * to the pure keyword retrieval in knowledge.ts, never blocks the turn.
 */

import { logDiagnostic } from "@/lib/diagnostics";
import {
  RETRIEVAL_BUDGET_CHARS,
  chunkKnowledge,
  cosineSimilarity,
  fuseScores,
  keywordScoreChunks,
  knowledgeChars,
  knowledgeHeader,
  noMatchMessage,
  packExcerpts,
  retrieveKnowledge,
  type KnowledgeChunk,
} from "@/lib/knowledge";
import { resolveKnowledgeDocs } from "@/lib/knowledge-store";
import { toolkitFetch } from "@/lib/toolkit";
import type { KnowledgeDoc } from "@/lib/types";

const EMBED_MODEL = "openai/text-embedding-3-small";
const EMBED_BATCH = 64;
/** Max chunks embedded inline during one retrieval — the rest index in background. */
const MAX_INLINE_EMBEDS = 128;
const RETRIEVAL_EMBED_TIMEOUT_MS = 12_000;
const WARM_TIMEOUT_MS = 120_000;
/** Cosine floor below which a vector match is treated as noise, not signal. */
const VECTOR_SIM_FLOOR = 0.18;

// ------------------------------------------------------------ vector cache

const DB_NAME = "gera-knowledge-vectors";
const STORE = "vectors";
const MAX_CACHE_ENTRIES = 2_400;
const PRUNE_TO = 2_000;

type VectorRow = { key: string; vec: ArrayBuffer; at: number };

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "key" });
          store.createIndex("at", "at");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function readVectors(keys: string[]): Promise<Map<string, Float32Array>> {
  const out = new Map<string, Float32Array>();
  const db = await openDb();
  if (!db || keys.length === 0) {
    return out;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      let pending = keys.length;
      const settle = () => {
        pending -= 1;
        if (pending === 0) {
          resolve(out);
        }
      };
      for (const key of keys) {
        const request = store.get(key);
        request.onsuccess = () => {
          const row = request.result as VectorRow | undefined;
          if (row && row.vec instanceof ArrayBuffer && row.vec.byteLength > 0) {
            out.set(key, new Float32Array(row.vec));
          }
          settle();
        };
        request.onerror = settle;
      }
    } catch {
      resolve(out);
    }
  });
}

async function writeVectors(rows: { key: string; vec: Float32Array }[]): Promise<void> {
  const db = await openDb();
  if (!db || rows.length === 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const at = Date.now();
      for (const row of rows) {
        store.put({ key: row.key, vec: row.vec.buffer as ArrayBuffer, at });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  void pruneCache(db);
}

let pruning = false;

/** Keeps the cache bounded: when past the cap, oldest rows go first. */
async function pruneCache(db: IDBDatabase): Promise<void> {
  if (pruning) {
    return;
  }
  pruning = true;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const countRequest = store.count();
      countRequest.onsuccess = () => {
        if (countRequest.result <= MAX_CACHE_ENTRIES) {
          resolve();
          return;
        }
        let toDelete = countRequest.result - PRUNE_TO;
        const cursorRequest = store.index("at").openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || toDelete <= 0) {
            resolve();
            return;
          }
          cursor.delete();
          toDelete -= 1;
          cursor.continue();
        };
        cursorRequest.onerror = () => resolve();
      };
      countRequest.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // best-effort
  } finally {
    pruning = false;
  }
}

// ------------------------------------------------------------- embeddings

/** Content-addressed cache key: same text + model ⇒ same vector, everywhere. */
async function chunkKey(text: string): Promise<string> {
  const payload = `${EMBED_MODEL}\n${text}`;
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  // FNV-1a fallback for non-secure contexts — weaker, but only a cache key.
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv-${(hash >>> 0).toString(16)}-${payload.length}`;
}

type EmbeddingResponse = { data?: { embedding?: number[] }[] };

/** One embeddings call; null on ANY failure so callers can degrade quietly. */
async function embedBatch(input: string[], signal: AbortSignal): Promise<Float32Array[] | null> {
  try {
    const response = await toolkitFetch("/v2/vercel/v1/embeddings", {
      method: "POST",
      retry: false,
      signal,
      body: JSON.stringify({ model: EMBED_MODEL, input }),
    });
    if (!response.ok) {
      logDiagnostic(
        "api",
        `HTTP ${response.status} · /v2/vercel/v1/embeddings`,
        (await response.text()).slice(0, 300),
      );
      return null;
    }
    const json = (await response.json()) as EmbeddingResponse;
    const rows = json.data ?? [];
    if (rows.length !== input.length) {
      return null;
    }
    const out: Float32Array[] = [];
    for (const row of rows) {
      if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
        return null;
      }
      out.push(Float32Array.from(row.embedding));
    }
    return out;
  } catch {
    return null; // offline / abort — keyword retrieval takes over
  }
}

/**
 * Vectors for chunks, aligned by index: cache hits first, then up to
 * `maxEmbeds` misses embedded inline (batched) and persisted. Chunks left
 * without a vector return null and compete on keyword score alone.
 */
async function vectorsForChunks(
  chunks: KnowledgeChunk[],
  maxEmbeds: number,
  signal: AbortSignal,
): Promise<(Float32Array | null)[]> {
  const keys = await Promise.all(chunks.map((chunk) => chunkKey(chunk.text)));
  const cached = await readVectors(keys);
  const result: (Float32Array | null)[] = keys.map((key) => cached.get(key) ?? null);
  const missing: number[] = [];
  result.forEach((vec, index) => {
    if (!vec) {
      missing.push(index);
    }
  });
  const inline = missing.slice(0, Math.max(0, maxEmbeds));
  for (let start = 0; start < inline.length; start += EMBED_BATCH) {
    const slice = inline.slice(start, start + EMBED_BATCH);
    const vectors = await embedBatch(slice.map((index) => chunks[index].text), signal);
    if (!vectors) {
      break; // partial index is fine — keyword scores cover the rest
    }
    const rows: { key: string; vec: Float32Array }[] = [];
    slice.forEach((chunkIndex, j) => {
      result[chunkIndex] = vectors[j];
      rows.push({ key: keys[chunkIndex], vec: vectors[j] });
    });
    await writeVectors(rows);
  }
  return result;
}

const warmInFlight = new Set<string>();

/**
 * Warms the vector cache for a knowledge base (fire-and-forget from upload
 * and retrieval). Never throws; concurrent calls for the same docs coalesce.
 */
export async function indexKnowledgeDocs(docs: KnowledgeDoc[]): Promise<void> {
  const usable = docs.filter((doc) => doc.text.trim().length > 0);
  if (usable.length === 0) {
    return;
  }
  const fingerprint = usable.map((doc) => `${doc.id}:${doc.fullChars ?? doc.text.length}`).join("|");
  if (warmInFlight.has(fingerprint)) {
    return;
  }
  warmInFlight.add(fingerprint);
  try {
    const resolved = await resolveKnowledgeDocs(usable);
    await vectorsForChunks(
      chunkKnowledge(resolved),
      Number.MAX_SAFE_INTEGER,
      AbortSignal.timeout(WARM_TIMEOUT_MS),
    );
  } catch {
    // background warm-up is best-effort
  } finally {
    warmInFlight.delete(fingerprint);
  }
}

// -------------------------------------------------------------- retrieval

/**
 * Hybrid retrieval: keyword scores fused with semantic similarity (RRF).
 * Falls back to keyword-only retrieval whenever embeddings are unavailable,
 * so a turn is never blocked by the semantic layer. Same contract as
 * `retrieveKnowledge` — returns "" when there is nothing to inject.
 */
export async function retrieveKnowledgeSmart(docs: KnowledgeDoc[], query: string): Promise<string> {
  const usable = docs.filter((doc) => doc.text.trim().length > 0);
  if (usable.length === 0) {
    return "";
  }
  // Cloud-stored docs resolve to their full R2 text first (IndexedDB-cached);
  // failures fall back to that doc's local excerpt — never blocks the turn.
  const resolved = await resolveKnowledgeDocs(usable);
  if (knowledgeChars(resolved) <= RETRIEVAL_BUDGET_CHARS) {
    return retrieveKnowledge(resolved, query); // whole-base injection — nothing to rank
  }
  try {
    const signal = AbortSignal.timeout(RETRIEVAL_EMBED_TIMEOUT_MS);
    const queryVectors = await embedBatch([query.slice(0, 4_000)], signal);
    const queryVec = queryVectors?.[0];
    if (!queryVec) {
      return retrieveKnowledge(resolved, query);
    }
    const chunks = chunkKnowledge(resolved);
    const vectors = await vectorsForChunks(chunks, MAX_INLINE_EMBEDS, signal);
    if (vectors.some((vec) => vec === null)) {
      void indexKnowledgeDocs(usable); // heal the index in the background
    }
    const sims = vectors.map((vec) => {
      if (!vec) {
        return null;
      }
      const sim = cosineSimilarity(queryVec, vec);
      return sim >= VECTOR_SIM_FLOOR ? sim : null;
    });
    if (sims.every((sim) => sim === null)) {
      return retrieveKnowledge(resolved, query); // vectors said nothing — keyword path as before
    }
    const fused = fuseScores(keywordScoreChunks(chunks, query), sims);
    const ranked = fused
      .map((score, index) => ({ score, index }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => chunks[entry.index]);
    const header = knowledgeHeader("hybrid");
    if (ranked.length === 0) {
      return noMatchMessage(resolved, header);
    }
    return `${header}\n\n${packExcerpts(ranked, RETRIEVAL_BUDGET_CHARS)}`;
  } catch {
    return retrieveKnowledge(resolved, query);
  }
}
