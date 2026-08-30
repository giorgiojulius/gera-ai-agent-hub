/**
 * Cloud layer for agent knowledge — the full text of large docs lives as an
 * R2 object under the account's private prefix (its key in
 * `KnowledgeDoc.r2Key`), while the synced profile blob keeps only a short
 * local excerpt. This module asks the backend for short-lived presigned
 * URLs, PUTs/GETs bytes directly against R2, caches full texts in
 * IndexedDB, and resolves docs to their full text with an honest per-doc
 * fallback to the local excerpt. Nothing here ever blocks a chat turn.
 */

import { authedFetch } from "@/lib/backend";
import { logDiagnostic } from "@/lib/diagnostics";
import type { KnowledgeDoc } from "@/lib/types";

const FETCH_TIMEOUT_MS = 20_000;
/** Client-side mirror of the backend's upload ceiling. */
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------- full-text IDB cache

const DB_NAME = "gera-knowledge-texts";
const STORE = "texts";
const MAX_CACHE_ENTRIES = 32;
const PRUNE_TO = 24;

type TextRow = { key: string; text: string; at: number };

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

async function readCached(key: string): Promise<string | null> {
  const db = await openDb();
  if (!db) {
    return null;
  }
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      request.onsuccess = () => {
        const row = request.result as TextRow | undefined;
        resolve(row && typeof row.text === "string" && row.text.length > 0 ? row.text : null);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function writeCached(key: string, text: string): Promise<void> {
  const db = await openDb();
  if (!db) {
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ key, text, at: Date.now() } satisfies TextRow);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  void pruneCache(db);
}

async function removeCached(key: string): Promise<void> {
  const db = await openDb();
  if (!db) {
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

let pruning = false;

/** Keeps the cache bounded: past the cap, the oldest full texts go first. */
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

// ------------------------------------------------------------ storage API

function uploadErrorMessage(status: number, body: string): string {
  if (status === 401) {
    return "Sign in to store knowledge files in the cloud.";
  }
  if (status === 403) {
    return "Cloud knowledge storage needs an invite-approved account.";
  }
  if (status === 429 || body.includes("storage_quota")) {
    return "Cloud storage quota is full — remove some knowledge files first.";
  }
  return `Cloud storage is unavailable right now (HTTP ${status}).`;
}

/**
 * Uploads a doc's full text to the account's cloud space and returns its
 * object key. Throws with a user-facing message on failure — the caller
 * decides whether to fall back to a trimmed local copy.
 */
export async function uploadKnowledgeText(docId: string, text: string): Promise<string> {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new Error("This file is too large for cloud storage.");
  }
  const minted = await authedFetch("/knowledge/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docId, contentLength: blob.size }),
  });
  if (!minted.ok) {
    const body = await minted.text().catch(() => "");
    logDiagnostic("api", `HTTP ${minted.status} · /knowledge/upload-url`, body.slice(0, 300));
    throw new Error(uploadErrorMessage(minted.status, body));
  }
  const { url, key } = (await minted.json()) as { url: string; key: string };
  const put = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: blob,
  });
  if (!put.ok) {
    logDiagnostic("api", `HTTP ${put.status} · R2 PUT`, key);
    throw new Error(`Cloud upload failed (HTTP ${put.status}). Try again.`);
  }
  void writeCached(key, text);
  return key;
}

const inflightFetches = new Map<string, Promise<string | null>>();

/**
 * Full text for a cloud-stored doc: IndexedDB cache first, then a fresh
 * presigned GET. Returns null on ANY failure so callers can degrade to the
 * local excerpt. Concurrent calls for the same key share one download.
 */
export function fetchKnowledgeText(key: string): Promise<string | null> {
  const existing = inflightFetches.get(key);
  if (existing) {
    return existing;
  }
  const task = fetchKnowledgeTextOnce(key).finally(() => inflightFetches.delete(key));
  inflightFetches.set(key, task);
  return task;
}

async function fetchKnowledgeTextOnce(key: string): Promise<string | null> {
  const cached = await readCached(key);
  if (cached) {
    return cached;
  }
  try {
    const minted = await authedFetch("/knowledge/download-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (!minted.ok) {
      logDiagnostic("api", `HTTP ${minted.status} · /knowledge/download-url`, key);
      return null;
    }
    const { url } = (await minted.json()) as { url: string };
    const got = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!got.ok) {
      return null;
    }
    const text = await got.text();
    if (text.length === 0) {
      return null;
    }
    void writeCached(key, text);
    return text;
  } catch {
    return null; // offline / timeout — the local excerpt covers this turn
  }
}

/** Best-effort delete of a cloud object plus its cache row. Never throws. */
export async function deleteKnowledgeText(key: string): Promise<void> {
  void removeCached(key);
  try {
    await authedFetch("/knowledge/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
  } catch {
    // orphaned objects are bounded by the per-account quota — acceptable
  }
}

/**
 * Resolves docs to their full text: cloud-stored docs are fetched (cache
 * first); any failure keeps that doc's local excerpt. Never throws — the
 * `fetcher` parameter exists for tests.
 */
export async function resolveKnowledgeDocs(
  docs: KnowledgeDoc[],
  fetcher: (key: string) => Promise<string | null> = fetchKnowledgeText,
): Promise<KnowledgeDoc[]> {
  return Promise.all(
    docs.map(async (doc) => {
      if (!doc.r2Key) {
        return doc;
      }
      try {
        const full = await fetcher(doc.r2Key);
        return full && full.trim().length > 0 ? { ...doc, text: full } : doc;
      } catch {
        return doc;
      }
    }),
  );
}
