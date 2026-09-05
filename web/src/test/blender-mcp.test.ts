import { describe, expect, it } from "vitest";

import { cloudMcpServersForAutomation } from "../../../functions/mcp-cloud";
import { addCatalogMcp, addMissingCatalogMcps } from "@/lib/agent-store";
import { BLENDER_BRIDGE_COMMAND, blenderConnectionInput, blenderEndpointError, blenderSetupSchema, type BlenderSetupValues } from "@/lib/blender-mcp";
import { normalizeStoredSettings } from "@/lib/history";
import { catalogEntryToServer, findCatalogEntry, missingCatalogEntries } from "@/lib/mcp-catalog";
import type { McpServerConfig } from "@/lib/types";

function values(patch: Partial<BlenderSetupValues> = {}): BlenderSetupValues {
  return { url: "https://blender.example.com/mcp", auth: "cloudflare", token: "", clientId: "fixture-client.access", clientSecret: "fixture-credential", acknowledged: true, ...patch };
}

function server(patch: Partial<McpServerConfig> = {}): McpServerConfig {
  return { ...blenderConnectionInput(values()), id: "blender", enabled: true, status: "connected", tools: [], disabledTools: ["execute_blender_code"], ...patch };
}

describe("Blender MCP setup", () => {
  it("is a Design setup entry, never an invented public MCP endpoint", () => {
    const entry = findCatalogEntry("blender");
    expect(entry).toMatchObject({ setup: "blender", category: "design", url: "", auth: "token" });
    expect(entry?.docsUrl).toContain("github.com/ahujasid/blender-mcp");
    expect(() => catalogEntryToServer(entry!)).toThrow(/requires setup/);
    expect(missingCatalogEntries([]).some((item) => item.id === "blender")).toBe(false);
    const settings = normalizeStoredSettings({});
    expect(addCatalogMcp(settings, "blender")).toBe(settings);
    expect(addMissingCatalogMcps(settings).mcpServers.some((item) => item.catalogId === "blender")).toBe(false);
  });

  it.each([
    "", "uvx blender-mcp", '{"command":"uvx","args":["blender-mcp"]}',
    "http://localhost:9876", "https://localhost:8000/mcp", "https://192.168.1.2/mcp",
    "https://127.0.0.1.nip.io/mcp", "http://blender.example.com/mcp", "https://user:password@blender.example.com/mcp",
    "https://blender.example.com:9876/mcp", "https://blender.example.com/mcp?token=credential",
    "https://blender.example.com/mcp#credential", "https://github.com/ahujasid/blender-mcp",
  ])("rejects a non-bridge or credential-bearing endpoint: %s", (url) => {
    expect(blenderEndpointError(url)).toBeTruthy();
    expect(blenderSetupSchema.safeParse(values({ url })).success).toBe(false);
  });

  it("requires an acknowledgement and the chosen authentication, without leaking input in errors", () => {
    expect(blenderSetupSchema.safeParse(values({ acknowledged: false })).success).toBe(false);
    expect(blenderSetupSchema.safeParse(values({ clientSecret: "" })).success).toBe(false);
    expect(blenderSetupSchema.safeParse(values({ auth: "bearer" })).success).toBe(false);
    const invalid = blenderSetupSchema.safeParse(values({ clientSecret: "do-not-echo\r\nheader" }));
    expect(invalid.success).toBe(false);
    if (!invalid.success) expect(JSON.stringify(invalid.error.issues)).not.toContain("do-not-echo");
  });

  it("passes Cloudflare service credentials as headers, not Bearer or URL parameters", () => {
    const input = blenderConnectionInput(values({ token: "unused-token" }));
    expect(input).toMatchObject({ catalogId: "blender", authMode: "headers", token: "", url: "https://blender.example.com/mcp" });
    expect(JSON.parse(input.headersJson)).toEqual({ "CF-Access-Client-Id": "fixture-client.access", "CF-Access-Client-Secret": "fixture-credential" });
    const armed = cloudMcpServersForAutomation([server()], ["blender"], {});
    expect(armed).toHaveLength(1);
    expect(armed[0]).toMatchObject({ id: "blender", kind: "mcp", url: input.url, disabledTools: ["execute_blender_code"] });
    expect(armed[0].headers).toEqual(JSON.parse(input.headersJson));
  });

  it("supports a protected Bearer bridge and discards unused Cloudflare fields", () => {
    const input = blenderConnectionInput(values({ auth: "bearer", token: "fixture-bearer" }));
    expect(input.headersJson).toBe("");
    const armed = cloudMcpServersForAutomation([server(input)], ["blender"], {});
    expect(armed[0]?.headers.Authorization).toBe("Bearer fixture-bearer");
  });

  it("preserves user-hosted URLs, catalog identity and tool choices across profile normalization", () => {
    const settings = normalizeStoredSettings({ mcpServers: [server()] });
    expect(settings.mcpServers[0]).toMatchObject({ id: "blender", catalogId: "blender", url: "https://blender.example.com/mcp", authMode: "headers", disabledTools: ["execute_blender_code"] });
    expect(cloudMcpServersForAutomation([server({ status: "idle" })], ["blender"], {})).toEqual([]);
    expect(cloudMcpServersForAutomation([server({ url: "http://localhost:9876" })], ["blender"], {})).toEqual([]);
  });

  it("keeps the documented bridge on loopback, using stdio and telemetry opt-out", () => {
    expect(BLENDER_BRIDGE_COMMAND).toContain("--host 127.0.0.1 --port 8000");
    expect(BLENDER_BRIDGE_COMMAND).toContain("-e DISABLE_TELEMETRY true -- uvx blender-mcp");
    expect(BLENDER_BRIDGE_COMMAND).not.toContain("--allow-origin");
  });
});
