// Cloud-side MCP for scheduled automation runs: decides which of the
// profile's connected servers can fire without the browser, and speaks the
// MCP Streamable HTTP protocol (initialize → tools/list → tools/call)
// directly from the Worker — no CORS constraints here, so no relay hop.
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
};

/** A grant rotated server-side; the account shard persists it for later runs. */
export type RefreshedOAuth = {
  serverId: string;
  /** The synced access token this refresh was based on — stale-detection anchor. */
  baseAccessToken: string;
  token: CloudOAuthToken;
};

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
};

export type CloudMcpSession = {
  url: string;
  headers: Record<string, string>;
  omitMcpHeaders: boolean;
  sessionId?: string;
  nextId: number;
};

const MCP_PROTOCOL_VERSION = "2025-06-18";
const CONNECT_TIMEOUT_MS = 12_000;
const CALL_TIMEOUT_MS = 40_000;
const MAX_SERVERS_PER_RUN = 8;

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
]);
/** Catalog token-placement quirks (mirrors the web client's buildAuth). */
const TOKEN_QUERY_PARAM: Record<string, string> = { exa: "exaApiKey" };
const TOKEN_URL_TEMPLATE: Record<string, string> = {
  firecrawl: "https://mcp.firecrawl.dev/{token}/v2/mcp",
};
const OMIT_HEADER_IDS = new Set(["gmail"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Filters the profile's MCP servers down to the ones this automation may use
 * (null allow-list = all) AND that can authenticate server-side. Auth is
 * resolved here: pasted keys follow the catalog's token placement, custom
 * headers pass through, synced browser sign-ins ride as OAuth grants, and
 * the native GitHub/Slack/Intercom connectors carry their REST credential.
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
    if (out.length >= MAX_SERVERS_PER_RUN) {
      break;
    }
    const server = eligibleCloudServer(raw, allowIds, oauthTokens);
    if (server) {
      out.push(server);
    }
  }
  return out;
}

function eligibleCloudServer(
  raw: unknown,
  allowIds: string[] | null,
  oauthTokens: Record<string, CloudOAuthToken>,
): CloudMcpServer | null {
  if (!isRecord(raw) || raw.enabled === false) {
    return null;
  }
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) {
    return null;
  }
  const catalogId = typeof raw.catalogId === "string" && raw.catalogId ? raw.catalogId : "";
  const catalogKey = catalogId || id;
  if (allowIds !== null && !allowIds.includes(id) && !(catalogId && allowIds.includes(catalogId))) {
    return null;
  }
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : catalogKey;
  const disabledTools = Array.isArray(raw.disabledTools)
    ? raw.disabledTools.filter((item): item is string => typeof item === "string")
    : [];
  const oauth = oauthTokens[id];

  // Native GitHub/Slack/Intercom: REST connectors, not MCP endpoints. A
  // pasted token wins (mirrors the browser); GitHub also accepts the synced
  // device-flow sign-in. No credential — honestly not eligible.
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
  if (!/^https:\/\//i.test(url)) {
    return null;
  }

  const headers: Record<string, string> = {};
  const headersJson = typeof raw.headersJson === "string" ? raw.headersJson.trim() : "";
  if (headersJson && raw.authMode !== "bearer") {
    try {
      const parsed = JSON.parse(headersJson) as unknown;
      if (isRecord(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") {
            headers[key] = value;
          }
        }
      }
    } catch {
      // malformed custom headers — ignore them, a pasted key may still work
    }
  }

  // Explicit "sign in" mode: only the synced browser grant authenticates.
  if (raw.authMode === "oauth") {
    if (!oauth) {
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
      oauth,
    };
  }

  const token = raw.authMode === "headers" ? "" : (typeof raw.token === "string" ? raw.token : "").trim();
  if (token) {
    const template = TOKEN_URL_TEMPLATE[catalogKey];
    const queryParam = TOKEN_QUERY_PARAM[catalogKey];
    if (template) {
      url = template.replace("{token}", encodeURIComponent(token));
    } else if (queryParam) {
      url = `${url}${url.includes("?") ? "&" : "?"}${queryParam}=${encodeURIComponent(token)}`;
    } else if (!headers.Authorization) {
      headers.Authorization = token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
    }
  }

  let grant: CloudOAuthToken | undefined;
  if (!token && Object.keys(headers).length === 0) {
    if (oauth) {
      // Signed-in server — the synced grant authenticates this run.
      grant = oauth;
    } else if (catalogId ? !OPEN_IDS.has(catalogKey) : raw.authMode === "bearer") {
      // Keyless: open catalog servers work; key-required ones would just 401
      // on every scheduled fire. Custom endpoints get the benefit of the
      // doubt unless they are explicitly set to bearer auth.
      return null;
    }
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
  if (!id || !/^https:\/\//i.test(url)) {
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

/**
 * Redeems the grant's refresh token now (single attempt). Rotated tokens are
 * reported through `refreshed` so the account shard can persist them — with
 * refresh-token rotation the old pair dies at the provider, so losing the
 * new one would strand every later run AND the browser's synced copy.
 * Failures keep the old token: a real auth problem then surfaces as an
 * honest connect error.
 */
async function redeemCloudRefreshToken(
  server: CloudMcpServer,
  refreshed: RefreshedOAuth[],
): Promise<boolean> {
  const grant = server.oauth;
  if (!grant?.refreshToken || !grant.tokenEndpoint || !grant.clientId) {
    return false;
  }
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: grant.refreshToken,
    client_id: grant.clientId,
  });
  if (grant.resource) {
    params.set("resource", grant.resource);
  }
  const response = await fetch(grant.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: params.toString(),
    signal: AbortSignal.timeout(12_000),
  });
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !data || typeof data.access_token !== "string" || !data.access_token) {
    return false;
  }
  const next: CloudOAuthToken = {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : grant.refreshToken,
    expiresAt:
      typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
        ? Date.now() + data.expires_in * 1_000
        : undefined,
    tokenEndpoint: grant.tokenEndpoint,
    clientId: grant.clientId,
    resource: grant.resource,
  };
  refreshed.push({ serverId: server.id, baseAccessToken: grant.accessToken, token: next });
  server.oauth = next;
  return true;
}

