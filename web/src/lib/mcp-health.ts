import { authSessionSnapshot, isAuthSessionCurrent } from "@/lib/auth-tokens";
import type { McpServerConfig } from "@/lib/types";

/** Ephemeral health bookkeeping; never stores credentials or crosses accounts. */
type McpHealthState = {
  attempt: symbol;
  inFlight: boolean;
  lastAttemptAt: number;
  lastHealthyAt: number;
  healthyFingerprint?: string;
};

let session = "";
const states = new Map<string, McpHealthState>();

/** Gets bookkeeping for this account session, not a globally shared server ID. */
export function mcpHealthState(id: string): McpHealthState {
  const current = authSessionSnapshot();
  if (session !== current) {
    session = current;
    states.clear();
  }
  let state = states.get(id);
  if (!state) {
    state = { attempt: Symbol(), inFlight: false, lastAttemptAt: 0, lastHealthyAt: 0 };
    states.set(id, state);
  }
  return state;
}

/** A config edit, disable, removal, or new sign-in supersedes pending checks. */
export function invalidateMcpHealth(id: string): void {
  const state = mcpHealthState(id);
  state.attempt = Symbol();
  state.inFlight = false;
  state.lastAttemptAt = 0;
  state.lastHealthyAt = 0;
  state.healthyFingerprint = undefined;
}

/** Non-secret, ephemeral deduplication hint, never used to authorize a request. */
export function mcpHealthFingerprint(server: McpServerConfig): string {
  const value = JSON.stringify([server.url, server.authMode ?? "auto", server.catalogId ?? server.id,
    server.token ?? "", server.headersJson ?? "", server.oauthScopes ?? "", server.authServerMetadataUrl ?? ""]);
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

/** Guards late results against newer checks, account switches and config edits. */
export function beginMcpHealthCheck(server: McpServerConfig) {
  const state = mcpHealthState(server.id);
  const snapshot = authSessionSnapshot();
  const attempt = Symbol();
  state.attempt = attempt;
  state.inFlight = true;
  state.lastAttemptAt = Date.now();
  const isCurrent = (): boolean => isAuthSessionCurrent(snapshot) && state.attempt === attempt;
  return {
    state,
    isCurrent,
    markHealthy(): void {
      if (isCurrent()) {
        state.lastHealthyAt = Date.now();
        state.healthyFingerprint = mcpHealthFingerprint(server);
      }
    },
    matches(item: McpServerConfig): boolean {
      return isCurrent() && item.id === server.id && item.enabled === server.enabled &&
        item.url === server.url && item.catalogId === server.catalogId &&
        item.authMode === server.authMode && item.token === server.token &&
        item.headersJson === server.headersJson && item.credentialStored === server.credentialStored &&
        item.oauthScopes === server.oauthScopes && item.authServerMetadataUrl === server.authServerMetadataUrl;
    },
    finish(): void {
      if (isCurrent()) state.inFlight = false;
    },
  };
}
