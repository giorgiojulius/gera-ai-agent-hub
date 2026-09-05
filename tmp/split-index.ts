// One-off, deterministic split of functions/index.ts: the project relays
// (projects / Slack events / Slack OAuth callback / page views) move to
// project-relay.ts and the repository-preview relays to repo-preview-relay.ts,
// both over a seam object built in index.ts (same shape as McpRelayContext).
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = "/home/user/rork-app/functions";
const SRC = `${ROOT}/index.ts`;
const src = readFileSync(SRC, "utf8");
const lines = src.split("\n");

function findLine(pred: (l: string) => boolean, from = 1): number {
  for (let i = from; i <= lines.length; i++) if (pred(lines[i - 1])) return i;
  throw new Error("line not found");
}
function withLeadingComments(start: number): number {
  let s = start;
  while (s > 1 && /^(\/\*\*|\s\*|\/\/)/.test(lines[s - 2])) s -= 1;
  return s;
}
function closingBrace(fnStart: number): number {
  return findLine((l) => l === "}", fnStart);
}
function replaceOnce(text: string, from: string | RegExp, to: string, expected = 1): string {
  const re = typeof from === "string" ? new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") : from;
  const count = (text.match(re) ?? []).length;
  if (count !== expected) throw new Error(`expected ${expected} match(es) for ${String(from)}, got ${count}`);
  return text.replace(re, to);
}

// ---- ranges --------------------------------------------------------------
const pStart = withLeadingComments(findLine((l) => l.startsWith("const PROJECT_BODY_LIMIT =")));
const pEnd = closingBrace(findLine((l) => l.startsWith("async function relayProjects(")));
const rStart = withLeadingComments(findLine((l) => l.startsWith("async function repoPreviewHmac(")));
const rEnd = closingBrace(findLine((l) => l.startsWith("async function relayRepoPreviewArchive(")));
if (!(pStart < pEnd && pEnd < rStart && rStart < rEnd)) throw new Error("range order");

let P = lines.slice(pStart - 1, pEnd).join("\n");
let R = lines.slice(rStart - 1, rEnd).join("\n");

