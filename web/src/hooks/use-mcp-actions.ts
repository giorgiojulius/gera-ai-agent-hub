// MCP connector actions — extracted verbatim from AgentProvider: the boot
// revalidation pass plus every card/catalog action (add, connect, OAuth
// sign-in, token toggle, removal). All state flows through the provider's
// setSettings, so behavior and persistence are unchanged.
import { useCallback, useEffect, useRef, useState } from "react";

import {
  addBlankMcpServer,
  addCatalogMcp,
  newMcpServer,
  oauthConnectMcp,
  reconnectMcp,
  revalidateMcpServers,
  type AgentState,
} from "@/lib/agent-store";
import { catalogEntryToServer, findCatalogEntry } from "@/lib/mcp-catalog";
import { clearMcpServerSession } from "@/lib/mcp";
import {
  clearOAuthToken,
  openOAuthPopup,
} from "@/lib/mcp-oauth";
import type { AgentSettings, McpServerConfig } from "@/lib/types";

type McpActionsArgs = {
  stateRef: { current: AgentState };
  servers: McpServerConfig[];
  canValidate: boolean;
  setSettings: (updater: (prev: AgentSettings) => AgentSettings) => void;
};

function shortFingerprint(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

/** Auth/config revision only — tools, identity, and verifiedAt must not loop validation. */
function validationFingerprint(server: McpServerConfig): string {
  const catalogId = server.catalogId ?? server.id;
  return [
    server.url,
    server.authMode ?? "auto",
    catalogId,
    shortFingerprint(server.token ?? ""),
    shortFingerprint(server.headersJson ?? ""),
  ].join("|");
}

export function useMcpActions({ stateRef, servers, canValidate, setSettings }: McpActionsArgs) {
  const [healthTick, setHealthTick] = useState<number>(0);
  const validatedRef = useRef<Map<string, string>>(new Map<string, string>());

  // Long-open tabs need the same honesty as a reload. Wake the ten-minute
  // freshness check once a minute and immediately when a hidden tab returns.
  useEffect(() => {
    if (!canValidate) {
      return;
    }
    const wake = () => setHealthTick((value) => value + 1);
    const onVisible = () => {
      if (!document.hidden) {
        wake();
      }
    };
    const timer = window.setInterval(wake, 60_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [canValidate]);

  // Re-run when cloud profile settings arrive too — the old mount-only pass
  // often ran before sync loaded its green cards, so they were never checked.
  // Each persisted green card is force-checked once per browser session (and
  // again whenever its auth/config fingerprint changes); a successful update
  // changes tools/verifiedAt only, so it cannot create a verification loop.
  useEffect(() => {
    if (!canValidate) {
      // AgentProvider is mounted behind the auth provider, not the visual gate.
      // Signed-out/loading renders must never probe every persisted connector.
      validatedRef.current.clear();
      return;
    }
    const forceIds = new Set<string>();
    const liveIds = new Set(servers.map((server) => server.id));
    for (const id of validatedRef.current.keys()) {
      if (!liveIds.has(id)) {
        validatedRef.current.delete(id);
      }
    }
    for (const server of servers) {
      if (server.status === "error" || server.status === "idle") {
        validatedRef.current.delete(server.id);
        continue;
      }
      if (!server.enabled || server.status !== "connected") {
        continue;
      }
      const fingerprint = validationFingerprint(server);
      if (validatedRef.current.get(server.id) !== fingerprint) {
        validatedRef.current.set(server.id, fingerprint);
        forceIds.add(server.id);
      }
    }
    revalidateMcpServers(servers, setSettings, forceIds);
  }, [canValidate, healthTick, servers, setSettings]);

  const updateMcp = useCallback((id: string, patch: Partial<McpServerConfig>) => {
    const current = stateRef.current.settings.mcpServers.find((server) => server.id === id);
    const urlChanged = typeof patch.url === "string" && patch.url.trim() !== current?.url.trim();
    const connectionChanged =
      urlChanged ||
      patch.authMode !== undefined ||
      patch.token !== undefined ||
      patch.headersJson !== undefined;
    if (urlChanged) {
      clearOAuthToken(id);
    }
    if (connectionChanged) {
      clearMcpServerSession(id);
    }
    setSettings((prev) => ({
      ...prev,
      mcpServers: prev.mcpServers.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));
  }, [setSettings, stateRef]);

  const addMcp = useCallback(() => {
    setSettings((prev) => addBlankMcpServer(prev));
  }, [setSettings]);

  const addCatalogMcpServer = useCallback((catalogId: string) => {
    setSettings((prev) => addCatalogMcp(prev, catalogId));
  }, [setSettings]);

  const connectCatalog = useCallback((catalogId: string) => {
    const entry = findCatalogEntry(catalogId);
    if (!entry || entry.blocked) {
      return;
    }
    const existing = stateRef.current.settings.mcpServers.find(
      (item) => item.catalogId === entry.id || item.id === entry.id,
    );
    const server = existing ?? catalogEntryToServer(entry);
    const hasToken = Boolean(server.token?.trim());
    if (entry.auth === "none" || entry.tokenOptional || hasToken || server.status === "connected") {
      void reconnectMcp(server, setSettings);
      return;
    }
    if (entry.auth === "oauth") {
      const popup = openOAuthPopup();
      void oauthConnectMcp(server, popup, setSettings);
      return;
    }
    if (!existing) {
      setSettings((prev) => addCatalogMcp(prev, catalogId));
    }
  }, [setSettings, stateRef]);

  const addCustomMcp = useCallback((input: {
    name: string;
    url: string;
    token?: string;
    headersJson?: string;
    authMode?: McpServerConfig["authMode"];
  }) => {
    const mode = input.authMode ?? "auto";
    const url = input.url.trim();
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      host = "";
    }
    const server = {
      ...newMcpServer(),
      name: input.name.trim() || host || "Custom MCP",
      url,
      token: mode === "bearer" || mode === "auto" ? (input.token?.trim() ?? "") : "",
      headersJson: mode === "headers" || mode === "auto" ? (input.headersJson?.trim() ?? "") : "",
      authMode: mode,
      enabled: true,
    };
    if (mode === "oauth") {
      // Popup must open in the same click tick or the browser blocks it.
      const popup = openOAuthPopup();
      void oauthConnectMcp(server, popup, setSettings);
      return;
    }
    void reconnectMcp(server, setSettings);
  }, [setSettings]);

  const removeMcp = useCallback((id: string) => {
    clearMcpServerSession(id);
    clearOAuthToken(id);
    setSettings((prev) => ({ ...prev, mcpServers: prev.mcpServers.filter((item) => item.id !== id) }));
  }, [setSettings]);

  const connectMcp = useCallback((id: string) => {
    const server = stateRef.current.settings.mcpServers.find((item) => item.id === id);
    if (!server) {
      return;
    }
    const entry = findCatalogEntry(server.catalogId ?? server.id);
    const needsOAuth =
      (entry?.auth === "oauth" || server.authMode === "oauth") &&
      !server.token?.trim() &&
      server.status !== "connected";
    if (needsOAuth) {
      const popup = openOAuthPopup();
      void oauthConnectMcp(server, popup, setSettings);
      return;
    }
    void reconnectMcp(server, setSettings);
  }, [setSettings, stateRef]);

  const toggleMcpTool = useCallback((serverId: string, toolName: string) => {
    setSettings((prev) => ({
      ...prev,
      mcpServers: prev.mcpServers.map((item) => {
        if (item.id !== serverId) {
          return item;
        }
        const disabled = item.disabledTools.includes(toolName)
          ? item.disabledTools.filter((name) => name !== toolName)
          : [...item.disabledTools, toolName];
        return { ...item, disabledTools: disabled };
      }),
    }));
  }, [setSettings]);

  return {
    updateMcp,
    addMcp,
    addCatalogMcpServer,
    connectCatalog,
    addCustomMcp,
    removeMcp,
    connectMcp,
    toggleMcpTool,
  };
}
