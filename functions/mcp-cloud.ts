import {
  extractMcpResultMedia,
  isUiOnlyTool,
  MCP_DEFAULT_PROTOCOL_VERSION,
  mcpConnect,
  mcpListAll,
  mcpRequest,
  mcpRequestWithInput,
  McpRpcError,
  mcpResourceLinks,
  sessionWireInfo,
  normalizePromptInfo,
  normalizeResourceInfo,
  normalizeResourceTemplateInfo,
  normalizeToolAnnotations,
  parseJsonRpcPayload,
  redactMcpText,
  redactMcpValue,
  selectRpcResponse,
  stringifyMcpPromptContent,
  stringifyMcpResourceRead,
  stringifyMcpToolResult,
  type JsonRpcMessage,
  type McpCredentialLease,
  type McpFetch,
  type McpNotification,
  type McpResultMedia,
  type McpPromptInfo,
  type McpProtocolSession,
  type McpResourceInfo,
  type McpResourceTemplateInfo,
  type McpServerRequest,
  type McpServerRequestReply,
  type McpToolAnnotations,
  type McpWireInfo,
} from "./mcp-protocol";
import { fetchPublicHttps, safePublicHttpsUrl } from "./network-safety";

// Cloud-side MCP for scheduled automation runs: decides which of the
// profile's connected servers can fire without the browser, and speaks the
// MCP Streamable HTTP protocol (initialize → tools/list → tools/call)
// directly from the Worker through the shared protocol core
// (mcp-protocol.ts) — no CORS constraints here, so no relay hop.
//
// Every connected server reaches cloud runs: pasted keys and custom headers
// sync inside the profile blob, browser sign-ins sync as OAuth grants (and
// refresh server-side when they expire), and the native GitHub/Slack/Intercom
// connectors dispatch through their server-side REST ports (native-*.ts).

/** A browser sign-in synced with the profile; refreshed server-side on expiry. */
export type CloudOAuthToken = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires. */
  expiresAt?: number;
  tokenEndpoint: string;
  clientId: string;
  resource?: string;
  /** Canonical MCP endpoint this browser grant was issued for. */
  mcpUrl?: string;
};

/** A grant rotated server-side; the account shard persists it for later runs. */
export type RefreshedOAuth = {
  serverId: string;
  /** The synced access token this refresh was based on — stale-detection anchor. */
  baseAccessToken: string;
  token: CloudOAuthToken;
};

/** Durable commit hook invoked before a rotated credential is used. */
export type PersistRefreshedOAuth = (rotation: RefreshedOAuth) => Promise<void>;

/** Durable hook written before a rotating provider request leaves the account actor. */
export type BeginCloudOAuthRefresh = (serverId: string, baseAccessToken: string) => Promise<void>;

/** A provider refresh failure, preserving whether retrying later is safe. */
export type CloudOAuthRefreshFailure = {
  ok: false;
  status: number;
  code: string;
  detail?: string;
  transient: boolean;
  /** The provider may have consumed the rotating token before the response vanished. */
  ambiguous: boolean;
  /** `insufficient_scope`: the scopes the server's WWW-Authenticate challenge demanded. */
  requiredScopes?: string[];
};

/** Provider refresh result with a typed durable-failure branch. */
export type CloudOAuthRefreshOutcome =
  | { ok: true; token: CloudOAuthToken }
  | CloudOAuthRefreshFailure;

export type CloudMcpServer = {
  id: string;
  name: string;
  /** "mcp" speaks Streamable HTTP; the rest dispatch to native REST ports. */
  kind: "mcp" | "github" | "slack" | "intercom";
  url: string;
  /** Fully resolved request headers (Authorization included when a key is set). */
  headers: Record<string, string>;
  /** Google hosts reject the MCP protocol headers — skip them there. */
  omitMcpHeaders: boolean;
  disabledTools: string[];
  /** Native connector credential (PAT / xoxb / Intercom access token). */
  token?: string;
  /** Synced browser sign-in — used when no pasted key exists. */
  oauth?: CloudOAuthToken;
};

export type CloudMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Display title from the tool or its annotations. */
  title?: string;
  /** Spec annotations (readOnlyHint, destructiveHint, …) as the server declared them. */
  annotations?: McpToolAnnotations;
  /** MCP Apps: renders its own UI — never offered to the model. */
  uiOnly?: boolean;
};

/** One live Streamable HTTP session — the shared protocol session shape. */
export type CloudMcpSession = McpProtocolSession;

function credentialVariants(values: string[]): string[] {
  const variants = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    variants.add(value);
    const bearer = /^Bearer\s+(.+)$/i.exec(value)?.[1]?.trim();
    if (bearer) variants.add(bearer);
    try {
      variants.add(encodeURIComponent(value));
      if (bearer) variants.add(encodeURIComponent(bearer));
    } catch {
      // Exact raw replacement still applies.
    }
  }
  return [...variants].filter(Boolean).sort((left, right) => right.length - left.length);
}

/** Redacts exact server-owned credentials before output reaches an LLM, log, or row. */
export function redactCloudMcpText(text: string, credentials: string[]): string {
  return redactMcpText(text, credentials);
}

/** Deep string redaction for provider-controlled schemas and structured output. */
export function redactCloudMcpValue(value: unknown, credentials: string[], depth: number = 0): unknown {
  return redactMcpValue(value, credentials, depth);
}

/** Every exact credential value a server carries — for redacting provider-originated text. */
export function cloudServerRedactions(server: CloudMcpServer): string[] {
  return serverCredentialValues(server);
}

function serverCredentialValues(server: CloudMcpServer): string[] {
  const values = [
    ...Object.values(server.headers),
    server.token ?? "",
    server.oauth?.accessToken ?? "",
    server.oauth?.refreshToken ?? "",
  ];
  try {
    const url = new URL(server.url);
    for (const [key, value] of url.searchParams) {
      if (/(?:token|key|secret|auth|credential)/i.test(key)) {
        values.push(value);
      }
    }
  } catch {
    // URL validity is checked before connection.
  }
  return credentialVariants(values);
}

