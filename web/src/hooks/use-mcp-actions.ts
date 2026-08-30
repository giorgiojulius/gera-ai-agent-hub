// MCP connector actions — extracted verbatim from AgentProvider: the boot
// revalidation pass plus every card/catalog action (add, connect, OAuth
// sign-in, token toggle, removal). All state flows through the provider's
// setSettings, so behavior and persistence are unchanged.
import { useCallback, useEffect } from "react";

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
import { clearOAuthToken, hasOAuthToken, openOAuthPopup } from "@/lib/mcp-oauth";
import type { AgentSettings, McpServerConfig } from "@/lib/types";

type McpActionsArgs = {
  stateRef: { current: AgentState };
  setSettings: (updater: (prev: AgentSettings) => AgentSettings) => void;
};

export function useMcpActions({ stateRef, setSettings }: McpActionsArgs) {
  // "Connect once and forget": MCP servers verified earlier stay connected
  // across reloads; one boot pass quietly re-verifies them in the background.
  // Dead sign-ins flip to an honest error; network blips change nothing and
  // heal lazily on the next tool call.
  useEffect(() => {
    revalidateMcpServers(stateRef.current.settings.mcpServers, setSettings);
  }, [setSettings, stateRef]);

  const updateMcp = useCallback((id: string, patch: Partial<McpServerConfig>) => {
    setSettings((prev) => ({
      ...prev,
      mcpServers: prev.mcpServers.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));
  }, [setSettings]);

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
    if (entry.auth === "none" || entry.tokenOptional || hasToken || hasOAuthToken(server.id)) {
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
      !hasOAuthToken(server.id);
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
