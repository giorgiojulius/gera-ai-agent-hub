import { authedFetchForSession } from "@/lib/backend";
import { authSessionSnapshot, getAccessToken, isAuthSessionCurrent } from "@/lib/auth-tokens";
import { AuthSessionChangedError } from "@/lib/backend";
import { withDiagnosticContext } from "@/lib/diagnostic-context";
import { newId } from "@/lib/env";
import { invalidateConnectorCaches } from "@/lib/connector-cache-scope";
import { sleep } from "@/lib/errors";
import { GITHUB_NATIVE_TOOLS } from "@/lib/github-native";
import { INTERCOM_NATIVE_TOOLS } from "@/lib/intercom-native";
import { SLACK_NATIVE_TOOLS } from "@/lib/slack-native";
import { findCatalogEntry, isGithubWriteTool } from "@/lib/mcp-catalog";
import type { McpServerConfig, McpStepUp, McpToolInfo, OpenAiTool } from "@/lib/types";
import { parseJsonRpcPayload, selectRpcResponse, stringifyMcpToolResult, type JsonRpcMessage } from "../../../functions/mcp-protocol";

let rejectedGeraSessionKey: string | null = null;
function shortHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16_777_619); }
  return (hash >>> 0).toString(36);
}
/** A provider key or sign-in was genuinely rejected, not a Gera infrastructure failure. */
export class McpAuthError extends Error {
  constructor(message: string) { super(message); this.name = "McpAuthError"; }
}
/** The Gera account session is unavailable; says nothing about provider credentials. */
export class McpAccountAuthError extends Error {
  constructor() { super("Sign in to Gera again before checking external connectors."); this.name = "McpAccountAuthError"; }
}
/** Pure compatibility parser; no browser MCP transport or session state exists. */
export function parseMcpRpcResponse(body: string, expectedId: number): JsonRpcMessage {
  const response = selectRpcResponse(parseJsonRpcPayload(body), expectedId);
  if (!response) throw new Error(`no JSON-RPC response for request ${expectedId}`);
  return response;
}
export type McpConnection = {
  tools: McpToolInfo[];
  identity?: string;
  credentialStored?: boolean;
  promptCount?: number;
  resourceCount?: number;
  protocolVersion?: string;
  stepUp?: McpStepUp;
};
/** Only date-shaped protocol revisions are displayed. */
export function parseMcpProtocolVersion(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}
/** Validates the non-secret server step-up payload. */
export function parseMcpStepUp(value: unknown): McpStepUp | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as { scopes?: unknown; code?: unknown };
  const scopes = Array.isArray(raw.scopes) ? raw.scopes.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 64) : [];
  const code = typeof raw.code === "string" && raw.code ? raw.code.slice(0, 80) : "insufficient_scope";
  return { scopes, code };
}
/** Plain-language provider consent requirement. */
export function describeMcpStepUp(stepUp: McpStepUp | undefined): string {
  const wanted = stepUp && stepUp.scopes.length > 0 ? ` (scopes: ${stepUp.scopes.join(" ")})` : "";
  return `This server needs a sign-in with wider access${wanted} — press “Sign in again with wider access” to grant it.`;
}
/** Explicit credential ingestion only; catalog schemas never ride the check request. */
export function mcpCheckServerPayload(config: McpServerConfig): Record<string, unknown> {
  return { id: config.id, name: config.name, url: config.url, headersJson: config.headersJson, token: config.token ?? "", authMode: config.authMode, catalogId: config.catalogId,
    ...(typeof config.credentialStored === "boolean" ? { credentialStored: config.credentialStored } : {}),
  };
}
const MCP_CHECK_RETRY_DELAY_MS = 600;
const INFRA_CHECK_CODES: ReadonlySet<string> = new Set(["account_shard_unavailable", "identity_unavailable", "upstream_unreachable", "mcp_check_failed"]);
type McpCheckBody = {
  tools?: unknown; identity?: unknown; credentialStored?: unknown; promptCount?: unknown; resourceCount?: unknown;
  protocolVersion?: unknown; stepUp?: unknown; error?: unknown; detail?: unknown; reason?: unknown; retryable?: unknown;
};
/** Distinguishes Gera infrastructure faults from a genuine provider authentication refusal. */
export function describeMcpCheckFailure(code: string, body: Pick<McpCheckBody, "reason" | "detail" | "stepUp">): string | null {
  switch (code) {
    case "step_up_required": return describeMcpStepUp(parseMcpStepUp(body.stepUp));
    case "reauth_required": return "The saved sign-in was rejected by the provider — press “Sign in” to authorize again.";
    case "identity_unavailable": return "Gera's account service is temporarily unavailable — your saved connections are unchanged; the check will retry automatically.";
    case "account_shard_unavailable": {
      const why = body.reason === "redeploy" ? "was updating" : body.reason === "overloaded" ? "was busy" : "hit an internal error";
      return `Gera's backend ${why} while checking this server — a temporary blip; it will retry automatically.`;
    }
    case "upstream_unreachable": return "The MCP server did not answer — it may be down or unreachable.";
    case "mcp_check_failed": return `The server check temporarily failed inside Gera${typeof body.detail === "string" && body.detail ? `: ${body.detail}` : "."} — it will retry automatically.`;
    default: return null;
  }
}
/** The only browser connection path: account-pinned server check, never an upstream MCP request. */
export async function connectMcpServer(config: McpServerConfig): Promise<McpConnection> {
  invalidateConnectorCaches(config.id);
  const sessionNonce = authSessionSnapshot();
  const geraSessionKey = `${sessionNonce}:${getAccessToken() ?? "signed-out"}`;
  if (rejectedGeraSessionKey === geraSessionKey) throw new McpAccountAuthError();
  const init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ server: mcpCheckServerPayload(config) }) };
  const attempt = async (): Promise<{ response: Response; data: McpCheckBody }> => {
    const response = await authedFetchForSession("/mcp/check", sessionNonce, init);
    const data = (await response.json().catch(() => ({}))) as McpCheckBody;
    if (!isAuthSessionCurrent(sessionNonce)) throw new AuthSessionChangedError();
    return { response, data };
  };
  let attempts = 1;
  let { response, data } = await attempt();
  if (!response.ok && response.status >= 500 && (data.retryable === true || data.error === "identity_unavailable")) {
    await sleep(MCP_CHECK_RETRY_DELAY_MS);
    attempts += 1;
    ({ response, data } = await attempt());
  }
  if (!response.ok) {
    const code = typeof data.error === "string" ? data.error : "";
    let detail = describeMcpCheckFailure(code, data) ?? (code || `server check failed (${response.status})`);
    if (detail === "server_auth_missing") {
      const perId = Array.isArray(data.detail) ? data.detail.map((item) => {
        const entry = item as { id?: unknown; grantPresent?: unknown; state?: unknown };
        return typeof entry.id === "string" ? `${entry.id}: ${entry.grantPresent === true ? "grant present" : "no grant"}${typeof entry.state === "string" && entry.state !== "ready" ? `, ${entry.state}` : ""}` : "";
      }).filter(Boolean).join("; ") : "";
      detail = `The server has no usable sign-in for this connector — press "Sign in" to authorize again.${perId ? ` (${perId})` : ""}`;
    }
    if (response.status === 401 && detail === "sign_in_required") { rejectedGeraSessionKey = geraSessionKey; throw new McpAccountAuthError(); }
    const context = { path: "POST /mcp/check", status: response.status, code: code || undefined, reason: typeof data.reason === "string" ? data.reason : undefined, attempts,
      serverId: config.id, catalogId: config.catalogId, authMode: config.authMode, credentialStored: config.credentialStored, serverDetail: data.detail };
    if (!INFRA_CHECK_CODES.has(code) && /auth|credential|sign.?in|token/i.test(detail)) throw withDiagnosticContext(new McpAuthError(detail), context);
    throw withDiagnosticContext(new Error(detail), context);
  }
  rejectedGeraSessionKey = null;
  const serverTools = Array.isArray(data.tools) ? data.tools.filter((tool): tool is McpToolInfo => Boolean(tool && typeof tool === "object" && typeof (tool as McpToolInfo).name === "string")) : [];
  const stepUp = parseMcpStepUp(data.stepUp);
  const protocolVersion = parseMcpProtocolVersion(data.protocolVersion);
  return {
    tools: serverTools, identity: typeof data.identity === "string" && data.identity ? data.identity : "Server verified", credentialStored: data.credentialStored === true,
    promptCount: typeof data.promptCount === "number" && data.promptCount >= 0 ? data.promptCount : 0,
    resourceCount: typeof data.resourceCount === "number" && data.resourceCount >= 0 ? data.resourceCount : 0,
    ...(protocolVersion ? { protocolVersion } : {}), ...(stepUp ? { stepUp } : {}),
  };
}
function githubChatWriteForced(server: Pick<McpServerConfig, "id" | "catalogId">, toolName: string): boolean {
  return (server.catalogId ?? server.id) === "github" && isGithubWriteTool(toolName);
}
function nativeToolTable(server: Pick<McpServerConfig, "id" | "catalogId">): McpToolInfo[] | null {
  const entry = findCatalogEntry(server.catalogId ?? server.id);
  return entry?.native === "slack" ? SLACK_NATIVE_TOOLS : entry?.native === "intercom" ? INTERCOM_NATIVE_TOOLS : entry?.native === "github" ? GITHUB_NATIVE_TOOLS : null;
}
/** UI metadata only; actual execution always belongs to the server toolset. */
export function mcpToolsToOpenAi(servers: McpServerConfig[]): OpenAiTool[] {
  const tools: OpenAiTool[] = [];
  for (const server of servers) {
    if (!server.enabled || server.status !== "connected") continue;
    for (const tool of nativeToolTable(server) ?? server.tools) {
      if (tool.uiOnly || (server.disabledTools.includes(tool.name) && !githubChatWriteForced(server, tool.name))) continue;
      tools.push({ type: "function", function: { name: mcpFunctionName(server.id, tool.name), description: `[MCP:${server.name}] ${tool.description ?? tool.name}`, parameters: tool.inputSchema ?? { type: "object", properties: {} } } });
    }
  }
  return tools;
}
/** Stable namespaced label compatible with existing chat records. */
export function mcpFunctionName(serverId: string, toolName: string): string {
  const serverPart = safeName(serverId, "server");
  const toolPart = safeName(toolName, "tool");
  const base = `mcp_${serverPart}_${toolPart}`;
  const changed = serverPart !== serverId.toLowerCase() || toolPart !== toolName.toLowerCase() || serverId !== serverId.toLowerCase() || toolName !== toolName.toLowerCase();
  if (!changed && base.length <= 64) return base;
  const suffix = shortHash(`${serverId}\u0000${toolName}`).slice(0, 7);
  return `${base.slice(0, 63 - suffix.length)}_${suffix}`;
}
/** Resolves a UI tool label, not a browser execution route. */
export function findServerForTool(servers: McpServerConfig[], functionName: string): { server: McpServerConfig; toolName: string } | null {
  if (!functionName.startsWith("mcp_")) return null;
  for (const server of servers) {
    if (!server.enabled || server.status !== "connected") continue;
    const tool = (nativeToolTable(server) ?? server.tools).find((item) => !item.uiOnly && (!server.disabledTools.includes(item.name) || githubChatWriteForced(server, item.name)) && mcpFunctionName(server.id, item.name) === functionName);
    if (tool) return { server, toolName: tool.name };
  }
  return null;
}
/** Empty configuration for the connector editor. */
export function newMcpServer(): McpServerConfig {
  return { id: newId(), name: "MCP server", url: "", headersJson: "", enabled: true, status: "idle", tools: [], disabledTools: [] };
}
function safeName(value: string, fallback: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || fallback; }
export const stringifyMcpResult: (result: unknown) => string = stringifyMcpToolResult;