const CONNECT_TIMEOUT_MS = 12_000;
/** The `server/discover` probe is bounded separately — a silent legacy server must not eat the connect budget. */
const DISCOVER_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 40_000;

// Minimal mirror of the web catalog facts the cloud needs; the full catalog
// (hints, icons, OAuth metadata) lives in the web app.
const NATIVE_IDS = new Set(["github", "slack", "intercom"]);
/** Catalog servers that answer without credentials (auth "none" or key optional). */
const OPEN_IDS = new Set([
  "deepwiki",
  "ms-learn",
  "gitmcp",
  "wolfram",
  "cloudflare-docs",
  "cf-agents",
  "context-awesome",
  "remote-mcp",
  "svelte-docs",
  "cometchat-docs",
  "soracom-docs",
  "nyc-subway",
  "sonatype",
  "nslookup",
  "testerarmy-docs",
  "invideo",
  "manifold",
  "context7",
  "huggingface",
  "exa",
  "firecrawl",
  "telnyx",
  "atom",
  "chainstack",
]);
/** Catalog token-placement quirks (mirrors the web client's buildAuth). */
const TOKEN_HEADER: Record<string, string> = {
  exa: "x-api-key",
  searchapi: "X-MCP-Token",
};
const TOKEN_QUERY_PARAM: Record<string, string> = {};
const TOKEN_URL_TEMPLATE: Record<string, string> = {
  octagon: "https://mcp.octagonai.co/{token}/mcp",
};
const OMIT_HEADER_IDS = new Set<string>();
const BLOCKED_IDS = new Set(["intercom-mcp"]);

/** Mutation tools on the native GitHub connector. Gera chat always leaves these armed. */
export const GITHUB_CHAT_WRITE_TOOLS = [
  "create_issue",
  "add_issue_comment",
  "create_branch",
  "put_file",
  "delete_file",
  "create_pull",
  "update_pull",
] as const;

/**
 * Gera chat GitHub is write-capable. Older profiles stored the factory
 * read-only block on the connector; strip those names so existing sign-ins
 * can commit without a reconnect. Project agents still filter writes via
 * their own Read-only / Read & write switch.
 */
export function unlockGithubChatWrites(catalogKey: string, disabledTools: string[]): string[] {
  if (catalogKey !== "github") {
    return disabledTools;
  }
  const blocked = new Set<string>(GITHUB_CHAT_WRITE_TOOLS);
  return disabledTools.filter((name) => !blocked.has(name));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Intersects a profile's connector scope with an automation's scope against
 * the actual server ids/catalog ids stored in the account profile.
 */
export function intersectMcpAllowIds(
  rawServers: unknown,
  profileValue: unknown,
  automationValue: unknown,
): string[] | null {
  const normalize = (value: unknown): string[] | null => {
    if (value === null || value === undefined) {
      return null;
    }
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
  };
  const profileIds = normalize(profileValue);
  const automationIds = normalize(automationValue);
  if (profileIds === null && automationIds === null) {
    return null;
  }
  if (!Array.isArray(rawServers)) {
    return [];
  }
  const allowedBy = (ids: string[] | null, candidates: string[]): boolean =>
    ids === null || candidates.some((candidate) => ids.includes(candidate));
  return rawServers.flatMap((raw): string[] => {
    if (!isRecord(raw)) {
      return [];
    }
    const id = typeof raw.id === "string" ? raw.id : "";
    const catalogId = typeof raw.catalogId === "string" ? raw.catalogId : "";
    if (!id) {
      return [];
    }
    const candidates = [id, catalogId].filter(Boolean);
    return allowedBy(profileIds, candidates) && allowedBy(automationIds, candidates) ? [id] : [];
  });
}

/**
 * Filters the profile's MCP servers down to the ones this automation may use
 * (null allow-list = all) AND that can authenticate server-side. Auth is
 * resolved here: pasted keys follow the catalog's token placement, custom
 * headers pass through, synced browser sign-ins ride as OAuth grants, and
 * the native GitHub/Slack/Intercom connectors carry their REST credential.
 * There is no per-run server count limit — the toolset resolver bounds a run
 * by its connect budget and combined catalog size instead.
 */
export function cloudMcpServersForAutomation(
  rawServers: unknown,
  allowIds: string[] | null,
  oauthTokens: Record<string, CloudOAuthToken> = {},
): CloudMcpServer[] {
  if (!Array.isArray(rawServers)) {
    return [];
  }
  const out: CloudMcpServer[] = [];
  for (const raw of rawServers) {
    const server = eligibleCloudServer(raw, allowIds, oauthTokens);
    if (server) {
      out.push(server);
    }
  }
  return out;
}

/**
 * Honest records for connected OAuth servers a run had to leave out because
 * their grant is blocked (`reauth_required` / `step_up_required`). Without
 * these the server would simply vanish from the run — the model could not
 * say why a tool is missing, and the user would not learn what to press.
 * `blocked` maps server id → state; the wording names the fix per state.
 */
export function blockedCloudServerFailures(
  rawServers: unknown,
  blocked: ReadonlyMap<string, string>,
): Array<{ name: string; arguments: string; result: string }> {
  if (!Array.isArray(rawServers) || blocked.size === 0) {
    return [];
  }
  const out: Array<{ name: string; arguments: string; result: string }> = [];
  for (const raw of rawServers) {
    if (!isRecord(raw) || raw.enabled === false || raw.status !== "connected") {
      continue;
    }
    const id = typeof raw.id === "string" ? raw.id : "";
    const catalogId = typeof raw.catalogId === "string" && raw.catalogId ? raw.catalogId : "";
    const catalogKey = catalogId || id;
    if (!id || NATIVE_IDS.has(catalogKey) || BLOCKED_IDS.has(catalogKey)) {
      continue;
    }
    const state = blocked.get(id) ?? (catalogId ? blocked.get(catalogId) : undefined);
    if (!state) {
      continue;
    }
    const token = typeof raw.token === "string" ? raw.token.trim() : "";
    const headers = parseCloudHeaders(raw.headersJson) ?? {};
    const reliesOnOAuth =
      raw.authMode === "oauth" || ((raw.authMode === "auto" || raw.authMode === undefined) && !token && !headers.Authorization);
    if (!reliesOnOAuth) {
      continue;
    }
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : catalogKey;
    out.push({
      name: "mcp_auth",
      arguments: name,
      result:
        state === "step_up_required"
          ? `MCP server "${name}" is parked: it needs a sign-in with wider access. Open Settings → MCP and press "Sign in again with wider access"; its tools are unavailable this run.`
          : `Could not authenticate MCP server "${name}": sign-in must be renewed (Settings → MCP → Sign in); its tools are unavailable this run.`,
    });
  }
  return out;
}

function parseCloudHeaders(value: unknown): Record<string, string> | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const headers: Record<string, string> = {};
    for (const [key, item] of Object.entries(parsed)) {
      if (typeof item === "string") {
        headers[key] = item;
      }
    }
    return headers;
  } catch {
    return null;
  }
}

