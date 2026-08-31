import { KNOWLEDGE_FILE_ACCEPT } from "@/lib/file-extract";
import type { CreateMode } from "@/lib/types";

/**
 * Accept list shared by the composer's file input and its drag-and-drop zone.
 * `null` means the mode takes no local files (audio always; video when the
 * picked model is link-only).
 */
export function composerAccept(mode: CreateMode, videoTakesFiles: boolean): string | null {
  if (mode === "chat") {
    return `image/*,${KNOWLEDGE_FILE_ACCEPT}`;
  }
  if (mode === "image") {
    return "image/*";
  }
  if (mode === "video") {
    return videoTakesFiles ? "image/*" : null;
  }
  return null;
}

/**
 * Mirrors `<input accept>` semantics for dropped files: comma-separated
 * entries are `.ext` suffixes, `type/*` families, or exact MIME types.
 * Case-insensitive; blank entries are ignored.
 */
export function matchesAccept(name: string, mime: string, accept: string): boolean {
  const fileName = name.toLowerCase();
  const fileMime = mime.toLowerCase();
  return accept
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .some((entry) => {
      if (entry.startsWith(".")) {
        return fileName.endsWith(entry);
      }
      if (entry.endsWith("/*")) {
        return fileMime.startsWith(entry.slice(0, -1));
      }
      return fileMime === entry;
    });
}

/** Keeps only the droppable files; a `null` accept keeps nothing. */
export function filterDroppedFiles<T extends { name: string; type: string }>(
  files: T[],
  accept: string | null,
): T[] {
  if (!accept) {
    return [];
  }
  return files.filter((file) => matchesAccept(file.name, file.type, accept));
}
