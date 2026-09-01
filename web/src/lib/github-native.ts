import { authedFetch, relayFetch } from "@/lib/backend";
import { GitHubAuthError, fetchGitHubViewer, githubIdentityLabel } from "@/lib/github-device";
import { hasOAuthRefreshToken, hasOAuthToken, oauthAuthHeader } from "@/lib/mcp-oauth";
import type { McpServerConfig, McpToolInfo } from "@/lib/types";

/**
 * Native GitHub connector — the GitHub REST API straight from the browser.
 *
 * The Copilot MCP endpoint (api.githubcopilot.com/mcp/) is a moving target with
 * its own auth quirks; the plain REST API (api.github.com) answers browsers
 * with `Access-Control-Allow-Origin: *` (verified by live probe), so the
 * device-flow token or a pasted PAT never has to leave the browser. It also
 * lets "my repositories" be the deterministic /user/repos listing instead of
 * a global search that misses private repos.
 */

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GERA_ACCOUNT_AUTH_PREFIX = "gera-account:";

function accountAuthServerId(auth: string): string | null {
  return auth.startsWith(GERA_ACCOUNT_AUTH_PREFIX)
    ? auth.slice(GERA_ACCOUNT_AUTH_PREFIX.length) || "github"
    : null;
}

async function githubTransportFetch(auth: string, url: URL, init: RequestInit): Promise<Response> {
  const serverId = accountAuthServerId(auth);
  if (!serverId) {
    return fetch(url.toString(), init);
  }
  const path = `${url.pathname}${url.search}`;
  const headers = new Headers(init.headers);
  const accept = headers.get("Accept") ?? "application/vnd.github+json";
  headers.delete("Authorization");
  headers.delete("X-GitHub-Api-Version");
  headers.set("X-Gera-GitHub-Accept", accept);
  return authedFetch(
    `/github-proxy?serverId=${encodeURIComponent(serverId)}&path=${encodeURIComponent(path)}`,
    { ...init, headers },
  );
}

/** Max characters of file content returned to the agent per read. */
const MAX_FILE_CHARS = 12_000;

