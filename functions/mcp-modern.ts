import {
  isRecord, defaultClientCapabilities, normalizeServerCapabilities,
  MCP_MODERN_PROTOCOL_VERSION, MCP_MODERN_PROTOCOL_VERSIONS,
  MCP_META_PROTOCOL_VERSION, MCP_META_CLIENT_CAPABILITIES, MCP_META_CLIENT_INFO, MCP_META_SERVER_INFO, MCP_META_LOG_LEVEL,
  MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION, MCP_ERROR_MISSING_CLIENT_CAPABILITY, MCP_ERROR_HEADER_MISMATCH, MCP_MAX_INPUT_ROUNDS,
  McpAuthRejectedError, McpRpcError, McpInputRequiredError, McpSignInRequiredError,
  type McpProtocolSession, type McpServerCapabilities, type McpServerInfo, type McpWireInfo,
} from "./mcp-protocol-shared";

/** Injected primitive avoids any runtime dependency on the transport facade. */
export type McpRequestPrimitive = (session: McpProtocolSession, method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
export type McpDiscovery = { protocolVersion: string; capabilities: McpServerCapabilities; serverInfo: McpServerInfo; instructions?: string };
/** No default log level: absent means the server must not emit request logs. */
export function modernRequestMeta(session: McpProtocolSession): Record<string, unknown> {
  return {
    [MCP_META_PROTOCOL_VERSION]: session.protocolVersion ?? MCP_MODERN_PROTOCOL_VERSION,
    [MCP_META_CLIENT_CAPABILITIES]: session.clientCapabilities ?? defaultClientCapabilities(),
    [MCP_META_CLIENT_INFO]: session.clientInfo ?? { name: "Gera AI", version: "1.0.0" },
    ...(session.logLevel ? { [MCP_META_LOG_LEVEL]: session.logLevel } : {}),
  };
}
/** Protocol-owned metadata wins over caller values; unrelated metadata is preserved. */
export function wireParams(session: McpProtocolSession, params: unknown): unknown {
  if (session.wire !== "modern") return params ?? {};
  const base = isRecord(params) ? params : {};
  const existing = isRecord(base._meta) ? base._meta : {};
  return { ...base, _meta: { ...existing, ...modernRequestMeta(session) } };
}
function serverInfoFrom(value: unknown): McpServerInfo {
  const raw = isRecord(value) ? value : {};
  return { name: typeof raw.name === "string" ? raw.name : undefined, title: typeof raw.title === "string" ? raw.title : undefined, version: typeof raw.version === "string" ? raw.version : undefined };
}
/** Chooses the newest common revision, independently of either list's order. */
export function pickModernVersion(offered: unknown, supported: readonly string[] = MCP_MODERN_PROTOCOL_VERSIONS): string | null {
  if (!Array.isArray(offered)) return null;
  const versions = new Set(offered.filter((item): item is string => typeof item === "string"));
  return supported.filter((version) => versions.has(version)).sort((a, b) => b.localeCompare(a))[0] ?? null;
}
/** Checks nested capabilities, not merely the top-level name (form != URL, sampling != sampling.tools). */
function supportedRequirement(required: unknown, implemented: unknown, depth: number = 0): boolean {
  if (depth > 5 || !isRecord(required) || !isRecord(implemented)) return false;
  return Object.entries(required).every(([key, value]) => Object.prototype.hasOwnProperty.call(implemented, key) &&
    (isRecord(value) ? supportedRequirement(value, implemented[key], depth + 1) : value === implemented[key]));
}
function mergeCapabilities(current: Record<string, unknown>, required: Record<string, unknown>): Record<string, unknown> {
  const out = { ...current };
  for (const [key, value] of Object.entries(required)) {
    out[key] = isRecord(value) && isRecord(current[key]) ? mergeCapabilities(current[key] as Record<string, unknown>, value) : value;
  }
  return out;
}
/** At most one version correction and one capability correction for an operation, including discovery/subscriptions. */
export async function withModernNegotiation<T>(session: McpProtocolSession, attempt: () => Promise<T>, versions: readonly string[] = MCP_MODERN_PROTOCOL_VERSIONS): Promise<T> {
  let retriedVersion = false;
  let retriedCapabilities = false;
  for (;;) {
    session.signal?.throwIfAborted();
    try { return await attempt(); }
    catch (error) {
      session.signal?.throwIfAborted();
      if (session.wire !== "modern" || !(error instanceof McpRpcError) || !isRecord(error.rpcData)) throw error;
      if (error.rpcCode === MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION && !retriedVersion && typeof error.rpcData.requested === "string") {
        const version = pickModernVersion(error.rpcData.supported, versions);
        if (version) { retriedVersion = true; session.protocolVersion = version; continue; }
      }
      if (error.rpcCode === MCP_ERROR_MISSING_CLIENT_CAPABILITY && !retriedCapabilities) {
        const required = error.rpcData.requiredCapabilities;
        // Empty roots and form accept/decline are implemented; URL elicitation,
        // sampling, and notification capabilities that we cannot send are not.
        const implemented = { ...defaultClientCapabilities(), roots: {} };
        if (isRecord(required) && Object.keys(required).length > 0 && supportedRequirement(required, implemented)) {
          retriedCapabilities = true;
          session.clientCapabilities = mergeCapabilities(session.clientCapabilities ?? defaultClientCapabilities(), required);
          continue;
        }
      }
      throw error;
    }
  }
}
function applyDiscovery(session: McpProtocolSession, version: string, result: Record<string, unknown> | null): McpDiscovery {
  const meta = isRecord(result?._meta) ? result._meta : {};
  session.wire = "modern"; session.protocolVersion = version; session.sessionId = undefined;
  session.capabilities = normalizeServerCapabilities(result?.capabilities);
  session.serverInfo = serverInfoFrom(meta[MCP_META_SERVER_INFO]);
  session.instructions = typeof result?.instructions === "string" ? result.instructions : undefined;
  session.initialized = true;
  return { protocolVersion: version, capabilities: session.capabilities, serverInfo: session.serverInfo, instructions: session.instructions };
}
/** Recognized modern refusals never fall back to initialize; legacy unknown-method/transport probes may. */
export async function discoverModern(session: McpProtocolSession, request: McpRequestPrimitive, options: { timeoutMs?: number } = {}): Promise<McpDiscovery | null> {
  const previous = { wire: session.wire, protocolVersion: session.protocolVersion };
  const restore = (): void => { session.wire = previous.wire; session.protocolVersion = previous.protocolVersion; };
  session.wire = "modern"; session.protocolVersion = MCP_MODERN_PROTOCOL_VERSION;
  try {
    // The facade's request already applies the bounded corrective retries.
    const result = (await request(session, "server/discover", {}, options.timeoutMs ?? 5_000)) as Record<string, unknown> | null;
    const version = pickModernVersion(result?.supportedVersions);
    if (!version) {
      if (Array.isArray(result?.supportedVersions)) throw new McpRpcError("No common MCP protocol version", MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION, { supported: result.supportedVersions, requested: session.protocolVersion }, 400);
      restore(); return null;
    }
    return applyDiscovery(session, version, result);
  } catch (error) {
    session.signal?.throwIfAborted();
    restore();
    if (error instanceof McpAuthRejectedError || error instanceof McpSignInRequiredError || (error instanceof Error && error.name === "McpCredentialUnavailableError")) throw error;
    if (error instanceof McpRpcError && [MCP_ERROR_HEADER_MISMATCH, MCP_ERROR_MISSING_CLIENT_CAPABILITY, MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION].includes(error.rpcCode ?? 0)) throw error;
    return null;
  }
}
/** A catalog stores only this negotiation summary, never the session or credential. */
export function sessionWireInfo(session: McpProtocolSession): McpWireInfo | undefined {
  if (!session.initialized || !session.protocolVersion) return undefined;
  return { era: session.wire ?? "legacy", protocolVersion: session.protocolVersion, ...(session.capabilities ? { capabilities: session.capabilities } : {}), ...(session.serverInfo ? { serverInfo: session.serverInfo } : {}) };
}
export function isInputRequiredResult(result: unknown): result is Record<string, unknown> & { resultType: "input_required" } {
  return isRecord(result) && result.resultType === "input_required";
}
async function answerInputRequests(session: McpProtocolSession, result: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requests = isRecord(result.inputRequests) ? result.inputRequests : {};
  const answers: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(requests)) {
    if (!isRecord(raw) || typeof raw.method !== "string") continue;
    if (raw.method === "roots/list") { answers[key] = { roots: [] }; continue; }
    if (raw.method === "sampling/createMessage") throw new McpInputRequiredError("the server asked Gera to run a model on its behalf (sampling), which Gera does not offer to servers");
    if (raw.method !== "elicitation/create") throw new McpInputRequiredError(`the server asked for input of an unsupported kind (${raw.method})`);
    if (!session.onServerRequest) { answers[key] = { action: "decline" }; continue; }
    try {
      const reply = await session.onServerRequest({ id: key, method: raw.method, params: raw.params });
      answers[key] = "result" in reply && isRecord(reply.result) ? reply.result : { action: "decline" };
    } catch { answers[key] = { action: "decline" }; }
  }
  return answers;
}
/** Repeats the original request with opaque state and input responses, up to three input rounds. */
export async function requestWithModernInput(session: McpProtocolSession, method: string, params: Record<string, unknown>, timeoutMs: number, request: McpRequestPrimitive): Promise<unknown> {
  let extra: Record<string, unknown> = {};
  for (let round = 0; ; round += 1) {
    const result = await request(session, method, { ...params, ...extra }, timeoutMs);
    if (!isInputRequiredResult(result)) return result;
    if (round >= MCP_MAX_INPUT_ROUNDS) throw new McpInputRequiredError(`the server kept asking for more input after ${MCP_MAX_INPUT_ROUNDS} rounds`);
    const inputResponses = await answerInputRequests(session, result);
    extra = { inputResponses, ...(typeof result.requestState === "string" ? { requestState: result.requestState } : {}) };
  }
}
/** List notifications advertised by this server. Request logs do not go on subscriptions. */
export function listenFilter(session: McpProtocolSession): Record<string, unknown> {
  const capabilities = session.capabilities ?? {};
  return { ...(capabilities.tools?.listChanged ? { toolsListChanged: true } : {}), ...(capabilities.prompts?.listChanged ? { promptsListChanged: true } : {}), ...(capabilities.resources?.listChanged ? { resourcesListChanged: true } : {}) };
}
