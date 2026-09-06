import { authedFetchForSession, AuthSessionChangedError } from "@/lib/backend";
import { authSessionSnapshot, isAuthSessionCurrent } from "@/lib/auth-tokens";
import { githubWireReference } from "@/lib/github-transport";
import type {
  RepoPreviewFramework,
  RepoPreviewInspection,
  RepoPreviewJob,
  RepoPreviewPackageManager,
  RepoPreviewPhase,
  RepoPreviewRootSource,
} from "@/lib/types";

const PHASES = new Set<RepoPreviewPhase>([
  "queued",
  "installing",
  "building",
  "packaging",
  "uploading",
  "ready",
  "failed",
  "cancelled",
  "expired",
]);
const FRAMEWORKS = new Set<RepoPreviewFramework>([
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
]);
const PACKAGE_MANAGERS = new Set<RepoPreviewPackageManager>(["bun", "pnpm", "yarn", "npm", "none"]);
const ROOT_SOURCES = new Set<RepoPreviewRootSource>(["explicit", "root", "rork.json", "detected"]);
const PREVIEW_ID = /^[a-f0-9]{24}\.[A-Za-z0-9_-]{32,64}\.[a-f0-9]{24}$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;

export type RepoPreviewInput = {
  repository: string;
  ref?: string;
  rootDirectory?: string;
  outputDirectory?: string;
};

export type RepoPreviewInstallResult = {
  ready: boolean;
  inspection: RepoPreviewInspection;
  branch?: string;
  pullRequestUrl?: string;
};

export class RepoPreviewApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly inspection?: RepoPreviewInspection;

  constructor(code: string, status: number, inspection?: RepoPreviewInspection) {
    const copy: Record<string, string> = {
      runner_setup_required: "This repository needs the one-time Gera preview runner first.",
      preview_not_found: "This repository preview no longer exists.",
      invite_required: "Your Gera account cannot launch repository previews.",
      sign_in_required: "Sign in to Gera before launching a repository.",
    };
    super(copy[code] ?? code);
    this.name = "RepoPreviewApiError";
    this.code = code;
    this.status = status;
    this.inspection = inspection;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;
}

function httpsUrl(value: unknown): string | undefined {
  const raw = text(value, 2_000);
  if (!raw) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function directory(value: unknown, fallback = "."): string | undefined {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const raw = text(value, 220)?.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!raw || raw === ".") {
    return ".";
  }
  return raw.startsWith("/") || raw.split("/").some((part) => !part || part === "." || part === "..")
    ? undefined
    : raw;
}

/** Distrusts synced/API preview metadata before rendering URLs or logs. */
export function normalizeRepoPreviewJob(value: unknown): RepoPreviewJob | undefined {
  const raw = object(value);
  const id = text(raw?.id, 120);
  const repository = text(raw?.repository, 200);
  const ref = text(raw?.ref, 180);
  const commitSha = text(raw?.commitSha, 40);
  const rootDirectory = directory(raw?.rootDirectory);
  const outputDirectory = raw?.outputDirectory ? directory(raw.outputDirectory, "") : undefined;
  const phase = raw?.phase as RepoPreviewPhase;
  const framework = raw?.framework as RepoPreviewFramework;
  const packageManager = raw?.packageManager as RepoPreviewPackageManager;
  if (
    !raw ||
    !id ||
    !PREVIEW_ID.test(id) ||
    !repository ||
    !REPOSITORY.test(repository) ||
    !ref ||
    !commitSha ||
    !/^[0-9a-f]{40}$/i.test(commitSha) ||
    !rootDirectory ||
    (raw.outputDirectory !== undefined && !outputDirectory) ||
    !PHASES.has(phase) ||
    !FRAMEWORKS.has(framework) ||
    !PACKAGE_MANAGERS.has(packageManager)
  ) {
    return undefined;
  }
  const number = (entry: unknown): number =>
    typeof entry === "number" && Number.isFinite(entry) ? Math.max(0, Math.floor(entry)) : 0;
  const createdAt = number(raw.createdAt);
  const updatedAt = number(raw.updatedAt);
  const expiresAt = number(raw.expiresAt);
  if (!createdAt || !updatedAt || !expiresAt) {
    return undefined;
  }
  return {
    id,
    repository,
    ref,
    commitSha: commitSha.toLowerCase(),
    rootDirectory,
    ...(outputDirectory ? { outputDirectory } : {}),
    framework,
    packageManager,
    phase,
    createdAt,
    updatedAt,
    expiresAt,
    ...(httpsUrl(raw.previewUrl) ? { previewUrl: httpsUrl(raw.previewUrl) } : {}),
    ...(httpsUrl(raw.actionsUrl) ? { actionsUrl: httpsUrl(raw.actionsUrl) } : {}),
    ...(httpsUrl(raw.setupPullRequestUrl) ? { setupPullRequestUrl: httpsUrl(raw.setupPullRequestUrl) } : {}),
    ...(text(raw.logs, 120_000) ? { logs: text(raw.logs, 120_000) } : {}),
    ...(text(raw.error, 500) ? { error: text(raw.error, 500) } : {}),
  };
}

