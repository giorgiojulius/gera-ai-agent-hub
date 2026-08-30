// Media vault — keeps bulky media (generated images/video/audio, image
// attachments) OUT of the JS heap. Base64 data URLs used to live inline in
// React state and localStorage for every thread; a handful of generations was
// enough to balloon the tab past Chrome's memory ceiling (the "Aw, Snap"
// out-of-memory crash, typically after the machine slept). Blobs in IndexedDB
// are disk-backed: state and storage now hold tiny `idb:<key>` refs, and the
// bytes are streamed back only where they are actually needed — the visible
// <img>/<video>/<audio>, an API payload, a sync push, or a share snapshot.
//
// Every operation fails soft: if IndexedDB is unavailable, the original data
// URL keeps flowing through unchanged and the app behaves exactly as before.
import { newId } from "@/lib/env";
import type { Attachment, ChatMessage, Conversation } from "@/lib/types";

const DB_NAME = "gera-media";
const STORE = "media";
const REF_PREFIX = "idb:";

export function isVaultRef(value: string): boolean {
  return value.startsWith(REF_PREFIX);
}

function isDataUrl(value: string): boolean {
  return value.startsWith("data:");
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openVault(): Promise<IDBDatabase | null> {
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
          db.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // A wipe from another tab/devtools must not brick this session.
        db.onclose = () => {
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function idbPut(db: IDBDatabase, key: string, blob: Blob): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbKeys(db: IDBDatabase): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys();
      request.onsuccess = () =>
        resolve((request.result ?? []).filter((key): key is string => typeof key === "string"));
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

function idbDelete(db: IDBDatabase, keys: string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const key of keys) {
        store.delete(key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob | null> {
  try {
    // fetch() decodes any well-formed data: URL without manual base64 work.
    const response = await fetch(dataUrl);
    return await response.blob();
  } catch {
    return null;
  }
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/**
 * Stores a data URL as a disk-backed blob and returns an `idb:` ref.
 * Non-data URLs (remote http, existing refs) and any storage failure return
 * the input unchanged — callers never need a fallback path.
 */
export async function vaultDataUrl(value: string): Promise<string> {
  if (!isDataUrl(value)) {
    return value;
  }
  const db = await openVault();
  if (!db) {
    return value;
  }
  const blob = await dataUrlToBlob(value);
  if (!blob || blob.size === 0) {
    return value;
  }
  const key = `m_${newId()}`;
  const stored = await idbPut(db, key, blob);
  return stored ? `${REF_PREFIX}${key}` : value;
}

/** Session cache: ref → object URL. Object URLs are cheap handles to disk-backed blobs. */
const objectUrlCache = new Map<string, string>();

/** Synchronous cache lookup — lets the UI skip the resolving flicker on re-renders. */
export function cachedMediaUrl(source: string): string | null {
  if (!isVaultRef(source)) {
    return source;
  }
  return objectUrlCache.get(source) ?? null;
}

/**
 * Resolves a media source to something an <img>/<video>/<audio> can render.
 * Refs become object URLs; anything else passes through. Null = the blob is
 * gone (vault cleared) — the caller shows a placeholder.
 */
export async function resolveMediaUrl(source: string): Promise<string | null> {
  if (!isVaultRef(source)) {
    return source;
  }
  const cached = objectUrlCache.get(source);
  if (cached) {
    return cached;
  }
  const db = await openVault();
  if (!db) {
    return null;
  }
  const blob = await idbGet(db, source.slice(REF_PREFIX.length));
  if (!blob) {
    return null;
  }
  const url = URL.createObjectURL(blob);
  const raced = objectUrlCache.get(source);
  if (raced) {
    URL.revokeObjectURL(url);
    return raced;
  }
  objectUrlCache.set(source, url);
  return url;
}

/** Resolves a media source back to a data URL — for API payloads, sync, and shares. */
export async function resolveMediaDataUrl(source: string): Promise<string | null> {
  if (!isVaultRef(source)) {
    return source;
  }
  const db = await openVault();
  if (!db) {
    return null;
  }
  const blob = await idbGet(db, source.slice(REF_PREFIX.length));
  if (!blob) {
    return null;
  }
  return blobToDataUrl(blob);
}

async function vaultAttachment(attachment: Attachment): Promise<Attachment> {
  if (!isDataUrl(attachment.dataUrl)) {
    return attachment;
  }
  const ref = await vaultDataUrl(attachment.dataUrl);
  return ref === attachment.dataUrl ? attachment : { ...attachment, dataUrl: ref };
}

/** Moves every inline data URL of a message into the vault. Same reference when untouched. */
export async function vaultMessageMedia(message: ChatMessage): Promise<ChatMessage> {
  const hasMedia =
    message.images?.some(isDataUrl) === true ||
    message.videos?.some(isDataUrl) === true ||
    (message.audioUrl !== undefined && isDataUrl(message.audioUrl)) ||
    message.attachments?.some((item) => isDataUrl(item.dataUrl)) === true;
  if (!hasMedia) {
    return message;
  }
  const [images, videos, audioUrl, attachments] = await Promise.all([
    message.images ? Promise.all(message.images.map(vaultDataUrl)) : Promise.resolve(undefined),
    message.videos ? Promise.all(message.videos.map(vaultDataUrl)) : Promise.resolve(undefined),
    message.audioUrl ? vaultDataUrl(message.audioUrl) : Promise.resolve(undefined),
    message.attachments
      ? Promise.all(message.attachments.map(vaultAttachment))
      : Promise.resolve(undefined),
  ]);
  return { ...message, images, videos, audioUrl, attachments };
}

/**
 * The reverse: refs back to inline data URLs so the payload is complete
 * off-device (cloud sync, share snapshots). Refs whose blob is gone are
 * dropped instead of leaking dangling `idb:` strings to other devices.
 */
export async function inlineMessageMedia(message: ChatMessage): Promise<ChatMessage> {
  const hasRefs =
    message.images?.some(isVaultRef) === true ||
    message.videos?.some(isVaultRef) === true ||
    (message.audioUrl !== undefined && isVaultRef(message.audioUrl)) ||
    message.attachments?.some((item) => isVaultRef(item.dataUrl)) === true;
  if (!hasRefs) {
    return message;
  }
  const inlineList = async (list: string[] | undefined): Promise<string[] | undefined> => {
    if (!list) {
      return undefined;
    }
    const resolved = await Promise.all(list.map(resolveMediaDataUrl));
    return resolved.filter((item): item is string => item !== null);
  };
  const [images, videos, audioUrl, attachments] = await Promise.all([
    inlineList(message.images),
    inlineList(message.videos),
    message.audioUrl ? resolveMediaDataUrl(message.audioUrl) : Promise.resolve(undefined),
    message.attachments
      ? Promise.all(
          message.attachments.map(async (item) => {
            if (!isVaultRef(item.dataUrl)) {
              return item;
            }
            const dataUrl = await resolveMediaDataUrl(item.dataUrl);
            return { ...item, dataUrl: dataUrl ?? "" };
          }),
        )
      : Promise.resolve(undefined),
  ]);
  return { ...message, images, videos, audioUrl: audioUrl ?? undefined, attachments };
}

/**
 * Prepares thread history for an API call: image attachments referenced by
 * `idb:` refs are inlined as data URLs (vision parts need real bytes). The
 * result is transient — it lives only for the duration of the turn.
 */
export async function resolveMessagesForApi(messages: ChatMessage[]): Promise<ChatMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      if (!message.attachments?.some((item) => isVaultRef(item.dataUrl))) {
        return message;
      }
      const attachments = await Promise.all(
        message.attachments.map(async (item) => {
          if (!isVaultRef(item.dataUrl)) {
            return item;
          }
          const dataUrl = await resolveMediaDataUrl(item.dataUrl);
          return { ...item, dataUrl: dataUrl ?? "" };
        }),
      );
      return { ...message, attachments };
    }),
  );
}

/** Vaults every message of a conversation; same reference when nothing changed. */
export async function vaultConversationMedia(conversation: Conversation): Promise<Conversation> {
  const messages = await Promise.all(conversation.messages.map(vaultMessageMedia));
  const changed = messages.some((message, index) => message !== conversation.messages[index]);
  return changed ? { ...conversation, messages } : conversation;
}

/**
 * One-time boot migration: moves legacy inline data URLs (persisted by older
 * versions) into the vault. Returns original → migrated pairs so the caller
 * can swap by object identity and never clobber a thread that changed
 * (e.g. started streaming) while this ran.
 */
export async function migrateConversationsToVault(
  conversations: Conversation[],
): Promise<Map<Conversation, Conversation>> {
  const replacements = new Map<Conversation, Conversation>();
  for (const conversation of conversations) {
    const migrated = await vaultConversationMedia(conversation);
    if (migrated !== conversation) {
      replacements.set(conversation, migrated);
    }
  }
  return replacements;
}

function collectRefs(conversations: Conversation[], extra: string[]): Set<string> {
  const keys = new Set<string>();
  const note = (value: string | undefined) => {
    if (value && isVaultRef(value)) {
      keys.add(value.slice(REF_PREFIX.length));
    }
  };
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      message.images?.forEach(note);
      message.videos?.forEach(note);
      note(message.audioUrl);
      message.attachments?.forEach((item) => note(item.dataUrl));
    }
  }
  extra.forEach(note);
  return keys;
}

/**
 * Garbage collection: deletes blobs no live thread references (deleted chats,
 * abandoned composer attachments, incognito threads from past sessions).
 * Runs at boot, after migration — never on the hot path.
 */
export async function pruneMediaVault(
  conversations: Conversation[],
  extraRefs: string[] = [],
): Promise<void> {
  const db = await openVault();
  if (!db) {
    return;
  }
  const keep = collectRefs(conversations, extraRefs);
  const all = await idbKeys(db);
  const orphans = all.filter((key) => !keep.has(key));
  if (orphans.length > 0) {
    await idbDelete(db, orphans);
  }
}
