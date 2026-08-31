import type { CodeChangeState } from "@/lib/types";

const MUTATION_TAILS = [
  "create_branch",
  "put_file",
  "write_file",
  "create_or_update_file",
  "update_file",
  "apply_patch",
  "delete_file",
  "remove_file",
  "create_pull",
  "open_pull_request",
] as const;

/** Tool rows represented by the richer code workbench instead of generic chips. */
export function isCodeMutationToolName(name: string): boolean {
  const lower = name.toLowerCase();
  return MUTATION_TAILS.some((tail) => lower === tail || lower.endsWith(`_${tail}`));
}

/** Keeps an interrupted turn's earlier files when a continuation adds more edits. */
export function mergeCodeChangeStates(
  base: CodeChangeState | undefined,
  next: CodeChangeState | undefined,
): CodeChangeState | undefined {
  if (!base) {
    return next;
  }
  if (!next) {
    return base;
  }
  const files = new Map(base.files.map((file) => [file.id, file]));
  for (const file of next.files) {
    files.set(file.id, file);
  }
  return {
    ...base,
    ...next,
    files: [...files.values()].slice(-24),
    startedAt: Math.min(base.startedAt, next.startedAt),
    repository: next.repository ?? base.repository,
    branch: next.branch ?? base.branch,
    pullRequestUrl: next.pullRequestUrl ?? base.pullRequestUrl,
    preview: next.preview ?? base.preview,
    validation: next.validation ?? base.validation,
  };
}

/** Only public HTTPS URLs without embedded credentials may enter an iframe. */
export function safeCodePreviewUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