export function normalizeRepoPreviewInspection(value: unknown): RepoPreviewInspection | undefined {
  const raw = object(value);
  const repository = text(raw?.repository, 200);
  const defaultBranch = text(raw?.defaultBranch, 180);
  const ref = text(raw?.ref, 180);
  const commitSha = text(raw?.commitSha, 40);
  const rootDirectory = directory(raw?.rootDirectory);
  const outputDirectory = raw?.outputDirectory ? directory(raw.outputDirectory, "") : undefined;
  const framework = raw?.framework as RepoPreviewFramework;
  const packageManager = raw?.packageManager as RepoPreviewPackageManager;
  if (
    !raw ||
    !repository ||
    !REPOSITORY.test(repository) ||
    !defaultBranch ||
    !ref ||
    !commitSha ||
    !/^[0-9a-f]{40}$/i.test(commitSha) ||
    !rootDirectory ||
    (raw.outputDirectory !== undefined && !outputDirectory) ||
    (raw.runner !== "ready" && raw.runner !== "missing" && raw.runner !== "outdated") ||
    !FRAMEWORKS.has(framework) ||
    !PACKAGE_MANAGERS.has(packageManager) ||
    typeof raw.projectFound !== "boolean"
  ) {
    return undefined;
  }
  // Older backends omit rootSource; a "." root is the repo root, anything else was typed.
  const rootSource: RepoPreviewRootSource = ROOT_SOURCES.has(raw.rootSource as RepoPreviewRootSource)
    ? (raw.rootSource as RepoPreviewRootSource)
    : rootDirectory === "."
      ? "root"
      : "explicit";
  return {
    repository,
    defaultBranch,
    ref,
    commitSha: commitSha.toLowerCase(),
    rootDirectory,
    rootSource,
    ...(outputDirectory ? { outputDirectory } : {}),
    rootSuggestions: Array.isArray(raw.rootSuggestions)
      ? raw.rootSuggestions.flatMap((item): string[] => {
          const normalized = directory(item);
          return normalized ? [normalized] : [];
        }).slice(0, 12)
      : [],
    runner: raw.runner,
    ...(typeof raw.runnerVersion === "number" && Number.isInteger(raw.runnerVersion) && raw.runnerVersion > 0
      ? { runnerVersion: raw.runnerVersion }
      : {}),
    framework,
    packageManager,
    projectFound: raw.projectFound,
  };
}

async function requestJson(
  path: string,
  init: RequestInit,
  githubAuthorization?: string,
): Promise<Record<string, unknown>> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (githubAuthorization) {
    headers.set("X-Gera-Upstream-Authorization", githubWireReference(githubAuthorization));
  }
  const session = authSessionSnapshot();
  const response = await authedFetchForSession(path, session, { ...init, headers: Object.fromEntries(headers.entries()) });
  const body = object(await response.json().catch(() => null)) ?? {};
  if (!isAuthSessionCurrent(session)) throw new AuthSessionChangedError();
  if (githubAuthorization) githubWireReference(githubAuthorization);
  if (!response.ok) {
    const code = text(body.error, 500) ?? `Repository preview request failed (${response.status}).`;
    throw new RepoPreviewApiError(code, response.status, normalizeRepoPreviewInspection(body.inspection));
  }
  return body;
}

export async function inspectRepoPreview(
  input: RepoPreviewInput,
  githubAuthorization: string,
): Promise<RepoPreviewInspection> {
  const body = await requestJson(
    "/repo-previews/inspect",
    { method: "POST", body: JSON.stringify(input) },
    githubAuthorization,
  );
  const inspection = normalizeRepoPreviewInspection(body.inspection);
  if (!inspection) {
    throw new Error("Gera returned invalid repository inspection metadata.");
  }
  return inspection;
}

export async function installRepoPreviewRunner(
  input: RepoPreviewInput,
  githubAuthorization: string,
): Promise<RepoPreviewInstallResult> {
  const body = await requestJson(
    "/repo-previews/install",
    { method: "POST", body: JSON.stringify(input) },
    githubAuthorization,
  );
  const inspection = normalizeRepoPreviewInspection(body.inspection);
  if (!inspection) {
    throw new Error("Gera returned invalid runner setup metadata.");
  }
  return {
    ready: body.ready === true,
    inspection,
    ...(text(body.branch, 220) ? { branch: text(body.branch, 220) } : {}),
    ...(httpsUrl(body.pullRequestUrl) ? { pullRequestUrl: httpsUrl(body.pullRequestUrl) } : {}),
  };
}

export async function startRepoPreview(
  input: RepoPreviewInput,
  githubAuthorization: string,
): Promise<RepoPreviewJob> {
  const body = await requestJson(
    "/repo-previews/start",
    { method: "POST", body: JSON.stringify(input) },
    githubAuthorization,
  );
  const job = normalizeRepoPreviewJob(body.job);
  if (!job) {
    throw new Error("Gera returned invalid repository preview metadata.");
  }
  return job;
}

export async function getRepoPreview(id: string): Promise<RepoPreviewJob> {
  const body = await requestJson(`/repo-previews/status?id=${encodeURIComponent(id)}`, { method: "GET" });
  const job = normalizeRepoPreviewJob(body.job);
  if (!job) {
    throw new Error("Gera returned invalid repository preview status.");
  }
  return job;
}

export async function cancelRepoPreview(id: string, githubAuthorization?: string): Promise<RepoPreviewJob> {
  const body = await requestJson(
    "/repo-previews/cancel",
    { method: "POST", body: JSON.stringify({ id }) },
    githubAuthorization,
  );
  const job = normalizeRepoPreviewJob(body.job);
  if (!job) {
    throw new Error("Gera returned invalid repository preview status.");
  }
  return job;
}