/** Max entries shown from a recursive repo tree listing. */
const MAX_TREE_ENTRIES = 400;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(str(value), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

class GitHubNotFoundError extends Error {}

function need(input: Record<string, unknown>, key: string): string {
  const value = str(input[key]).trim();
  if (!value) {
    throw new Error(`Provide "${key}".`);
  }
  if (key === "owner" && !GITHUB_OWNER_RE.test(value)) {
    throw new Error('Provide a valid GitHub "owner" login.');
  }
  if (key === "repo" && (!GITHUB_REPO_RE.test(value) || value === "." || value === "..")) {
    throw new Error('Provide a valid GitHub "repo" name.');
  }
  return value;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  if (typeof input[key] !== "string") {
    throw new Error(`Provide "${key}" as a string.`);
  }
  return input[key];
}

/** Keeps a Contents path inside the selected repository; root is explicit only. */
function normalizeContentsPath(raw: string, allowRoot: boolean): string {
  const value = raw.replace(/^\/+/, "");
  if (!value) {
    if (allowRoot) {
      return "";
    }
    throw new Error('Provide a non-empty file "path".');
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\u0000"))) {
    throw new Error('GitHub file paths cannot contain empty, ".", or ".." segments.');
  }
  return segments.join("/");
}

function day(iso: unknown): string {
  return str(iso).slice(0, 10);
}

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** GitHub Actions logs are full of ANSI color codes — strip them for readability. */
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Resolves the Authorization header for the native GitHub connector:
 * a pasted PAT wins, then the stored device-flow sign-in. Throws a
 * user-actionable error when neither exists.
 */
export async function resolveGitHubAuth(
  config: Pick<McpServerConfig, "id" | "catalogId" | "token"> &
    Partial<Pick<McpServerConfig, "credentialStored" | "status">>,
): Promise<string> {
  const pasted = config.token?.trim();
  if (pasted) {
    return pasted.toLowerCase().startsWith("bearer ") ? pasted : `Bearer ${pasted}`;
  }
  const oauthIds = [config.id];
  // Device flow stores the catalog credential under the stable `github` key.
  // Legacy/imported rows may have a generated instance id plus catalogId.
  if (config.catalogId && config.catalogId !== config.id) {
    oauthIds.push(config.catalogId);
  }
  for (const oauthId of oauthIds) {
    const hadRefreshableGrant = hasOAuthToken(oauthId) && hasOAuthRefreshToken(oauthId);
    const oauth = await oauthAuthHeader(oauthId);
    if (oauth) {
      return oauth;
    }
    if (hadRefreshableGrant && hasOAuthToken(oauthId)) {
      throw new Error("Could not refresh GitHub sign-in right now — retry shortly; your session was kept.");
    }
  }
  if (config.credentialStored === true || config.status === "connected") {
    const serverId = config.id || config.catalogId || "github";
    const sentinel = `${GERA_ACCOUNT_AUTH_PREFIX}${serverId}`;
    const probe = await githubTransportFetch(sentinel, new URL(`${GITHUB_API}/user`), {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (probe.ok) {
      return sentinel;
    }
    if (probe.status === 401) {
      throw new GitHubAuthError('GitHub needs a fresh sign-in — press "Sign in with GitHub" again.');
    }
    throw new Error(`Could not verify the server-owned GitHub sign-in (HTTP ${probe.status}).`);
  }
  throw new GitHubAuthError('GitHub needs a sign-in — press "Sign in with GitHub", or paste a PAT.');
}

/**
 * Returns the run's copy of the MCP server list with the browser-held GitHub
 * credential injected into the GitHub connector entry (as `token`). Server
 * runs cannot read this browser's sign-in store — the device-flow token
 * lives in localStorage only, and the profile sync that mirrors it
 * server-side is best-effort — so without this hand-off a cloud run can
 * silently lose GitHub tools while the composer's repo picker keeps working.
 * A pasted PAT already rides in `token` and stays untouched; the input array
 * and its entries are never mutated.
 */
export function injectGitHubRunAuth(
  servers: McpServerConfig[],
  auth: string | undefined,
): McpServerConfig[] {
  if (!auth) {
    const filtered = servers.filter((server) => (server.catalogId ?? server.id) !== "github");
    return filtered.length === servers.length ? servers : filtered;
  }
  let changed = false;
  const next = servers.map((server) => {
    if ((server.catalogId ?? server.id) !== "github" || server.token?.trim()) {
      return server;
    }
    changed = true;
    return { ...server, token: auth };
  });
  return changed ? next : servers;
}

/** Non-secret in-memory cache key; never expose or persist the credential itself. */
export function githubAuthorizationFingerprint(auth: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < auth.length; index += 1) {
    hash ^= auth.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

/** Decodes GitHub's base64 file content (newline-wrapped) as UTF-8 text. */
export function decodeGitHubContent(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function isProbablyBinaryText(text: string): boolean {
  const sample = text.slice(0, 4_096);
  if (sample.includes("\u0000")) {
    return true;
  }
  let suspicious = 0;
  for (const char of sample) {
    const code = char.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || char === "\uFFFD") {
      suspicious += 1;
    }
  }
  return sample.length > 0 && suspicious > Math.max(4, sample.length * 0.02);
}

function formatGitHubFileText(record: Record<string, unknown>, text: string, streamTruncated = false): string {
  const path = str(record.path) || "file";
  const size = num(record.size);
  const sha = str(record.sha);
  if (isProbablyBinaryText(text)) {
    return `${path} is a binary file (${size} B${sha ? `, sha ${sha}` : ""}) — cannot display as text.`;
  }
  const truncated = streamTruncated || text.length > MAX_FILE_CHARS;
  return `${path} (${size} B${sha ? `, sha ${sha}` : ""}${truncated ? `, showing first ${MAX_FILE_CHARS} chars` : ""}):\n${text.slice(0, MAX_FILE_CHARS)}`;
}

/** Encodes UTF-8 text as base64 for the contents API (writes). */
export function encodeGitHubContent(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * System-prompt block for a repository pinned to the thread from the composer.
 * The model treats the pin as the default repo for every repository question;
 * when the GitHub connector is off for the run, the block says so honestly
 * instead of promising reads that cannot happen.
 */
export function pinnedRepoPromptBlock(fullName: string, connectorOn: boolean): string {
  const slash = fullName.indexOf("/");
  const owner = slash > 0 ? fullName.slice(0, slash) : "";
  const repo = slash > 0 ? fullName.slice(slash + 1) : fullName;
  const lines = [
    "## Pinned GitHub repository",
    `The user pinned "${fullName}" to this thread — treat it as the default repository for anything repository-related.`,
  ];
  if (connectorOn && owner) {
    lines.push(
      `When GitHub tools (mcp_github_*) are available, call them with owner "${owner}" and repo "${repo}" right away instead of asking which repository is meant. A different repository named explicitly by the user takes precedence for that request.`,
    );
  } else if (!connectorOn) {
    lines.push(
      "The GitHub connector is off for this run, so the repository contents cannot be read right now — say so honestly if asked about the code.",
    );
  }
  return lines.join("\n");
}

/** One row in the composer's thread-repo picker. */
export type RepoOption = {
  fullName: string;
  private: boolean;
  description: string;
  pushedAt: string;
};

/**
 * Structured /user/repos listing for the composer's repo picker — the same
 * deterministic listing the agent's list_my_repos uses (owner + collaborator
 * + org member, newest push first), capped at 300.
 */
export async function listRepoOptions(auth: string): Promise<RepoOption[]> {
  const repos: Array<Record<string, unknown>> = [];
  for (let page = 1; page <= 3 && repos.length < 300; page += 1) {
    const batch = asRecordArray(
      await ghFetch(auth, "/user/repos", {
        query: {
          per_page: 100,
          page,
          sort: "pushed",
          affiliation: "owner,collaborator,organization_member",
        },
      }),
    );
    repos.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  return repos
    .map((repo) => ({
      fullName: str(repo.full_name),
      private: repo.private === true,
      description: str(repo.description),
      pushedAt: str(repo.pushed_at),
    }))
    .filter((repo) => repo.fullName.length > 0);
}

/** One repo per line: name, visibility, language, stars, last push, description. */
export function formatRepoLine(repo: Record<string, unknown>): string {
  const parts: string[] = [];
  if (repo.private === true) {
    parts.push("private");
  }
  if (repo.fork === true) {
    parts.push("fork");
  }
  if (repo.archived === true) {
    parts.push("archived");
  }
  const language = str(repo.language);
  if (language) {
    parts.push(language);
  }
  const stars = num(repo.stargazers_count);
  if (stars > 0) {
    parts.push(`★${stars}`);
  }
  const pushed = day(repo.pushed_at);
  if (pushed) {
    parts.push(`pushed ${pushed}`);
  }
  const description = str(repo.description).trim();
  const suffix = description ? ` — ${description.slice(0, 120)}` : "";
  return `${str(repo.full_name)} [${parts.join(" · ") || "public"}]${suffix}`;
}

/** Owners that appear in github.com URLs but are never user accounts. */
const NON_REPO_OWNERS = new Set([
  "settings", "orgs", "topics", "search", "features", "marketplace", "apps",
  "sponsors", "about", "pricing", "login", "signup", "explore", "trending",
  "collections", "notifications", "issues", "pulls", "codespaces", "copilot",
]);

/** Repo-looking tokens that are actually file paths end in these extensions. */
const FILE_LIKE_RE = /\.(?:tsx?|jsx?|mjs|cjs|json|md|css|scss|html|svg|png|jpe?g|gif|py|rb|go|rs|java|kts?|swift|ya?ml|toml|lock|txt|sh|env|xml|csv)$/i;

/**
 * GitHub repositories referenced in free text: github.com URLs first, then
 * standalone owner/repo tokens. Path segments like "src/lib" never match —
 * they are preceded or followed by more path — and npm scopes (@scope/pkg)
 * are excluded. Existence is NOT verified here; each ref is a candidate.
 */
export function githubRepoRefs(text: string, limit = 3): Array<{ owner: string; repo: string }> {
  const out: Array<{ owner: string; repo: string }> = [];
  const seen = new Set<string>();
  const push = (rawOwner: string, rawRepo: string, allowFileLike: boolean) => {
    const owner = rawOwner.trim();
    const repo = rawRepo.trim().replace(/\.+$/, "").replace(/\.git$/i, "");
    if (!owner || !repo || out.length >= limit) {
      return;
    }
    if (NON_REPO_OWNERS.has(owner.toLowerCase()) || (!allowFileLike && FILE_LIKE_RE.test(repo))) {
      return;
    }
    if (!/[a-z]/i.test(owner + repo)) {
      return; // dates and scores like "24/7"
    }
    const key = `${owner}/${repo}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ owner, repo });
    }
  };
  for (const match of text.matchAll(/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)/gi)) {
    push(match[1], match[2], true);
  }
  for (const match of text.matchAll(/(?<![\w./@-])([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9._-]{1,100})(?![\w/-])/g)) {
    push(match[1], match[2], false);
  }
  return out;
}

/**
 * Repositories a run should read: an explicit owner/repo in the current
 * request wins; otherwise the thread pin is the default. Keeping the pin as
 * structured run data (instead of hoping a model notices it in a system
 * prompt) is what makes private repos work in Research and Julius too.
 */
export function githubRunRepoRefs(
  text: string,
  pinnedRepo?: string,
): Array<{ owner: string; repo: string }> {
  const explicit = githubRepoRefs(text);
  if (explicit.length > 0) {
    return explicit;
  }
  const pin = pinnedRepo?.trim() ?? "";
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9._-]{1,100})$/.exec(pin);
  return match ? [{ owner: match[1], repo: match[2] }] : [];
}

/** Structured repo metadata for callers that need more than a display string (deep research). */
export type GitHubRepoMeta = {
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
  isPrivate: boolean;
  description: string;
  language: string;
  stars: number;
  pushedAt: string;
  openIssues: number;
};

/** Fetches one repo's metadata; throws ghFetch's honest 404/403 errors when invisible. */
export async function fetchGitHubRepoMeta(auth: string, owner: string, repo: string): Promise<GitHubRepoMeta> {
  const data = (await ghFetch(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)) as Record<string, unknown>;
  return {
    fullName: str(data.full_name) || `${owner}/${repo}`,
    htmlUrl: str(data.html_url) || `https://github.com/${owner}/${repo}`,
    defaultBranch: str(data.default_branch) || "main",
    isPrivate: data.private === true,
    description: str(data.description).trim(),
    language: str(data.language),
    stars: num(data.stargazers_count),
    pushedAt: day(data.pushed_at),
    openIssues: num(data.open_issues_count),
  };
}

/** A research reflector repo pick: a source file, a commit diff, or a PR diff. */
export type RepoPick =
  | { meta: GitHubRepoMeta; kind: "file"; path: string }
  | { meta: GitHubRepoMeta; kind: "commit"; ref: string }
  | { meta: GitHubRepoMeta; kind: "pull"; number: number };

/**
 * Parses a research reflector pick. Files: "owner/repo:path", "owner/repo/path",
 * or a bare path when exactly one repo is loaded. Commit diffs: "owner/repo@sha"
 * (bare "@sha" binds to the single loaded repo). PR diffs: "owner/repo#123".
 * "@" inside file paths (src/@types/x.d.ts) still parses as a file.
 */
export function parseRepoPick(pick: string, repos: Map<string, GitHubRepoMeta>): RepoPick | null {
  const trimmed = pick.trim().replace(/^[`"']+|[`"']+$/g, "").replace(/^\/+/, "");
  if (!trimmed) {
    return null;
  }
  const only = repos.size === 1 ? [...repos.values()][0] : undefined;

  const hash = trimmed.lastIndexOf("#");
  if (hash > -1 && /^\d+$/.test(trimmed.slice(hash + 1))) {
    const prefix = trimmed.slice(0, hash).trim().replace(/\/+$/, "").toLowerCase();
    const meta = prefix ? repos.get(prefix) : only;
    if (meta) {
      return { meta, kind: "pull", number: Number.parseInt(trimmed.slice(hash + 1), 10) };
    }
  }

  const at = trimmed.lastIndexOf("@");
  if (at > -1) {
    const prefix = trimmed.slice(0, at).trim().replace(/\/+$/, "").toLowerCase();
    const ref = trimmed.slice(at + 1).trim();
    const meta = prefix ? repos.get(prefix) : only;
    // A known repo prefix (or a lone sha-like ref) means a commit pick;
    // "src/@types/x.d.ts" has no repo prefix and falls through to files.
    if (meta && ref && !ref.includes(":") && (repos.has(prefix) || /^[0-9a-f]{7,40}$/i.test(ref))) {
      return { meta, kind: "commit", ref };
    }
  }

  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    const meta = repos.get(trimmed.slice(0, colon).trim().toLowerCase());
    const path = trimmed.slice(colon + 1).trim().replace(/^\/+/, "");
    if (meta && path) {
      return { meta, kind: "file", path };
    }
  }
  const lowered = trimmed.toLowerCase();
  for (const meta of repos.values()) {
    const prefix = `${meta.fullName.toLowerCase()}/`;
    if (lowered.startsWith(prefix) && trimmed.length > prefix.length) {
      return { meta, kind: "file", path: trimmed.slice(prefix.length).replace(/^\/+/, "") };
    }
  }
  if (only && colon === -1) {
    return { meta: only, kind: "file", path: trimmed };
  }
  return null;
}

async function ghFetch(
  auth: string,
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    query?: Record<string, string | number | undefined>;
    body?: unknown;
  } = {},
): Promise<unknown> {
  const url = new URL(`${GITHUB_API}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  let response: Response;
  try {
    response = await githubTransportFetch(auth, url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: auth,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new Error("Could not reach GitHub from the browser. Check your connection.");
  }

  if (response.ok) {
    return (await response.json()) as unknown;
  }

  let message = "";
  try {
    const data = (await response.json()) as { message?: unknown };
    message = str(data.message);
  } catch {
    // non-JSON error body
  }

  if (response.status === 401) {
    throw new GitHubAuthError('GitHub rejected the token — press "Sign in with GitHub" again, or paste a fresh PAT.');
  }
  if (response.status === 403 || response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    if (response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0" || retryAfter) {
      const reset = Number.parseInt(response.headers.get("x-ratelimit-reset") ?? "", 10);
      const at = retryAfter
        ? ` (retry after ${retryAfter} seconds)`
        : Number.isFinite(reset)
          ? ` (resets ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC)`
          : "";
      throw new Error(`GitHub rate limit reached${at}. Try again in a bit.`);
    }
    // Org OAuth-app restrictions land here — surface GitHub's own words.
    throw new Error(`GitHub refused the request${message ? `: ${message}` : "."}`);
  }
  if (response.status === 404) {
    throw new GitHubNotFoundError(
      "Not found — or this token cannot see it. Private repos owned by an organization stay hidden until the org approves this OAuth app (see \"review org access\" on the GitHub card).",
    );
  }
  throw new Error(`GitHub returned ${response.status}${message ? `: ${message}` : "."}`);
}

async function readResponseTextPrefix(
  response: Response,
  maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    const text = await response.text();
    return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let finished = false;
  while (text.length <= maxChars) {
    const chunk = await reader.read();
    if (chunk.done) {
      finished = true;
      text += decoder.decode();
      break;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  if (!finished) {
    await reader.cancel().catch(() => undefined);
    text += decoder.decode();
  }
  return { text: text.slice(0, maxChars), truncated: !finished || text.length > maxChars };
}

/** Reads a Contents endpoint as raw bytes, preserving auth for private repositories. */
async function ghFetchRawText(
  auth: string,
  path: string,
  query: Record<string, string | number | undefined> = {},
): Promise<{ text: string; truncated: boolean }> {
  const url = new URL(`${GITHUB_API}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  let response: Response;
  try {
    response = await githubTransportFetch(auth, url, {
      headers: {
        Authorization: auth,
        Accept: "application/vnd.github.raw+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
    });
  } catch {
    throw new Error("Could not reach GitHub from the browser. Check your connection.");
  }
  if (!response.ok) {
    let message = "";
    try {
      const data = (await response.json()) as { message?: unknown };
      message = str(data.message);
    } catch {
      // non-JSON error body
    }
    if (response.status === 401) {
      throw new GitHubAuthError('GitHub rejected the token — press "Sign in with GitHub" again, or paste a fresh PAT.');
    }
    if (response.status === 403 || response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      if (response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0" || retryAfter) {
        throw new Error(`GitHub rate limit reached${retryAfter ? ` (retry after ${retryAfter} seconds)` : ""}. Try again in a bit.`);
      }
      throw new Error(`GitHub refused the raw file read${message ? `: ${message}` : "."}`);
    }
    if (response.status === 404) {
      throw new Error("Not found — or this token cannot read the file. Check the exact path, branch, and repository Contents permission.");
    }
    throw new Error(`GitHub returned ${response.status}${message ? `: ${message}` : "."}`);
  }
  return readResponseTextPrefix(response, MAX_FILE_CHARS + 1);
}

/** Org logins visible to this token — an org missing here means it has not approved the OAuth app. */
async function listOrgLogins(auth: string): Promise<string[]> {
  const orgs = asRecordArray(await ghFetch(auth, "/user/orgs", { query: { per_page: 100 } }));
  return orgs.map((org) => str(org.login)).filter((login) => login.length > 0);
}

/** Connect-time verification: who the token belongs to, scopes, and visible orgs. */
export async function verifyGitHubNative(auth: string): Promise<{ identity: string }> {
  const viewer = await fetchGitHubViewer(auth);
  let orgSuffix = "";
  try {
    const orgs = await listOrgLogins(auth);
    if (orgs.length > 0) {
      orgSuffix = ` · orgs: ${orgs.slice(0, 3).join(", ")}${orgs.length > 3 ? ` +${orgs.length - 3}` : ""}`;
    }
  } catch {
    // fail-soft: identity without orgs is still useful
  }
  return { identity: `${githubIdentityLabel(viewer)}${orgSuffix}` };
}

async function whoami(auth: string): Promise<string> {
  const viewer = await fetchGitHubViewer(auth);
  const lines = [`Signed in as @${viewer.login}${viewer.name ? ` (${viewer.name})` : ""}.`];
  if (viewer.scopes !== null) {
    lines.push(`Token scopes: ${viewer.scopes.length > 0 ? viewer.scopes.join(", ") : "(none)"}.`);
    if (!viewer.scopes.includes("repo")) {
      lines.push('Missing the "repo" scope — private repositories are invisible. Sign in again to grant it.');
    }
  }
  try {
    const orgs = await listOrgLogins(auth);
    lines.push(
      orgs.length > 0
        ? `Organizations visible to this token: ${orgs.join(", ")}. An org missing from this list has not approved the app — its private repos are hidden.`
        : "No organizations are visible to this token. If you expect org repos, the org has not approved this OAuth app yet.",
    );
  } catch {
    lines.push("Could not list organizations (read:org may be missing).");
  }
  return lines.join("\n");
}

async function listMyRepos(auth: string, input: Record<string, unknown>): Promise<string> {
  const limit = clampNumber(input.limit, 100, 1, 300);
  const visibility = str(input.visibility);
  const filter = str(input.nameFilter).trim().toLowerCase();
  const repos: Array<Record<string, unknown>> = [];
  for (let page = 1; page <= 3 && repos.length < 300; page += 1) {
    const batch = asRecordArray(
      await ghFetch(auth, "/user/repos", {
        query: {
          per_page: 100,
          page,
          sort: "pushed",
          affiliation: "owner,collaborator,organization_member",
          ...(visibility === "public" || visibility === "private" ? { visibility } : {}),
        },
      }),
    );
    repos.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  const filtered = filter
    ? repos.filter((repo) => `${str(repo.full_name)} ${str(repo.description)}`.toLowerCase().includes(filter))
    : repos;
  const shown = filtered.slice(0, limit);
  if (shown.length === 0) {
    return filter
      ? `No repos match "${filter}" among the ${repos.length} repos this token can see.`
      : "No repositories are visible to this token. Check whoami: the account may lack the repo scope, or org access is not approved.";
  }
  const header = `${shown.length}${filtered.length > shown.length ? ` of ${filtered.length}` : ""} repos visible to this account${filter ? ` matching "${filter}"` : ""} (owner + collaborator + org member, newest push first):`;
  return `${header}\n${shown.map(formatRepoLine).join("\n")}`;
}

async function searchRepositories(auth: string, input: Record<string, unknown>): Promise<string> {
  const query = need(input, "query");
  const data = (await ghFetch(auth, "/search/repositories", {
    query: { q: query, per_page: clampNumber(input.limit, 10, 1, 30) },
  })) as Record<string, unknown>;
  const items = asRecordArray(data.items);
  if (items.length === 0) {
    return `No repositories on GitHub match "${query}". For your own repos use list_my_repos — search can lag behind or miss private repos.`;
  }
  return `${num(data.total_count)} repositories match "${query}":\n${items.map(formatRepoLine).join("\n")}`;
}

async function getRepo(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const data = (await ghFetch(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)) as Record<string, unknown>;
  const topics = Array.isArray(data.topics) ? data.topics.filter((t): t is string => typeof t === "string") : [];
  return [
    formatRepoLine(data),
    `default branch: ${str(data.default_branch)} · forks: ${num(data.forks_count)} · open issues: ${num(data.open_issues_count)}`,
    topics.length > 0 ? `topics: ${topics.join(", ")}` : "",
    str(data.html_url),
  ]
    .filter(Boolean)
    .join("\n");
}

async function getContents(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const rawPath = normalizeContentsPath(requiredString(input, "path"), true);
  const endpoint = contentsEndpoint(owner, repo, rawPath, true);
  const ref = str(input.ref) || undefined;
  const data = await ghFetch(auth, endpoint, { query: { ref } });
  if (Array.isArray(data)) {
    const entries = asRecordArray(data);
    const lines = entries.map((entry) => {
      const type = str(entry.type) === "dir" ? "dir " : "file";
      const size = str(entry.type) === "file" ? ` (${num(entry.size)} B)` : "";
      return `${type} ${str(entry.path)}${size}`;
    });
    return `${owner}/${repo}/${rawPath || ""} — ${entries.length} entries:\n${lines.join("\n")}`;
  }
  const record = (data ?? {}) as Record<string, unknown>;
  if (str(record.type) === "file" && str(record.encoding) === "base64" && typeof record.content === "string") {
    let text: string;
    try {
      text = decodeGitHubContent(record.content);
    } catch {
      return `${str(record.path)} is a binary file (${num(record.size)} B) — cannot display as text.`;
    }
    return formatGitHubFileText(record, text);
  }
  if (str(record.type) === "file") {
    // GitHub intentionally returns encoding:"none" and no inline body for
    // files above 1 MB. Re-read the exact endpoint with its raw media type;
    // unlike download_url this keeps private-repo authentication intact.
    const raw = await ghFetchRawText(auth, endpoint, { ref });
    return formatGitHubFileText(record, raw.text, raw.truncated);
  }
  return `Unexpected content type "${str(record.type)}" at ${rawPath || "/"}.`;
}

async function getFileTree(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  let ref = str(input.ref).trim();
  if (!ref) {
    ref = (await fetchGitHubRepoMeta(auth, owner, repo)).defaultBranch;
  }
  const data = (await ghFetch(
    auth,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}`,
    { query: { recursive: "1" } },
  )) as Record<string, unknown>;
  const files = asRecordArray(data.tree).filter((entry) => str(entry.type) === "blob");
  if (files.length === 0) {
    return `No files found in ${owner}/${repo}@${ref} — the repository may be empty.`;
  }
  const shown = files.slice(0, MAX_TREE_ENTRIES);
  const lines = shown.map((entry) => `${str(entry.path)} (${num(entry.size)} B)`);
  const more = files.length > shown.length ? `\n…and ${files.length - shown.length} more files` : "";
  const capped = data.truncated === true ? " (GitHub truncated the listing)" : "";
  return `${files.length} files in ${owner}/${repo}@${ref}${capped}:\n${lines.join("\n")}${more}`;
}

async function getReadme(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`;
  const data = (await ghFetch(auth, endpoint)) as Record<string, unknown>;
  if (str(data.encoding) === "base64" && typeof data.content === "string") {
    return formatGitHubFileText(data, decodeGitHubContent(data.content));
  }
  const raw = await ghFetchRawText(auth, endpoint);
  return formatGitHubFileText(data, raw.text, raw.truncated);
}

async function listCommits(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const commits = asRecordArray(
    await ghFetch(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`, {
      query: { sha: str(input.branch) || undefined, per_page: clampNumber(input.limit, 20, 1, 50) },
    }),
  );
  if (commits.length === 0) {
    return "No commits found.";
  }
  const lines = commits.map((item) => {
    const commit = (item.commit ?? {}) as Record<string, unknown>;
    const authorRecord = (commit.author ?? {}) as Record<string, unknown>;
    const login = str(((item.author ?? {}) as Record<string, unknown>).login) || str(authorRecord.name) || "unknown";
    const message = str(commit.message).split("\n")[0] ?? "";
    return `${str(item.sha).slice(0, 7)} ${day(authorRecord.date)} @${login} — ${message}`;
  });
  return `Latest ${lines.length} commits in ${owner}/${repo}${str(input.branch) ? ` (${str(input.branch)})` : ""}:\n${lines.join("\n")}`;
}

async function searchCode(auth: string, input: Record<string, unknown>): Promise<string> {
  const query = need(input, "query");
  const data = (await ghFetch(auth, "/search/code", {
    query: { q: query, per_page: clampNumber(input.limit, 10, 1, 30) },
  })) as Record<string, unknown>;
  const items = asRecordArray(data.items);
  if (items.length === 0) {
    return `No code matches "${query}". Private code needs a repo:owner/name or user:@me qualifier, and only default branches are indexed.`;
  }
  const lines = items.map((item) => {
    const repoRecord = (item.repository ?? {}) as Record<string, unknown>;
    return `${str(repoRecord.full_name)}: ${str(item.path)}`;
  });
  return `${num(data.total_count)} code matches for "${query}":\n${lines.join("\n")}`;
}

function issueLine(item: Record<string, unknown>): string {
  const repoFromUrl = str(item.repository_url).split("/repos/")[1] ?? "";
  const author = str(((item.user ?? {}) as Record<string, unknown>).login);
  const isPr = item.pull_request !== undefined;
  return `${repoFromUrl ? `[${repoFromUrl}] ` : ""}#${num(item.number)} [${str(item.state)}${isPr ? " PR" : ""}] ${str(item.title)} — @${author} · ${num(item.comments)} comments · updated ${day(item.updated_at)}`;
}

async function searchIssues(auth: string, input: Record<string, unknown>): Promise<string> {
  const query = need(input, "query");
  const data = (await ghFetch(auth, "/search/issues", {
    query: { q: query, per_page: clampNumber(input.limit, 10, 1, 30) },
  })) as Record<string, unknown>;
  const items = asRecordArray(data.items);
  if (items.length === 0) {
    return `No issues or PRs match "${query}". Use qualifiers like repo:owner/name, is:pr, is:open, author:@me.`;
  }
  return `${num(data.total_count)} matches for "${query}":\n${items.map(issueLine).join("\n")}`;
}

async function listIssues(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const items = asRecordArray(
    await ghFetch(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
      query: { state: str(input.state) || "open", per_page: clampNumber(input.limit, 20, 1, 50) },
    }),
  ).filter((item) => item.pull_request === undefined);
  if (items.length === 0) {
    return `No ${str(input.state) || "open"} issues in ${owner}/${repo}.`;
  }
  return `${items.length} issues in ${owner}/${repo}:\n${items.map(issueLine).join("\n")}`;
}

async function listPulls(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const items = asRecordArray(
    await ghFetch(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
      query: { state: str(input.state) || "open", per_page: clampNumber(input.limit, 20, 1, 50) },
    }),
  );
  if (items.length === 0) {
    return `No ${str(input.state) || "open"} pull requests in ${owner}/${repo}.`;
  }
  const lines = items.map((item) => {
    const author = str(((item.user ?? {}) as Record<string, unknown>).login);
    const head = str(((item.head ?? {}) as Record<string, unknown>).ref);
    const base = str(((item.base ?? {}) as Record<string, unknown>).ref);
    return `#${num(item.number)} [${str(item.state)}${item.draft === true ? " draft" : ""}] ${str(item.title)} — @${author} · ${head} → ${base} · updated ${day(item.updated_at)}`;
  });
  return `${items.length} pull requests in ${owner}/${repo}:\n${lines.join("\n")}`;
}

async function getPull(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const number = clampNumber(input.number, 0, 1, 1_000_000);
  if (number === 0) {
    throw new Error('Provide "number".');
  }
  const data = (await ghFetch(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`)) as Record<string, unknown>;
  const author = str(((data.user ?? {}) as Record<string, unknown>).login);
  const head = str(((data.head ?? {}) as Record<string, unknown>).ref);
  const base = str(((data.base ?? {}) as Record<string, unknown>).ref);
  const body = str(data.body).trim();
  return [
    `#${num(data.number)} ${str(data.title)} [${str(data.state)}${data.draft === true ? ", draft" : ""}${data.merged === true ? ", merged" : ""}]`,
    `@${author} · ${head} → ${base} · ${num(data.commits)} commits · ${num(data.changed_files)} files · +${num(data.additions)}/−${num(data.deletions)}`,
    str(data.html_url),
    body ? `\n${body.slice(0, 1_500)}${body.length > 1_500 ? "…" : ""}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function createIssue(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const title = need(input, "title");
  const data = (await ghFetch(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
    method: "POST",
    body: { title, body: str(input.body) || undefined },
  })) as Record<string, unknown>;
  return `Created issue #${num(data.number)}: ${str(data.html_url)}`;
}

async function addIssueComment(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const number = clampNumber(input.number, 0, 1, 1_000_000);
  if (number === 0) {
    throw new Error('Provide "number".');
  }
  const body = need(input, "body");
  const data = (await ghFetch(
    auth,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
    { method: "POST", body: { body } },
  )) as Record<string, unknown>;
  return `Comment posted: ${str(data.html_url)}`;
}

// ---------------------------------------------------------------------------
// Write operations — the PR factory's hands. Rails baked in: the default
// branch is write-protected (changes ship as branch → PR) and there is
// deliberately NO merge tool — merging stays with the human.

/** Max characters of file content accepted per write. */
const MAX_WRITE_CHARS = 350_000;

/**
 * Write guard: refuses writes aimed at the repo's default branch —
 * branches + PRs are the only path to it.
 */
async function assertWritableBranch(auth: string, owner: string, repo: string, branch: string): Promise<void> {
  const meta = await fetchGitHubRepoMeta(auth, owner, repo);
  if (branch === meta.defaultBranch) {
    throw new Error(
      `"${branch}" is the default branch of ${meta.fullName} — it is write-protected by design. create_branch a working branch, commit there with put_file, then open a PR with create_pull; the human merges.`,
    );
  }
}

async function createBranch(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const branch = need(input, "branch");
  const from = str(input.from).trim() || (await fetchGitHubRepoMeta(auth, owner, repo)).defaultBranch;
  const base = (await ghFetch(
    auth,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(from)}`,
  )) as Record<string, unknown>;
  const sha = str(base.sha);
  if (!sha) {
    throw new Error(`Could not resolve "${from}" to a commit in ${owner}/${repo}.`);
  }
  await ghFetch(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha },
  });
  return `Created branch "${branch}" in ${owner}/${repo} from ${from}@${sha.slice(0, 7)}. Commit with put_file, then open a PR with create_pull.`;
}

/** Contents endpoint for one validated path; an empty root must be explicitly allowed. */
function contentsEndpoint(owner: string, repo: string, rawPath: string, allowRoot = false): string {
  const path = normalizeContentsPath(rawPath, allowRoot);
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${encodedPath ? `/${encodedPath}` : ""}`;
}

/** Current blob sha of a file on a branch; null only when GitHub says it is absent. */
async function fileShaOnBranch(auth: string, endpoint: string, branch: string): Promise<string | null> {
  let data: unknown;
  try {
    data = await ghFetch(auth, endpoint, { query: { ref: branch } });
  } catch (error) {
    if (error instanceof GitHubNotFoundError) {
      return null;
    }
    throw error;
  }
  if (Array.isArray(data)) {
    throw new Error("That path is a directory — pass a file path.");
  }
  const sha = str((data as Record<string, unknown>).sha);
  return sha || null;
}

async function putFile(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const branch = need(input, "branch");
  const path = normalizeContentsPath(need(input, "path"), false);
  const message = need(input, "message");
  const content = requiredString(input, "content");
  if (content.length > MAX_WRITE_CHARS) {
    throw new Error(
      `Content is ${content.length} chars — the per-write cap is ${MAX_WRITE_CHARS}. Split the file or the change.`,
    );
  }
  await assertWritableBranch(auth, owner, repo, branch);
  const endpoint = contentsEndpoint(owner, repo, path);
  const existingSha = await fileShaOnBranch(auth, endpoint, branch);
  const expectedSha = str(input.expected_sha).trim();
  if (existingSha && !expectedSha) {
    throw new Error(`File ${path} already exists on ${branch}. Read it first and pass its sha as "expected_sha" to prevent overwriting a newer edit.`);
  }
  if (existingSha && expectedSha !== existingSha) {
    throw new Error(`File ${path} changed since it was read (expected ${expectedSha}, current ${existingSha}). Read it again before writing.`);
  }
  if (!existingSha && expectedSha) {
    throw new Error(`File ${path} does not exist on ${branch}, but "expected_sha" was provided. Re-check the path before writing.`);
  }
  const data = (await ghFetch(auth, endpoint, {
    method: "PUT",
    body: {
      message,
      content: encodeGitHubContent(content),
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
    },
  })) as Record<string, unknown>;
  const commit = (data.commit ?? {}) as Record<string, unknown>;
  const url = str(commit.html_url);
  return `${existingSha ? "Updated" : "Created"} ${path} on ${branch} — commit ${str(commit.sha).slice(0, 7)}${url ? ` (${url})` : ""}.`;
}

async function deleteFile(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const branch = need(input, "branch");
  const path = normalizeContentsPath(need(input, "path"), false);
  const message = need(input, "message");
  await assertWritableBranch(auth, owner, repo, branch);
  const endpoint = contentsEndpoint(owner, repo, path);
  const sha = await fileShaOnBranch(auth, endpoint, branch);
  if (!sha) {
    throw new Error(`${path} does not exist on ${branch} — nothing to delete.`);
  }
  const expectedSha = need(input, "expected_sha");
  if (expectedSha !== sha) {
    throw new Error(`File ${path} changed since it was read (expected ${expectedSha}, current ${sha}). Read it again before deleting.`);
  }
  const data = (await ghFetch(auth, endpoint, {
    method: "DELETE",
    body: { message, sha, branch },
  })) as Record<string, unknown>;
  const commit = (data.commit ?? {}) as Record<string, unknown>;
  return `Deleted ${path} on ${branch} — commit ${str(commit.sha).slice(0, 7)}.`;
}

async function createPull(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const title = need(input, "title");
  const head = need(input, "head");
  const base = str(input.base).trim() || (await fetchGitHubRepoMeta(auth, owner, repo)).defaultBranch;
  if (head === base) {
    throw new Error(
      `head and base are both "${head}" — commit to a working branch (create_branch) and open the PR from it.`,
    );
  }
  const data = (await ghFetch(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
    method: "POST",
    body: {
      title,
      head,
      base,
      body: str(input.body) || undefined,
      draft: input.draft === true,
    },
  })) as Record<string, unknown>;
  return `Opened PR #${num(data.number)} (${head} → ${base}): ${str(data.html_url)}\nMerging stays with the human — there is no merge tool. Watch CI with list_workflow_runs on ${head}.`;
}

async function updatePull(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const number = clampNumber(input.number, 0, 1, 1_000_000);
  if (number === 0) {
    throw new Error('Provide "number".');
  }
  const title = str(input.title).trim();
  const body = str(input.body);
  const state = str(input.state).trim();
  if (state && state !== "open" && state !== "closed") {
    throw new Error('state must be "open" or "closed".');
  }
  if (!title && !body.trim() && !state) {
    throw new Error("Nothing to update — pass title, body, and/or state.");
  }
  const data = (await ghFetch(
    auth,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
    {
      method: "PATCH",
      body: {
        ...(title ? { title } : {}),
        ...(body.trim() ? { body } : {}),
        ...(state ? { state } : {}),
      },
    },
  )) as Record<string, unknown>;
  return `Updated PR #${num(data.number)} [${str(data.state)}]: ${str(data.html_url)}`;
}

/** Per-file patch cap when rendering diffs. */
const MAX_PATCH_CHARS = 2_500;

/** Tail kept from a CI job log — failures live at the end. */
const LOG_TAIL_CHARS = 9_000;

type JobLogTail = { text: string; totalChars: number; truncated: boolean };

/** Streams a potentially huge log while retaining only its failure-heavy tail. */
async function readResponseTextTail(response: Response, maxChars: number): Promise<JobLogTail> {
  if (!response.body) {
    const text = stripAnsi(await response.text());
    return { text: text.slice(-maxChars), totalChars: text.length, truncated: text.length > maxChars };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  let totalChars = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      tail += decoder.decode();
      break;
    }
    const text = decoder.decode(chunk.value, { stream: true });
    totalChars += text.length;
    tail = `${tail}${text}`.slice(-(maxChars + 128));
  }
  const clean = stripAnsi(tail).slice(-maxChars);
  return { text: clean, totalChars: Math.max(totalChars, clean.length), truncated: totalChars > maxChars };
}

/** Renders a GitHub "files" array (commit / PR / compare) as readable unified diffs within a budget. */
export function formatDiffFiles(files: Array<Record<string, unknown>>, budget = MAX_FILE_CHARS): string {
  if (files.length === 0) {
    return "No changed files.";
  }
  const parts: string[] = [];
  let used = 0;
  for (const file of files) {
    const header = `--- ${str(file.filename)} [${str(file.status) || "changed"}] +${num(file.additions)}/−${num(file.deletions)}`;
    const rawPatch = str(file.patch);
    const patch = rawPatch.length > MAX_PATCH_CHARS ? `${rawPatch.slice(0, MAX_PATCH_CHARS)}\n…(patch truncated)` : rawPatch;
    const block = rawPatch ? `${header}\n${patch}` : `${header} (no text diff — binary or too large)`;
    if (used + block.length > budget) {
      parts.push(`…diff budget reached; ${files.length - parts.length} more changed files not shown`);
      break;
    }
    used += block.length;
    parts.push(block);
  }
  return parts.join("\n\n");
}

async function getCommit(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const ref = need(input, "ref");
  const data = (await ghFetch(
    auth,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`,
  )) as Record<string, unknown>;
  const commit = (data.commit ?? {}) as Record<string, unknown>;
  const authorRecord = (commit.author ?? {}) as Record<string, unknown>;
  const login = str(((data.author ?? {}) as Record<string, unknown>).login) || str(authorRecord.name) || "unknown";
  const stats = (data.stats ?? {}) as Record<string, unknown>;
  const files = asRecordArray(data.files);
  return [
    `commit ${str(data.sha).slice(0, 12)} by @${login} on ${day(authorRecord.date)} — ${files.length} files, +${num(stats.additions)}/−${num(stats.deletions)}`,
    str(commit.message).trim(),
    "",
    formatDiffFiles(files),
  ].join("\n");
}

async function compareCommits(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const base = need(input, "base");
  const head = need(input, "head");
  const data = (await ghFetch(
    auth,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  )) as Record<string, unknown>;
  const commits = asRecordArray(data.commits);
  const commitLines = commits.slice(-15).map((item) => {
    const commit = (item.commit ?? {}) as Record<string, unknown>;
    const authorRecord = (commit.author ?? {}) as Record<string, unknown>;
    return `${str(item.sha).slice(0, 7)} ${day(authorRecord.date)} — ${(str(commit.message).split("\n")[0] ?? "").slice(0, 100)}`;
  });
  const files = asRecordArray(data.files);
  return [
    `${base}...${head}: ${str(data.status)}, ahead ${num(data.ahead_by)} / behind ${num(data.behind_by)}, ${files.length} changed files`,
    commitLines.length > 0 ? `Commits:\n${commitLines.join("\n")}` : "",
    "",
    formatDiffFiles(files),
  ]
    .filter(Boolean)
    .join("\n");
}

async function getPullFiles(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const number = clampNumber(input.number, 0, 1, 1_000_000);
  if (number === 0) {
    throw new Error('Provide "number".');
  }
  const files: Array<Record<string, unknown>> = [];
  for (let page = 1; page <= 30; page += 1) {
    const batch = asRecordArray(
      await ghFetch(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files`, {
        query: { per_page: 100, page },
      }),
    );
    files.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  return `PR #${number} in ${owner}/${repo} — ${files.length} changed files:\n\n${formatDiffFiles(files)}`;
}

function formatRunLine(run: Record<string, unknown>): string {
  const conclusion = str(run.conclusion) || str(run.status) || "unknown";
  const flag = conclusion === "success" ? "✓" : conclusion === "failure" ? "✗" : "·";
  const actor = str(((run.actor ?? {}) as Record<string, unknown>).login);
  return `${flag} run_id ${num(run.id)} [${conclusion}] ${str(run.name)}: ${str(run.display_title).slice(0, 80)} — ${str(run.head_branch)}@${str(run.head_sha).slice(0, 7)} · ${str(run.event)} · ${day(run.run_started_at) || day(run.created_at)}${actor ? ` · @${actor}` : ""}`;
}

async function fetchWorkflowRuns(
  auth: string,
  owner: string,
  repo: string,
  query: Record<string, string | number | undefined>,
): Promise<Array<Record<string, unknown>>> {
  const data = (await ghFetch(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs`, {
    query,
  })) as Record<string, unknown>;
  return asRecordArray(data.workflow_runs);
}

async function listWorkflowRuns(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const runs = await fetchWorkflowRuns(auth, owner, repo, {
    per_page: clampNumber(input.limit, 15, 1, 50),
    branch: str(input.branch) || undefined,
    status: str(input.status) || undefined,
  });
  if (runs.length === 0) {
    return `No workflow runs in ${owner}/${repo}${str(input.branch) ? ` on ${str(input.branch)}` : ""} — GitHub Actions may be unused here.`;
  }
  return `Latest ${runs.length} workflow runs in ${owner}/${repo} (newest first):\n${runs.map(formatRunLine).join("\n")}\nUse list_run_jobs with a run_id for job/step details, get_job_logs for a job's log.`;
}

function formatJobLine(job: Record<string, unknown>): string {
  const conclusion = str(job.conclusion) || str(job.status) || "unknown";
  const flag = conclusion === "success" ? "✓" : conclusion === "failure" ? "✗" : "·";
  const steps = asRecordArray(job.steps);
  const failedSteps = steps.filter((step) => str(step.conclusion) === "failure").map((step) => str(step.name));
  return `${flag} job_id ${num(job.id)} [${conclusion}] ${str(job.name)} · started ${str(job.started_at).slice(0, 16)}${failedSteps.length > 0 ? `\n  failed steps: ${failedSteps.join(" · ")}` : ""}`;
}

async function listRunJobs(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const runId = clampNumber(input.run_id, 0, 1, Number.MAX_SAFE_INTEGER);
  if (runId === 0) {
    throw new Error('Provide "run_id" (from list_workflow_runs).');
  }
  const data = (await ghFetch(
    auth,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/jobs`,
    { query: { per_page: 50, filter: "latest" } },
  )) as Record<string, unknown>;
  const jobs = asRecordArray(data.jobs);
  if (jobs.length === 0) {
    return `Run ${runId} has no jobs.`;
  }
  return `${jobs.length} jobs in run ${runId}:\n${jobs.map(formatJobLine).join("\n")}\nUse get_job_logs with a job_id to read a job's log.`;
}

/**
 * Job logs need the relay because their signed blob redirect has no browser
 * CORS headers. The relay follows that hop without forwarding Authorization,
 * and this reader retains only a bounded tail of a potentially huge log.
 */
async function fetchJobLogText(auth: string, owner: string, repo: string, jobId: number): Promise<JobLogTail> {
  const target = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${jobId}/logs`;
  const headers = {
    Authorization: auth,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  let response: Response;
  try {
    response = accountAuthServerId(auth)
      ? await githubTransportFetch(auth, new URL(target), { headers })
      : await relayFetch("/mcp-proxy", target, { headers });
  } catch {
    throw new Error("Could not reach GitHub logs through the relay.");
  }
  if (response.status === 404) {
    throw new Error("No logs — they expire after 90 days, or the job_id is wrong (take it from list_run_jobs).");
  }
  if (response.status === 401) {
    throw new GitHubAuthError('GitHub rejected the token — press "Sign in with GitHub" again, or paste a fresh PAT.');
  }
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} for job logs.`);
  }
  return readResponseTextTail(response, LOG_TAIL_CHARS);
}

async function getJobLogs(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const jobId = clampNumber(input.job_id, 0, 1, Number.MAX_SAFE_INTEGER);
  if (jobId === 0) {
    throw new Error('Provide "job_id" (from list_run_jobs).');
  }
  const log = await fetchJobLogText(auth, owner, repo, jobId);
  const text = log.text.trim();
  if (!text) {
    return `Job ${jobId} produced an empty log.`;
  }
  return `Log of job ${jobId}${log.truncated ? ` (last ${LOG_TAIL_CHARS} of ${log.totalChars} chars — failures live at the end)` : ""}:\n${text}`;
}

async function listRunArtifacts(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const runId = clampNumber(input.run_id, 0, 1, Number.MAX_SAFE_INTEGER);
  if (runId === 0) {
    throw new Error('Provide "run_id" (from list_workflow_runs).');
  }
  const data = (await ghFetch(
    auth,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/artifacts`,
  )) as Record<string, unknown>;
  const artifacts = asRecordArray(data.artifacts);
  if (artifacts.length === 0) {
    return `Run ${runId} produced no artifacts.`;
  }
  const lines = artifacts.map(
    (artifact) =>
      `${str(artifact.name)} — ${Math.max(1, Math.round(num(artifact.size_in_bytes) / 1024))} KB${artifact.expired === true ? " · EXPIRED" : ""} · created ${day(artifact.created_at)}`,
  );
  return `${artifacts.length} artifacts of run ${runId} (download as zips at https://github.com/${owner}/${repo}/actions/runs/${runId}):\n${lines.join("\n")}`;
}

async function listReleases(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const releases = asRecordArray(
    await ghFetch(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`, {
      query: { per_page: clampNumber(input.limit, 10, 1, 30) },
    }),
  );
  if (releases.length === 0) {
    return `No releases in ${owner}/${repo}. Tags may still exist — see list_branches or list_commits.`;
  }
  const lines = releases.map((release) => {
    const flags = [release.draft === true ? "draft" : "", release.prerelease === true ? "prerelease" : ""]
      .filter(Boolean)
      .join(", ");
    const body = str(release.body).trim().replace(/\s+/g, " ").slice(0, 200);
    return `${str(release.tag_name)} — ${str(release.name) || "(unnamed)"}${flags ? ` [${flags}]` : ""} · ${day(release.published_at) || "unpublished"}${body ? `\n  ${body}` : ""}`;
  });
  return `${releases.length} releases in ${owner}/${repo}:\n${lines.join("\n")}`;
}

async function listBranches(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const branches = asRecordArray(
    await ghFetch(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`, {
      query: { per_page: clampNumber(input.limit, 50, 1, 100) },
    }),
  );
  if (branches.length === 0) {
    return `No branches in ${owner}/${repo}.`;
  }
  const lines = branches.map(
    (branch) =>
      `${str(branch.name)}${branch.protected === true ? " [protected]" : ""} @${str(((branch.commit ?? {}) as Record<string, unknown>).sha).slice(0, 7)}`,
  );
  return `${branches.length} branches in ${owner}/${repo}:\n${lines.join("\n")}`;
}

async function listDeployments(auth: string, input: Record<string, unknown>): Promise<string> {
  const owner = need(input, "owner");
  const repo = need(input, "repo");
  const deployments = asRecordArray(
    await ghFetch(auth, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/deployments`, {
      query: { per_page: clampNumber(input.limit, 10, 1, 30) },
    }),
  );
  if (deployments.length === 0) {
    return `No deployments recorded in ${owner}/${repo} — deploys may run outside GitHub, or via Actions only (see list_workflow_runs).`;
  }
  const withStatus = await Promise.all(
    deployments.slice(0, 10).map(async (deployment) => {
      let state = "unknown";
      let previewUrl = "";
      try {
        const statuses = asRecordArray(
          await ghFetch(
            auth,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/deployments/${num(deployment.id)}/statuses`,
            { query: { per_page: 1 } },
          ),
        );
        state = str(statuses[0]?.state) || "pending";
        previewUrl = str(statuses[0]?.environment_url) || str(statuses[0]?.target_url);
      } catch {
        // status listing can fail on old deployments — keep "unknown"
      }
      const summary = `${str(deployment.environment) || "env?"} [${state}] ref ${str(deployment.ref)}@${str(deployment.sha).slice(0, 7)} · ${day(deployment.created_at)} · by @${str(((deployment.creator ?? {}) as Record<string, unknown>).login) || "unknown"}`;
      return previewUrl ? `${summary}\n  preview: ${previewUrl}` : summary;
    }),
  );
  return `${deployments.length} deployments in ${owner}/${repo} (latest first):\n${withStatus.join("\n")}`;
}

/** One repo's CI picture for deep research: recent runs plus the latest failure's log tail. */
export type RepoCiSnapshot = {
  runsText: string;
  failure: { url: string; title: string; text: string } | null;
};

/** Null when the repo has no workflow runs. Log-fetch failures degrade to the job/step breakdown. */
export async function fetchRepoCiSnapshot(auth: string, owner: string, repo: string): Promise<RepoCiSnapshot | null> {
  const runs = await fetchWorkflowRuns(auth, owner, repo, { per_page: 12 });
  if (runs.length === 0) {
    return null;
  }
  const runsText = `Recent workflow runs (newest first):\n${runs.map(formatRunLine).join("\n")}`;
  const failed = runs.find((run) => str(run.conclusion) === "failure");
  if (!failed) {
    return { runsText, failure: null };
  }
  const runId = num(failed.id);
  const runUrl = str(failed.html_url) || `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
  const header = `${str(failed.name)}: "${str(failed.display_title)}" on ${str(failed.head_branch)}@${str(failed.head_sha).slice(0, 7)} failed ${day(failed.run_started_at) || day(failed.created_at)}.`;
  let text = header;
  try {
    const data = (await ghFetch(
      auth,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/jobs`,
      { query: { per_page: 50, filter: "latest" } },
    )) as Record<string, unknown>;
    const jobs = asRecordArray(data.jobs);
    const failedJob = jobs.find((job) => str(job.conclusion) === "failure");
    text = `${header}\n${jobs.map(formatJobLine).join("\n")}`;
    if (failedJob) {
      try {
        const log = (await fetchJobLogText(auth, owner, repo, num(failedJob.id))).text.trim();
        if (log) {
          text += `\n\nLog tail of failed job "${str(failedJob.name)}":\n${log.slice(-6_000)}`;
        }
      } catch {
        text += "\n\n(Job log could not be fetched.)";
      }
    }
  } catch {
    text = `${header}\n(Job breakdown unavailable.)`;
  }
  return {
    runsText,
    failure: { url: runUrl, title: `${owner}/${repo} — latest failing CI run`, text },
  };
}

/** Tool surface exposed to the agent; names become mcp_github_* functions. */
export const GITHUB_NATIVE_TOOLS: McpToolInfo[] = [
  {
    name: "whoami",
    description:
      "Show which GitHub account this token belongs to, its scopes, and which organizations it can see. Run this first when repos seem missing.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_my_repos",
    description:
      "List ALL repositories this account can access — own, private, collaborator, and org repos — sorted by last push. This is the reliable way to find the user's repositories; prefer it over search for anything 'my'.",
    inputSchema: {
      type: "object",
      properties: {
        nameFilter: { type: "string", description: "Optional substring to match against repo name/description" },
        visibility: { type: "string", enum: ["all", "public", "private"], description: "Filter by visibility (default all)" },
        limit: { type: "number", description: "Max repos to return (default 100, max 300)" },
      },
    },
  },
  {
    name: "search_repositories",
    description:
      "Search repositories across ALL of GitHub (global). For the user's own repos use list_my_repos instead — global search can miss private repos. Supports qualifiers like language:, stars:>100, user:@me.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query, e.g. 'kanban language:typescript' or 'user:@me api'" },
        limit: { type: "number", description: "Max results (default 10, max 30)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_repo",
    description: "Get details for one repository: description, default branch, stars, forks, topics, URL.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner (user or org login)" },
        repo: { type: "string", description: "Repo name" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "get_contents",
    description:
      "Read a file's actual text content or list a directory in a repository. Pass an exact path returned by get_file_tree; use path:'' only for the repo root. Private and 1–100 MB text files are read through GitHub's authenticated raw fallback, then truncated at 12k chars.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        path: { type: "string", description: "File or directory path (empty = root)" },
        ref: { type: "string", description: "Branch, tag, or commit SHA (default: default branch)" },
      },
      required: ["owner", "repo", "path"],
    },
  },
  {
    name: "get_file_tree",
    description:
      "List EVERY file in a repository in one call (recursive tree with sizes). Use this to map a codebase before reading specific files with get_contents.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        ref: { type: "string", description: "Branch, tag, or commit SHA (default: default branch)" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "get_readme",
    description: "Fetch a repository's README as text.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "list_commits",
    description: "List recent commits in a repository (optionally for one branch).",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        branch: { type: "string", description: "Branch, tag, or SHA (default: default branch)" },
        limit: { type: "number", description: "Max commits (default 20, max 50)" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "search_code",
    description:
      "Search code on GitHub. For private code include repo:owner/name or user:@me in the query; only default branches are indexed.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Code search query, e.g. 'useQuery repo:owner/name' " },
        limit: { type: "number", description: "Max results (default 10, max 30)" },
      },
      required: ["query"],
    },
  },
  {
    name: "search_issues",
    description:
      "Search issues and pull requests. Use qualifiers: repo:owner/name, is:issue / is:pr, is:open, author:@me, assignee:@me.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query, e.g. 'is:open is:pr repo:owner/name'" },
        limit: { type: "number", description: "Max results (default 10, max 30)" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_issues",
    description: "List issues in a repository (PRs excluded).",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        state: { type: "string", enum: ["open", "closed", "all"], description: "Issue state (default open)" },
        limit: { type: "number", description: "Max issues (default 20, max 50)" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "list_pulls",
    description: "List pull requests in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        state: { type: "string", enum: ["open", "closed", "all"], description: "PR state (default open)" },
        limit: { type: "number", description: "Max PRs (default 20, max 50)" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "get_pull",
    description: "Get one pull request: title, branches, diff stats, and description.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        number: { type: "number", description: "PR number" },
      },
      required: ["owner", "repo", "number"],
    },
  },
  {
    name: "get_pull_files",
    description: "Get a pull request's full diff: every changed file with its patch (up to GitHub's 3,000-file API limit).",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        number: { type: "number", description: "PR number" },
      },
      required: ["owner", "repo", "number"],
    },
  },
  {
    name: "get_commit",
    description: "Get one commit's message, stats, and full diff (per-file patches). ref accepts a SHA, branch, or tag.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        ref: { type: "string", description: "Commit SHA, branch, or tag" },
      },
      required: ["owner", "repo", "ref"],
    },
  },
  {
    name: "compare_commits",
    description: "Compare two refs (base...head): the commit list and full diff between them. Great for 'what changed since'.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        base: { type: "string", description: "Base SHA, branch, or tag" },
        head: { type: "string", description: "Head SHA, branch, or tag" },
      },
      required: ["owner", "repo", "base", "head"],
    },
  },
  {
    name: "list_workflow_runs",
    description:
      "List recent GitHub Actions workflow runs (CI/CD) with conclusion, branch, and run_id. Start here for CI, build, or deploy questions.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        branch: { type: "string", description: "Filter by branch" },
        status: { type: "string", description: "Filter: completed, success, failure, in_progress, queued" },
        limit: { type: "number", description: "Max runs (default 15, max 50)" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "list_run_jobs",
    description: "List a workflow run's jobs with conclusions and failed steps. Take run_id from list_workflow_runs.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        run_id: { type: "number", description: "Workflow run id" },
      },
      required: ["owner", "repo", "run_id"],
    },
  },
  {
    name: "get_job_logs",
    description: "Read a CI job's log (the tail — failures live at the end). Take job_id from list_run_jobs.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        job_id: { type: "number", description: "Job id" },
      },
      required: ["owner", "repo", "job_id"],
    },
  },
  {
    name: "list_run_artifacts",
    description: "List artifacts a workflow run produced (names, sizes, expiry). Artifacts download as zips from the run's page.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        run_id: { type: "number", description: "Workflow run id" },
      },
      required: ["owner", "repo", "run_id"],
    },
  },
  {
    name: "list_releases",
    description: "List releases with tags, dates, and release notes.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        limit: { type: "number", description: "Max releases (default 10, max 30)" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "list_branches",
    description: "List branches with head SHAs and protection flags.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        limit: { type: "number", description: "Max branches (default 50, max 100)" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "list_deployments",
    description:
      "List deployments with environment, ref, latest status, and the real preview URL when the provider publishes one — covers Vercel/Netlify-style integrations recorded on GitHub.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        limit: { type: "number", description: "Max deployments (default 10, max 30)" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        title: { type: "string", description: "Issue title" },
        body: { type: "string", description: "Issue body (Markdown)" },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "add_issue_comment",
    description: "Comment on an issue or pull request.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        number: { type: "number", description: "Issue or PR number" },
        body: { type: "string", description: "Comment body (Markdown)" },
      },
      required: ["owner", "repo", "number", "body"],
    },
  },
  {
    name: "create_branch",
    description:
      "Create a working branch (default: off the repo's default branch). Required before any code write — the default branch is write-protected; changes ship as branch → PR.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        branch: { type: "string", description: 'New branch name, e.g. "fix/login-crash"' },
        from: { type: "string", description: "Source branch or SHA (default: the default branch)" },
      },
      required: ["owner", "repo", "branch"],
    },
  },
  {
    name: "put_file",
    description:
      "Create or update ONE file on a working branch as a commit. Pass the COMPLETE new file content — never a diff, never placeholders. To update an existing file, read it first and pass its sha as expected_sha; stale writes are refused. The default branch is write-protected: commit to a create_branch branch and ship the change as a PR (create_pull).",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        branch: { type: "string", description: "Working branch to commit to (never the default branch)" },
        path: { type: "string", description: "File path, e.g. src/app.ts" },
        content: { type: "string", description: "The complete new file content (UTF-8 text; an explicit empty string is allowed)" },
        expected_sha: { type: "string", description: "Required when updating an existing file: sha returned by get_contents" },
        message: { type: "string", description: "Commit message" },
      },
      required: ["owner", "repo", "branch", "path", "content", "message"],
    },
  },
  {
    name: "delete_file",
    description: "Delete one file on a working branch as a commit. Read it first and pass its sha as expected_sha; stale deletes are refused. The default branch is write-protected.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        branch: { type: "string", description: "Working branch (never the default branch)" },
        path: { type: "string", description: "File path to delete" },
        expected_sha: { type: "string", description: "sha returned by get_contents for the version being deleted" },
        message: { type: "string", description: "Commit message" },
      },
      required: ["owner", "repo", "branch", "path", "expected_sha", "message"],
    },
  },
  {
    name: "create_pull",
    description:
      "Open a pull request (head working branch → base, default: the default branch). Write an honest description: what & why, how it was verified, what was NOT verified, risks. There is deliberately NO merge tool — the human merges. Watch CI with list_workflow_runs on the head branch.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        title: { type: "string", description: "PR title" },
        head: { type: "string", description: "Branch with the changes" },
        base: { type: "string", description: "Target branch (default: the default branch)" },
        body: { type: "string", description: "PR description (Markdown) — honest: verified vs not verified, risks" },
        draft: { type: "boolean", description: "Open as a draft PR" },
      },
      required: ["owner", "repo", "title", "head"],
    },
  },
  {
    name: "update_pull",
    description:
      "Update a pull request's title, body, or state (open/closed) — keep the description honest after new commits. No merge tool exists; the human merges.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo: { type: "string", description: "Repo name" },
        number: { type: "number", description: "PR number" },
        title: { type: "string", description: "New title" },
        body: { type: "string", description: "New description (Markdown)" },
        state: { type: "string", enum: ["open", "closed"], description: "Set PR state" },
      },
      required: ["owner", "repo", "number"],
    },
  },
];

