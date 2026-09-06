import { isRecord, MCP_DEFAULT_PROTOCOL_VERSION, MCP_MODERN_PROTOCOL_VERSION, type McpProtocolSession } from "./mcp-protocol-shared";

/** Protocol-owned HTTP fields, shared by cloud transport and relay/CORS. */
export const MCP_PROTOCOL_HEADERS = ["MCP-Protocol-Version", "Mcp-Session-Id", "Mcp-Method", "Mcp-Name"] as const;
/** Provider auth remains intact, but it can never override protocol-owned headers. */
export function credentialHeaders(...sources: Record<string, string>[]): Record<string, string> {
  const owned = new Set<string>(MCP_PROTOCOL_HEADERS.map((name) => name.toLowerCase()));
  return Object.fromEntries(sources.flatMap((source) => Object.entries(source)).filter(([name]) => !owned.has(name.toLowerCase()) && !name.toLowerCase().startsWith("mcp-param-")));
}
/** Encodes values that cannot round-trip unambiguously as a plain HTTP header. */
export function mcpHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value) && value === value.trim() && !value.startsWith("=?base64?")) return value;
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `=?base64?${btoa(binary)}?=`;
}
function modernNameHeader(method: string, params: unknown): Record<string, string> {
  if (!isRecord(params)) return {};
  const value = method === "resources/read" ? params.uri : method === "tools/call" || method === "prompts/get" ? params.name : undefined;
  return typeof value === "string" && value ? { "Mcp-Name": mcpHeaderValue(value) } : {};
}
/** Derives protocol headers from trusted session state, separately from provider credentials. */
export function protocolHeaders(session: McpProtocolSession, includeVersion: boolean, method?: string, params?: unknown): Record<string, string> {
  if (session.omitMcpHeaders) return {};
  if (session.wire === "modern") return {
    "MCP-Protocol-Version": session.protocolVersion ?? MCP_MODERN_PROTOCOL_VERSION,
    ...(method ? { "Mcp-Method": method } : {}),
    ...(method ? modernNameHeader(method, params) : {}),
  };
  return {
    ...(includeVersion ? { "MCP-Protocol-Version": session.protocolVersion ?? MCP_DEFAULT_PROTOCOL_VERSION } : {}),
    ...(session.sessionId ? { "Mcp-Session-Id": session.sessionId } : {}),
  };
}
