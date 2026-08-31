// Durable control plane for repository previews. One object is addressed by a
// hashed account key, so launch quotas and job history stay strongly
// consistent while public asset reads scale across account shards.

import { DurableObject } from "cloudflare:workers";

import {
  getRorkStorageCredentials,
  presignRorkStorageUrl,
  type RorkStorageEnv,
} from "./knowledge-storage";
import {
  REPO_PREVIEW_MAX_ARCHIVE_BYTES,
  REPO_PREVIEW_MAX_LOG_CHARS,
  REPO_PREVIEW_TOKEN_TTL_MS,
  REPO_PREVIEW_TTL_MS,
  REPO_PREVIEW_WORKFLOW_PATH,
  detectRepoPreviewProject,
  isRepoPreviewId,
  normalizeRepoPreviewDirectory,
  normalizeRepoPreviewManifest,
  normalizeRepoPreviewRef,
  parseRepoPreviewRepository,
  redactRepoPreviewLog,
  repoPreviewContentType,
  repoPreviewRunnerVersion,
  repoPreviewWorkflowMatches,
  repoPreviewWorkflowSource,
  rewriteRepoPreviewHtml,
  signRepoPreviewId,
  type RepoPreviewFramework,
  type RepoPreviewInspection,
  type RepoPreviewJob,
  type RepoPreviewManifest,
  type RepoPreviewPackageManager,
  type RepoPreviewPhase,
} from "./repo-preview-shared";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_USER_AGENT = "Gera-AI-Agent-Hub/1.0";
type ActiveRepoPreviewPhase = "queued" | "installing" | "building" | "packaging" | "uploading";
const ACTIVE_PHASES: ActiveRepoPreviewPhase[] = ["queued", "installing", "building", "packaging", "uploading"];
const MAX_ACTIVE_JOBS = 2;
const MAX_RECENT_JOBS = 12;
const QUEUED_TIMEOUT_MS = 20 * 60_000;
const HTML_REWRITE_LIMIT = 2_000_000;
const MANIFEST_BODY_LIMIT = 1_000_000;
const CONTROL_BODY_LIMIT = 32_000;
const PREVIEW_ID_PART = /^[A-Za-z0-9_-]{20,80}$/;

export type RepoPreviewStoreEnv = RorkStorageEnv & {
  DO?: { fetch(request: Request): Promise<Response> };
  RORK_AUTH_SECRET_KEY?: string;
};

type PreviewRow = {
  id: string;
  owner_email: string;
  repository: string;
  ref: string;
  commit_sha: string;
  root_directory: string;
  output_directory: string;
  framework: string;
  package_manager: string;
  phase: string;
  run_id: string;
  actions_url: string;
  setup_pr_url: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
  token_hash: string;
  token_expires_at: number;
  archive_key: string;
  archive_bytes: number;
  manifest: string;
  logs: string;
  error: string;
};

type GitHubRecord = Record<string, unknown>;

type InspectInput = {
  repository?: unknown;
  ref?: unknown;
  rootDirectory?: unknown;
  outputDirectory?: unknown;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function asRecord(value: unknown): GitHubRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as GitHubRecord)
    : null;
}

function stringValue(value: unknown, limit = 500): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function githubHeaders(auth: string, hasBody = false): Record<string, string> {
  return {
    Authorization: auth,
    Accept: "application/vnd.github+json",
    "User-Agent": GITHUB_USER_AGENT,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
  };
}

class PreviewGitHubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PreviewGitHubError";
    this.status = status;
  }
}

