// Platform-neutral contract for launching GitHub web repositories through
// Gera's Rork backend. The Worker owns auth, lifecycle and R2 delivery; a tiny
// repository workflow supplies isolated build compute without receiving any
// Gera/Rork credential.

export const REPO_PREVIEW_RUNNER_VERSION = 3;
export const REPO_PREVIEW_WORKFLOW_PATH = ".github/workflows/gera-web-preview.yml";
export const REPO_PREVIEW_TTL_MS = 24 * 60 * 60_000;
export const REPO_PREVIEW_RUNNER_TTL_MS = 45 * 60_000;
export const REPO_PREVIEW_MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const REPO_PREVIEW_MAX_FILES = 1_000;
export const REPO_PREVIEW_MAX_LOG_CHARS = 120_000;

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const SAFE_REF_PATTERN = /^[A-Za-z0-9._/-]{1,180}$/;
const PREVIEW_ID_PATTERN = /^[a-f0-9]{24}\.[A-Za-z0-9_-]{32,64}\.[a-f0-9]{24}$/;
const PREVIEW_ACCESS_PATTERN = /^[a-f0-9]{48}$/;

export type RepoPreviewPhase =
  | "queued"
  | "installing"
  | "building"
  | "packaging"
  | "uploading"
  | "ready"
  | "failed"
  | "cancelled"
  | "expired";

export type RepoPreviewFramework =
  | "vite"
  | "next"
  | "astro"
  | "nuxt"
  | "sveltekit"
  | "remix"
  | "react-scripts"
  | "angular"
  | "static"
  | "unknown";

export type RepoPreviewPackageManager = "bun" | "pnpm" | "yarn" | "npm" | "none";

export type RepoPreviewManifestFile = {
  path: string;
  offset: number;
  size: number;
};

export type RepoPreviewManifest = {
  version: 1;
  entry: string;
  files: RepoPreviewManifestFile[];
};

export type RepoPreviewDetection = {
  framework: RepoPreviewFramework;
  packageManager: RepoPreviewPackageManager;
  projectFound: boolean;
};

/**
 * How the project root was chosen: typed by the user, the repository root itself,
 * declared by a Rork workspace's rork.json, or picked from ranked app folders.
 */
export type RepoPreviewRootSource = "explicit" | "root" | "rork.json" | "detected";

export type RepoPreviewInspection = RepoPreviewDetection & {
  repository: string;
  defaultBranch: string;
  ref: string;
  commitSha: string;
  rootDirectory: string;
  rootSource: RepoPreviewRootSource;
  outputDirectory?: string;
  rootSuggestions: string[];
  runner: "ready" | "missing" | "outdated";
  runnerVersion?: number;
};

export type RepoPreviewJob = {
  id: string;
  repository: string;
  ref: string;
  commitSha: string;
  rootDirectory: string;
  outputDirectory?: string;
  framework: RepoPreviewFramework;
  packageManager: RepoPreviewPackageManager;
  phase: RepoPreviewPhase;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  previewUrl?: string;
  actionsUrl?: string;
  setupPullRequestUrl?: string;
  logs?: string;
  error?: string;
};

/** Strict owner/repo parsing used before any GitHub request. */
export function parseRepoPreviewRepository(value: unknown): { owner: string; repo: string; fullName: string } | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^([^/]+)\/([^/]+)$/.exec(value.trim());
  if (!match || !OWNER_PATTERN.test(match[1]) || !REPO_PATTERN.test(match[2]) || match[2] === "." || match[2] === "..") {
    return null;
  }
  return { owner: match[1], repo: match[2], fullName: `${match[1]}/${match[2]}` };
}

/** A ref is data for GitHub's API, never a shell fragment. */
export function normalizeRepoPreviewRef(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const ref = value.trim();
  return SAFE_REF_PATTERN.test(ref) && !ref.includes("..") && !ref.startsWith("/") && !ref.endsWith("/")
    ? ref
    : undefined;
}

/** Keeps monorepo/output paths relative and unable to leave the checkout. */
export function normalizeRepoPreviewDirectory(value: unknown, fallback = "."): string | null {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value !== "string") {
    return null;
  }
  const raw = value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!raw || raw === ".") {
    return ".";
  }
  const parts = raw.split("/");
  if (
    raw.length > 220 ||
    raw.startsWith("/") ||
    parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))
  ) {
    return null;
  }
  return parts.join("/");
}

export function isRepoPreviewId(value: string): boolean {
  return PREVIEW_ID_PATTERN.test(value);
}

export function isRepoPreviewAccessToken(value: string): boolean {
  return PREVIEW_ACCESS_PATTERN.test(value);
}

/** Capability-bearing namespace; the workflow receives the id but never this access token. */
export function repoPreviewPublicPrefix(id: string, accessToken: string): string | null {
  return isRepoPreviewId(id) && isRepoPreviewAccessToken(accessToken)
    ? `/repo-preview/${id}/${accessToken}/`
    : null;
}

