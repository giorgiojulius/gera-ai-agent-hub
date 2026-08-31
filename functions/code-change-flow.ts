import type {
  RunCodeChangeFile,
  RunCodeChangeState,
  RunCodePreview,
  RunCodeValidation,
  RunToolRecord,
} from "./run-protocol";

const MAX_FILES = 24;
const MAX_DIFF_CHARS = 30_000;
const MAX_DIFF_LINES = 500;
const MAX_PREVIEW_CHARS = 180_000;
const MAX_ERROR_CHARS = 300;
const URL_PATTERN = /https:\/\/[^\s<>"')\]]+/gi;

const TOOL_NAMES = [
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
  "list_workflow_runs",
  "list_deployments",
  "get_contents",
  "read_file",
] as const;

type KnownToolName = (typeof TOOL_NAMES)[number];
type ToolArgs = Record<string, unknown>;
type DiffPiece = { kind: "same" | "add" | "delete" | "marker"; text: string };
type WriteCapture = { file: RunCodeChangeFile; content?: string };

function cap(value: string, limit: number): { text: string; truncated: boolean } {
  return value.length > limit
    ? { text: `${value.slice(0, limit)}\n… [preview truncated]`, truncated: true }
    : { text: value, truncated: false };
}

function toolTail(name: string): KnownToolName | null {
  const lower = name.toLowerCase();
  for (const candidate of TOOL_NAMES) {
    if (lower === candidate || lower.endsWith(`_${candidate}`)) {
      return candidate;
    }
  }
  return null;
}

function parseArgs(raw: string): ToolArgs | null {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ToolArgs)
      : null;
  } catch {
    return null;
  }
}

function textArg(args: ToolArgs, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function cleanLabel(value: string, limit: number): string {
  return value.replace(/[\r\n\0]/g, " ").trim().slice(0, limit);
}

function repoOf(args: ToolArgs): string {
  const owner = cleanLabel(textArg(args, "owner", "repo_owner"), 80);
  const repo = cleanLabel(textArg(args, "repo", "repository", "repo_name"), 120);
  if (owner && repo && !repo.includes("/")) {
    return `${owner}/${repo}`;
  }
  return cleanLabel(repo, 200);
}

function pathOf(args: ToolArgs): string {
  return cleanLabel(textArg(args, "path", "file_path", "filePath", "filename", "file"), 300);
}

function branchOf(args: ToolArgs, tool: KnownToolName): string {
  if (tool === "create_pull" || tool === "open_pull_request") {
    return cleanLabel(textArg(args, "head", "branch", "ref"), 180);
  }
  return cleanLabel(textArg(args, "branch", "ref", "head"), 180);
}

function languageOf(path: string): string | undefined {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  const aliases: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    json: "json",
    md: "markdown",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    sh: "bash",
    yml: "yaml",
    yaml: "yaml",
    xml: "xml",
    svg: "svg",
  };
  return aliases[extension];
}

function linesOf(value: string): string[] {
  return value.length > 0 ? value.replace(/\r\n/g, "\n").split("\n") : [];
}

function collapseSameRuns(pieces: DiffPiece[]): DiffPiece[] {
  const output: DiffPiece[] = [];
  let index = 0;
  while (index < pieces.length) {
    if (pieces[index].kind !== "same") {
      output.push(pieces[index]);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < pieces.length && pieces[end].kind === "same") {
      end += 1;
    }
    const run = pieces.slice(index, end);
    if (run.length <= 8) {
      output.push(...run);
    } else {
      output.push(...run.slice(0, 3));
      output.push({ kind: "marker", text: `… ${run.length - 6} unchanged lines …` });
      output.push(...run.slice(-3));
    }
    index = end;
  }
  return output;
}

function fallbackDiff(before: string[], after: string[]): DiffPiece[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return [
    ...before.slice(0, prefix).map((text): DiffPiece => ({ kind: "same", text })),
    ...before.slice(prefix, before.length - suffix).map((text): DiffPiece => ({ kind: "delete", text })),
    ...after.slice(prefix, after.length - suffix).map((text): DiffPiece => ({ kind: "add", text })),
    ...before.slice(before.length - suffix).map((text): DiffPiece => ({ kind: "same", text })),
  ];
}

