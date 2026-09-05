/**
 * One-time move of MCP sign-ins out of the browser. Older bundles kept OAuth
 * grants (and the GitHub device-flow token) in localStorage; the account
 * vault is now the only home of a credential. On boot every legacy key is
 * purged, cards that relied on a browser-held grant and have no vault-backed
 * credential are marked for a fresh sign-in with an honest notice, and a
 * non-secret report (counts + ids, never tokens) is kept for Diagnostics.
 */

import { findCatalogEntry } from "@/lib/mcp-catalog";
import { purgeLegacyOAuthStorage } from "@/lib/mcp-oauth";
import type { AgentSettings, McpServerConfig } from "@/lib/types";

export const MCP_CREDENTIAL_MIGRATION_KEY = "gera.mcp.oauth.migration.v1";

/** Card text for a server whose browser-held sign-in was retired. */
export const VAULT_RESIGNIN_NOTICE =
  "Gera moved sign-ins to the server vault — sign in again to reconnect this server.";

export type McpCredentialMigrationReport = {
  /** When the purge ran. */
  at: number;
  /** Grants the vault already held (`credentialStored`) — nothing to do for the user. */
  moved: number;
  /** Cards that need a fresh sign-in. */
  awaiting: number;
  /** Ids the report is about (never any credential material). */
  serverIds: string[];
};

/** True when this card's connection could only have come from a browser-held grant. */
export function reliesOnBrowserGrant(server: McpServerConfig): boolean {
  const entry = findCatalogEntry(server.catalogId ?? server.id);
  if ((server.token ?? "").trim().length > 0) {
    return false;
  }
  if (entry?.native === "github") {
    return true;
  }
  if (entry?.native) {
    return false;
  }
  if (entry?.auth === "oauth" || server.authMode === "oauth") {
    return true;
  }
  // A custom "auto" server without a key or headers fell back to OAuth.
  return !entry && (server.authMode ?? "auto") === "auto" && server.headersJson.trim().length === 0;
}

function affectedBy(server: McpServerConfig, purgedIds: ReadonlySet<string>): boolean {
  if (purgedIds.has(server.id)) {
    return true;
  }
  if (server.catalogId && purgedIds.has(server.catalogId)) {
    return true;
  }
  // The device flow stored the GitHub grant under the stable catalog key.
  return findCatalogEntry(server.catalogId ?? server.id)?.native === "github" && purgedIds.has("github");
}

/**
 * Purges legacy browser grants and marks the cards that depended on them.
 * Returns the same settings object when nothing was stored locally, so the
 * caller can skip a state update. Cards whose credential the vault already
 * holds keep their status — the session's health check verifies them.
 */
export function migrateBrowserGrantsToVault(
  settings: AgentSettings,
  now: number = Date.now(),
): { settings: AgentSettings; report: McpCredentialMigrationReport | null } {
  const purge = purgeLegacyOAuthStorage();
  if (!purge.found) {
    return { settings, report: null };
  }
  const purgedIds = new Set(purge.serverIds);
  let moved = 0;
  let awaiting = 0;
  const serverIds: string[] = [];
  let changed = false;
  const mcpServers = settings.mcpServers.map((server): McpServerConfig => {
    if (!affectedBy(server, purgedIds) || !reliesOnBrowserGrant(server)) {
      return server;
    }
    serverIds.push(server.id);
    if (server.credentialStored === true) {
      moved += 1;
      return server;
    }
    if (server.status === "idle" && !server.error) {
      return server;
    }
    awaiting += 1;
    changed = true;
    const next: McpServerConfig = {
      ...server,
      status: "error",
      error: VAULT_RESIGNIN_NOTICE,
      credentialStored: false,
    };
    delete next.identity;
    delete next.verifiedAt;
    return next;
  });
  const report: McpCredentialMigrationReport = { at: now, moved, awaiting, serverIds };
  saveMcpCredentialMigrationReport(report);
  return { settings: changed ? { ...settings, mcpServers } : settings, report };
}

function saveMcpCredentialMigrationReport(report: McpCredentialMigrationReport): void {
  try {
    window.localStorage.setItem(MCP_CREDENTIAL_MIGRATION_KEY, JSON.stringify(report));
  } catch {
    // restricted storage — Diagnostics simply shows no migration line
  }
}

/** The last migration report, or null when this browser never held a legacy grant. */
export function loadMcpCredentialMigrationReport(): McpCredentialMigrationReport | null {
  try {
    const raw = window.localStorage.getItem(MCP_CREDENTIAL_MIGRATION_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<McpCredentialMigrationReport> | null;
    if (
      !parsed ||
      typeof parsed.at !== "number" ||
      typeof parsed.moved !== "number" ||
      typeof parsed.awaiting !== "number"
    ) {
      return null;
    }
    return {
      at: parsed.at,
      moved: parsed.moved,
      awaiting: parsed.awaiting,
      serverIds: Array.isArray(parsed.serverIds)
        ? parsed.serverIds.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return null;
  }
}

/** Human line for Diagnostics; null when there is nothing to report. */
export function describeMcpCredentialMigration(report: McpCredentialMigrationReport | null): string | null {
  if (!report || (report.moved === 0 && report.awaiting === 0)) {
    return null;
  }
  const moved = `${report.moved} sign-in${report.moved === 1 ? "" : "s"} moved to the vault`;
  const awaiting =
    report.awaiting > 0
      ? `${report.awaiting} await${report.awaiting === 1 ? "s" : ""} a fresh sign-in`
      : "none awaiting sign-in";
  return `Browser grants retired · ${moved} · ${awaiting}`;
}