function oauthMatchesServer(oauth: CloudOAuthToken | undefined, url: string): oauth is CloudOAuthToken {
  if (!oauth) {
    return false;
  }
  if (!oauth.mcpUrl) {
    return true; // backwards-compatible once; all new grants are endpoint-bound
  }
  const expected = safePublicHttpsUrl(oauth.mcpUrl);
  const current = safePublicHttpsUrl(url);
  return Boolean(expected && current && expected.toString().replace(/\/$/, "") === current.toString().replace(/\/$/, ""));
}

function applyCatalogToken(
  catalogKey: string,
  token: string,
  url: string,
  headers: Record<string, string>,
): string {
  const template = TOKEN_URL_TEMPLATE[catalogKey];
  const header = TOKEN_HEADER[catalogKey];
  const queryParam = TOKEN_QUERY_PARAM[catalogKey];
  if (template) {
    return template.replace("{token}", encodeURIComponent(token));
  }
  if (header) {
    headers[header] = token;
  } else if (queryParam) {
    const parsed = new URL(url);
    parsed.searchParams.set(queryParam, token);
    return parsed.toString();
  } else {
    headers.Authorization = token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
  }
  return url;
}

function eligibleCloudServer(
  raw: unknown,
  allowIds: string[] | null,
  oauthTokens: Record<string, CloudOAuthToken>,
): CloudMcpServer | null {
  // Cloud runs honor the same verified-green contract as the browser. Idle,
  // connecting, errored, disabled, and provider-blocked rows never arm.
  if (!isRecord(raw) || raw.enabled === false || raw.status !== "connected") {
    return null;
  }
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) {
    return null;
  }
  const catalogId = typeof raw.catalogId === "string" && raw.catalogId ? raw.catalogId : "";
  const catalogKey = catalogId || id;
  if (BLOCKED_IDS.has(catalogKey)) {
    return null;
  }
  if (allowIds !== null && !allowIds.includes(id) && !(catalogId && allowIds.includes(catalogId))) {
    return null;
  }
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : catalogKey;
  const disabledTools = unlockGithubChatWrites(
    catalogKey,
    Array.isArray(raw.disabledTools)
      ? raw.disabledTools.filter((item): item is string => typeof item === "string")
      : [],
  );
  // Grants are keyed by the id that signed in. Catalog cards normally share
  // one id, but imported/legacy rows carry an instance id + catalogId, and
  // device-flow GitHub always commits under the canonical "github" id. A run
  // must find the grant through any of those keys — otherwise the health
  // check stays green while every cloud run silently loses GitHub tools.
  const oauth =
    oauthTokens[id] ??
    (catalogId && catalogId !== id ? oauthTokens[catalogId] : undefined) ??
    (catalogKey === "github" ? oauthTokens.github : undefined);

  if (NATIVE_IDS.has(catalogKey)) {
    const pasted = typeof raw.token === "string" ? raw.token.trim() : "";
    const viaOAuth = catalogKey === "github" && !pasted ? oauth : undefined;
    if (!pasted && !viaOAuth) {
      return null;
    }
    return {
      id,
      name,
      kind: catalogKey as "github" | "slack" | "intercom",
      url: "",
      headers: {},
      omitMcpHeaders: false,
      disabledTools,
      token: pasted || undefined,
      oauth: viaOAuth,
    };
  }

  let url = (typeof raw.url === "string" ? raw.url : "").trim();
  if (!safePublicHttpsUrl(url)) {
    return null;
  }
  const mode =
    raw.authMode === "none" || raw.authMode === "bearer" || raw.authMode === "headers" || raw.authMode === "oauth"
      ? raw.authMode
      : "auto";
  const token = typeof raw.token === "string" ? raw.token.trim() : "";
  let headers: Record<string, string> = {};
  let grant: CloudOAuthToken | undefined;

  if (mode === "headers" || mode === "auto") {
    const parsedHeaders = parseCloudHeaders(raw.headersJson);
    if (!parsedHeaders) {
      return null;
    }
    headers = parsedHeaders;
  }
  if (mode === "bearer") {
    if (!token) {
      return null;
    }
    url = applyCatalogToken(catalogKey, token, url, headers);
  } else if (mode === "oauth") {
    if (!oauthMatchesServer(oauth, url)) {
      return null;
    }
    grant = oauth;
  } else if (mode === "auto") {
    if (token) {
      url = applyCatalogToken(catalogKey, token, url, headers);
    } else if (!headers.Authorization && oauthMatchesServer(oauth, url)) {
      grant = oauth;
    } else if (Object.keys(headers).length === 0 && (catalogId ? !OPEN_IDS.has(catalogKey) : false)) {
      return null;
    }
  }
  // mode "none" intentionally ignores every stale key/header/grant.

  if (!safePublicHttpsUrl(url)) {
    return null;
  }
  return {
    id,
    name,
    kind: "mcp",
    url,
    headers,
    omitMcpHeaders: OMIT_HEADER_IDS.has(catalogKey),
    disabledTools,
    oauth: grant,
  };
}