/** Bounded line diff: LCS for normal files, prefix/suffix fallback for giant files. */
export function buildCodePatch(beforeText: string, afterText: string): {
  patch: string;
  additions: number;
  deletions: number;
  truncated: boolean;
} {
  const before = linesOf(beforeText);
  const after = linesOf(afterText);
  let pieces: DiffPiece[];
  if (before.length <= MAX_DIFF_LINES && after.length <= MAX_DIFF_LINES) {
    const width = after.length + 1;
    const table = new Uint16Array((before.length + 1) * width);
    for (let left = before.length - 1; left >= 0; left -= 1) {
      for (let right = after.length - 1; right >= 0; right -= 1) {
        const at = left * width + right;
        table[at] = before[left] === after[right]
          ? table[(left + 1) * width + right + 1] + 1
          : Math.max(table[(left + 1) * width + right], table[left * width + right + 1]);
      }
    }
    pieces = [];
    let left = 0;
    let right = 0;
    while (left < before.length && right < after.length) {
      if (before[left] === after[right]) {
        pieces.push({ kind: "same", text: before[left] });
        left += 1;
        right += 1;
      } else if (table[(left + 1) * width + right] >= table[left * width + right + 1]) {
        pieces.push({ kind: "delete", text: before[left] });
        left += 1;
      } else {
        pieces.push({ kind: "add", text: after[right] });
        right += 1;
      }
    }
    while (left < before.length) {
      pieces.push({ kind: "delete", text: before[left] });
      left += 1;
    }
    while (right < after.length) {
      pieces.push({ kind: "add", text: after[right] });
      right += 1;
    }
  } else {
    pieces = fallbackDiff(before, after);
  }
  const additions = pieces.filter((piece) => piece.kind === "add").length;
  const deletions = pieces.filter((piece) => piece.kind === "delete").length;
  const rendered = collapseSameRuns(pieces)
    .map((piece) => `${piece.kind === "add" ? "+" : piece.kind === "delete" ? "-" : piece.kind === "marker" ? "@@" : " "}${piece.text}`)
    .join("\n");
  const bounded = cap(rendered, MAX_DIFF_CHARS);
  return { patch: bounded.text, additions, deletions, truncated: bounded.truncated };
}

function extractReadBody(call: RunToolRecord): string | null {
  if (call.status !== "done" || typeof call.result !== "string") {
    return null;
  }
  const split = call.result.indexOf(":\n");
  if (toolTail(call.name) === "get_contents") {
    return split >= 0 ? call.result.slice(split + 2) : null;
  }
  return call.result;
}

function matchingBefore(calls: RunToolRecord[], writeIndex: number, args: ToolArgs): string | null {
  const path = pathOf(args);
  const repository = repoOf(args);
  for (let index = writeIndex - 1; index >= 0; index -= 1) {
    const call = calls[index];
    const tool = toolTail(call.name);
    if (tool !== "get_contents" && tool !== "read_file") {
      continue;
    }
    const readArgs = parseArgs(call.arguments);
    if (!readArgs || pathOf(readArgs) !== path) {
      continue;
    }
    const readRepository = repoOf(readArgs);
    if (repository && readRepository && repository !== readRepository) {
      continue;
    }
    const body = extractReadBody(call);
    if (body !== null) {
      return body;
    }
  }
  return null;
}

function explicitPatch(raw: string): { patch: string; additions: number; deletions: number; truncated: boolean } {
  const bounded = cap(raw, MAX_DIFF_CHARS);
  const lines = linesOf(raw);
  return {
    patch: bounded.text,
    additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
    truncated: bounded.truncated,
  };
}