/** Refreshes an expiring synced grant in place; no-op while it still looks fresh. */
export async function ensureFreshCloudOAuth(
  server: CloudMcpServer,
  refreshed: RefreshedOAuth[],
): Promise<void> {
  const grant = server.oauth;
  if (!grant?.refreshToken || !grant.tokenEndpoint || !grant.clientId) {
    return;
  }
  const expiring = grant.expiresAt !== undefined && Date.now() > grant.expiresAt - OAUTH_EXPIRY_SKEW_MS;
  if (!expiring) {
    return;
  }
  await redeemCloudRefreshToken(server, refreshed);
}

/**
 * Redeems the refresh token regardless of the recorded expiry. Used after an
 * auth-rejected connect: providers that omit expires_in or revoke access
 * tokens early still repair without a new sign-in — mirrors the browser's
 * 401 replay.
 */
export async function forceRefreshCloudOAuth(
  server: CloudMcpServer,
  refreshed: RefreshedOAuth[],
): Promise<boolean> {
  return redeemCloudRefreshToken(server, refreshed);
}

type JsonRpcResponse = {
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
};

function protocolHeaders(session: CloudMcpSession): Record<string, string> {
  if (session.omitMcpHeaders) {
    return {};
  }
  return {
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    ...(session.sessionId ? { "Mcp-Session-Id": session.sessionId } : {}),
  };
}

function jsonRpcMessages(payload: string): JsonRpcResponse[] {
  const parsed = JSON.parse(payload) as unknown;
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.filter(isRecord).map((value) => value as JsonRpcResponse);
}

/**
 * Streamable HTTP may emit progress/log notifications before the response.
 * Read every SSE event and select the response for this request id instead of
 * accidentally treating the first notification as an empty tool result.
 */
export function parseCloudMcpRpcResponse(text: string, expectedId: number): JsonRpcResponse {
  const trimmed = text.trim();
  let messages: JsonRpcResponse[] = [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    messages = jsonRpcMessages(trimmed);
  } else {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const payload = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!payload || payload === "[DONE]") {
        continue;
      }
      messages.push(...jsonRpcMessages(payload));
    }
  }
  const responses = messages.filter((message) => "result" in message || "error" in message);
  const exact = responses.find((message) => String(message.id) === String(expectedId));
  if (exact) {
    return exact;
  }
  // Keep compatibility with a few non-conforming stateless servers that omit
  // an id, but never accept a mismatched id from another request.
  if (responses.length === 1 && responses[0].id === undefined) {
    return responses[0];
  }
  throw new Error(`no JSON-RPC response for request ${expectedId}`);
}

async function rpc(
  session: CloudMcpSession,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  session.nextId += 1;
  const requestId = session.nextId;
  const response = await fetch(session.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...protocolHeaders(session),
      ...session.headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params: params ?? {} }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const sessionHeader = response.headers.get("mcp-session-id");
  if (sessionHeader) {
    session.sessionId = sessionHeader;
  }
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `auth rejected (${response.status}) — the synced sign-in or key was refused; open Gera and reconnect this server so a fresh credential syncs`,
      );
    }
    throw new Error(`HTTP ${response.status}`);
  }
  let parsed: JsonRpcResponse;
  try {
    parsed = parseCloudMcpRpcResponse(text, requestId);
  } catch {
    throw new Error("unexpected response shape");
  }
  if (parsed.error) {
    throw new Error(parsed.error.message || "MCP request failed");
  }
  return parsed.result;
}