/** Validates one synced grant object; null when it cannot authenticate anything. */
export function cloudOAuthToken(value: unknown): CloudOAuthToken | null {
  if (!isRecord(value) || typeof value.accessToken !== "string" || !value.accessToken) {
    return null;
  }
  return {
    accessToken: value.accessToken,
    refreshToken:
      typeof value.refreshToken === "string" && value.refreshToken ? value.refreshToken : undefined,
    expiresAt:
      typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) ? value.expiresAt : undefined,
    tokenEndpoint: typeof value.tokenEndpoint === "string" ? value.tokenEndpoint : "",
    clientId: typeof value.clientId === "string" ? value.clientId : "",
    resource: typeof value.resource === "string" && value.resource ? value.resource : undefined,
    mcpUrl: typeof value.mcpUrl === "string" && value.mcpUrl ? value.mcpUrl : undefined,
  };
}

/** Parses the profile blob's synced sign-in map (`mcpOAuth`). */
export function cloudOAuthTokens(raw: unknown): Record<string, CloudOAuthToken> {
  const out: Record<string, CloudOAuthToken> = {};
  if (!isRecord(raw)) {
    return out;
  }
  for (const [serverId, value] of Object.entries(raw)) {
    const token = cloudOAuthToken(value);
    if (token) {
      out[serverId] = token;
    }
  }
  return out;
}

/**
 * Revives one CloudMcpServer from internal shard-to-shard JSON — project
 * agents resolve their linked servers through the owner's account shard.
 * Only Streamable HTTP servers ride this path; the native connectors have
 * their own per-agent credentials.
 */
export function normalizeCloudMcpServer(raw: unknown): CloudMcpServer | null {
  if (!isRecord(raw) || raw.kind !== "mcp") {
    return null;
  }
  const id = typeof raw.id === "string" ? raw.id : "";
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!id || !safePublicHttpsUrl(url)) {
    return null;
  }
  const headers: Record<string, string> = {};
  if (isRecord(raw.headers)) {
    for (const [key, value] of Object.entries(raw.headers)) {
      if (typeof value === "string") {
        headers[key] = value;
      }
    }
  }
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    kind: "mcp",
    url,
    headers,
    omitMcpHeaders: raw.omitMcpHeaders === true,
    disabledTools: Array.isArray(raw.disabledTools)
      ? raw.disabledTools.filter((item): item is string => typeof item === "string")
      : [],
    oauth: cloudOAuthToken(raw.oauth) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Rotation chains.
//
// Providers with refresh-token rotation revoke the old pair the moment a
// refresh is redeemed. Server runs redeem tokens while the browser sleeps,
// so the account shard keeps ONE override per server: the freshest grant
// (the tip) plus the access tokens it superseded (`bases`, oldest first —
// bases[0] is the browser-synced token the chain grew from). Any copy whose
// access token appears in `bases` is merely behind on the same chain and may
// adopt the tip; a token outside the chain is a fresh sign-in that retires
// the override.

/** One server's rotation override: the freshest grant + superseded tokens. */
export type OAuthRotation = {
  serverId: string;
  /** Access tokens this chain superseded, oldest first. */
  bases: string[];
  token: CloudOAuthToken;
};

/** Longest kept chain; beyond it keep both ends (blob anchor + recent links). */
const ROTATION_CHAIN_CAP = 8;

/** Parses one stored override; accepts the legacy `{ baseAccessToken }` shape. */
export function normalizeOAuthOverride(serverId: string, value: unknown): OAuthRotation | null {
  if (!serverId || !isRecord(value)) {
    return null;
  }
  const token = cloudOAuthToken(value.token);
  if (!token) {
    return null;
  }
  const bases = Array.isArray(value.bases)
    ? value.bases.filter((item): item is string => typeof item === "string" && item.length > 0)
    : typeof value.baseAccessToken === "string" && value.baseAccessToken
      ? [value.baseAccessToken]
      : [];
  if (bases.length === 0) {
    return null;
  }
  return { serverId, bases, token };
}

/**
 * Overlays rotation overrides onto the blob-synced tokens (in place). Returns
 * the chains that applied (so this run's own refreshes extend them) and the
 * override ids that are dead: the blob caught up with the tip, the server was
 * signed out, or a fresh sign-in started a new chain.
 */
export function overlayOAuthRotations(
  tokens: Record<string, CloudOAuthToken>,
  rotations: OAuthRotation[],
): { appliedChains: Map<string, string[]>; staleIds: string[] } {
  const appliedChains = new Map<string, string[]>();
  const staleIds: string[] = [];
  for (const rotation of rotations) {
    const current = tokens[rotation.serverId];
    if (!current || current.accessToken === rotation.token.accessToken) {
      staleIds.push(rotation.serverId);
      continue;
    }
    if (rotation.bases.includes(current.accessToken)) {
      tokens[rotation.serverId] = rotation.token;
      appliedChains.set(rotation.serverId, rotation.bases);
    } else {
      staleIds.push(rotation.serverId);
    }
  }
  return { appliedChains, staleIds };
}

/**
 * The chain to persist with one refresh: the applied override's bases plus
 * the access token this refresh redeemed. Capped keeping both ends — the
 * first link anchors to the browser-synced token, the last links are what
 * recently-live copies still hold.
 */
export function chainRotationBases(
  appliedChains: Map<string, string[]>,
  rotated: RefreshedOAuth,
): string[] {
  const prior = appliedChains.get(rotated.serverId) ?? [];
  const bases = prior.includes(rotated.baseAccessToken)
    ? [...prior]
    : [...prior, rotated.baseAccessToken];
  if (bases.length <= ROTATION_CHAIN_CAP) {
    return bases;
  }
  const half = ROTATION_CHAIN_CAP / 2;
  return [...bases.slice(0, half), ...bases.slice(-half)];
}

/** Refresh this long before the recorded expiry — clock skew + run latency. */
const OAUTH_EXPIRY_SKEW_MS = 60_000;

const CLOUD_REFRESH_REUSE_MS = 2 * 60_000;
type CloudRefreshFlight = { task: Promise<CloudOAuthRefreshOutcome>; expiresAt: number };
const cloudRefreshInFlight = new Map<string, CloudRefreshFlight>();