function fileFromCall(calls: RunToolRecord[], index: number): WriteCapture | null {
  const call = calls[index];
  const tool = toolTail(call.name);
  if (
    tool !== "put_file" &&
    tool !== "write_file" &&
    tool !== "create_or_update_file" &&
    tool !== "update_file" &&
    tool !== "apply_patch" &&
    tool !== "delete_file" &&
    tool !== "remove_file"
  ) {
    return null;
  }
  const args = parseArgs(call.arguments);
  if (!args) {
    return null;
  }
  const path = pathOf(args);
  if (!path) {
    return null;
  }
  const before = matchingBefore(calls, index, args);
  const isDelete = tool === "delete_file" || tool === "remove_file";
  const isPatch = tool === "apply_patch";
  const content = textArg(args, "content", "new_content", "newContent", "text");
  const rawPatch = textArg(args, "patch", "diff");
  let action: RunCodeChangeFile["action"] = isDelete
    ? "delete"
    : isPatch
      ? "patch"
      : textArg(args, "expected_sha", "sha") || before !== null || /^Updated\b/i.test(call.result ?? "")
        ? "update"
        : "create";
  if (/^Created\b/i.test(call.result ?? "")) {
    action = "create";
  }
  const diff = isPatch && rawPatch
    ? explicitPatch(rawPatch)
    : isDelete
      ? before !== null
        ? buildCodePatch(before, "")
        : { patch: "@@ File deleted; its previous body was not read in this run.", additions: 0, deletions: 0, truncated: false }
      : buildCodePatch(before ?? "", content);
  return {
    file: {
      id: call.id,
      path,
      action,
      status: call.status,
      ...(languageOf(path) ? { language: languageOf(path) } : {}),
      additions: diff.additions,
      deletions: diff.deletions,
      ...(diff.patch ? { patch: diff.patch } : {}),
      ...(diff.truncated ? { truncated: true } : {}),
      ...(call.status === "error" && call.result
        ? { error: cleanLabel(call.result, MAX_ERROR_CHARS) }
        : {}),
    },
    ...(!isDelete && !isPatch ? { content } : {}),
  };
}

function safeHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value.replace(/[.,;:!?]+$/, ""));
    if (url.protocol !== "https:" || url.username || url.password) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function urlsIn(value: string): string[] {
  return (value.match(URL_PATTERN) ?? []).flatMap((raw) => {
    const safe = safeHttpsUrl(raw);
    return safe ? [safe] : [];
  });
}

function isGitHubControlUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === "api.github.com" ||
      (url.hostname === "github.com" && (/\/pull\/\d+/.test(url.pathname) || url.pathname.includes("/actions/")));
  } catch {
    return true;
  }
}

function previewFromCalls(calls: RunToolRecord[], htmlPreview?: RunCodePreview): RunCodePreview | undefined {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    const tool = toolTail(call.name);
    const looksLikePreview = tool === "list_deployments" || /(?:preview|deploy)/i.test(call.name);
    if (!looksLikePreview || call.status !== "done" || !call.result) {
      continue;
    }
    const url = urlsIn(call.result).find((candidate) => !isGitHubControlUrl(candidate));
    if (url) {
      return { kind: "url", label: "Live deployment", url };
    }
  }
  return htmlPreview;
}

function pullRequestUrl(calls: RunToolRecord[]): string | undefined {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    const tool = toolTail(call.name);
    if ((tool === "create_pull" || tool === "open_pull_request") && call.status === "done" && call.result) {
      return urlsIn(call.result).find((url) => /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url));
    }
  }
  return undefined;
}

function validationFromCalls(calls: RunToolRecord[]): RunCodeValidation | undefined {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    const tool = toolTail(call.name);
    if (tool !== "list_workflow_runs" && !/(?:test|check|build|verify|workflow)/i.test(call.name)) {
      continue;
    }
    if (call.status === "running") {
      return { status: "running", label: "Verification running" };
    }
    if (call.status === "error") {
      return { status: "failed", label: "Verification failed" };
    }
    const result = call.result ?? "";
    const url = urlsIn(result).find((candidate) => candidate.includes("/actions/"));
    if (/\[(?:success|passed)\]|\b(?:tests? passed|build succeeded|checks? passed)\b/i.test(result)) {
      return { status: "passed", label: "Checks passed", ...(url ? { url } : {}) };
    }
    if (/\[(?:failure|failed|cancelled|timed_out)\]|\b(?:tests? failed|build failed)\b/i.test(result)) {
      return { status: "failed", label: "Checks failed", ...(url ? { url } : {}) };
    }
    return { status: "unknown", label: "Verification checked", ...(url ? { url } : {}) };
  }
  return undefined;
}

function normalizeRelativePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function resolvePreviewAsset(htmlPath: string, reference: string): string | null {
  const clean = reference.split(/[?#]/, 1)[0] ?? "";
  if (!clean || /^(?:[a-z]+:|\/\/|#)/i.test(clean)) {
    return null;
  }
  if (clean.startsWith("/")) {
    return normalizeRelativePath(clean);
  }
  const directory = htmlPath.includes("/") ? htmlPath.slice(0, htmlPath.lastIndexOf("/") + 1) : "";
  return normalizeRelativePath(`${directory}${clean}`);
}

function inlineLocalPreviewAssets(html: string, htmlPath: string, writes: WriteCapture[]): string {
  const contentByPath = new Map<string, string>();
  for (const item of writes) {
    if (item.file.status === "done" && typeof item.content === "string") {
      contentByPath.set(normalizeRelativePath(item.file.path), item.content);
    }
  }
  const lookup = (reference: string): string | undefined => {
    const resolved = resolvePreviewAsset(htmlPath, reference);
    if (!resolved) {
      return undefined;
    }
    const direct = contentByPath.get(resolved);
    if (direct !== undefined) {
      return direct;
    }
    const matches = [...contentByPath.entries()].filter(([path]) => path.endsWith(`/${resolved}`));
    return matches.length === 1 ? matches[0][1] : undefined;
  };
  const withStyles = html.replace(
    /<link\b([^>]*?)href=(['"])([^'"]+)\2([^>]*)>/gi,
    (full, before: string, _quote: string, href: string, after: string) => {
      const css = lookup(href);
      const attrs = `${before} ${after}`.toLowerCase();
      if (css === undefined || (!attrs.includes("stylesheet") && !href.toLowerCase().split(/[?#]/, 1)[0]?.endsWith(".css"))) {
        return full;
      }
      return `<style data-gera-source="${href.replace(/["<>]/g, "")}">${css.replace(/<\/style/gi, "<\\/style")}</style>`;
    },
  );
  return withStyles.replace(
    /<script\b([^>]*?)src=(['"])([^'"]+)\2([^>]*)>\s*<\/script>/gi,
    (full, before: string, _quote: string, src: string, after: string) => {
      const js = lookup(src);
      if (js === undefined) {
        return full;
      }
      const attrs = `${before} ${after}`.replace(/\s+/g, " ").trim();
      return `<script${attrs ? ` ${attrs}` : ""} data-gera-source="${src.replace(/["<>]/g, "")}">${js.replace(/<\/script/gi, "<\\/script")}</script>`;
    },
  );
}

function htmlPreviewFromWrites(writes: WriteCapture[]): RunCodePreview | undefined {
  const runnable = writes.filter(
    (item) => item.file.status === "done" && item.file.language === "html" && typeof item.content === "string",
  );
  const newestFirst = [...runnable].reverse();
  const chosen = newestFirst.find((item) => /(?:^|\/)index\.html?$/i.test(item.file.path)) ?? newestFirst[0];
  if (!chosen?.content || chosen.content.length > MAX_PREVIEW_CHARS) {
    return undefined;
  }
  const lower = chosen.content.toLowerCase();
  if (!lower.includes("<html") && !lower.includes("<!doctype") && !lower.includes("<body")) {
    return undefined;
  }
  const html = inlineLocalPreviewAssets(chosen.content, chosen.file.path, writes);
  return html.length <= MAX_PREVIEW_CHARS
    ? { kind: "html", label: chosen.file.path, html }
    : undefined;
}

function mergeFiles(previous: RunCodeChangeState | undefined, current: RunCodeChangeFile[]): RunCodeChangeFile[] {
  const byPath = new Map<string, RunCodeChangeFile>();
  for (const file of previous?.files ?? []) {
    byPath.set(file.path, file);
  }
  for (const file of current) {
    // A file may be committed more than once in one turn; the workbench is a
    // touched-file ledger, so keep its newest committed shape rather than
    // showing duplicate rows for intermediate commits.
    byPath.delete(file.path);
    byPath.set(file.path, file);
  }
  return [...byPath.values()].slice(-MAX_FILES);
}

/** True for mutation/branch/PR rows represented by the richer workbench card. */
export function isCodeMutationToolName(name: string): boolean {
  const tool = toolTail(name);
  return tool === "create_branch" ||
    tool === "put_file" ||
    tool === "write_file" ||
    tool === "create_or_update_file" ||
    tool === "update_file" ||
    tool === "apply_patch" ||
    tool === "delete_file" ||
    tool === "remove_file" ||
    tool === "create_pull" ||
    tool === "open_pull_request";
}

/**
 * Converts repository tool records into a bounded, credential-free live edit
 * ledger. `previous` keeps completed rows visible while the next tool's JSON
 * arguments are still streaming; the final rebuild passes no previous state.
 */
export function deriveCodeChangeFlow(
  calls: RunToolRecord[],
  startedAt: number,
  previous?: RunCodeChangeState,
): RunCodeChangeState | undefined {
  const hasMutation = calls.some((call) => isCodeMutationToolName(call.name));
  if (!hasMutation && !previous) {
    return undefined;
  }
  const writes = calls.flatMap((_, index) => {
    const capture = fileFromCall(calls, index);
    return capture ? [capture] : [];
  });
  const files = mergeFiles(previous, writes.map((item) => item.file));
  let repository = previous?.repository;
  let branch = previous?.branch;
  for (const call of calls) {
    if (!isCodeMutationToolName(call.name)) {
      continue;
    }
    const args = parseArgs(call.arguments);
    const tool = toolTail(call.name);
    if (!args || !tool) {
      continue;
    }
    repository = repoOf(args) || repository;
    branch = branchOf(args, tool) || branch;
  }
  const htmlPreview = htmlPreviewFromWrites(writes);
  return {
    status: "running",
    files,
    startedAt: previous?.startedAt ?? startedAt,
    ...(repository ? { repository } : {}),
    ...(branch ? { branch } : {}),
    ...(pullRequestUrl(calls) ?? previous?.pullRequestUrl
      ? { pullRequestUrl: pullRequestUrl(calls) ?? previous?.pullRequestUrl }
      : {}),
    ...(previewFromCalls(calls, htmlPreview) ?? previous?.preview
      ? { preview: previewFromCalls(calls, htmlPreview) ?? previous?.preview }
      : {}),
    ...(validationFromCalls(calls) ?? previous?.validation
      ? { validation: validationFromCalls(calls) ?? previous?.validation }
      : {}),
  };
}

/** Combines code work created before and after a resumed assistant turn. */
export function mergeRunCodeChangeStates(
  base: RunCodeChangeState | undefined,
  next: RunCodeChangeState | undefined,
): RunCodeChangeState | undefined {
  if (!base) {
    return next;
  }
  if (!next) {
    return base;
  }
  const byPath = new Map(base.files.map((file) => [file.path, file]));
  for (const file of next.files) {
    byPath.delete(file.path);
    byPath.set(file.path, file);
  }
  return {
    ...base,
    ...next,
    files: [...byPath.values()].slice(-MAX_FILES),
    startedAt: Math.min(base.startedAt, next.startedAt),
    repository: next.repository ?? base.repository,
    branch: next.branch ?? base.branch,
    pullRequestUrl: next.pullRequestUrl ?? base.pullRequestUrl,
    preview: next.preview ?? base.preview,
    validation: next.validation ?? base.validation,
  };
}

/** Rebuilds from settled records, removes ghost writes, and seals the status. */
export function finalizeCodeChangeFlow(
  calls: RunToolRecord[],
  startedAt: number,
  previous?: RunCodeChangeState,
): RunCodeChangeState | undefined {
  const rebuilt = deriveCodeChangeFlow(calls, startedAt);
  const flow = rebuilt ?? previous;
  if (!flow) {
    return undefined;
  }
  const failed = flow.files.some((file) => file.status === "error") ||
    calls.some((call) => isCodeMutationToolName(call.name) && call.status === "error");
  return { ...flow, status: failed ? "error" : "done" };
}