async function previewIdentityHmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Signs the public id before it is allowed to address a Durable Object. */
export async function signRepoPreviewId(ownerKey: string, nonce: string, secret: string): Promise<string> {
  if (!/^[a-f0-9]{24}$/.test(ownerKey) || !/^[A-Za-z0-9_-]{32,64}$/.test(nonce) || !secret) {
    throw new Error("invalid_preview_identity");
  }
  const unsigned = `${ownerKey}.${nonce}`;
  return `${unsigned}.${(await previewIdentityHmac(secret, unsigned)).slice(0, 24)}`;
}

/** Rejects fabricated ids before they can allocate persistent DO storage. */
export async function verifyRepoPreviewId(id: string, secret: string): Promise<boolean> {
  if (!isRepoPreviewId(id) || !secret) return false;
  const lastDot = id.lastIndexOf(".");
  const unsigned = id.slice(0, lastDot);
  const provided = id.slice(lastDot + 1);
  const expected = (await previewIdentityHmac(secret, unsigned)).slice(0, 24);
  let difference = provided.length ^ expected.length;
  for (let index = 0; index < Math.min(provided.length, expected.length); index += 1) {
    difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const ARCHIVE_KEY_PATTERN = /^previews\/[a-f0-9]{24}\/[a-f0-9]{64}\.tar$/;
const STAGING_KEY_SUFFIX = ".upload-run-";

/** Outcome the entrypoint reports after streaming the runner artifact into storage. */
export type RepoPreviewArchiveCommit = {
  stagingKey: string;
  contentLength: number;
  status: number;
  failure: string;
  uploaded: boolean;
};

/** Final object key; a staging key left behind by an aborted run collapses to it. */
export function repoPreviewArchiveBaseKey(key: string): string {
  const index = key.indexOf(STAGING_KEY_SUFFIX);
  return index >= 0 ? key.slice(0, index) : key;
}

/** Object key used while one exact workflow run is transferring its artifact. */
export function repoPreviewStagingKey(archiveKey: string, runId: string): string {
  return `${repoPreviewArchiveBaseKey(archiveKey)}${STAGING_KEY_SUFFIX}${runId}`;
}

/** Only the staging key minted for this exact run may be committed. */
export function isRepoPreviewStagingKey(value: unknown, runId: string): value is string {
  if (typeof value !== "string" || !/^\d+$/.test(runId)) return false;
  const suffix = `${STAGING_KEY_SUFFIX}${runId}`;
  return value.endsWith(suffix) && ARCHIVE_KEY_PATTERN.test(value.slice(0, -suffix.length));
}

/** Declared artifact size accepted for a claim: positive, integral, bounded. */
export function normalizeRepoPreviewArchiveLength(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= REPO_PREVIEW_MAX_ARCHIVE_BYTES
    ? value
    : null;
}

/** Validates the entrypoint's transfer report before the row can become servable. */
export function normalizeRepoPreviewArchiveCommit(value: unknown, runId: string): RepoPreviewArchiveCommit | null {
  const raw = record(value);
  const contentLength = normalizeRepoPreviewArchiveLength(raw?.contentLength);
  if (!raw || contentLength === null || !isRepoPreviewStagingKey(raw.stagingKey, runId)) {
    return null;
  }
  const status =
    typeof raw.status === "number" && Number.isInteger(raw.status) && raw.status >= 0 && raw.status <= 999
      ? raw.status
      : 0;
  const failure = typeof raw.failure === "string" ? raw.failure.trim().slice(0, 200) : "";
  return {
    stagingKey: raw.stagingKey,
    contentLength,
    status,
    failure,
    uploaded: !failure && status >= 200 && status < 300,
  };
}

/** Persisted reason when the artifact never landed in storage — specific, never opaque. */
export function repoPreviewArchiveFailureMessage(result: Pick<RepoPreviewArchiveCommit, "status" | "failure">): string {
  if (result.failure) {
    return `The preview artifact could not be transferred to Rork storage: ${result.failure}`;
  }
  if (result.status === 0) {
    return "The preview artifact transfer to Rork storage did not complete.";
  }
  return `Rork storage rejected the preview artifact (HTTP ${result.status}).`;
}

/** Persisted reason when Rork storage credentials cannot be minted at all. */
export function repoPreviewStorageUnavailableMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "storage_quota") {
    return "Rork file storage quota is exhausted for this project. Free space or top up storage, then launch the preview again.";
  }
  return "Rork file storage is unavailable for this project (storage_unavailable). Enable file storage for the Gera backend, then launch the preview again.";
}

/** Verifies the workflow run GitHub created before any callback identity is accepted. */
export function repoPreviewWorkflowRunMatches(
  value: unknown,
  expected: {
    repository: string;
    defaultBranch: string;
    workflowSha: string;
    workflowPath: string;
    runId: string;
  },
): boolean {
  const run = record(value);
  const repository = record(run?.repository);
  const id = typeof run?.id === "number" && Number.isSafeInteger(run.id) ? String(run.id) : "";
  const path = typeof run?.path === "string" ? run.path.trim().split("@", 1)[0] : "";
  const htmlUrl = typeof run?.html_url === "string" ? run.html_url.trim() : "";
  return id === expected.runId &&
    typeof repository?.full_name === "string" &&
    repository.full_name.toLowerCase() === expected.repository.toLowerCase() &&
    typeof run?.head_sha === "string" &&
    run.head_sha.toLowerCase() === expected.workflowSha.toLowerCase() &&
    run.head_branch === expected.defaultBranch &&
    path === expected.workflowPath &&
    run.event === "workflow_dispatch" &&
    run.run_attempt === 1 &&
    run.name === "Gera web preview" &&
    htmlUrl.toLowerCase().startsWith(
      `https://github.com/${expected.repository}/actions/runs/`.toLowerCase(),
    );
}

