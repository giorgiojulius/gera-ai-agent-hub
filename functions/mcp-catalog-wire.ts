import { isRecord, normalizeServerCapabilities, MCP_MODERN_PROTOCOL_VERSIONS, MCP_SUPPORTED_PROTOCOL_VERSIONS, type McpWireInfo } from "./mcp-protocol-shared";

/** Revives only non-secret negotiation fields; malformed input means probe again. */
export function normalizeCatalogWire(value: unknown): McpWireInfo | undefined {
  if (!isRecord(value) || (value.era !== "modern" && value.era !== "legacy") || typeof value.protocolVersion !== "string" || !value.protocolVersion) return undefined;
  const versions = value.era === "modern" ? MCP_MODERN_PROTOCOL_VERSIONS : MCP_SUPPORTED_PROTOCOL_VERSIONS;
  if (!versions.includes(value.protocolVersion)) return undefined;
  const rawInfo = isRecord(value.serverInfo) ? value.serverInfo : {};
  return {
    era: value.era,
    protocolVersion: value.protocolVersion,
    ...(isRecord(value.capabilities) ? { capabilities: normalizeServerCapabilities(value.capabilities) } : {}),
    ...(Object.keys(rawInfo).length > 0 ? { serverInfo: {
      name: typeof rawInfo.name === "string" ? rawInfo.name : undefined,
      title: typeof rawInfo.title === "string" ? rawInfo.title : undefined,
      version: typeof rawInfo.version === "string" ? rawInfo.version : undefined,
    } } : {}),
  };
}