async function githubJson(
  auth: string,
  path: string,
  init: { method?: "GET" | "POST" | "PUT"; body?: unknown } = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      method: init.method ?? "GET",
      headers: githubHeaders(auth, init.body !== undefined),
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new PreviewGitHubError(502, "Could not reach GitHub from the Rork backend.");
  }
  if (response.ok) {
    if (response.status === 204) {
      return null;
    }
    return response.json().catch(() => null);
  }
  const data = asRecord(await response.json().catch(() => null));
  const providerMessage = stringValue(data?.message, 300);
  const message = response.status === 401
    ? "GitHub rejected the credential. Sign in again."
    : response.status === 403 || response.status === 429
      ? `GitHub refused the preview request${providerMessage ? `: ${providerMessage}` : "."}`
      : response.status === 404
        ? "The repository, ref, or workflow was not found with this credential."
        : `GitHub returned ${response.status}${providerMessage ? `: ${providerMessage}` : "."}`;
  throw new PreviewGitHubError(response.status === 401 ? 424 : response.status, message);
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function repoPath(owner: string, repo: string, suffix: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

async function readRepoFile(
  auth: string,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<{ content: string; sha: string } | null> {
  try {
    const data = asRecord(
      await githubJson(
        auth,
        `${repoPath(owner, repo, `/contents/${path.split("/").map(encodeURIComponent).join("/")}`)}?ref=${encodeURIComponent(ref)}`,
      ),
    );
    if (!data || data.type !== "file" || typeof data.content !== "string") {
      return null;
    }
    return { content: decodeBase64Utf8(data.content), sha: stringValue(data.sha, 100) };
  } catch (error) {
    if (error instanceof PreviewGitHubError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

function relativeToRoot(path: string, root: string): string | null {
  if (root === ".") {
    return path;
  }
  const prefix = `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

function rootSuggestions(paths: string[]): string[] {
  const suggestions = new Set<string>();
  for (const path of paths) {
    if (!/(?:^|\/)(?:package\.json|index\.html)$/.test(path) || path.includes("node_modules/")) {
      continue;
    }
    const parts = path.split("/");
    if (parts.length > 5) {
      continue;
    }
    suggestions.add(parts.length === 1 ? "." : parts.slice(0, -1).join("/"));
  }
  return [...suggestions].slice(0, 12);
}

async function inspectRepository(auth: string, input: InspectInput): Promise<RepoPreviewInspection> {
  const repository = parseRepoPreviewRepository(input.repository);
  const rootDirectory = normalizeRepoPreviewDirectory(input.rootDirectory);
  const outputDirectory = input.outputDirectory === undefined || input.outputDirectory === ""
    ? undefined
    : normalizeRepoPreviewDirectory(input.outputDirectory, "");
  if (!repository) {
    throw new PreviewGitHubError(400, "Choose a valid owner/repository.");
  }
  if (!rootDirectory || outputDirectory === null || outputDirectory === ".") {
    throw new PreviewGitHubError(400, "Project and output directories must stay inside the repository.");
  }

  const metadata = asRecord(await githubJson(auth, repoPath(repository.owner, repository.repo, "")));
  const defaultBranch = stringValue(metadata?.default_branch, 180) || "main";
  const rawRef = input.ref === undefined || input.ref === "" ? defaultBranch : normalizeRepoPreviewRef(input.ref);
  if (!rawRef) {
    throw new PreviewGitHubError(400, "Choose a valid branch, tag, or commit ref.");
  }
  const commit = asRecord(
    await githubJson(auth, repoPath(repository.owner, repository.repo, `/commits/${encodeURIComponent(rawRef)}`)),
  );
  const commitSha = stringValue(commit?.sha, 40);
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw new PreviewGitHubError(502, "GitHub returned no immutable commit for this ref.");
  }

  const tree = asRecord(
    await githubJson(
      auth,
      `${repoPath(repository.owner, repository.repo, `/git/trees/${encodeURIComponent(commitSha)}`)}?recursive=1`,
    ),
  );
  const allPaths = Array.isArray(tree?.tree)
    ? tree.tree.flatMap((item): string[] => {
        const entry = asRecord(item);
        const path = stringValue(entry?.path, 500);
        return path && (entry?.type === "blob" || entry?.type === "tree") ? [path] : [];
      })
    : [];
  const selectedPaths = allPaths.flatMap((path): string[] => {
    const relative = relativeToRoot(path, rootDirectory);
    return relative ? [relative] : [];
  });
  const packagePath = rootDirectory === "." ? "package.json" : `${rootDirectory}/package.json`;
  const packageFile = await readRepoFile(auth, repository.owner, repository.repo, packagePath, commitSha);
  const detection = detectRepoPreviewProject(packageFile?.content ?? null, selectedPaths);

  const runnerFile = await readRepoFile(
    auth,
    repository.owner,
    repository.repo,
    REPO_PREVIEW_WORKFLOW_PATH,
    defaultBranch,
  );
  const runnerSource = runnerFile?.content ?? null;
  const installedVersion = repoPreviewRunnerVersion(runnerSource);
  const runner = repoPreviewWorkflowMatches(runnerSource)
    ? "ready"
    : runnerFile === null
      ? "missing"
      : "outdated";
  return {
    repository: repository.fullName,
    defaultBranch,
    ref: rawRef,
    commitSha: commitSha.toLowerCase(),
    rootDirectory,
    ...(outputDirectory ? { outputDirectory } : {}),
    rootSuggestions: rootSuggestions(allPaths),
    runner,
    ...(installedVersion ? { runnerVersion: installedVersion } : {}),
    ...detection,
  };
}

function randomPart(): string {
  return `${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requestOwner(request: Request): { email: string; key: string } | null {
  const encoded = request.headers.get("X-Gera-Email") ?? "";
  let email = "";
  try {
    email = decodeURIComponent(encoded).trim().toLowerCase();
  } catch {
    email = "";
  }
  const key = request.headers.get("X-Gera-Preview-Owner-Key") ?? "";
  return email && /^[a-f0-9]{24}$/.test(key) ? { email, key } : null;
}

function githubAuth(request: Request): string {
  const value = request.headers.get("X-Gera-GitHub-Authorization") ?? "";
  return value.length <= 1_000 && /^(?:Bearer|token)\s+[^\r\n]+$/i.test(value) ? value : "";
}

function requestPreviewToken(request: Request): string {
  const value = request.headers.get("X-Gera-Preview-Token") ?? "";
  return value.length <= 200 && PREVIEW_ID_PART.test(value) ? value : "";
}

const ACTIVE_PHASE_RANK: Record<ActiveRepoPreviewPhase, number> = {
  queued: 0,
  installing: 1,
  building: 2,
  packaging: 3,
  uploading: 4,
};

function isActivePhase(value: RepoPreviewPhase): value is ActiveRepoPreviewPhase {
  return ACTIVE_PHASES.includes(value as ActiveRepoPreviewPhase);
}

function canAdvancePhase(current: RepoPreviewPhase, next: RepoPreviewPhase): boolean {
  return isActivePhase(current) && isActivePhase(next) && ACTIVE_PHASE_RANK[next] >= ACTIVE_PHASE_RANK[current];
}

async function readRequestText(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    throw new PreviewGitHubError(413, "Request body is too large.");
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new PreviewGitHubError(413, "Request body is too large.");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

async function readRequestJson(request: Request, limit: number): Promise<Record<string, unknown> | null> {
  const text = await readRequestText(request, limit);
  if (!text) return null;
  try {
    return asRecord(JSON.parse(text) as unknown);
  } catch {
    throw new PreviewGitHubError(400, "Request body must be valid JSON.");
  }
}

function phaseValue(value: string): RepoPreviewPhase {
  return ([...ACTIVE_PHASES, "ready", "failed", "cancelled", "expired"] as string[]).includes(value)
    ? (value as RepoPreviewPhase)
    : "failed";
}

function frameworkValue(value: string): RepoPreviewFramework {
  const values: RepoPreviewFramework[] = [
    "vite",
    "next",
    "astro",
    "nuxt",
    "sveltekit",
    "remix",
    "react-scripts",
    "angular",
    "static",
    "unknown",
  ];
  return values.includes(value as RepoPreviewFramework) ? (value as RepoPreviewFramework) : "unknown";
}

function packageManagerValue(value: string): RepoPreviewPackageManager {
  return (["bun", "pnpm", "yarn", "npm", "none"] as string[]).includes(value)
    ? (value as RepoPreviewPackageManager)
    : "none";
}

function rowToJob(row: PreviewRow, origin: string): RepoPreviewJob {
  const phase = row.expires_at <= Date.now() && row.phase !== "cancelled" ? "expired" : phaseValue(row.phase);
  return {
    id: row.id,
    repository: row.repository,
    ref: row.ref,
    commitSha: row.commit_sha,
    rootDirectory: row.root_directory,
    ...(row.output_directory ? { outputDirectory: row.output_directory } : {}),
    framework: frameworkValue(row.framework),
    packageManager: packageManagerValue(row.package_manager),
    phase,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    ...(phase === "ready" ? { previewUrl: `${origin}/repo-preview/${row.id}/` } : {}),
    ...(row.actions_url ? { actionsUrl: row.actions_url } : {}),
    ...(row.setup_pr_url ? { setupPullRequestUrl: row.setup_pr_url } : {}),
    ...(row.logs ? { logs: row.logs } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

function safeError(error: unknown): { status: number; message: string } {
  if (error instanceof PreviewGitHubError) {
    return { status: error.status >= 400 && error.status < 600 ? error.status : 502, message: error.message };
  }
  return { status: 502, message: error instanceof Error ? error.message.slice(0, 300) : "Preview backend failed." };
}

function previewHeaders(contentType: string, html: boolean): Headers {
  const headers = new Headers({
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "private, no-store",
  });
  if (html) {
    headers.set(
      "Content-Security-Policy",
      "sandbox allow-scripts allow-forms allow-popups allow-modals; default-src 'self' https: data: blob:; base-uri 'self'; object-src 'none'; frame-ancestors *; script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob:; style-src 'self' 'unsafe-inline' https:; connect-src 'self' https: wss:; img-src 'self' https: data: blob:; media-src 'self' https: data: blob:; font-src 'self' https: data:; worker-src 'self' blob:;",
    );
  }
  return headers;
}

export class RepoPreviewStore extends DurableObject {
  private readonly workerEnv: RepoPreviewStoreEnv;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.workerEnv = (env ?? {}) as RepoPreviewStoreEnv;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS repo_previews (
        id TEXT PRIMARY KEY,
        owner_email TEXT NOT NULL,
        repository TEXT NOT NULL,
        ref TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        root_directory TEXT NOT NULL,
        output_directory TEXT NOT NULL DEFAULT '',
        framework TEXT NOT NULL,
        package_manager TEXT NOT NULL,
        phase TEXT NOT NULL,
        run_id TEXT NOT NULL DEFAULT '',
        actions_url TEXT NOT NULL DEFAULT '',
        setup_pr_url TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        token_hash TEXT NOT NULL,
        token_expires_at INTEGER NOT NULL,
        archive_key TEXT NOT NULL,
        archive_bytes INTEGER NOT NULL DEFAULT 0,
        manifest TEXT NOT NULL DEFAULT '',
        logs TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT ''
      )
    `);
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_repo_previews_owner_created ON repo_previews (owner_email, created_at DESC)");
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS repo_preview_owners (
        owner_key TEXT PRIMARY KEY,
        next_maintenance_at INTEGER NOT NULL,
        touched_at INTEGER NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1
      )
    `);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/internal/")) {
        return await this.handleInternal(request, url);
      }
      if (url.pathname.startsWith("/hook/")) {
        return await this.handleHook(request, url);
      }
      if (url.pathname.startsWith("/asset/")) {
        return await this.handleAsset(request, url);
      }
      const owner = requestOwner(request);
      if (!owner) {
        return json({ error: "sign_in_required" }, 401);
      }
      await this.sweep(owner.email);
      if (request.method === "POST" && url.pathname === "/inspect") {
        return await this.handleInspect(request);
      }
      if (request.method === "POST" && url.pathname === "/install") {
        return await this.handleInstall(request, owner);
      }
      if (request.method === "POST" && url.pathname === "/start") {
        return await this.handleStart(request, owner, url.origin);
      }
      if (request.method === "GET" && url.pathname === "/status") {
        return this.handleStatus(url, owner, url.origin);
      }
      if (request.method === "POST" && url.pathname === "/cancel") {
        return await this.handleCancel(request, owner, url.origin);
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      const safe = safeError(error);
      const routeLabel = url.pathname.startsWith("/hook/") ? "/hook/[redacted]" : url.pathname;
      console.error("repo preview route failed", routeLabel, safe.message);
      return json({ error: safe.message }, safe.status);
    }
  }

  private internalAuthorized(request: Request): boolean {
    const expected = this.workerEnv.RORK_AUTH_SECRET_KEY ?? "";
    const provided = request.headers.get("X-Gera-Internal-Secret") ?? "";
    if (!expected || expected.length !== provided.length) return false;
    let difference = 0;
    for (let index = 0; index < expected.length; index += 1) {
      difference |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
    }
    return difference === 0;
  }

  private async handleInternal(request: Request, url: URL): Promise<Response> {
    if (request.method !== "POST" || !this.internalAuthorized(request)) {
      return json({ error: "not_found" }, 404);
    }
    if (url.pathname === "/internal/touch") {
      const input = await readRequestJson(request, 2_000);
      const ownerKey = stringValue(input?.ownerKey, 24);
      const requestedAt = typeof input?.nextAt === "number" ? Math.floor(input.nextAt) : 0;
      if (!/^[a-f0-9]{24}$/.test(ownerKey)) {
        return json({ error: "invalid_owner_key" }, 400);
      }
      const now = Date.now();
      const nextAt = Math.min(now + REPO_PREVIEW_TTL_MS, Math.max(now + 60_000, requestedAt || now + 10 * 60_000));
      this.ctx.storage.sql.exec(
        `INSERT INTO repo_preview_owners (owner_key, next_maintenance_at, touched_at, generation) VALUES (?, ?, ?, 1)
          ON CONFLICT(owner_key) DO UPDATE SET
            next_maintenance_at = excluded.next_maintenance_at,
            touched_at = excluded.touched_at,
            generation = generation + 1`,
        ownerKey,
        nextAt,
        now,
      );
      return json({ ok: true });
    }
    if (url.pathname === "/internal/maintain") {
      await this.sweepAll();
      const nextAt = this.nextMaintenanceAt();
      return json({ ok: true, keep: nextAt !== null, nextAt });
    }
    if (url.pathname === "/internal/sweep") {
      if (!this.workerEnv.DO) return json({ error: "do_router_unavailable" }, 503);
      const now = Date.now();
      const owners = this.ctx.storage.sql
        .exec<{ owner_key: string; generation: number }>(
          "SELECT owner_key, generation FROM repo_preview_owners WHERE next_maintenance_at <= ? ORDER BY next_maintenance_at ASC LIMIT 50",
          now,
        )
        .toArray();
      let maintained = 0;
      for (const owner of owners) {
        try {
          const headers = new Headers({
            "X-Rork-DO-Class": "RepoPreviewStore",
            "X-Rork-DO-Id": `repo-preview:${owner.owner_key}`,
            "X-Gera-Internal-Secret": this.workerEnv.RORK_AUTH_SECRET_KEY ?? "",
          });
          const response = await this.workerEnv.DO.fetch(
            new Request(`${url.origin}/internal/maintain`, { method: "POST", headers }),
          );
          const result = asRecord(await response.json().catch(() => null));
          const keep = response.ok && result?.keep === true;
          const nextAt = typeof result?.nextAt === "number" ? Math.floor(result.nextAt) : now + 10 * 60_000;
          if (keep) {
            this.ctx.storage.sql.exec(
              "UPDATE repo_preview_owners SET next_maintenance_at = ?, touched_at = ? WHERE owner_key = ? AND generation = ?",
              Math.max(now + 60_000, nextAt),
              now,
              owner.owner_key,
              owner.generation,
            );
          } else if (response.ok) {
            this.ctx.storage.sql.exec(
              "DELETE FROM repo_preview_owners WHERE owner_key = ? AND generation = ?",
              owner.owner_key,
              owner.generation,
            );
          } else {
            this.ctx.storage.sql.exec(
              "UPDATE repo_preview_owners SET next_maintenance_at = ? WHERE owner_key = ? AND generation = ?",
              now + 10 * 60_000,
              owner.owner_key,
              owner.generation,
            );
          }
          maintained += 1;
        } catch {
          this.ctx.storage.sql.exec(
            "UPDATE repo_preview_owners SET next_maintenance_at = ? WHERE owner_key = ? AND generation = ?",
            now + 10 * 60_000,
            owner.owner_key,
            owner.generation,
          );
        }
      }
      return json({ ok: true, maintained, more: owners.length === 50 });
    }
    return json({ error: "not_found" }, 404);
  }

  private nextMaintenanceAt(): number | null {
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec<{ next_at: number | null }>(
        `SELECT MIN(CASE
          WHEN phase IN ('queued','installing','building','packaging','uploading') THEN token_expires_at
          WHEN archive_bytes < 0 THEN ?
          ELSE expires_at END) AS next_at
         FROM repo_previews
         WHERE expires_at > ? OR archive_bytes != 0
           OR phase IN ('queued','installing','building','packaging','uploading')`,
        now + 10 * 60_000,
        now,
      )
      .toArray()[0];
    return typeof row?.next_at === "number" ? Math.max(now + 60_000, row.next_at) : null;
  }

  private async sweepAll(): Promise<void> {
    const owners = this.ctx.storage.sql
      .exec<{ owner_email: string }>("SELECT DISTINCT owner_email FROM repo_previews")
      .toArray();
    for (const owner of owners) {
      await this.sweep(owner.owner_email);
    }
  }

  private async body(request: Request): Promise<Record<string, unknown>> {
    const parsed = await readRequestJson(request, CONTROL_BODY_LIMIT);
    if (!parsed) {
      throw new PreviewGitHubError(400, "Request body must be a JSON object.");
    }
    return parsed;
  }

  private row(id: string): PreviewRow | undefined {
    return this.ctx.storage.sql.exec<PreviewRow>("SELECT * FROM repo_previews WHERE id = ?", id).toArray()[0];
  }

  private async handleInspect(request: Request): Promise<Response> {
    const auth = githubAuth(request);
    if (!auth) {
      return json({ error: "GitHub sign-in is required for repository previews." }, 422);
    }
    const inspection = await inspectRepository(auth, await this.body(request));
    return json({ inspection });
  }

  private async handleInstall(request: Request, owner: { email: string; key: string }): Promise<Response> {
    const auth = githubAuth(request);
    if (!auth) {
      return json({ error: "GitHub sign-in with repository workflow access is required." }, 401);
    }
    const input = await this.body(request);
    const inspection = await inspectRepository(auth, input);
    if (inspection.runner === "ready") {
      return json({ ready: true, inspection });
    }
    const repository = parseRepoPreviewRepository(inspection.repository);
    if (!repository) {
      return json({ error: "invalid_repository" }, 400);
    }
    const defaultRef = asRecord(
      await githubJson(
        auth,
        repoPath(repository.owner, repository.repo, `/git/ref/heads/${encodeURIComponent(inspection.defaultBranch)}`),
      ),
    );
    const baseSha = stringValue(asRecord(defaultRef?.object)?.sha, 40);
    if (!/^[0-9a-f]{40}$/i.test(baseSha)) {
      throw new PreviewGitHubError(502, "GitHub returned no default-branch commit for the setup PR.");
    }
    const branch = `gera/web-preview-runner-${Date.now().toString(36)}-${owner.key.slice(0, 6)}`;
    await githubJson(auth, repoPath(repository.owner, repository.repo, "/git/refs"), {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha: baseSha },
    });
    const current = await readRepoFile(
      auth,
      repository.owner,
      repository.repo,
      REPO_PREVIEW_WORKFLOW_PATH,
      inspection.defaultBranch,
    );
    await githubJson(
      auth,
      repoPath(repository.owner, repository.repo, `/contents/${REPO_PREVIEW_WORKFLOW_PATH}`),
      {
        method: "PUT",
        body: {
          message: current ? "Update Gera web preview runner" : "Add Gera web preview runner",
          content: encodeBase64Utf8(repoPreviewWorkflowSource()),
          branch,
          ...(current?.sha ? { sha: current.sha } : {}),
        },
      },
    );
    const pull = asRecord(await githubJson(auth, repoPath(repository.owner, repository.repo, "/pulls"), {
      method: "POST",
      body: {
        title: current ? "Update Gera web preview runner" : "Add Gera web preview runner",
        head: branch,
        base: inspection.defaultBranch,
        body: [
          "Adds the bounded, read-only runner used by Gera to build ephemeral web previews.",
          "",
          "- checks out an immutable commit",
          "- receives no repository, Gera, or Rork secrets",
          "- uploads only the static build output through a short-lived preview-scoped token",
          "- keeps GitHub permissions at `contents: read`",
        ].join("\n"),
      },
    }));
    const pullRequestUrl = stringValue(pull?.html_url, 2_000);
    if (!pullRequestUrl.startsWith("https://github.com/")) {
      throw new PreviewGitHubError(502, `The runner branch was created (${branch}), but GitHub returned no setup PR URL.`);
    }
    return json({ ready: false, branch, pullRequestUrl, inspection });
  }

  private async handleStart(
    request: Request,
    owner: { email: string; key: string },
    origin: string,
  ): Promise<Response> {
    const auth = githubAuth(request);
    if (!auth) {
      return json({ error: "GitHub sign-in is required for repository previews." }, 422);
    }
    const input = await this.body(request);
    const inspection = await inspectRepository(auth, input);
    if (inspection.runner !== "ready") {
      return json({ error: "runner_setup_required", inspection }, 428);
    }
    if (!inspection.projectFound) {
      return json({ error: "No runnable package.json or index.html was found at this project root.", inspection }, 422);
    }
    const duplicate = this.ctx.storage.sql
      .exec<PreviewRow>(
        `SELECT * FROM repo_previews
          WHERE owner_email = ? AND repository = ? AND commit_sha = ? AND root_directory = ?
            AND output_directory = ? AND phase IN ('queued','installing','building','packaging','uploading')
          ORDER BY created_at DESC LIMIT 1`,
        owner.email,
        inspection.repository,
        inspection.commitSha,
        inspection.rootDirectory,
        inspection.outputDirectory ?? "",
      )
      .toArray()[0];
    if (duplicate) {
      return json({ job: rowToJob(duplicate, origin), deduplicated: true }, 200);
    }
    const activeCount = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM repo_previews WHERE owner_email = ? AND phase IN ('queued','installing','building','packaging','uploading')`,
        owner.email,
      )
      .toArray()[0]?.n ?? 0;
    if (activeCount >= MAX_ACTIVE_JOBS) {
      return json({ error: "Two repository previews are already building. Stop one or wait for it to finish." }, 429);
    }
    const count = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM repo_previews WHERE owner_email = ?", owner.email)
      .toArray()[0]?.n ?? 0;
    if (count >= MAX_RECENT_JOBS) {
      const oldest = this.ctx.storage.sql
        .exec<PreviewRow>(
          "SELECT * FROM repo_previews WHERE owner_email = ? AND phase NOT IN ('queued','installing','building','packaging','uploading') ORDER BY created_at ASC LIMIT 1",
          owner.email,
        )
        .toArray()[0];
      if (!oldest) {
        return json({ error: "Preview history is full while builds are active." }, 429);
      }
      if (!(await this.deleteArchive(oldest))) {
        this.ctx.storage.sql.exec(
          "UPDATE repo_previews SET archive_bytes = -2, manifest = '', updated_at = ? WHERE id = ?",
          Date.now(),
          oldest.id,
        );
        return json({ error: "Rork storage cleanup is pending; retry this launch shortly." }, 503);
      }
      this.ctx.storage.sql.exec("DELETE FROM repo_previews WHERE id = ?", oldest.id);
    }

    const previewSecret = this.workerEnv.RORK_AUTH_SECRET_KEY ?? "";
    if (!previewSecret) {
      return json({ error: "preview_identity_unavailable" }, 503);
    }
    const random = randomPart();
    const id = await signRepoPreviewId(owner.key, random.slice(0, 48), previewSecret);
    const uploadToken = randomPart();
    const tokenHash = await sha256(uploadToken);
    const now = Date.now();
    const repository = parseRepoPreviewRepository(inspection.repository);
    if (!repository || !isRepoPreviewId(id)) {
      return json({ error: "invalid_preview_identity" }, 400);
    }
    const archiveKey = `previews/${owner.key}/${random.slice(0, 64)}.tar`;
    const workflowName = REPO_PREVIEW_WORKFLOW_PATH.split("/").pop() ?? "gera-web-preview.yml";
    const actionsUrl = `https://github.com/${inspection.repository}/actions/workflows/${workflowName}`;
    this.ctx.storage.sql.exec(
      `INSERT INTO repo_previews
        (id, owner_email, repository, ref, commit_sha, root_directory, output_directory,
         framework, package_manager, phase, run_id, actions_url, setup_pr_url,
         created_at, updated_at, expires_at, token_hash, token_expires_at,
         archive_key, archive_bytes, manifest, logs, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', '', ?, '', ?, ?, ?, ?, ?, ?, 0, '', '', '')`,
      id,
      owner.email,
      inspection.repository,
      inspection.ref,
      inspection.commitSha,
      inspection.rootDirectory,
      inspection.outputDirectory ?? "",
      inspection.framework,
      inspection.packageManager,
      actionsUrl,
      now,
      now,
      now + REPO_PREVIEW_TTL_MS,
      tokenHash,
      now + REPO_PREVIEW_TOKEN_TTL_MS,
      archiveKey,
    );
    try {
      const dispatch = asRecord(await githubJson(
        auth,
        repoPath(repository.owner, repository.repo, `/actions/workflows/${encodeURIComponent(workflowName)}/dispatches`),
        {
          method: "POST",
          body: {
            ref: inspection.defaultBranch,
            return_run_details: true,
            inputs: {
              preview_id: id,
              commit_sha: inspection.commitSha,
              root_directory: inspection.rootDirectory,
              output_directory: inspection.outputDirectory ?? "",
              callback_url: origin,
              upload_token: uploadToken,
            },
          },
        },
      ));
      const runId = typeof dispatch?.workflow_run_id === "number" ? String(Math.floor(dispatch.workflow_run_id)) : "";
      const runUrl = stringValue(dispatch?.html_url, 2_000);
      if (!/^\d+$/.test(runId) || !runUrl.startsWith(`https://github.com/${inspection.repository}/actions/runs/`)) {
        throw new PreviewGitHubError(502, "GitHub dispatched the workflow but returned no verifiable run identity.");
      }
      this.ctx.storage.sql.exec(
        `UPDATE repo_previews SET run_id = ?, actions_url = ?, updated_at = ?
          WHERE id = ? AND run_id = ''`,
        runId,
        runUrl,
        Date.now(),
        id,
      );
    } catch (error) {
      const safe = safeError(error);
      this.ctx.storage.sql.exec(
        "UPDATE repo_previews SET phase = 'failed', updated_at = ?, token_hash = '', error = ? WHERE id = ?",
        Date.now(),
        safe.message,
        id,
      );
      throw error;
    }
    const created = this.row(id);
    if (!created) {
      return json({ error: "preview_state_unavailable" }, 502);
    }
    console.log("repo preview dispatched", inspection.repository, inspection.framework, id.slice(0, 30));
    return json({ job: rowToJob(created, origin) }, 202);
  }

  private handleStatus(url: URL, owner: { email: string; key: string }, origin: string): Response {
    const id = url.searchParams.get("id") ?? "";
    const row = isRepoPreviewId(id) ? this.row(id) : undefined;
    if (!row || row.owner_email !== owner.email || !id.startsWith(`${owner.key}.`)) {
      return json({ error: "preview_not_found" }, 404);
    }
    if (row.phase === "queued" && Date.now() - row.updated_at > QUEUED_TIMEOUT_MS) {
      this.ctx.storage.sql.exec(
        "UPDATE repo_previews SET phase = 'failed', updated_at = ?, token_hash = '', error = ? WHERE id = ?",
        Date.now(),
        "GitHub did not start the preview workflow within 20 minutes. Check whether Actions are enabled for this repository.",
        id,
      );
    }
    const current = this.row(id) ?? row;
    return json({ job: rowToJob(current, origin) });
  }

  private async handleCancel(
    request: Request,
    owner: { email: string; key: string },
    origin: string,
  ): Promise<Response> {
    const input = await this.body(request);
    const id = stringValue(input.id, 120);
    const row = isRepoPreviewId(id) ? this.row(id) : undefined;
    if (!row || row.owner_email !== owner.email || !id.startsWith(`${owner.key}.`)) {
      return json({ error: "preview_not_found" }, 404);
    }
    if (ACTIVE_PHASES.includes(phaseValue(row.phase))) {
      const auth = githubAuth(request);
      const repository = parseRepoPreviewRepository(row.repository);
      if (!auth || !repository || !/^\d+$/.test(row.run_id)) {
        return json({ error: "A verified GitHub Actions run is required before this preview can be stopped." }, 409);
      }
      await githubJson(
        auth,
        repoPath(repository.owner, repository.repo, `/actions/runs/${row.run_id}/cancel`),
        { method: "POST" },
      );
      const beforeMark = this.row(id);
      if (!beforeMark || !ACTIVE_PHASES.includes(phaseValue(beforeMark.phase))) {
        return json({ job: rowToJob(beforeMark ?? row, origin) });
      }
      this.ctx.storage.sql.exec(
        `UPDATE repo_previews SET phase = 'cancelled', updated_at = ?, token_hash = '', error = ''
          WHERE id = ? AND phase = ?`,
        Date.now(),
        id,
        beforeMark.phase,
      );
      const cancelled = this.row(id);
      if (cancelled?.phase === "cancelled") {
        const deleted = await this.deleteArchive(cancelled);
        this.ctx.storage.sql.exec(
          "UPDATE repo_previews SET archive_bytes = ?, manifest = '' WHERE id = ? AND phase = 'cancelled'",
          deleted ? 0 : -2,
          id,
        );
      }
    }
    const current = this.row(id) ?? row;
    return json({ job: rowToJob(current, origin) });
  }

  private async authenticatedHook(request: Request, url: URL): Promise<{ row: PreviewRow; id: string; action: string; token: string } | null> {
    const parts = url.pathname.slice("/hook/".length).split("/");
    if (parts.length !== 2) {
      return null;
    }
    const [id, action] = parts;
    const token = requestPreviewToken(request);
    if (!isRepoPreviewId(id) || !PREVIEW_ID_PART.test(token) || !["started", "phase", "archive", "manifest", "logs", "complete"].includes(action)) {
      return null;
    }
    const row = this.row(id);
    if (!row || !row.token_hash || row.token_expires_at <= Date.now() || row.token_hash !== await sha256(token)) {
      return null;
    }
    if (row.phase === "cancelled" || row.phase === "expired" || row.phase === "ready") {
      return null;
    }
    return { row, id, action, token };
  }

  private async handleHook(request: Request, url: URL): Promise<Response> {
    const auth = await this.authenticatedHook(request, url);
    if (!auth) {
      return json({ error: "hook_not_found" }, 404);
    }
    const { row, id, action, token } = auth;
    const expectedMethod = ["archive", "manifest", "logs"].includes(action) ? "PUT" : "POST";
    if (request.method !== expectedMethod) {
      return json({ error: "method_not_allowed" }, 405);
    }
    const contentType = (request.headers.get("Content-Type") ?? "").split(";", 1)[0].trim().toLowerCase();
    const expectedType = action === "archive"
      ? "application/x-tar"
      : action === "logs"
        ? "text/plain"
        : "application/json";
    if (contentType !== expectedType) {
      return json({ error: "unsupported_content_type" }, 415);
    }
    const now = Date.now();
    if (action === "started") {
      if (row.phase === "queued") {
        this.ctx.storage.sql.exec(
          "UPDATE repo_previews SET phase = 'installing', updated_at = ? WHERE id = ? AND token_hash = ? AND phase = 'queued'",
          now,
          id,
          row.token_hash,
        );
      }
      return json({ ok: true });
    }
    if (action === "phase") {
      const input = await readRequestJson(request, 4_000);
      const phase = stringValue(input?.phase, 30) as RepoPreviewPhase;
      const current = this.row(id);
      if (!current || current.token_hash !== row.token_hash || !canAdvancePhase(phaseValue(current.phase), phase) || phase === "queued") {
        return json({ error: "invalid_phase_transition" }, 409);
      }
      this.ctx.storage.sql.exec(
        "UPDATE repo_previews SET phase = ?, updated_at = ? WHERE id = ? AND token_hash = ? AND phase = ?",
        phase,
        now,
        id,
        row.token_hash,
        current.phase,
      );
      return json({ ok: true });
    }
    if (action === "logs") {
      const rawLogs = await readRequestText(request, REPO_PREVIEW_MAX_LOG_CHARS * 2);
      const logs = redactRepoPreviewLog(rawLogs.replaceAll(token, "[redacted-upload-capability]"));
      const current = this.row(id);
      if (!current || current.token_hash !== row.token_hash || !ACTIVE_PHASES.includes(phaseValue(current.phase))) {
        return json({ error: "preview_not_active" }, 409);
      }
      this.ctx.storage.sql.exec(
        `UPDATE repo_previews SET logs = ?, updated_at = ?
          WHERE id = ? AND token_hash = ? AND phase IN ('queued','installing','building','packaging','uploading')`,
        logs,
        now,
        id,
        row.token_hash,
      );
      return json({ ok: true });
    }
    if (action === "archive") {
      const contentLength = Number(request.headers.get("Content-Length") ?? "0");
      if (
        !request.body ||
        !Number.isInteger(contentLength) ||
        contentLength <= 0 ||
        contentLength > REPO_PREVIEW_MAX_ARCHIVE_BYTES
      ) {
        return json({ error: "invalid_archive_size" }, 413);
      }
      const current = this.row(id);
      if (
        !current ||
        current.token_hash !== row.token_hash ||
        !ACTIVE_PHASES.includes(phaseValue(current.phase)) ||
        current.archive_bytes !== 0
      ) {
        return json({ error: "archive_already_claimed" }, 409);
      }
      const stagingKey = `${row.archive_key}.upload-${row.token_hash.slice(0, 12)}`;
      this.ctx.storage.sql.exec(
        `UPDATE repo_previews SET phase = 'uploading', archive_key = ?, archive_bytes = -1, manifest = '', updated_at = ?
          WHERE id = ? AND token_hash = ? AND archive_bytes = 0
            AND phase IN ('queued','installing','building','packaging','uploading')`,
        stagingKey,
        now,
        id,
        row.token_hash,
      );
      const claimed = this.row(id);
      if (!claimed || claimed.token_hash !== row.token_hash || claimed.archive_bytes !== -1 || claimed.phase !== "uploading") {
        return json({ error: "archive_claim_failed" }, 409);
      }
      const creds = await getRorkStorageCredentials(this.workerEnv);
      const upload = await fetch(await presignRorkStorageUrl(creds, "PUT", stagingKey), {
        method: "PUT",
        headers: { "Content-Type": "application/x-tar" },
        body: request.body,
      });
      if (!upload.ok) {
        console.error("repo preview R2 upload failed", upload.status);
        const deleted = await this.deleteStorageKey(stagingKey);
        this.ctx.storage.sql.exec(
          `UPDATE repo_previews SET phase = 'failed', token_hash = '', archive_bytes = ?, manifest = '', updated_at = ?, error = ?
            WHERE id = ? AND token_hash = ? AND archive_bytes = -1`,
          deleted ? 0 : -2,
          Date.now(),
          "Rork storage rejected the preview artifact.",
          id,
          row.token_hash,
        );
        return json({ error: "archive_upload_failed" }, 502);
      }
      const afterUpload = this.row(id);
      if (
        !afterUpload ||
        afterUpload.token_hash !== row.token_hash ||
        afterUpload.token_expires_at <= Date.now() ||
        afterUpload.phase !== "uploading" ||
        afterUpload.archive_bytes !== -1
      ) {
        if (!(await this.deleteStorageKey(stagingKey))) {
          this.ctx.storage.sql.exec(
            `UPDATE repo_previews SET archive_bytes = -2, manifest = ''
              WHERE id = ? AND archive_key = ? AND archive_bytes <= 0`,
            id,
            stagingKey,
          );
        }
        return json({ error: "preview_no_longer_active" }, 409);
      }
      this.ctx.storage.sql.exec(
        `UPDATE repo_previews SET archive_bytes = ?, updated_at = ?
          WHERE id = ? AND token_hash = ? AND phase = 'uploading' AND archive_bytes = -1`,
        contentLength,
        Date.now(),
        id,
        row.token_hash,
      );
      return json({ ok: true });
    }
    if (action === "manifest") {
      const body = await readRequestText(request, MANIFEST_BODY_LIMIT);
      let decoded: unknown;
      try {
        decoded = JSON.parse(body) as unknown;
      } catch {
        return json({ error: "invalid_manifest_json" }, 400);
      }
      const current = this.row(id);
      if (
        !current ||
        current.token_hash !== row.token_hash ||
        current.phase !== "uploading" ||
        current.archive_bytes <= 0 ||
        current.manifest
      ) {
        return json({ error: "manifest_out_of_order" }, 409);
      }
      const manifest = normalizeRepoPreviewManifest(decoded, current.archive_bytes);
      if (!manifest) {
        return json({ error: "invalid_manifest" }, 400);
      }
      this.ctx.storage.sql.exec(
        `UPDATE repo_previews SET manifest = ?, updated_at = ?
          WHERE id = ? AND token_hash = ? AND phase = 'uploading' AND archive_bytes > 0 AND manifest = ''`,
        JSON.stringify(manifest),
        now,
        id,
        row.token_hash,
      );
      return json({ ok: true });
    }
    if (action === "complete") {
      const input = await readRequestJson(request, 4_000);
      const success = input?.status === "success";
      const message = stringValue(input?.message, 300);
      const current = this.row(id);
      if (!current || current.token_hash !== row.token_hash || !ACTIVE_PHASES.includes(phaseValue(current.phase))) {
        return json({ error: "preview_not_active" }, 409);
      }
      const ready = success && current.phase === "uploading" && current.archive_bytes > 0 && Boolean(current.manifest);
      this.ctx.storage.sql.exec(
        "UPDATE repo_previews SET phase = ?, token_hash = '', updated_at = ?, error = ? WHERE id = ? AND token_hash = ?",
        ready ? "ready" : "failed",
        now,
        ready ? "" : message || "The repository build did not produce a valid preview artifact.",
        id,
        row.token_hash,
      );
      console.log("repo preview completed", ready ? "ready" : "failed", row.repository, id.slice(0, 30));
      return json({ ok: true, ready });
    }
    return json({ error: "not_found" }, 404);
  }

  private async handleAsset(request: Request, url: URL): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    const rest = url.pathname.slice("/asset/".length);
    const slash = rest.indexOf("/");
    const id = slash >= 0 ? rest.slice(0, slash) : rest;
    if (!isRepoPreviewId(id)) {
      return new Response("Preview not found", { status: 404 });
    }
    const row = this.row(id);
    if (!row) {
      return new Response("Preview not found", { status: 404 });
    }
    if (row.expires_at <= Date.now()) {
      this.ctx.storage.sql.exec(
        "UPDATE repo_previews SET phase = 'expired', token_hash = '', updated_at = ? WHERE id = ?",
        Date.now(),
        id,
      );
      return new Response("This preview expired.", { status: 410 });
    }
    if (row.phase !== "ready" || !row.manifest || row.archive_bytes <= 0) {
      return new Response("Preview is not ready.", { status: 409 });
    }
    let manifest: RepoPreviewManifest | null = null;
    try {
      manifest = normalizeRepoPreviewManifest(JSON.parse(row.manifest) as unknown, row.archive_bytes);
    } catch {
      manifest = null;
    }
    if (!manifest) {
      return new Response("Preview manifest is invalid.", { status: 500 });
    }
    let requested = "";
    try {
      requested = decodeURIComponent(slash >= 0 ? rest.slice(slash + 1) : "").replace(/^\/+/, "");
    } catch {
      return new Response("Bad preview path.", { status: 400 });
    }
    if (requested && normalizeRepoPreviewDirectory(requested, "") !== requested) {
      return new Response("Bad preview path.", { status: 400 });
    }
    let file = manifest.files.find((entry) => entry.path === (requested || manifest.entry));
    const tail = requested.split("/").pop() ?? "";
    if (!file && (!tail || !tail.includes("."))) {
      file = manifest.files.find((entry) => entry.path === manifest.entry);
    }
    if (!file) {
      return new Response("Not found", { status: 404 });
    }
    const contentType = repoPreviewContentType(file.path);
    const html = contentType.startsWith("text/html");
    if (html && file.size > HTML_REWRITE_LIMIT) {
      return new Response("Preview HTML exceeds the safe rendering limit.", { status: 413 });
    }
    const headers = previewHeaders(contentType, html);
    if (request.method === "HEAD" || file.size === 0) {
      headers.set("Content-Length", String(file.size));
      return new Response(null, { status: 200, headers });
    }
    const creds = await getRorkStorageCredentials(this.workerEnv);
    const signed = await presignRorkStorageUrl(creds, "GET", row.archive_key);
    const range = `bytes=${file.offset}-${file.offset + file.size - 1}`;
    const upstream = await fetch(signed, { headers: { Range: range } });
    if (!upstream.ok || upstream.status !== 206) {
      console.error("repo preview R2 range failed", upstream.status);
      return new Response("Preview artifact is unavailable.", { status: 502 });
    }
    let body: BodyInit | null = upstream.body;
    if (html) {
      const selected = new Uint8Array(await upstream.arrayBuffer());
      if (selected.byteLength !== file.size) {
        return new Response("Preview artifact range is invalid.", { status: 502 });
      }
      body = rewriteRepoPreviewHtml(new TextDecoder().decode(selected), `/repo-preview/${id}/`);
    }
    if (typeof body === "string") {
      headers.set("Content-Length", String(new TextEncoder().encode(body).byteLength));
    } else {
      headers.set("Content-Length", String(file.size));
    }
    return new Response(body, { status: 200, headers });
  }

  private async deleteStorageKey(key: string): Promise<boolean> {
    if (!key) return true;
    try {
      const creds = await getRorkStorageCredentials(this.workerEnv);
      const response = await fetch(await presignRorkStorageUrl(creds, "DELETE", key), { method: "DELETE" });
      return response.ok || response.status === 404;
    } catch {
      return false;
    }
  }

  private async deleteArchive(row: PreviewRow): Promise<boolean> {
    if (!row.archive_key || (row.archive_bytes === 0 && !row.archive_key.includes(".upload-"))) {
      return true;
    }
    return this.deleteStorageKey(row.archive_key);
  }

  private async sweep(ownerEmail: string): Promise<void> {
    const now = Date.now();
    const pendingCleanup = this.ctx.storage.sql
      .exec<PreviewRow>(
        "SELECT * FROM repo_previews WHERE owner_email = ? AND archive_bytes < 0 AND phase NOT IN ('queued','installing','building','packaging','uploading')",
        ownerEmail,
      )
      .toArray();
    for (const row of pendingCleanup) {
      if (await this.deleteArchive(row)) {
        this.ctx.storage.sql.exec(
          "UPDATE repo_previews SET archive_bytes = 0, manifest = '' WHERE id = ? AND archive_bytes < 0",
          row.id,
        );
      }
    }
    this.ctx.storage.sql.exec(
      `UPDATE repo_previews
        SET phase = 'failed', token_hash = '', updated_at = ?, error = ?
        WHERE owner_email = ? AND token_expires_at <= ?
          AND phase IN ('queued','installing','building','packaging','uploading')`,
      now,
      "The isolated runner did not finish before its 45-minute upload capability expired.",
      ownerEmail,
      now,
    );
    const expired = this.ctx.storage.sql
      .exec<PreviewRow>(
        "SELECT * FROM repo_previews WHERE owner_email = ? AND expires_at <= ?",
        ownerEmail,
        now,
      )
      .toArray();
    for (const row of expired) {
      const deleted = await this.deleteArchive(row);
      this.ctx.storage.sql.exec(
        `UPDATE repo_previews SET phase = 'expired', token_hash = '', updated_at = ?,
          archive_bytes = ?, manifest = ? WHERE id = ?`,
        now,
        deleted ? 0 : row.archive_bytes,
        deleted ? "" : row.manifest,
        row.id,
      );
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM repo_previews WHERE owner_email = ? AND expires_at < ? AND archive_bytes = 0",
      ownerEmail,
      now - 7 * REPO_PREVIEW_TTL_MS,
    );
  }
}
