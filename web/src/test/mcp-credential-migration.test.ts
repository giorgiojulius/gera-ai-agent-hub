// One-time move of MCP sign-ins out of the browser: legacy grants are purged,
// cards that depended on one show the honest re-sign-in notice, vault-backed
// and keyed cards are untouched, and Diagnostics gets counts only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOKENS_KEY = "gera.mcp.oauth.tokens.v1";

describe("one-time move of sign-ins into the vault (web/src/lib/mcp-credential-migration)", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    vi.resetModules();
    store = new Map<string, string>();
    const storage = {
      get length(): number {
        return store.size;
      },
      key: (index: number): string | null => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    vi.stubGlobal("window", { localStorage: storage });
    vi.stubGlobal("localStorage", storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const server = (over: Record<string, unknown>) => ({
    id: "x",
    name: "X",
    url: "https://mcp.example.com/mcp",
    headersJson: "",
    enabled: true,
    status: "connected",
    tools: [{ name: "t" }],
    disabledTools: [],
    verifiedAt: 1_700_000_000_000,
    identity: "proof",
    ...over,
  });

  it("marks cards that depended on a browser grant, keeps vault-backed and keyed cards, and reports counts", async () => {
    const token = { accessToken: "a", tokenEndpoint: "https://t", clientId: "c" };
    store.set(
      TOKENS_KEY,
      JSON.stringify({ github: token, linear: token, "custom-auto": token, "vaulted": token, "asleep": token }),
    );
    const { normalizeStoredSettings } = await import("@/lib/history");
    const { migrateBrowserGrantsToVault, loadMcpCredentialMigrationReport, describeMcpCredentialMigration, VAULT_RESIGNIN_NOTICE } =
      await import("@/lib/mcp-credential-migration");
    const settings = normalizeStoredSettings({
      mcpServers: [
        // Device-flow GitHub card under a generated instance id — relied on the "github" grant.
        server({ id: "gh-1", catalogId: "github", name: "GitHub", url: "https://api.github.com" }),
        // OAuth catalog server whose grant lived only here.
        server({ id: "linear", catalogId: "linear", authMode: "oauth", url: "https://mcp.linear.app/mcp" }),
        // Custom auto server that fell back to OAuth.
        server({ id: "custom-auto" }),
        // Vault already holds this one — nothing changes for the user.
        server({ id: "vaulted", authMode: "oauth", credentialStored: true }),
        // Pasted key: untouched even though a stale grant existed under its id.
        server({ id: "keyed", authMode: "bearer", token: "sk-live" }),
        // Idle card: nothing to retire.
        server({ id: "asleep", authMode: "oauth", status: "idle", tools: [] }),
        // Unrelated connected server without a grant: untouched.
        server({ id: "open", authMode: "none" }),
      ],
    });

    const { settings: next, report } = migrateBrowserGrantsToVault(settings, 1_800_000_000_000);
    const byId = new Map(next.mcpServers.map((item) => [item.id, item] as const));
    for (const id of ["gh-1", "linear", "custom-auto"]) {
      expect(byId.get(id)?.status, id).toBe("error");
      expect(byId.get(id)?.error, id).toBe(VAULT_RESIGNIN_NOTICE);
      expect(byId.get(id)?.credentialStored, id).toBe(false);
      expect(byId.get(id)?.identity, id).toBeUndefined();
      expect(byId.get(id)?.verifiedAt, id).toBeUndefined();
    }
    expect(byId.get("vaulted")?.status).toBe("connected");
    expect(byId.get("keyed")?.status).toBe("connected");
    expect(byId.get("keyed")?.token).toBe("sk-live");
    expect(byId.get("asleep")?.status).toBe("idle");
    expect(byId.get("open")?.status).toBe("connected");
    expect(report).toEqual({
      at: 1_800_000_000_000,
      moved: 1,
      awaiting: 3,
      serverIds: ["gh-1", "linear", "custom-auto", "vaulted", "asleep"],
    });
    expect(store.has(TOKENS_KEY)).toBe(false);
    expect(loadMcpCredentialMigrationReport()).toEqual(report);
    expect(describeMcpCredentialMigration(report)).toBe(
      "Browser grants retired · 1 sign-in moved to the vault · 3 await a fresh sign-in",
    );
    // The stored report carries ids and counts only — never a token.
    expect(store.get("gera.mcp.oauth.migration.v1")).not.toContain("accessToken");

    // Nothing left locally: the next boot is a no-op and returns the same object.
    const again = migrateBrowserGrantsToVault(next);
    expect(again.settings).toBe(next);
    expect(again.report).toBeNull();
  });

  it("is a no-op for a browser that never held a grant", async () => {
    const { normalizeStoredSettings } = await import("@/lib/history");
    const { migrateBrowserGrantsToVault, describeMcpCredentialMigration } = await import("@/lib/mcp-credential-migration");
    const settings = normalizeStoredSettings({ mcpServers: [server({ id: "linear", authMode: "oauth" })] });
    const result = migrateBrowserGrantsToVault(settings);
    expect(result.settings).toBe(settings);
    expect(result.report).toBeNull();
    expect(describeMcpCredentialMigration(null)).toBeNull();
    expect(store.has("gera.mcp.oauth.migration.v1")).toBe(false);
  });
});