/** Dispatches an agent tool call to the GitHub REST API. */
export async function callGitHubNativeTool(auth: string, name: string, args: unknown): Promise<string> {
  const input = (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  switch (name) {
    case "whoami":
      return whoami(auth);
    case "list_my_repos":
      return listMyRepos(auth, input);
    case "search_repositories":
      return searchRepositories(auth, input);
    case "get_repo":
      return getRepo(auth, input);
    case "get_contents":
      return getContents(auth, input);
    case "get_file_tree":
      return getFileTree(auth, input);
    case "get_readme":
      return getReadme(auth, input);
    case "list_commits":
      return listCommits(auth, input);
    case "search_code":
      return searchCode(auth, input);
    case "search_issues":
      return searchIssues(auth, input);
    case "list_issues":
      return listIssues(auth, input);
    case "list_pulls":
      return listPulls(auth, input);
    case "get_pull":
      return getPull(auth, input);
    case "create_issue":
      return createIssue(auth, input);
    case "add_issue_comment":
      return addIssueComment(auth, input);
    case "create_branch":
      return createBranch(auth, input);
    case "put_file":
      return putFile(auth, input);
    case "delete_file":
      return deleteFile(auth, input);
    case "create_pull":
      return createPull(auth, input);
    case "update_pull":
      return updatePull(auth, input);
    case "get_pull_files":
      return getPullFiles(auth, input);
    case "get_commit":
      return getCommit(auth, input);
    case "compare_commits":
      return compareCommits(auth, input);
    case "list_workflow_runs":
      return listWorkflowRuns(auth, input);
    case "list_run_jobs":
      return listRunJobs(auth, input);
    case "get_job_logs":
      return getJobLogs(auth, input);
    case "list_run_artifacts":
      return listRunArtifacts(auth, input);
    case "list_releases":
      return listReleases(auth, input);
    case "list_branches":
      return listBranches(auth, input);
    case "list_deployments":
      return listDeployments(auth, input);
    default:
      throw new Error(`Unknown GitHub tool "${name}".`);
  }
}
