// Download / open helpers for chat media. Sources may be vault refs (`idb:`),
// object URLs, remote URLs, or data URLs — everything funnels through
// resolveMediaUrl + fetch so a single code path handles all four. Downloads
// fall back to opening in a new tab when bytes are unreachable (e.g. a
// cross-origin URL without CORS headers).
import { toast } from "sonner";

import { resolveMediaUrl } from "@/lib/media-vault";

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/webm": ".weba",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "application/pdf": ".pdf",
  "application/json": ".json",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/markdown": ".md",
};

/** File extension (with dot) for a mime type; empty string when unknown. */
export function extensionForMime(mime: string): string {
  const clean = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return MIME_EXTENSIONS[clean] ?? "";
}

/** Keeps letters/digits/dot/underscore/dash; collapses everything else to single dashes. */
export function safeFileName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/-+(?=\.)/g, "")
    .replace(/^[-.]+|[-]+$/g, "");
  return cleaned || "gera-media";
}

function hasExtension(name: string): boolean {
  return /\.[a-zA-Z0-9]{1,6}$/.test(name);
}

/** Final download name: sanitized, with an extension inferred from the mime when missing. */
export function downloadFileName(baseName: string, mime: string): string {
  const safe = safeFileName(baseName);
  return hasExtension(safe) ? safe : `${safe}${extensionForMime(mime)}`;
}

async function mediaBlob(source: string): Promise<Blob | null> {
  const url = await resolveMediaUrl(source);
  if (!url) {
    return null;
  }
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    return await response.blob();
  } catch {
    return null;
  }
}

/**
 * Saves a media source to disk via a temporary object URL. Returns false when
 * the bytes are unreachable so callers can fall back to opening the URL.
 */
export async function downloadMedia(source: string, baseName: string): Promise<boolean> {
  const blob = await mediaBlob(source);
  if (!blob || blob.size === 0) {
    return false;
  }
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = downloadFileName(baseName, blob.type);
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 5_000);
  return true;
}

/**
 * Opens media in a new tab. Browsers refuse to navigate to data: URLs, so
 * those are re-wrapped as object URLs first.
 */
export async function openMediaInNewTab(source: string): Promise<boolean> {
  let url = await resolveMediaUrl(source);
  if (!url) {
    return false;
  }
  if (url.startsWith("data:")) {
    const blob = await mediaBlob(source);
    if (!blob) {
      return false;
    }
    url = URL.createObjectURL(blob);
    const revokeTarget = url;
    window.setTimeout(() => URL.revokeObjectURL(revokeTarget), 60_000);
  }
  window.open(url, "_blank", "noopener");
  return true;
}

/** Download with a graceful chain: save → open in new tab → honest toast. */
export async function downloadOrOpenMedia(source: string, baseName: string): Promise<void> {
  if (await downloadMedia(source, baseName)) {
    return;
  }
  if (await openMediaInNewTab(source)) {
    toast.info("Opened in a new tab — this file's host doesn't allow direct downloads.");
    return;
  }
  toast.error("Media unavailable", {
    description: "The file may have been cleared from this browser's storage.",
  });
}