/** initialize → initialized → tools/list; returns a live session + its tools. */
export async function connectCloudMcp(
  server: CloudMcpServer,
): Promise<{ session: CloudMcpSession; tools: CloudMcpTool[] }> {
  const headers: Record<string, string> = { ...server.headers };
  if (server.oauth && !headers.Authorization) {
    headers.Authorization = `Bearer ${server.oauth.accessToken}`;
  }
  const session: CloudMcpSession = {
    url: server.url,
    headers,
    omitMcpHeaders: server.omitMcpHeaders,
    nextId: 0,
  };
  await rpc(
    session,
    "initialize",
    {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: "Gera AI cloud runs", version: "1.0.0" },
    },
    CONNECT_TIMEOUT_MS,
  );
  try {
    await fetch(session.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...protocolHeaders(session),
        ...session.headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: AbortSignal.timeout(6_000),
    });
  } catch {
    // the initialized notification is best-effort
  }
  const listed = (await rpc(session, "tools/list", {}, CONNECT_TIMEOUT_MS)) as {
    tools?: Array<Record<string, unknown>>;
  } | null;
  const tools: CloudMcpTool[] = [];
  for (const raw of listed?.tools ?? []) {
    const name = typeof raw.name === "string" ? raw.name : "";
    if (!name || server.disabledTools.includes(name)) {
      continue;
    }
    tools.push({
      name,
      description: typeof raw.description === "string" && raw.description ? raw.description : name,
      inputSchema: isRecord(raw.inputSchema) ? raw.inputSchema : { type: "object", properties: {} },
    });
  }
  return { session, tools };
}

const MAX_RESOURCE_LINK_READS = 4;

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function resourceHeading(resource: Record<string, unknown>): string {
  const uri = typeof resource.uri === "string" ? resource.uri : "resource";
  const mime = typeof resource.mimeType === "string" && resource.mimeType ? ` · ${resource.mimeType}` : "";
  return `[Resource ${uri}${mime}]`;
}

function stringifyResource(resource: Record<string, unknown>): string {
  const heading = resourceHeading(resource);
  if (typeof resource.text === "string") {
    return `${heading}\n${resource.text}`;
  }
  if (typeof resource.blob === "string") {
    return `${heading}\n[Binary data omitted · ${resource.blob.length} base64 chars]`;
  }
  return heading;
}

function stringifyContentPart(part: unknown): string {
  if (!isRecord(part)) {
    return jsonText(part);
  }
  if (typeof part.text === "string") {
    return part.text;
  }
  if (part.type === "resource" && isRecord(part.resource)) {
    return stringifyResource(part.resource);
  }
  if (part.type === "resource_link" && typeof part.uri === "string") {
    const label = typeof part.name === "string" && part.name ? `${part.name} · ` : "";
    return `[Resource link ${label}${part.uri}]`;
  }
  if ((part.type === "image" || part.type === "audio") && typeof part.data === "string") {
    const mime = typeof part.mimeType === "string" && part.mimeType ? ` · ${part.mimeType}` : "";
    return `[${part.type} content omitted${mime} · ${part.data.length} base64 chars]`;
  }
  return jsonText(part);
}

/** Flattens text, embedded resources, and structured MCP results for the model. */
export function stringifyCloudMcpResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (!isRecord(result)) {
    return jsonText(result);
  }
  const pieces = Array.isArray(result.content)
    ? result.content.map(stringifyContentPart).filter((part) => part.length > 0)
    : [];
  if (pieces.length === 0 && result.structuredContent !== undefined) {
    pieces.push(jsonText(result.structuredContent));
  }
  const text = pieces.join("\n");
  return result.isError === true ? `Tool reported an error${text ? `:\n${text}` : "."}` : text;
}

function resourceLinks(result: unknown): string[] {
  if (!isRecord(result) || result.isError === true || !Array.isArray(result.content)) {
    return [];
  }
  const links: string[] = [];
  for (const part of result.content) {
    if (isRecord(part) && part.type === "resource_link" && typeof part.uri === "string" && part.uri) {
      if (!links.includes(part.uri)) {
        links.push(part.uri);
      }
    }
  }
  return links.slice(0, MAX_RESOURCE_LINK_READS);
}

function stringifyResourceReadResult(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.contents)) {
    return jsonText(result);
  }
  return result.contents
    .map((content) => (isRecord(content) ? stringifyResource(content) : jsonText(content)))
    .filter((content) => content.length > 0)
    .join("\n");
}

/**
 * Runs one tool and resolves resource links through the same authenticated MCP
 * session, so file-oriented servers deliver actual contents rather than only
 * a project tree or opaque URI.
 */
export async function callCloudMcpTool(
  session: CloudMcpSession,
  name: string,
  args: unknown,
): Promise<string> {
  const result = await rpc(session, "tools/call", { name, arguments: args ?? {} }, CALL_TIMEOUT_MS);
  const pieces = [stringifyCloudMcpResult(result)];
  for (const uri of resourceLinks(result)) {
    try {
      const resource = await rpc(session, "resources/read", { uri }, CALL_TIMEOUT_MS);
      const text = stringifyResourceReadResult(resource);
      if (text) {
        pieces.push(text);
      }
    } catch (error) {
      pieces.push(`[Could not read resource ${uri}: ${error instanceof Error ? error.message : "unknown error"}]`);
    }
  }
  return pieces.filter((piece) => piece.length > 0).join("\n\n");
}

/** Mirrors the web client's namespacing: mcp_<serverId sans dashes>_<safe tool>. */
export function cloudMcpFunctionName(serverId: string, toolName: string): string {
  const safe = toolName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "tool";
  return `mcp_${serverId.replace(/-/g, "")}_${safe}`.slice(0, 64);
}