function pruneCloudRefreshFlights(now: number): void {
  for (const [key, flight] of cloudRefreshInFlight) {
    if (flight.expiresAt <= now) {
      cloudRefreshInFlight.delete(key);
    }
  }
  if (cloudRefreshInFlight.size > 1_000) {
    for (const [key, flight] of cloudRefreshInFlight) {
      if (cloudRefreshInFlight.size <= 1_000) {
        break;
      }
      // Never evict a pending redeem: doing so would permit a duplicate use
      // of the same rotating refresh token under load.
      if (Number.isFinite(flight.expiresAt)) {
        cloudRefreshInFlight.delete(key);
      }
    }
  }
}

function refreshFlightKey(grant: CloudOAuthToken): string {
  // Exact, process-local key: never logged or persisted. Resource and MCP URL
  // are part of the OAuth grant boundary and must never share a token exchange.
  return JSON.stringify([
    grant.tokenEndpoint,
    grant.clientId,
    grant.refreshToken ?? "",
    grant.accessToken,
    grant.resource ?? "",
    grant.mcpUrl ?? "",
  ]);
}

function oauthRefreshFailure(status: number, data: Record<string, unknown> | null): CloudOAuthRefreshFailure {
  const code = typeof data?.error === "string" && data.error ? data.error : status >= 500 ? "server_error" : "request_failed";
  const rawDetail = typeof data?.error_description === "string" ? data.error_description : "";
  const detail = rawDetail ? rawDetail.slice(0, 300) : undefined;
  const transient =
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500 ||
    ["temporarily_unavailable", "server_error", "slow_down", "timeout"].includes(code);
  const explicitRetryable = ["temporarily_unavailable", "server_error", "slow_down"].includes(code);
  const ambiguous = transient && !explicitRetryable && status !== 429;
  return { ok: false, status, code, detail, transient, ambiguous };
}