/** Keeps bearer-like preview ids out of route-level diagnostics. */
export function repoPreviewSafeRouteLabel(pathname: string): string {
  if (pathname.startsWith("/hook/")) return "/hook/[redacted]";
  if (pathname.startsWith("/asset/")) return "/asset/[redacted]";
  return pathname.slice(0, 300);
}

/** Framework/package-manager inference from immutable repository metadata. */
export function detectRepoPreviewProject(
  packageJsonText: string | null,
  repositoryPaths: string[],
): RepoPreviewDetection {
  const paths = new Set(repositoryPaths.map((path) => path.replace(/^\.\//, "")));
  const packageManager: RepoPreviewPackageManager = paths.has("bun.lock") || paths.has("bun.lockb")
    ? "bun"
    : paths.has("pnpm-lock.yaml")
      ? "pnpm"
      : paths.has("yarn.lock")
        ? "yarn"
        : packageJsonText
          ? "npm"
          : "none";
  if (!packageJsonText) {
    return {
      framework: paths.has("index.html") ? "static" : "unknown",
      packageManager,
      projectFound: paths.has("index.html"),
    };
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = record(JSON.parse(packageJsonText) as unknown);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return { framework: "unknown", packageManager, projectFound: false };
  }
  const dependencies = {
    ...(record(parsed.dependencies) ?? {}),
    ...(record(parsed.devDependencies) ?? {}),
  };
  const has = (name: string): boolean => typeof dependencies[name] === "string";
  const framework: RepoPreviewFramework = has("vite")
    ? "vite"
    : has("next")
      ? "next"
      : has("astro")
        ? "astro"
        : has("nuxt")
          ? "nuxt"
          : has("@sveltejs/kit")
            ? "sveltekit"
            : has("@remix-run/react")
              ? "remix"
              : has("react-scripts")
                ? "react-scripts"
                : has("@angular/core")
                  ? "angular"
                  : paths.has("index.html")
                    ? "static"
                    : "unknown";
  return { framework, packageManager, projectFound: true };
}

/** A confident web entry: a recognised framework or a static index.html, not just any package.json. */
export function isRepoPreviewWebEntry(detection: RepoPreviewDetection): boolean {
  return detection.projectFound && detection.framework !== "unknown";
}

/**
 * Rork workspaces (this repository's own shape) keep every app in a subfolder and
 * declare them in a root rork.json: `{ apps: [{ path: "web", framework: "web" }, ...] }`.
 * The first "web" app's path is the preview root; other frameworks (expo, cloudflare,
 * ios, android) are not static web builds and are ignored.
 */
export function repoPreviewRorkWebRoot(rorkJsonText: string | null): string | null {
  if (!rorkJsonText) {
    return null;
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = record(JSON.parse(rorkJsonText) as unknown);
  } catch {
    return null;
  }
  const apps = Array.isArray(parsed?.apps) ? parsed.apps : [];
  for (const item of apps) {
    const app = record(item);
    if (app?.framework !== "web") {
      continue;
    }
    const path = normalizeRepoPreviewDirectory(app.path);
    if (path) {
      return path;
    }
  }
  return null;
}

const WORKSPACE_MARKERS = ["rork.json", "pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json"];

/**
 * A root that only orchestrates sub-apps (Rork workspace, npm/pnpm workspaces,
 * turbo/nx/lerna, or a package.json with nothing to build) should never be built
 * itself — the web app lives in one of its folders.
 */
export function repoPreviewRootIsWorkspaceShell(packageJsonText: string | null, rootPaths: string[]): boolean {
  const paths = new Set(rootPaths.map((path) => path.replace(/^\.\//, "")));
  if (WORKSPACE_MARKERS.some((marker) => paths.has(marker))) {
    return true;
  }
  if (!packageJsonText) {
    return true;
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = record(JSON.parse(packageJsonText) as unknown);
  } catch {
    return false;
  }
  if (!parsed) {
    return false;
  }
  if (parsed.workspaces !== undefined) {
    return true;
  }
  const scripts = record(parsed.scripts);
  return typeof scripts?.build !== "string";
}

const ROOT_MAX_DEPTH = 4;
const ROOT_IGNORED_SEGMENT = /^(?:node_modules|dist|build|out|public|static|assets|coverage|vendor|\..*)$/i;
const ROOT_WEB_HINT = /^(?:web|www|site|website|app|apps|frontend|front|client|ui|dashboard|admin|landing|portal|storefront|shop|studio|console)$/i;
const ROOT_NON_WEB_HINT = /^(?:functions?|api|server|backend|workers?|services?|supabase|convex|infra|scripts?|tools?|e2e|tests?|__tests__|spec|fixtures?|examples?|packages?|libs?|shared|common|utils?|cli|bot|mobile|ios|android|expo|native)$/i;

/**
 * Directories that can be a web project root, best first. Ranking prefers a
 * Vite-style folder (package.json + index.html), web-ish names such as `web` or
 * `apps/site`, and shallow paths; backend-ish names such as `functions`, `api`
 * or `server` sink to the bottom. Build output and dot folders never qualify.
 */
export function rankRepoPreviewRoots(repositoryPaths: string[]): string[] {
  const markers = new Map<string, { packageJson: boolean; indexHtml: boolean }>();
  for (const raw of repositoryPaths) {
    const parts = raw.replace(/^\.\//, "").split("/");
    const name = parts[parts.length - 1];
    if (name !== "package.json" && name !== "index.html") {
      continue;
    }
    const directory = parts.slice(0, -1);
    if (directory.length > ROOT_MAX_DEPTH || directory.some((part) => !part || ROOT_IGNORED_SEGMENT.test(part))) {
      continue;
    }
    const key = directory.length === 0 ? "." : directory.join("/");
    const entry = markers.get(key) ?? { packageJson: false, indexHtml: false };
    if (name === "package.json") {
      entry.packageJson = true;
    } else {
      entry.indexHtml = true;
    }
    markers.set(key, entry);
  }
  const scored = [...markers.entries()].map(([directory, marks]) => {
    const parts = directory === "." ? [] : directory.split("/");
    let score = marks.packageJson && marks.indexHtml ? 4 : marks.indexHtml ? 1 : 0;
    if (parts.some((part) => ROOT_WEB_HINT.test(part))) score += 2;
    if (parts.some((part) => ROOT_NON_WEB_HINT.test(part))) score -= 3;
    score -= parts.length;
    return { directory, score };
  });
  scored.sort((a, b) => b.score - a.score || a.directory.localeCompare(b.directory));
  return scored.map((item) => item.directory).slice(0, 12);
}

/** Extracts the installed runner marker without trusting the workflow body. */
export function repoPreviewRunnerVersion(source: string | null): number | undefined {
  const match = source?.match(/^# gera-web-preview-runner: (\d+)$/m);
  if (!match) {
    return undefined;
  }
  const value = Number.parseInt(match[1], 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** A marker is informational; dispatch requires byte-equivalent canonical workflow code. */
export function repoPreviewWorkflowMatches(source: string | null): boolean {
  if (!source) return false;
  const normalized = (value: string): string => value.replace(/\r\n/g, "\n").trimEnd();
  return normalized(source) === normalized(repoPreviewWorkflowSource());
}

const PREVIEW_ARTIFACT_EXTENSIONS = new Set([
  "html", "htm", "css", "js", "mjs", "cjs", "json", "webmanifest", "txt", "csv",
  "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "ico",
  "woff", "woff2", "ttf", "otf", "wasm",
  "mp3", "wav", "ogg", "m4a", "mp4", "webm", "mov",
  "pdf", "glb", "gltf", "usdz", "bin",
]);
const PREVIEW_ARTIFACT_BLOCKED_NAMES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "tsconfig.json", "jsconfig.json", "config.json", "secrets.json", "credentials.json", "service-account.json",
  "wrangler.json", "wrangler.jsonc", "wrangler.toml",
]);

function isSensitiveArtifactName(name: string): boolean {
  const lower = name.toLowerCase();
  return PREVIEW_ARTIFACT_BLOCKED_NAMES.has(lower) ||
    /(?:^|\.)config\.(?:js|mjs|cjs|ts|json|jsonc|toml|yaml|yml)$/.test(lower) ||
    /^(?:ts|js)config(?:\.[a-z0-9_-]+)?\.json$/.test(lower) ||
    /(?:^|[-_.])(?:secret|secrets|credential|credentials|service-account)(?:[-_.]|$)/.test(lower);
}

/** Only browser-deliverable artifact paths can enter the public capability. */
export function isRepoPreviewArtifactPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 500 || value.startsWith("/") || value.includes("\\")) {
    return false;
  }
  const parts = value.split("/");
  if (
    parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".") || part.includes("\0")) ||
    isSensitiveArtifactName(parts[parts.length - 1])
  ) {
    return false;
  }
  const extension = parts[parts.length - 1].toLowerCase().split(".").pop() ?? "";
  return PREVIEW_ARTIFACT_EXTENSIONS.has(extension);
}

function safeManifestPath(value: unknown): string | null {
  return isRepoPreviewArtifactPath(value) ? value.split("/").join("/") : null;
}

/** Validates the tar index before any offset can become an R2 Range request. */
export function normalizeRepoPreviewManifest(value: unknown, archiveBytes: number): RepoPreviewManifest | null {
  const raw = record(value);
  if (
    !raw ||
    raw.version !== 1 ||
    !Number.isInteger(archiveBytes) ||
    archiveBytes <= 0 ||
    archiveBytes > REPO_PREVIEW_MAX_ARCHIVE_BYTES ||
    !Array.isArray(raw.files) ||
    raw.files.length === 0 ||
    raw.files.length > REPO_PREVIEW_MAX_FILES
  ) {
    return null;
  }
  const files: RepoPreviewManifestFile[] = [];
  const seen = new Set<string>();
  for (const item of raw.files) {
    const file = record(item);
    const path = safeManifestPath(file?.path);
    const offset = file?.offset;
    const size = file?.size;
    if (
      !file ||
      !path ||
      seen.has(path) ||
      typeof offset !== "number" ||
      typeof size !== "number" ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset + size > archiveBytes
    ) {
      return null;
    }
    seen.add(path);
    files.push({ path, offset, size });
  }
  const entry = safeManifestPath(raw.entry) ?? "index.html";
  if (!seen.has(entry)) {
    return null;
  }
  return { version: 1, entry, files };
}

/** Active document formats receive an origin-sandboxing CSP when served publicly. */
export function repoPreviewContentSecurityPolicy(path: string): string | undefined {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  if (extension === "html" || extension === "htm") {
    return "sandbox allow-scripts allow-forms allow-popups allow-modals; default-src 'self' https: data: blob:; base-uri 'self'; object-src 'none'; frame-ancestors *; script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob:; style-src 'self' 'unsafe-inline' https:; connect-src 'self' https: wss:; img-src 'self' https: data: blob:; media-src 'self' https: data: blob:; font-src 'self' https: data:; worker-src 'self' blob:;";
  }
  if (extension === "svg") {
    return "sandbox; default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; img-src data:;";
  }
  return undefined;
}

/** MIME is derived from the validated path, never accepted from the workflow. */
export function repoPreviewContentType(path: string): string {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  const values: Record<string, string> = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    cjs: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    map: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    webmanifest: "application/manifest+json",
    txt: "text/plain; charset=utf-8",
    wasm: "application/wasm",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
  };
  return values[extension] ?? "application/octet-stream";
}

/** Makes root-relative build assets resolve inside one preview's path namespace. */
export function rewriteRepoPreviewHtml(html: string, previewPrefix: string): string {
  const prefix = previewPrefix.endsWith("/") ? previewPrefix : `${previewPrefix}/`;
  const namespacedPath = prefix.replace(/^\/+/, "");
  const rewritten = html.replace(
    /\b(src|href|poster|action)=(['"])\/(?!\/)([^'"]*)\2/gi,
    (full, attribute: string, quote: string, path: string) => path.startsWith(namespacedPath)
      ? full
      : `${attribute}=${quote}${prefix}${path}${quote}`,
  );
  const base = `<base href="${prefix}">`;
  if (/<head(?:\s[^>]*)?>/i.test(rewritten)) {
    return rewritten.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${base}`);
  }
  return `${base}${rewritten}`;
}

/** Build logs are useful evidence, but credential-shaped output is never persisted. */
export function redactRepoPreviewLog(value: string): string {
  return value
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,})\b/g, "[redacted-token]")
    .replace(/\b[a-f0-9]{24}\.[A-Za-z0-9_-]{32,64}\.[a-f0-9]{24}\b/g, "[redacted-preview-id]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[redacted]@")
    .replace(/([?&](?:token|key|secret|signature|auth)=)[^&\s]+/gi, "$1[redacted]")
    .slice(-REPO_PREVIEW_MAX_LOG_CHARS);
}

/** Auditable bounded workflow installed through a PR in the selected repo. */
export function repoPreviewWorkflowSource(): string {
  return `# gera-web-preview-runner: ${REPO_PREVIEW_RUNNER_VERSION}
name: Gera web preview
run-name: Gera web preview

on:
  workflow_dispatch:
    inputs:
      preview_id:
        description: Gera preview id
        required: true
        type: string
      commit_sha:
        description: Immutable source commit
        required: true
        type: string
      root_directory:
        description: Web project root
        required: true
        default: .
        type: string
      output_directory:
        description: Optional build output directory
        required: false
        default: ""
        type: string
      callback_url:
        description: Gera backend callback origin
        required: true
        type: string

permissions: {}

jobs:
  begin:
    runs-on: ubuntu-latest
    timeout-minutes: 2
    permissions:
      contents: none
      id-token: write
    steps:
      - name: Authenticate exact runner
        shell: bash
        env:
          CALLBACK_URL: \${{ inputs.callback_url }}
        run: |
          set -euo pipefail
          PREVIEW_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["inputs"]["preview_id"])' "$GITHUB_EVENT_PATH")"
          echo "::add-mask::$PREVIEW_ID"
          for ATTEMPT in {1..10}; do
            OIDC_TOKEN="$(curl --fail --silent --show-error \
              -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
              "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=gera-repo-preview" | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')"
            if printf '{}' | curl --fail --silent --show-error \
              -H "Authorization: Bearer $OIDC_TOKEN" -H "Content-Type: application/json" --data-binary @- \
              "$CALLBACK_URL/repo-preview-hook/$PREVIEW_ID/started"; then
              exit 0
            fi
            sleep 2
          done
          exit 1

  build:
    needs: begin
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
      id-token: none
    outputs:
      exit_code: \${{ steps.build.outputs.exit_code }}
    steps:
      - name: Check out immutable source
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          ref: \${{ inputs.commit_sha }}
          persist-credentials: false
          fetch-depth: 1

      - name: Set up Node
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: "22"

      - name: Set up Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: "1.3.9"

      - name: Install, build and package
        id: build
        shell: bash
        env:
          ROOT_DIRECTORY: \${{ inputs.root_directory }}
          REQUESTED_OUTPUT: \${{ inputs.output_directory }}
        run: |
          set +e
          LOG_FILE="$RUNNER_TEMP/gera-preview.log"
          {
            set -euo pipefail
            case "$ROOT_DIRECTORY" in
              /*|*".."*) echo "Unsafe root directory."; exit 2 ;;
            esac
            PROJECT_DIR="$GITHUB_WORKSPACE"
            if [ "$ROOT_DIRECTORY" != "." ]; then PROJECT_DIR="$GITHUB_WORKSPACE/$ROOT_DIRECTORY"; fi
            if [ ! -d "$PROJECT_DIR" ]; then echo "Project root not found: $ROOT_DIRECTORY"; exit 2; fi
            cd "$PROJECT_DIR"
            PREVIEW_BASE="/repo-preview/__GERA_PREVIEW_BASE__/"

            if [ -f package.json ]; then
              corepack enable || true
              if [ -f bun.lock ] || [ -f bun.lockb ]; then
                PACKAGE_MANAGER=bun
                bun install --frozen-lockfile
              elif [ -f pnpm-lock.yaml ]; then
                PACKAGE_MANAGER=pnpm
                PACKAGE_MANAGER_SPEC="$(node -p 'require("./package.json").packageManager || ""')"
                if [[ "$PACKAGE_MANAGER_SPEC" == pnpm@* ]]; then corepack prepare "$PACKAGE_MANAGER_SPEC" --activate; else corepack prepare pnpm@9.15.9 --activate; fi
                pnpm install --frozen-lockfile
              elif [ -f yarn.lock ]; then
                PACKAGE_MANAGER=yarn
                PACKAGE_MANAGER_SPEC="$(node -p 'require("./package.json").packageManager || ""')"
                if [[ "$PACKAGE_MANAGER_SPEC" == yarn@* ]]; then corepack prepare "$PACKAGE_MANAGER_SPEC" --activate; else corepack prepare yarn@1.22.22 --activate; fi
                yarn install --immutable || yarn install --frozen-lockfile
              elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
                PACKAGE_MANAGER=npm
                npm ci
              else
                PACKAGE_MANAGER=npm
                npm install
              fi

              if node -e 'const p=require("./package.json"); process.exit(p.scripts && p.scripts.build ? 0 : 1)'; then
                if node -e 'const p=require("./package.json"); const d={...(p.dependencies||{}),...(p.devDependencies||{})}; process.exit(d.vite ? 0 : 1)'; then
                  case "$PACKAGE_MANAGER" in
                    bun) bun run build -- --base="$PREVIEW_BASE" ;;
                    pnpm) pnpm run build -- --base="$PREVIEW_BASE" ;;
                    yarn) yarn build --base="$PREVIEW_BASE" ;;
                    *) npm run build -- --base="$PREVIEW_BASE" ;;
                  esac
                else
                  export PUBLIC_URL="$PREVIEW_BASE"
                  export BASE_URL="$PREVIEW_BASE"
                  case "$PACKAGE_MANAGER" in
                    bun) bun run build ;;
                    pnpm) pnpm run build ;;
                    yarn) yarn build ;;
                    *) npm run build ;;
                  esac
                fi
              elif [ ! -f index.html ]; then
                echo "package.json has no build script and the project root has no index.html."
                exit 3
              fi
            elif [ ! -f index.html ]; then
              echo "No package.json or index.html found in $ROOT_DIRECTORY."
              exit 3
            fi

            export REQUESTED_OUTPUT
            OUTPUT_DIR="$(python3 - <<'PY'
          import os
          from pathlib import Path
          root = Path.cwd()
          requested = os.environ.get("REQUESTED_OUTPUT", "").strip().strip("/")
          candidates = [requested] if requested else ["dist", "build", "out", ".output/public", "public", "."]
          for candidate in candidates:
              if not candidate:
                  continue
              path = (root / candidate).resolve()
              try:
                  path.relative_to(root.resolve())
              except ValueError:
                  continue
              if path.is_dir() and (path / "index.html").is_file():
                  print(path)
                  raise SystemExit(0)
          for parent in (root / "dist", root / "build", root / "out"):
              if parent.is_dir():
                  for index in sorted(parent.glob("**/index.html")):
                      if len(index.relative_to(parent).parts) <= 4:
                          print(index.parent.resolve())
                          raise SystemExit(0)
          raise SystemExit("Build completed, but no static index.html output was found. Set the output directory explicitly.")
          PY
            )"
            export OUTPUT_DIR
            python3 - <<'PY'
          import json
          import os
          import tarfile
          from pathlib import Path
          root = Path(os.environ["OUTPUT_DIR"]).resolve()
          tar_path = Path(os.environ["RUNNER_TEMP"]) / "gera-preview.tar"
          manifest_path = Path(os.environ["RUNNER_TEMP"]) / "gera-preview-manifest.json"
          files = []
          allowed_extensions = {
              ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".json", ".webmanifest", ".txt", ".csv",
              ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
              ".woff", ".woff2", ".ttf", ".otf", ".wasm",
              ".mp3", ".wav", ".ogg", ".m4a", ".mp4", ".webm", ".mov",
              ".pdf", ".glb", ".gltf", ".usdz", ".bin",
          }
          blocked_names = {
              "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
              "tsconfig.json", "jsconfig.json", "config.json", "secrets.json", "credentials.json", "service-account.json",
              "wrangler.json", "wrangler.jsonc", "wrangler.toml",
          }
          def sensitive_name(name):
              lower = name.lower()
              return (
                  lower in blocked_names
                  or ".config." in lower
                  or (lower.startswith(("tsconfig.", "jsconfig.")) and lower.endswith(".json"))
                  or any(marker in f"-{lower.replace('_', '-').replace('.', '-')}-" for marker in ("-secret-", "-secrets-", "-credential-", "-credentials-", "-service-account-"))
              )
          for path in sorted(root.rglob("*")):
              if path.is_symlink() or not path.is_file() or path.suffix.lower() not in allowed_extensions:
                  continue
              relative_path = path.relative_to(root)
              if any(part.startswith(".") for part in relative_path.parts) or sensitive_name(path.name):
                  continue
              relative = relative_path.as_posix()
              files.append((path, relative))
          if not files or len(files) > 1000:
              raise SystemExit(f"Preview output has {len(files)} files; expected 1..1000.")
          if not any(relative == "index.html" for _, relative in files):
              raise SystemExit("Preview output has no root index.html.")
          if sum(path.stat().st_size for path, _ in files) > 50 * 1024 * 1024:
              raise SystemExit("Preview output exceeds 50 MiB.")
          with tarfile.open(tar_path, "w", format=tarfile.GNU_FORMAT) as archive:
              for path, relative in files:
                  archive.add(path, arcname=relative, recursive=False)
          with tarfile.open(tar_path, "r") as archive:
              entries = [
                  {"path": member.name, "offset": member.offset_data, "size": member.size}
                  for member in archive.getmembers()
                  if member.isfile()
              ]
          if tar_path.stat().st_size > 50 * 1024 * 1024:
              raise SystemExit("Packaged preview exceeds 50 MiB.")
          manifest_path.write_text(json.dumps({"version": 1, "entry": "index.html", "files": entries}), encoding="utf-8")
          print(f"Packaged {len(entries)} files ({tar_path.stat().st_size} bytes).")
          PY
          } > >(tee "$LOG_FILE") 2>&1
          EXIT_CODE=$?
          echo "exit_code=$EXIT_CODE" >> "$GITHUB_OUTPUT"
          exit 0

      - name: Stage bounded handoff
        if: always()
        shell: bash
        run: |
          touch "$RUNNER_TEMP/gera-preview.log"
          if [ "\${{ steps.build.outputs.exit_code }}" != "0" ]; then
            rm -f "$RUNNER_TEMP/gera-preview.tar" "$RUNNER_TEMP/gera-preview-manifest.json"
          fi

      - name: Transfer bounded handoff
        if: always()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: gera-preview-handoff-\${{ github.run_id }}-\${{ github.run_attempt }}
          path: |
            \${{ runner.temp }}/gera-preview.tar
            \${{ runner.temp }}/gera-preview.log
          if-no-files-found: error
          retention-days: 1
          compression-level: 0

  publish:
    needs: [begin, build]
    if: always()
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      actions: read
      contents: none
      id-token: write
    steps:
      - name: Receive bounded handoff
        id: download
        continue-on-error: true
        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0
        with:
          name: gera-preview-handoff-\${{ github.run_id }}-\${{ github.run_attempt }}
          path: \${{ runner.temp }}/gera-preview-handoff

      - name: Publish from trusted job
        if: always()
        shell: bash
        env:
          CALLBACK_URL: \${{ inputs.callback_url }}
          BUILD_CODE: \${{ needs.build.outputs.exit_code }}
          BUILD_RESULT: \${{ needs.build.result }}
        run: |
          set -euo pipefail
          PREVIEW_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["inputs"]["preview_id"])' "$GITHUB_EVENT_PATH")"
          echo "::add-mask::$PREVIEW_ID"
          OIDC_TOKEN="$(curl --fail --silent --show-error \
            -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=gera-repo-preview" | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')"
          PREVIEW_BASE="$(printf '{}' | curl --fail --silent --show-error \
            -H "Authorization: Bearer $OIDC_TOKEN" -H "Content-Type: application/json" --data-binary @- \
            "$CALLBACK_URL/repo-preview-hook/$PREVIEW_ID/configuration" \
            | python3 -c 'import json,re,sys; value=json.load(sys.stdin).get("previewBase", ""); prefix=f"/repo-preview/{sys.argv[1]}/"; token=value[len(prefix):-1] if value.startswith(prefix) and value.endswith("/") else ""; assert re.fullmatch(r"[a-f0-9]{48}", token); print(value)' "$PREVIEW_ID")"
          PREVIEW_ACCESS="\${PREVIEW_BASE%/}"
          PREVIEW_ACCESS="\${PREVIEW_ACCESS##*/}"
          echo "::add-mask::$PREVIEW_ACCESS"
          echo "::add-mask::$PREVIEW_BASE"
          set +e
          HANDOFF_DIR="$RUNNER_TEMP/gera-preview-handoff"
          LOG_FILE="$HANDOFF_DIR/gera-preview.log"
          if [ -f "$LOG_FILE" ]; then
            tail -c 120000 "$LOG_FILE" | curl --fail --silent --show-error -X PUT \
              -H "Authorization: Bearer $OIDC_TOKEN" -H "Content-Type: text/plain; charset=utf-8" --data-binary @- \
              "$CALLBACK_URL/repo-preview-hook/$PREVIEW_ID/logs" >/dev/null || true
          fi

          REWRITE_CODE=1
          if [ "$BUILD_RESULT" = "success" ] && [ "$BUILD_CODE" = "0" ] \
            && [ -f "$HANDOFF_DIR/gera-preview.tar" ]; then
            export HANDOFF_DIR PREVIEW_BASE
            python3 - <<'PY'
          import io
          import json
          import os
          import tarfile
          from pathlib import Path

          limit = 50 * 1024 * 1024
          placeholder = b"/repo-preview/__GERA_PREVIEW_BASE__/"
          replacement = os.environ["PREVIEW_BASE"].encode("utf-8")
          handoff = Path(os.environ["HANDOFF_DIR"])
          source = handoff / "gera-preview.tar"
          target = handoff / "gera-preview-bound.tar"
          manifest_path = handoff / "gera-preview-manifest.json"
          text_extensions = {".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".json", ".webmanifest", ".txt", ".csv", ".svg", ".gltf"}
          seen = set()
          total = 0
          with tarfile.open(source, "r:") as incoming, tarfile.open(target, "w", format=tarfile.GNU_FORMAT) as outgoing:
              members = incoming.getmembers()
              if not members or len(members) > 1000:
                  raise SystemExit("Invalid handoff file count.")
              for member in members:
                  parts = member.name.split("/")
                  if not member.isfile() or member.name.startswith("/") or any(part in ("", ".", "..") for part in parts) or member.name in seen:
                      raise SystemExit("Unsafe handoff entry.")
                  if member.size < 0 or member.size > limit or total + member.size > limit:
                      raise SystemExit("Oversized handoff entry.")
                  stream = incoming.extractfile(member)
                  if stream is None:
                      raise SystemExit("Unreadable handoff entry.")
                  data = stream.read(member.size + 1)
                  if len(data) != member.size:
                      raise SystemExit("Handoff entry size mismatch.")
                  if Path(member.name).suffix.lower() in text_extensions:
                      data = data.replace(placeholder, replacement)
                  total += len(data)
                  if total > limit:
                      raise SystemExit("Bound preview exceeds 50 MiB.")
                  info = tarfile.TarInfo(member.name)
                  info.size = len(data)
                  info.mode = 0o644
                  info.mtime = 0
                  outgoing.addfile(info, io.BytesIO(data))
                  seen.add(member.name)
          if "index.html" not in seen or target.stat().st_size > limit:
              raise SystemExit("Bound preview is invalid or too large.")
          with tarfile.open(target, "r:") as archive:
              entries = [
                  {"path": member.name, "offset": member.offset_data, "size": member.size}
                  for member in archive.getmembers()
                  if member.isfile()
              ]
          manifest_path.write_text(json.dumps({"version": 1, "entry": "index.html", "files": entries}), encoding="utf-8")
          os.replace(target, source)
          PY
            REWRITE_CODE=$?
          fi

          UPLOAD_CODE=1
          if [ "$REWRITE_CODE" = "0" ]; then
            printf '{"phase":"uploading"}' | curl --fail --silent --show-error \
              -H "Authorization: Bearer $OIDC_TOKEN" -H "Content-Type: application/json" --data-binary @- \
              "$CALLBACK_URL/repo-preview-hook/$PREVIEW_ID/phase" \
            && curl --fail --silent --show-error -X PUT \
              -H "Authorization: Bearer $OIDC_TOKEN" -H "Content-Type: application/x-tar" \
              --data-binary @"$HANDOFF_DIR/gera-preview.tar" \
              "$CALLBACK_URL/repo-preview-hook/$PREVIEW_ID/archive" \
            && curl --fail --silent --show-error -X PUT \
              -H "Authorization: Bearer $OIDC_TOKEN" -H "Content-Type: application/json" \
              --data-binary @"$HANDOFF_DIR/gera-preview-manifest.json" \
              "$CALLBACK_URL/repo-preview-hook/$PREVIEW_ID/manifest"
            UPLOAD_CODE=$?
          fi

          if [ "$UPLOAD_CODE" = "0" ]; then
            STATUS=success
            MESSAGE="Static preview is ready."
          else
            STATUS=failed
            MESSAGE="Install, build, packaging, transfer, or upload failed. Open the bounded log in Gera."
          fi
          printf '{"status":"%s","message":"%s"}' "$STATUS" "$MESSAGE" | curl --fail --silent --show-error \
            -H "Authorization: Bearer $OIDC_TOKEN" -H "Content-Type: application/json" --data-binary @- \
            "$CALLBACK_URL/repo-preview-hook/$PREVIEW_ID/complete"
          COMPLETE_CODE=$?
          if [ "$STATUS" != "success" ] || [ "$COMPLETE_CODE" != "0" ]; then exit 1; fi
`;
}