// ---- project relays ------------------------------------------------------
P = P.replace(
  /^async function (relay\w+)\(request: Request, url: URL, env: Env(, ctx: ExecutionCtx)?\): Promise<Response> \{$/gm,
  (_m, name: string, exec: string | undefined) =>
    `export async function ${name}(relay: ProjectRelayContext, request: Request, url: URL${exec ?? ""}): Promise<Response> {`,
);
P = replaceOnce(P, /^  env: Env,$/gm, "  relay: ProjectRelayContext,", 2);
P = replaceOnce(P, "env.DO.fetch(", "relay.durable.fetch(", 1);
P = replaceOnce(P, "requireInvitedAccount(request, env)", "relay.requireInvitedAccount(request)", 1);
P = replaceOnce(P, "isInvitedCached(env, ", "relay.isInvitedCached(", 1);
P = replaceOnce(P, "accountAuthorizationLease(env, ", "relay.accountAuthorizationLease(", 1);
P = P.replace(/\bcorsJson\(/g, "relay.corsJson(");
P = P.replace(/\bCORS_HEADERS\b/g, "relay.corsHeaders");
P = P.replace(/\benv\b/g, "relay");
for (const bad of [/\bEnv\b/, /\brelay\.relay\b/, /\brequireInvitedAccount\(request, relay\)/]) {
  if (bad.test(P)) throw new Error(`project cluster still has ${bad}`);
}
const pExports = [...P.matchAll(/^export async function (\w+)\(/gm)].map((m) => m[1]);

const projectHeader = `// Project relays of the Worker — /projects/* (registry + per-project shard
// sub-routes with post-commit effects), inbound Slack events, the Slack app
// install callback and the public page-view ingest. Moved verbatim out of
// index.ts: the Worker lends the DO binding, CORS helpers and its account /
// invite gates through ProjectRelayContext. Bodies stay bounded here; the
// shard (project-store.ts) owns authorisation and secrets.

import { decodeSlackInstallState } from "./native-slack";

type ExecutionCtx = { waitUntil(promise: Promise<unknown>): void };

/** The slice of the Worker's verified account principal these relays touch. */
export type ProjectRelayAccount = { storageOwner: string };

/** What index.ts lends the project relays. */
export type ProjectRelayContext<A extends ProjectRelayAccount = ProjectRelayAccount> = {
  /** Durable Object namespace binding — ProjectStore registry and shards. */
  durable: { fetch(request: Request): Promise<Response> };
  corsHeaders: Record<string, string>;
  corsJson(data: unknown, status: number): Response;
  /** Platform identity + invite gate; a Response means "answer with this". */
  requireInvitedAccount(request: Request): Promise<A | Response>;
  /** Cached invite check for a member added to a project. */
  isInvitedCached(requestUrl: string, email: string): Promise<boolean>;
  /** Short-lived GitHub authorization proof from the account shard (agent MCP link). */
  accountAuthorizationLease(requestUrl: string, account: A, serverId: string, force: boolean): Promise<string | null>;
};
`;
const projectFile = `${projectHeader}\n${P}\n`;

// ---- repo-preview relays -------------------------------------------------
R = replaceOnce(
  R,
  "async function repoPreviewOwnerKey(email: string, env: Env)",
  "async function repoPreviewOwnerKey(email: string, relay: RepoPreviewRelayContext)",
);
R = replaceOnce(R, /^  env: Env,$/gm, "  relay: RepoPreviewRelayContext,", 3);
R = replaceOnce(
  R,
  "async function sweepRepoPreviewRegistry(env: Env, origin: string)",
  "export async function sweepRepoPreviewRegistry(relay: RepoPreviewRelayContext, origin: string)",
);
R = R.replace(
  /^async function (relayRepoPreviews|relayRepoPreviewPublic)\(request: Request, url: URL, env: Env\)/gm,
  "export async function $1(relay: RepoPreviewRelayContext, request: Request, url: URL)",
);
R = replaceOnce(R, "env.DO.fetch(", "relay.durable.fetch(", 1);
R = replaceOnce(R, "env.RORK_AUTH_SECRET_KEY", "relay.authSecretKey", 6);
R = replaceOnce(R, "requireInvitedAccount(request, env)", "relay.requireInvitedAccount(request)", 1);
R = replaceOnce(R, "accountAuthorizationLease(env, ", "relay.accountAuthorizationLease(", 1);
R = R.replace(/\bcorsJson\(/g, "relay.corsJson(");
R = R.replace(/\bCORS_HEADERS\b/g, "relay.corsHeaders");
R = R.replace(/\breadBoundedText\(/g, "relay.readBoundedText(");
R = R.replace(/\benv\b/g, "relay");
for (const bad of [/\bEnv\b/, /\brelay\.relay\b/]) {
  if (bad.test(R)) throw new Error(`repo cluster still has ${bad}`);
}
const rExports = [...R.matchAll(/^export async function (\w+)\(/gm)].map((m) => m[1]);

const repoHeader = `// Repository-preview relays of the Worker — the authenticated control plane
// (/repo-previews/*), the public hook surface the GitHub Actions runner calls
// back into, the streamed archive upload and the registry touch / sweep.
// Moved verbatim out of index.ts: the Worker lends the DO binding, the
// internal registry secret, CORS helpers, bounded body reads and its account
// gate through RepoPreviewRelayContext.

import { REPO_PREVIEW_MAX_ARCHIVE_BYTES, verifyRepoPreviewId } from "./repo-preview-shared";

/** The slice of the Worker's verified account principal these relays touch. */
export type RepoPreviewRelayAccount = { storageOwner: string };

/** What index.ts lends the repository-preview relays. */
export type RepoPreviewRelayContext<A extends RepoPreviewRelayAccount = RepoPreviewRelayAccount> = {
  /** Durable Object namespace binding — RepoPreviewStore registry and per-owner shards. */
  durable: { fetch(request: Request): Promise<Response> };
  /** Worker secret behind the internal registry routes and the preview-id HMAC. */
  authSecretKey: string | undefined;
  corsHeaders: Record<string, string>;
  corsJson(data: unknown, status: number): Response;
  readBoundedText(request: Request, limit: number): Promise<string | null>;
  /** Platform identity + invite gate; a Response means "answer with this". */
  requireInvitedAccount(request: Request): Promise<A | Response>;
  /** Short-lived GitHub authorization proof from the account shard. */
  accountAuthorizationLease(requestUrl: string, account: A, serverId: string, force: boolean): Promise<string | null>;
};
`;
const repoFile = `${repoHeader}\n${R}\n`;

// ---- index.ts ------------------------------------------------------------
const drop = new Set<number>();
for (let i = pStart; i <= pEnd; i++) drop.add(i);
for (let i = rStart; i <= rEnd; i++) drop.add(i);
// Imports that only the moved clusters used.
drop.add(findLine((l) => l === 'import { REPO_PREVIEW_MAX_ARCHIVE_BYTES, verifyRepoPreviewId } from "./repo-preview-shared";'));
drop.add(findLine((l) => l === 'import { decodeSlackInstallState } from "./native-slack";'));
let idx = lines.filter((_, i) => !drop.has(i + 1)).join("\n");

const projectImport = `import { ${[...pExports].sort().join(", ")}, type ProjectRelayContext } from "./project-relay";`;
const repoImport = `import {\n${[...rExports, "type RepoPreviewRelayContext"]
  .sort((a, b) => a.replace(/^type /, "").localeCompare(b.replace(/^type /, ""), "en"))
  .map((s) => `  ${s},`)
  .join("\n")}\n} from "./repo-preview-relay";`;
idx = replaceOnce(idx, '} from "./mcp-relay";\n', `} from "./mcp-relay";\n${projectImport}\n${repoImport}\n`, 1);

const factories = `
function projectRelayContext(env: Env): ProjectRelayContext<AccountPrincipal> {
  return {
    durable: env.DO,
    corsHeaders: CORS_HEADERS,
    corsJson,
    requireInvitedAccount: (request) => requireInvitedAccount(request, env),
    isInvitedCached: (requestUrl, email) => isInvitedCached(env, requestUrl, email),
    accountAuthorizationLease: (requestUrl, account, serverId, force) =>
      accountAuthorizationLease(env, requestUrl, account, serverId, force),
  };
}

function repoPreviewRelayContext(env: Env): RepoPreviewRelayContext<AccountPrincipal> {
  return {
    durable: env.DO,
    authSecretKey: env.RORK_AUTH_SECRET_KEY,
    corsHeaders: CORS_HEADERS,
    corsJson,
    readBoundedText,
    requireInvitedAccount: (request) => requireInvitedAccount(request, env),
    accountAuthorizationLease: (requestUrl, account, serverId, force) =>
      accountAuthorizationLease(env, requestUrl, account, serverId, force),
  };
}
`;
// Place the factories right after mcpRelayContext().
{
  const il = idx.split("\n");
  const s = il.findIndex((l) => l.startsWith("function mcpRelayContext(env: Env)"));
  if (s < 0) throw new Error("mcpRelayContext not found");
  let e = s;
  while (il[e] !== "}") e += 1;
  il.splice(e + 1, 0, ...factories.split("\n").slice(0, -1));
  idx = il.join("\n");
}

idx = replaceOnce(idx, "relayProjects(request, url, env, ctx)", "relayProjects(projectRelayContext(env), request, url, ctx)");
idx = replaceOnce(idx, "relaySlackEvents(request, url, env, ctx)", "relaySlackEvents(projectRelayContext(env), request, url, ctx)");
idx = replaceOnce(idx, "relaySlackOAuthCallback(request, url, env)", "relaySlackOAuthCallback(projectRelayContext(env), request, url)");
idx = replaceOnce(idx, "relayPageViews(request, url, env)", "relayPageViews(projectRelayContext(env), request, url)");
idx = replaceOnce(idx, "relayRepoPreviewPublic(request, url, env)", "relayRepoPreviewPublic(repoPreviewRelayContext(env), request, url)");
idx = replaceOnce(idx, "relayRepoPreviews(request, url, env)", "relayRepoPreviews(repoPreviewRelayContext(env), request, url)");
idx = replaceOnce(idx, "sweepRepoPreviewRegistry(env, url.origin)", "sweepRepoPreviewRegistry(repoPreviewRelayContext(env), url.origin)");
idx = idx.replace(/\n{3,}/g, "\n\n");

// Nothing in index.ts may still reference module-private names of the moved clusters.
for (const n of [
  "PROJECT_BODY_LIMIT",
  "PROJECT_SUB_ROUTES",
  "projectStoreFetch",
  "projectPostEffects",
  "SLACK_EVENT_BODY_LIMIT",
  "PAGE_VIEW_BODY_LIMIT",
  "escapeHtml",
  "slackCallbackPage",
  "repoPreviewHmac",
  "repoPreviewOwnerKey",
  "repoPreviewStoreRequest",
  "touchRepoPreviewRegistry",
  "fixedLengthBody",
  "hookJson",
  "FixedLengthStreamConstructor",
  "decodeSlackInstallState",
  "verifyRepoPreviewId",
  "REPO_PREVIEW_MAX_ARCHIVE_BYTES",
]) {
  if (new RegExp(`\\b${n}\\b`).test(idx)) throw new Error(`index.ts still references ${n}`);
}

writeFileSync(`${ROOT}/project-relay.ts`, projectFile);
writeFileSync(`${ROOT}/repo-preview-relay.ts`, repoFile);
writeFileSync(SRC, idx);
console.log(
  JSON.stringify(
    {
      project: [pStart, pEnd, pExports],
      repo: [rStart, rEnd, rExports],
      indexBytes: Buffer.byteLength(idx),
      projectBytes: Buffer.byteLength(projectFile),
      repoBytes: Buffer.byteLength(repoFile),
    },
    null,
    2,
  ),
);