async function refreshIdempotencyKey(grant: CloudOAuthToken): Promise<string> {
  const material = new TextEncoder().encode(
    [
      grant.tokenEndpoint,
      grant.clientId,
      grant.refreshToken ?? "",
      grant.accessToken,
      grant.resource ?? "",
      grant.mcpUrl ?? "",
    ].join("\u0000"),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
  return `gera-oauth-${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** One provider exchange shared by browser, interactive, and scheduled refreshes. */
async function requestCloudOAuthRefresh(grant: CloudOAuthToken): Promise<CloudOAuthRefreshOutcome> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: grant.refreshToken ?? "",
    client_id: grant.clientId,
  });
  if (grant.resource) {
    params.set("resource", grant.resource);
  }
  let response: Response;
  try {
    const idempotencyKey = await refreshIdempotencyKey(grant);
    response = await fetchPublicHttps(grant.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        // OAuth does not standardize refresh idempotency, but providers and our
        // black-box staging broker that support it can replay the same rotated
        // response after an isolate replacement instead of redeeming twice.
        "Idempotency-Key": idempotencyKey,
        "X-Gera-Refresh-Id": idempotencyKey,
      },
      body: params.toString(),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    return { ok: false, status: 502, code: "temporarily_unavailable", transient: true, ambiguous: true };
  }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    return oauthRefreshFailure(response.status, data);
  }
  if (!data || typeof data.access_token !== "string" || !data.access_token) {
    return { ok: false, status: 502, code: "invalid_response", transient: true, ambiguous: true };
  }
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : Number(data.expires_in);
  return {
    ok: true,
    token: {
      accessToken: data.access_token,
      refreshToken:
        typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : grant.refreshToken,
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1_000 : undefined,
      tokenEndpoint: grant.tokenEndpoint,
      clientId: grant.clientId,
      resource: grant.resource,
      mcpUrl: grant.mcpUrl,
    },
  };
}

/** Redeems one rotating grant; concurrent cloud and browser callers share the exchange. */
async function redeemCloudRefreshToken(
  server: CloudMcpServer,
  refreshed: RefreshedOAuth[],
  persist?: PersistRefreshedOAuth,
  begin?: BeginCloudOAuthRefresh,
): Promise<CloudOAuthRefreshOutcome> {
  const grant = server.oauth;
  if (!grant?.refreshToken || !grant.tokenEndpoint || !grant.clientId || !safePublicHttpsUrl(grant.tokenEndpoint)) {
    return { ok: false, status: 400, code: "invalid_grant", transient: false, ambiguous: false };
  }
  await begin?.(server.id, grant.accessToken);
  const key = refreshFlightKey(grant);
  const now = Date.now();
  pruneCloudRefreshFlights(now);
  let flight = cloudRefreshInFlight.get(key);
  if (!flight || flight.expiresAt <= now) {
    const task = requestCloudOAuthRefresh(grant);
    flight = { task, expiresAt: Number.POSITIVE_INFINITY };
    cloudRefreshInFlight.set(key, flight);
    void task.then((result) => {
      const current = cloudRefreshInFlight.get(key);
      if (current !== flight) {
        return;
      }
      if (result.ok) {
        current.expiresAt = Date.now() + CLOUD_REFRESH_REUSE_MS;
      } else {
        cloudRefreshInFlight.delete(key);
      }
    });
  }
  const outcome = await flight.task;
  if (!outcome.ok) {
    return outcome;
  }
  const rotation = { serverId: server.id, baseAccessToken: grant.accessToken, token: outcome.token };
  if (persist) {
    await persist(rotation);
  }
  refreshed.push(rotation);
  server.oauth = outcome.token;
  return outcome;
}

/** Refreshes and durably commits a browser grant before the response is returned. */
export function refreshCloudOAuthGrant(
  server: CloudMcpServer,
  persist: PersistRefreshedOAuth,
  begin?: BeginCloudOAuthRefresh,
): Promise<CloudOAuthRefreshOutcome> {
  return redeemCloudRefreshToken(server, [], persist, begin);
}

/** Refreshes an expiring synced grant in place; no-op while it still looks fresh. */
export async function ensureFreshCloudOAuth(
  server: CloudMcpServer,
  refreshed: RefreshedOAuth[],
  persist?: PersistRefreshedOAuth,
  begin?: BeginCloudOAuthRefresh,
): Promise<CloudOAuthRefreshOutcome | null> {
  const grant = server.oauth;
  if (!grant?.refreshToken || !grant.tokenEndpoint || !grant.clientId) {
    return null;
  }
  const expiring = grant.expiresAt !== undefined && Date.now() > grant.expiresAt - OAUTH_EXPIRY_SKEW_MS;
  if (!expiring) {
    return null;
  }
  return redeemCloudRefreshToken(server, refreshed, persist, begin);
}

/**
 * Redeems the refresh token regardless of the recorded expiry. Used after an
 * auth-rejected connect: providers that omit expires_in or revoke access
 * tokens early still repair without a new sign-in — mirrors the browser's
 * 401 replay.
 */
export function forceRefreshCloudOAuthOutcome(
  server: CloudMcpServer,
  refreshed: RefreshedOAuth[],
  persist?: PersistRefreshedOAuth,
  begin?: BeginCloudOAuthRefresh,
): Promise<CloudOAuthRefreshOutcome> {
  return redeemCloudRefreshToken(server, refreshed, persist, begin);
}

export async function forceRefreshCloudOAuth(
  server: CloudMcpServer,
  refreshed: RefreshedOAuth[],
  persist?: PersistRefreshedOAuth,
  begin?: BeginCloudOAuthRefresh,
): Promise<boolean> {
  return (await forceRefreshCloudOAuthOutcome(server, refreshed, persist, begin)).ok;
}

type JsonRpcResponse = JsonRpcMessage;

/**
 * Streamable HTTP may emit progress/log notifications before the response.
 * Read every SSE event and select the response for this request id instead of
 * accidentally treating the first notification as an empty tool result.
 * (Kept as a thin wrapper over the protocol core for existing callers/tests.)
 */
export function parseCloudMcpRpcResponse(text: string, expectedId: number): JsonRpcResponse {
  const selected = selectRpcResponse(parseJsonRpcPayload(text), expectedId);
  if (!selected) {
    throw new Error(`no JSON-RPC response for request ${expectedId}`);
  }
  return selected;
}

/** One JSON-RPC request on a live session (timeouts are idle timeouts — handlers may pause them). */
async function rpc(session: CloudMcpSession, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  return mcpRequest(session, method, params, timeoutMs);
}

/** Default page budget for one tools/list walk; deferred loading raises it. */
const DEFAULT_MAX_TOOLS = 500;
/** Prompts and resources listed during an inventory handshake (bounded, cached). */
const MAX_INVENTORY_PROMPTS = 200;
const MAX_INVENTORY_RESOURCES = 300;
const MAX_INVENTORY_TEMPLATES = 100;

export type ConnectCloudMcpOptions = {
  /** Stop listing after this many tools (default 500). */
  maxTools?: number;
  /** Keep tools the user disabled — catalog caches store the full remote table. */
  includeDisabled?: boolean;
  /** Also list prompts, resources and resource templates (capability-gated). */
  inventory?: boolean;
  /** Injected transport (conformance tests); production keeps the public-HTTPS guard. */
  fetch?: McpFetch;
  /** Answers server → client requests (elicitation/create, roots/list…) on any stream. */
  onServerRequest?: (request: McpServerRequest) => Promise<McpServerRequestReply>;
  /** Receives notifications (list_changed, progress, logging) on any stream. */
  onNotification?: (notification: McpNotification) => void;
  /**
   * Per-request credential source (mcp-credentials.ts). When set, the session
   * carries no credential strings: headers and redactions are leased per
   * request and dropped, and `server.headers` / `server.oauth` are ignored.
   */
  lease?: McpCredentialLease;
  /** Negotiation cached by an earlier run (with the tool catalog) — skips the `server/discover` probe. */
  wireHint?: McpWireInfo;
};

export type CloudMcpConnection = {
  session: CloudMcpSession;
  tools: CloudMcpTool[];
  prompts: McpPromptInfo[];
  resources: McpResourceInfo[];
  resourceTemplates: McpResourceTemplateInfo[];
  /** The wire the handshake settled on (cached with the catalog). */
  wire?: McpWireInfo;
};

/** Turns one raw `tools/list` entry into the redacted catalog shape; null when unusable. */
export function normalizeCloudMcpTool(raw: Record<string, unknown>, redactions: string[]): CloudMcpTool | null {
  const name = typeof raw.name === "string" ? raw.name : "";
  if (!name || redactCloudMcpText(name, redactions) !== name) {
    return null;
  }
  const rawDescription = typeof raw.description === "string" && raw.description ? raw.description : name;
  const inputSchema = isRecord(raw.inputSchema) ? raw.inputSchema : { type: "object", properties: {} };
  const annotations = normalizeToolAnnotations(raw.annotations);
  const title =
    typeof raw.title === "string" && raw.title.trim()
      ? redactCloudMcpText(raw.title.trim().slice(0, 200), redactions)
      : annotations?.title;
  const uiOnly = isUiOnlyTool(raw);
  return {
    name,
    description: redactCloudMcpText(rawDescription, redactions),
    inputSchema: redactCloudMcpValue(inputSchema, redactions) as Record<string, unknown>,
    ...(title ? { title } : {}),
    ...(annotations ? { annotations } : {}),
    ...(uiOnly ? { uiOnly: true } : {}),
  };
}

/** Lists tools on a live session (used by the first handshake and by list_changed refreshes). */
export async function listCloudMcpTools(
  session: CloudMcpSession,
  server: Pick<CloudMcpServer, "disabledTools">,
  options: { maxTools?: number; includeDisabled?: boolean } = {},
): Promise<CloudMcpTool[]> {
  const maxTools = Math.max(1, Math.floor(options.maxTools ?? DEFAULT_MAX_TOOLS));
  const rawTools = await mcpListAll(session, "tools/list", "tools", {
    maxItems: maxTools,
    maxPages: 20,
    timeoutMs: CONNECT_TIMEOUT_MS,
  });
  const redactions = session.redactions ?? [];
  const tools: CloudMcpTool[] = [];
  for (const raw of rawTools) {
    const tool = normalizeCloudMcpTool(raw, redactions);
    if (!tool || (!options.includeDisabled && server.disabledTools.includes(tool.name))) {
      continue;
    }
    tools.push(tool);
  }
  return tools;
}

/** Lists prompts, resources and templates the server's capabilities advertise. */
export async function listCloudMcpInventory(
  session: CloudMcpSession,
): Promise<Pick<CloudMcpConnection, "prompts" | "resources" | "resourceTemplates">> {
  const redactions = session.redactions ?? [];
  const clean = <T>(value: T): T => redactCloudMcpValue(value, redactions) as T;
  const prompts: McpPromptInfo[] = [];
  const resources: McpResourceInfo[] = [];
  const resourceTemplates: McpResourceTemplateInfo[] = [];
  if (session.capabilities?.prompts) {
    for (const raw of await mcpListAll(session, "prompts/list", "prompts", { maxItems: MAX_INVENTORY_PROMPTS, timeoutMs: CONNECT_TIMEOUT_MS })) {
      const prompt = normalizePromptInfo(raw);
      if (prompt) prompts.push(clean(prompt));
    }
  }
  if (session.capabilities?.resources) {
    for (const raw of await mcpListAll(session, "resources/list", "resources", { maxItems: MAX_INVENTORY_RESOURCES, timeoutMs: CONNECT_TIMEOUT_MS })) {
      const resource = normalizeResourceInfo(raw);
      if (resource) resources.push(clean(resource));
    }
    try {
      for (const raw of await mcpListAll(session, "resources/templates/list", "resourceTemplates", { maxItems: MAX_INVENTORY_TEMPLATES, timeoutMs: CONNECT_TIMEOUT_MS })) {
        const template = normalizeResourceTemplateInfo(raw);
        if (template) resourceTemplates.push(clean(template));
      }
    } catch {
      // Templates are optional; a server advertising resources may still reject the method.
    }
  }
  return { prompts, resources, resourceTemplates };
}

/** A cached "modern" hint that turned out wrong: the server no longer knows the stateless methods. */
function staleModernHint(error: unknown): boolean {
  return (
    error instanceof McpRpcError &&
    (error.rpcCode === -32601 || error.httpStatus === 404 || error.httpStatus === 405)
  );
}

/**
 * Negotiates the wire (`server/discover`, else initialize → initialized) and
 * lists tools (+ optional inventory); returns a live session + its tables.
 * A cached wire hint skips the probe; if the hint proves stale the handshake
 * is redone once with a fresh probe.
 */
export async function connectCloudMcp(
  server: CloudMcpServer,
  options: ConnectCloudMcpOptions = {},
): Promise<CloudMcpConnection> {
  const headers: Record<string, string> = options.lease ? {} : { ...server.headers };
  if (!options.lease && server.oauth && !headers.Authorization) {
    headers.Authorization = `Bearer ${server.oauth.accessToken}`;
  }
  const newSession = (): CloudMcpSession => ({
    url: server.url,
    headers,
    omitMcpHeaders: server.omitMcpHeaders,
    protocolVersion: MCP_DEFAULT_PROTOCOL_VERSION,
    nextId: 0,
    redactions: options.lease ? [] : serverCredentialValues(server),
    ...(options.lease ? { lease: options.lease } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.onServerRequest ? { onServerRequest: options.onServerRequest } : {}),
    ...(options.onNotification ? { onNotification: options.onNotification } : {}),
  });
  const handshake = async (wireHint: McpWireInfo | undefined): Promise<CloudMcpConnection> => {
    const session = newSession();
    await mcpConnect(session, {
      clientInfo: { name: "Gera AI cloud runs", version: "1.0.0" },
      timeoutMs: CONNECT_TIMEOUT_MS,
      discoverTimeoutMs: DISCOVER_TIMEOUT_MS,
      ...(wireHint ? { wireHint } : {}),
    });
    const tools = await listCloudMcpTools(session, server, {
      maxTools: options.maxTools,
      includeDisabled: options.includeDisabled,
    });
    const inventory = options.inventory
      ? await listCloudMcpInventory(session)
      : { prompts: [], resources: [], resourceTemplates: [] };
    const wire = sessionWireInfo(session);
    return { session, tools, ...inventory, ...(wire ? { wire } : {}) };
  };
  if (options.wireHint?.era === "modern") {
    try {
      return await handshake(options.wireHint);
    } catch (error) {
      if (!staleModernHint(error)) {
        throw error;
      }
    }
    return handshake(undefined);
  }
  return handshake(options.wireHint);
}

const MAX_RESOURCE_LINK_READS = 4;

/** Flattens text, embedded resources, and structured MCP results for the model. */
export function stringifyCloudMcpResult(result: unknown): string {
  return stringifyMcpToolResult(result);
}

/**
 * Runs one tool and resolves resource links through the same authenticated MCP
 * session, so file-oriented servers deliver actual contents rather than only
 * a project tree or opaque URI.
 */
const MAX_MCP_RENDER_CHARS = 300_000;

export async function callCloudMcpTool(
  session: CloudMcpSession,
  name: string,
  args: unknown,
): Promise<string> {
  return (await callCloudMcpToolRich(session, name, args)).text;
}

/** A tool result with its binary parts kept: text for the model plus bounded images / files. */
export type CloudMcpToolResult = { text: string; media: McpResultMedia };

/**
 * Same as callCloudMcpTool, but keeps the result's images (up to 5 / 4 MB) and
 * audio/blob parts (up to 4 MB each) as data URLs; whatever exceeds a cap is
 * described in the text instead.
 */
export async function callCloudMcpToolRich(
  session: CloudMcpSession,
  name: string,
  args: unknown,
): Promise<CloudMcpToolResult> {
  // The stateless revision may answer with `input_required`; the input rounds
  // ride the session's server-request handler (interactive: card; background: decline).
  const result = await mcpRequestWithInput(session, "tools/call", { name, arguments: args ?? {} }, CALL_TIMEOUT_MS);
  const redactions = session.redactions ?? [];
  const rendered = redactCloudMcpText(stringifyCloudMcpResult(result), redactions);
  if (isRecord(result) && result.isError === true) {
    throw new Error(rendered || "MCP tool reported an error.");
  }
  const media = extractMcpResultMedia(result);
  const pieces = [rendered, ...media.omitted.map((note) => `[${note}]`)];
  for (const uri of mcpResourceLinks(result, MAX_RESOURCE_LINK_READS)) {
    try {
      const resource = await mcpRequestWithInput(session, "resources/read", { uri }, CALL_TIMEOUT_MS);
      const text = redactCloudMcpText(stringifyMcpResourceRead(resource), redactions);
      if (text) {
        pieces.push(text);
      }
    } catch (error) {
      pieces.push(redactCloudMcpText(
        `[Could not read resource ${uri}: ${error instanceof Error ? error.message : "unknown error"}]`,
        redactions,
      ));
    }
  }
  const output = redactCloudMcpText(pieces.filter((piece) => piece.length > 0).join("\n\n"), redactions);
  return {
    text: output.length > MAX_MCP_RENDER_CHARS
      ? `${output.slice(0, MAX_MCP_RENDER_CHARS)}\n… [MCP result truncated]`
      : output,
    media,
  };
}

/** Text cap for one resource read handed to the composer as an attachment. */
export const RESOURCE_TEXT_CHARS = 300_000;
/** Base64 cap for one binary resource handed to the composer (4 MB of bytes). */
export const RESOURCE_BLOB_BASE64_CHARS = Math.ceil((4 * 1024 * 1024) / 3) * 4;

export type CloudMcpResourceContent = {
  uri: string;
  mimeType?: string;
  /** Text content, capped at RESOURCE_TEXT_CHARS with `truncated` set. */
  text?: string;
  truncated?: boolean;
  /** Base64 bytes when the blob fits the 4 MB cap. */
  blob?: string;
  /** Set when a binary body was too large to ship; `size` is the byte estimate. */
  omitted?: boolean;
  size?: number;
};

/** `resources/read` for the composer's @-mentions: text capped honestly, blobs bounded. */
export async function readCloudMcpResource(session: CloudMcpSession, uri: string): Promise<CloudMcpResourceContent[]> {
  const result = await mcpRequestWithInput(session, "resources/read", { uri }, CALL_TIMEOUT_MS);
  const redactions = session.redactions ?? [];
  if (!isRecord(result) || !Array.isArray(result.contents)) {
    throw new Error("resources/read returned no contents");
  }
  const out: CloudMcpResourceContent[] = [];
  for (const raw of result.contents.slice(0, 8)) {
    if (!isRecord(raw)) {
      continue;
    }
    const entry: CloudMcpResourceContent = {
      uri: typeof raw.uri === "string" ? redactCloudMcpText(raw.uri, redactions) : uri,
      ...(typeof raw.mimeType === "string" && raw.mimeType ? { mimeType: raw.mimeType.slice(0, 200) } : {}),
    };
    if (typeof raw.text === "string") {
      const text = redactCloudMcpText(raw.text, redactions);
      if (text.length > RESOURCE_TEXT_CHARS) {
        entry.text = text.slice(0, RESOURCE_TEXT_CHARS);
        entry.truncated = true;
      } else {
        entry.text = text;
      }
    } else if (typeof raw.blob === "string") {
      const size = Math.floor((raw.blob.length * 3) / 4);
      if (raw.blob.length > RESOURCE_BLOB_BASE64_CHARS) {
        entry.omitted = true;
        entry.size = size;
      } else {
        entry.blob = raw.blob;
        entry.size = size;
      }
    }
    out.push(entry);
  }
  return out;
}

export type CloudMcpPromptMessage = {
  role: "user" | "assistant";
  /** Flattened text (embedded resources included, media described). */
  text: string;
  /** Inline image when the part was an image small enough to ship. */
  image?: { data: string; mimeType: string };
};

export type CloudMcpPromptResult = {
  description?: string;
  messages: CloudMcpPromptMessage[];
};

/** `prompts/get` for the composer's slash menu: messages flattened per role. */
export async function getCloudMcpPrompt(
  session: CloudMcpSession,
  name: string,
  args: Record<string, string>,
): Promise<CloudMcpPromptResult> {
  const result = await mcpRequestWithInput(session, "prompts/get", { name, arguments: args }, CALL_TIMEOUT_MS);
  const redactions = session.redactions ?? [];
  if (!isRecord(result) || !Array.isArray(result.messages)) {
    throw new Error("prompts/get returned no messages");
  }
  const messages: CloudMcpPromptMessage[] = [];
  for (const raw of result.messages.slice(0, 40)) {
    if (!isRecord(raw)) {
      continue;
    }
    const role = raw.role === "assistant" ? "assistant" : "user";
    const content = raw.content;
    const image =
      isRecord(content) &&
      content.type === "image" &&
      typeof content.data === "string" &&
      content.data.length <= RESOURCE_BLOB_BASE64_CHARS
        ? { data: content.data, mimeType: typeof content.mimeType === "string" && content.mimeType ? content.mimeType : "image/png" }
        : undefined;
    const text = image ? "" : redactCloudMcpText(stringifyMcpPromptContent(content), redactions);
    messages.push({ role, text: text.length > RESOURCE_TEXT_CHARS ? `${text.slice(0, RESOURCE_TEXT_CHARS)}\n… [truncated]` : text, ...(image ? { image } : {}) });
  }
  return {
    ...(typeof result.description === "string" && result.description
      ? { description: redactCloudMcpText(result.description.slice(0, 2_000), redactions) }
      : {}),
    messages,
  };
}

/** Collision-resistant mirror of the browser's MCP function namespace. */
export function cloudMcpFunctionName(serverId: string, toolName: string): string {
  const safe = (value: string, fallback: string): string =>
    value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || fallback;
  const serverPart = safe(serverId, "server");
  const toolPart = safe(toolName, "tool");
  const base = `mcp_${serverPart}_${toolPart}`;
  const normalizedChanged =
    serverPart !== serverId.toLowerCase() ||
    toolPart !== toolName.toLowerCase() ||
    serverId !== serverId.toLowerCase() ||
    toolName !== toolName.toLowerCase();
  if (!normalizedChanged && base.length <= 64) {
    return base;
  }
  const material = `${serverId}\u0000${toolName}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  const suffix = (hash >>> 0).toString(36).slice(0, 7);
  return `${base.slice(0, 63 - suffix.length)}_${suffix}`;
}
