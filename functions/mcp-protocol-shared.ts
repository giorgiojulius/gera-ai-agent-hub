/** Protocol data and errors shared by the transport and wire policies; no runtime dependency on either. */
export type McpFetch = (url: string, init: RequestInit) => Promise<Response>;
export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";
export const MCP_MODERN_PROTOCOL_VERSIONS: readonly string[] = [MCP_MODERN_PROTOCOL_VERSION];
export const MCP_LATEST_PROTOCOL_VERSION = "2025-11-25";
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const MCP_DEFAULT_PROTOCOL_VERSION = "2025-06-18";
export type McpWireEra = "modern" | "legacy";
/** Non-secret negotiation, suitable for the account catalog. Never contains a session id. */
export type McpWireInfo = {
  era: McpWireEra;
  protocolVersion: string;
  capabilities?: McpServerCapabilities;
  serverInfo?: McpServerInfo;
};
export const MCP_META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const MCP_META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const MCP_META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const MCP_META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
export const MCP_META_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
export const MCP_META_LOG_LEVEL = "io.modelcontextprotocol/logLevel";
export type McpLogLevel = "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency";
export const MCP_ERROR_HEADER_MISMATCH = -32020;
export const MCP_ERROR_MISSING_CLIENT_CAPABILITY = -32021;
export const MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION = -32022;
export const MCP_MAX_INPUT_ROUNDS = 3;
export const MCP_MAX_RESPONSE_CHARS = 2_000_000;
export type JsonRpcId = number | string;
export type JsonRpcError = { code?: number; message?: string; data?: unknown };
export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
};
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;
/** Narrows untrusted JSON to an object, excluding arrays. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export type McpServerCapabilities = {
  tools?: { listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  logging?: Record<string, unknown>;
  completions?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
};
export type McpServerInfo = { name?: string; title?: string; version?: string };
/** Reads only recognized capability fields. */
export function normalizeServerCapabilities(value: unknown): McpServerCapabilities {
  if (!isRecord(value)) return {};
  const flag = (record: unknown, key: string): boolean | undefined =>
    isRecord(record) && typeof record[key] === "boolean" ? (record[key] as boolean) : undefined;
  const out: McpServerCapabilities = {};
  if (isRecord(value.tools)) out.tools = { listChanged: flag(value.tools, "listChanged") };
  if (isRecord(value.prompts)) out.prompts = { listChanged: flag(value.prompts, "listChanged") };
  if (isRecord(value.resources)) out.resources = { subscribe: flag(value.resources, "subscribe"), listChanged: flag(value.resources, "listChanged") };
  if (isRecord(value.logging)) out.logging = value.logging;
  if (isRecord(value.completions)) out.completions = value.completions;
  if (isRecord(value.experimental)) out.experimental = value.experimental;
  return out;
}
export type McpServerRequestReply = { result: unknown } | { error: { code: number; message: string } };
export type McpServerRequest = { id: JsonRpcId; method: string; params: unknown };
export type McpNotification = { method: string; params: unknown };
/** Credential material held for one HTTP request and redacted before returning its result. */
export type McpLeasedCredential = { url?: string; headers: Record<string, string>; redactions: string[] };
export type McpCredentialLease = () => Promise<McpLeasedCredential>;
/** Mutable, run-local protocol state. A lease keeps provider credentials off the session. */
export type McpProtocolSession = {
  url: string;
  headers: Record<string, string>;
  lease?: McpCredentialLease;
  /** Cancellation for the connection operation or the lifetime of its owning run. */
  signal?: AbortSignal;
  omitMcpHeaders: boolean;
  protocolVersion?: string;
  sessionId?: string;
  nextId: number;
  redactions?: string[];
  fetch?: McpFetch;
  initialized?: boolean;
  wire?: McpWireEra;
  clientInfo?: { name: string; version: string; title?: string };
  clientCapabilities?: Record<string, unknown>;
  logLevel?: McpLogLevel;
  capabilities?: McpServerCapabilities;
  serverInfo?: McpServerInfo;
  instructions?: string;
  onServerRequest?: (request: McpServerRequest) => Promise<McpServerRequestReply>;
  onNotification?: (notification: McpNotification) => void;
};
/** A genuine provider credential rejection; never a protocol fallback signal. */
export class McpAuthRejectedError extends Error {
  readonly status: number;
  readonly wwwAuthenticate: string | null;
  constructor(status: number, wwwAuthenticate: string | null) {
    super(`auth rejected (${status}) — the synced sign-in or key was refused; open Gera and reconnect this server so a fresh credential syncs`);
    this.name = "McpAuthRejectedError";
    this.status = status;
    this.wwwAuthenticate = wwwAuthenticate;
  }
}
export class McpSessionLostError extends Error {
  constructor() { super("MCP session expired"); this.name = "McpSessionLostError"; }
}
/** Preserves structured JSON-RPC errors, including non-2xx modern error bodies. */
export class McpRpcError extends Error {
  readonly rpcCode: number | undefined;
  readonly rpcData: unknown;
  readonly httpStatus: number;
  constructor(message: string, code: number | undefined, data: unknown, httpStatus: number) {
    super(message);
    this.name = "McpRpcError";
    this.rpcCode = code;
    this.rpcData = data;
    this.httpStatus = httpStatus;
  }
}
/** A permanent grant refresh refusal: no wire fallback or second redemption is permitted. */
export class McpSignInRequiredError extends Error {
  constructor() { super("sign-in must be renewed"); this.name = "McpSignInRequiredError"; }
}
export class McpInputRequiredError extends Error {
  constructor(message: string) { super(message); this.name = "McpInputRequiredError"; }
}
export type McpInitializeOptions = {
  logLevel?: McpLogLevel;
  clientInfo?: { name: string; version: string; title?: string };
  capabilities?: Record<string, unknown>;
  timeoutMs?: number;
};
/** Only form elicitation is advertised; URL elicitation and sampling are not implemented. */
export function defaultClientCapabilities(): Record<string, unknown> { return { elicitation: { form: {} } }; }
/** Exact and URL-encoded variants of provider secrets; longest replacements first. */
export function credentialVariants(values: string[]): string[] {
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
    } catch { /* Raw replacement still applies. */ }
  }
  return [...variants].filter(Boolean).sort((left, right) => right.length - left.length);
}
/** Redacts server-owned credentials before output reaches an LLM, log, or row. */
export function redactMcpText(text: string, credentials: string[]): string {
  let redacted = text;
  for (const credential of credentialVariants(credentials)) redacted = redacted.split(credential).join("[REDACTED_CREDENTIAL]");
  return redacted;
}
/** Deep redaction for provider-controlled schemas and structured output. */
export function redactMcpValue(value: unknown, credentials: string[], depth: number = 0): unknown {
  if (typeof value === "string") return redactMcpText(value, credentials);
  if (depth >= 20) return "[REDACTED_DEEP_PROVIDER_VALUE]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactMcpValue(item, credentials, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) output[redactMcpText(key, credentials)] = redactMcpValue(item, credentials, depth + 1);
  return output;
}
/** Static session redactions; leased values are added for each individual request. */
export function sessionRedactions(session: McpProtocolSession): string[] { return session.redactions ?? []; }
