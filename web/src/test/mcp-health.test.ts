import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconnectMcp, revalidateMcpServers } from "@/lib/agent-store";
import { invalidateAuthSession } from "@/lib/auth-tokens";
import { normalizeStoredSettings, saveSettings } from "@/lib/history";
import { connectMcpServer, describeMcpCheckFailure, McpAuthError } from "@/lib/mcp";
import { invalidateMcpHealth, mcpHealthState } from "@/lib/mcp-health";
import type { AgentSettings, McpServerConfig } from "@/lib/types";

vi.mock("@/lib/mcp", async (original) => ({
  ...await original<typeof import("@/lib/mcp")>(),
  connectMcpServer: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/diagnostics", () => ({ logDiagnostic: vi.fn() }));

const connect = vi.mocked(connectMcpServer);
const healthy = { tools: [{ name: "list_teams" }], identity: "Verified now", credentialStored: true };
const authFailure = 'Could not connect MCP server "TesterArmy": auth rejected (401) — the synced sign-in or key was rejected';
let settings: AgentSettings;
const setSettings = (updater: (prev: AgentSettings) => AgentSettings): void => { settings = updater(settings); };
const server = (): McpServerConfig => settings.mcpServers[0];
const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); };

beforeEach(() => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { localStorage: storage, dispatchEvent: vi.fn() });
  connect.mockReset();
  settings = normalizeStoredSettings({ mcpServers: [{
    id: "testerarmy", catalogId: "testerarmy", name: "TesterArmy", url: "https://tester.army/mcp",
    headersJson: "", authMode: "oauth", enabled: true, status: "connected", credentialStored: true,
    tools: [{ name: "list_teams" }], disabledTools: ["delete_project"], identity: "Previously verified", verifiedAt: 1,
  }] });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("MCP health after a deployment", () => {
  it("recovers a persisted identity_unavailable only after the server actually answers", async () => {
    settings.mcpServers[0] = { ...server(), status: "error", error: "identity_unavailable", verifiedAt: undefined };
    let finish!: (value: typeof healthy) => void;
    connect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    revalidateMcpServers(settings.mcpServers, setSettings);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(server().status).toBe("error");
    expect(server().credentialStored).toBe(true);
    finish(healthy);
    await tick();
    expect(server()).toMatchObject({ status: "connected", credentialStored: true, identity: "Verified now", disabledTools: ["delete_project"] });
    expect(server().error).toBeUndefined();
    saveSettings(settings);
    expect(JSON.parse(localStorage.getItem("gera.settings.v1") ?? "{}").mcpServers[0]).toMatchObject({ status: "connected", credentialStored: true });
  });

  it.each(["identity_unavailable", "mcp_check_failed"])("keeps a green connection through a %s re-check failure", async (code) => {
    const original = { ...server() };
    connect.mockRejectedValue(new Error(describeMcpCheckFailure(code, {}) ?? code));
    await reconnectMcp(original, setSettings);
    expect(server()).toMatchObject({ status: "connected", identity: original.identity, verifiedAt: 1, credentialStored: true });
    expect(server().error).toBeUndefined();
  });

  it("does not make an unverified server green during an infrastructure outage", async () => {
    settings.mcpServers[0] = { ...server(), status: "idle", identity: undefined, verifiedAt: undefined };
    connect.mockRejectedValue(new Error(describeMcpCheckFailure("identity_unavailable", {}) ?? ""));
    await reconnectMcp(server(), setSettings);
    expect(server().status).toBe("error");
    expect(server().verifiedAt).toBeUndefined();
    expect(server().credentialStored).toBe(true);
  });

  it("re-checks a stored 401 using server-owned credentials, without a browser grant", async () => {
    settings.mcpServers[0] = { ...server(), status: "error", error: authFailure, verifiedAt: undefined };
    connect.mockResolvedValue(healthy);
    revalidateMcpServers(settings.mcpServers, setSettings);
    await tick();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0][0].credentialStored).toBe(true);
    expect(server().status).toBe("connected");
  });

  it("deduplicates the post-recovery forced health pass but still permits manual re-check", async () => {
    settings.mcpServers[0] = { ...server(), status: "error", error: "identity_unavailable" };
    connect.mockResolvedValue(healthy);
    revalidateMcpServers(settings.mcpServers, setSettings);
    await tick();
    revalidateMcpServers(settings.mcpServers, setSettings, new Set([server().id]));
    await tick();
    expect(connect).toHaveBeenCalledTimes(1);
    await reconnectMcp(server(), setSettings);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("keeps a real 401 red and bounds its health retries to ten minutes", async () => {
    settings.mcpServers[0] = { ...server(), status: "error", error: authFailure, verifiedAt: undefined };
    connect.mockRejectedValue(new McpAuthError(authFailure));
    revalidateMcpServers(settings.mcpServers, setSettings);
    await tick();
    for (let i = 0; i < 5; i += 1) revalidateMcpServers(settings.mcpServers, setSettings);
    await tick();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(server().status).toBe("error");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000 + 1);
    connect.mockResolvedValue(healthy);
    revalidateMcpServers(settings.mcpServers, setSettings);
    await tick();
    clock.mockRestore();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(server().status).toBe("connected");
  });

  it.each(["The saved sign-in was rejected by the provider — press “Sign in” to authorize again.", "principal_conflict", "Bearer token is missing."])("does not auto-retry a definitive verdict: %s", (error) => {
    settings.mcpServers[0] = { ...server(), status: "error", error };
    revalidateMcpServers(settings.mcpServers, setSettings);
    expect(connect).not.toHaveBeenCalled();
    expect(server().status).toBe("error");
  });

  it("does not let a late failing health check overwrite a newer manual success", async () => {
    let rejectOld!: (error: Error) => void;
    connect.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    revalidateMcpServers(settings.mcpServers, setSettings);
    connect.mockResolvedValueOnce(healthy);
    await reconnectMcp(server(), setSettings);
    rejectOld(new McpAuthError(authFailure));
    await tick();
    expect(server().status).toBe("connected");
    expect(server().identity).toBe("Verified now");
    expect(server().error).toBeUndefined();
  });

  it.each(["edit", "disable", "remove", "account"])("ignores a stale successful check after %s", async (action) => {
    let finish!: (value: typeof healthy) => void;
    connect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    revalidateMcpServers(settings.mcpServers, setSettings);
    if (action === "edit") settings.mcpServers[0] = { ...server(), url: "https://other.example/mcp", status: "idle" };
    if (action === "disable") settings.mcpServers[0] = { ...server(), enabled: false, status: "idle" };
    if (action === "remove") { invalidateMcpHealth(server().id); settings.mcpServers = []; }
    if (action === "account") { invalidateAuthSession(); settings.mcpServers[0] = { ...server(), status: "idle" }; }
    finish(healthy);
    await tick();
    expect(settings.mcpServers.some((item) => item.identity === "Verified now")).toBe(false);
    if (action === "account") expect(mcpHealthState("testerarmy").lastHealthyAt).toBe(0);
  });
});
