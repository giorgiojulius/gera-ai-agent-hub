// Public shares are intentionally readable without identity. Repository
// preview ids are bearer capabilities, so defense in depth strips them on
// both write and read, including snapshots from old or alternative clients.

/** Recursively removes every repository-preview capability from a share payload. */
export function stripRepoPreviewCapabilities(value: unknown, depth = 0): unknown {
  if (depth > 24) return null;
  if (Array.isArray(value)) {
    return value.map((item) => stripRepoPreviewCapabilities(item, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const hadRepoPreview = Object.prototype.hasOwnProperty.call(source, "repoPreview");
  for (const [key, item] of Object.entries(source)) {
    if (key === "repoPreview") continue;
    result[key] = stripRepoPreviewCapabilities(item, depth + 1);
  }
  if (hadRepoPreview && (typeof result.content !== "string" || !result.content.trim())) {
    result.content = "Repository preview details stay private to the account that launched it.";
  }
  return result;
}
