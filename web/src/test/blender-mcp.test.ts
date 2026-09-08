import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { cloudMcpServersForAutomation } from "../../../functions/mcp-cloud";
import { addCatalogMcp, addMissingCatalogMcps } from "@/lib/agent-store";
import {
  BLENDER_BRIDGE_COMMAND,
  BLENDER_BRIDGE_SCRIPT_PATH,
  BLENDER_BRIDGE_TOKEN_FILE,
  BLENDER_MCP_PROXY_COMMAND,
  BLENDER_TUNNEL_COMMAND,
  blenderConnectionInput,
  blenderEndpointError,
  blenderSetupSchema,
  type BlenderSetupValues,
} from "@/lib/blender-mcp";
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

  it("documents Gera's self-protecting bridge and pins the third-party alternative", () => {
    expect(BLENDER_BRIDGE_COMMAND).toBe("uv run gera-blender-bridge.py --tunnel");
    expect(BLENDER_BRIDGE_SCRIPT_PATH).toBe("/gera-blender-bridge.py");
    expect(BLENDER_TUNNEL_COMMAND).toBe("cloudflared tunnel --url http://127.0.0.1:8000");
    // mcp-proxy 0.12 has no upper bound on `mcp`; 2.0.0 removed request_ctx and it crashes on import.
    expect(BLENDER_MCP_PROXY_COMMAND).toContain('uvx --with "mcp<2" mcp-proxy');
    expect(BLENDER_MCP_PROXY_COMMAND).toContain("--host 127.0.0.1 --port 8000");
    expect(BLENDER_MCP_PROXY_COMMAND).toContain("-e DISABLE_TELEMETRY true -- uvx blender-mcp");
    expect(BLENDER_MCP_PROXY_COMMAND).not.toContain("--allow-origin");
  });

  it("ships the bridge script: stdlib only, loopback default, mandatory Bearer gate, legacy handshake, telemetry opt-out", () => {
    // A static contract check of the file Gera serves — the live behaviour was exercised separately against a stdio fixture.
    const script = readFileSync(new URL(`../../public${BLENDER_BRIDGE_SCRIPT_PATH}`, import.meta.url), "utf8");
    expect(script.startsWith("#!/usr/bin/env python3\n# /// script\n# requires-python = \">=3.10\"\n# dependencies = []\n# ///\n")).toBe(true);
    const stdlib = new Set(["__future__", "argparse", "hmac", "json", "os", "re", "secrets", "shlex", "shutil", "signal", "subprocess", "sys", "threading", "time", "uuid", "http", "pathlib", "typing"]);
    const imports = [...script.matchAll(/^(?:import|from)\s+([A-Za-z_][\w.]*)/gm)].map((match) => match[1].split(".")[0]);
    expect(imports.length).toBeGreaterThan(10);
    expect(imports.filter((name) => !stdlib.has(name))).toEqual([]);
    expect(script).toContain('DEFAULT_HOST = "127.0.0.1"');
    expect(script).toContain("DEFAULT_PORT = 8000");
    expect(script).toContain('DEFAULT_COMMAND = "uvx blender-mcp"');
    expect(script).toContain('env.setdefault("DISABLE_TELEMETRY", "true")');
    expect(script).toContain("hmac.compare_digest");
    expect(script).toContain('Bearer realm="gera-blender-bridge"');
    expect(script).toContain("if not self._authorized():");
    expect(script).toContain('if method == "server/discover":');
    expect(script).toContain("JSON_RPC_METHOD_NOT_FOUND = -32601");
    // Handshake line only: blender-mcp pins `mcp<2`, whose ceiling is 2025-11-25. The 2026-07-28 revision is the
    // client's probe (discover → -32601 → fallback); the bridge never advertises a newer revision than upstream agreed to.
    expect(script).toContain('SUPPORTED_PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")');
    expect(script).not.toContain('"2026-07-28"');
    expect(script).toContain("requested <= ceiling");
    expect(script).toContain('negotiate_version(requested, upstream.get("protocolVersion"))');
    expect(script).toContain('"tunnel", "--url"');
    expect(script).toContain("trycloudflare");
    expect(script).toContain('Path.home() / ".gera" / "blender-bridge.token"');
    expect(BLENDER_BRIDGE_TOKEN_FILE).toBe("~/.gera/blender-bridge.token");
    // Only the token gates access: no CORS headers are ever emitted for browsers.
    expect(script).not.toContain("Access-Control-Allow");
  });
});
