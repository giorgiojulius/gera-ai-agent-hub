import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedFetch, relayFetch } from "@/lib/backend";
import { diagnosticContextOf, redactSecrets, withDiagnosticContext } from "@/lib/diagnostic-context";
import {
  describeError,
  listDiagnostics,
  logDiagnostic,
  resetDiagnosticsForTests,
  unseenDiagnosticsCount,
} from "@/lib/diagnostics";
import { connectMcpServer, McpAuthError } from "@/lib/mcp";
import type { McpServerConfig } from "@/lib/types";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("diagnostics journal", () => {
  beforeEach(() => {
    resetDiagnosticsForTests();
  });

  afterEach(() => {
    resetDiagnosticsForTests();
    vi.unstubAllGlobals();
  });

  it("records a surfaced error", () => {
    logDiagnostic("chat", "The run failed on the server", "model timeout");
    const entries = listDiagnostics();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.scope).toBe("chat");
    expect(entries[0]?.message).toBe("The run failed on the server");
    expect(entries[0]?.detail).toBe("model timeout");
    expect(unseenDiagnosticsCount()).toBe(1);
  });

  it("skips user aborts and known browser noise", () => {
    logDiagnostic("chat", new DOMException("Stopped.", "AbortError"));
    logDiagnostic("app", "ResizeObserver loop limit exceeded");
    logDiagnostic("promise", "Script error.");
    expect(listDiagnostics()).toHaveLength(0);
  });

  it("collapses identical bursts", () => {
    logDiagnostic("mcp", "GitHub disconnected");
    logDiagnostic("mcp", "GitHub disconnected");
    expect(listDiagnostics()).toHaveLength(1);
  });

  it("keeps bursts apart when their detail differs (two connectors, one message)", () => {
    logDiagnostic("mcp", "This server needs a sign-in.", { server: "github" });
    logDiagnostic("mcp", "This server needs a sign-in.", { server: "linear" });
    expect(listDiagnostics()).toHaveLength(2);
  });

  it("keeps distinct scopes and messages", () => {
    logDiagnostic("chat", "The run failed on the server");
    logDiagnostic("mcp", "This server needs a key or sign-in.");
    expect(listDiagnostics().map((entry) => entry.scope)).toEqual(["mcp", "chat"]);
  });

  it("writes the full picture: context, error type, cause chain and stack", () => {
    const cause = withDiagnosticContext(new Error("upstream said no"), { status: 403 });
    const error = withDiagnosticContext(new McpAuthError("GitHub needs a sign-in"), {
      path: "POST /mcp/check",
      code: "server_auth_missing",
      serverDetail: [{ id: "github", grantPresent: false, state: "ready" }],
    });
    (error as { cause?: unknown }).cause = cause;
    logDiagnostic("mcp", error, { server: "github", action: "health-check" });
    const entry = listDiagnostics()[0];
    expect(entry?.message).toBe("GitHub needs a sign-in");
    const detail = entry?.detail ?? "";
    expect(detail).toContain("server: github");
    expect(detail).toContain("action: health-check");
    expect(detail).toContain("type: McpAuthError");
    expect(detail).toContain("path: POST /mcp/check");
    expect(detail).toContain("code: server_auth_missing");
    expect(detail).toContain('serverDetail: [{"id":"github","grantPresent":false,"state":"ready"}]');
    expect(detail).toContain("caused by: Error: upstream said no");
    expect(detail).toContain("  status: 403");
    expect(detail).toContain("stack:");
    expect(detail).not.toContain("McpAuthError: GitHub needs a sign-in\n"); // headline is not duplicated
  });

  it("never stores credential-shaped text", () => {
    const error = withDiagnosticContext(new Error("Bad credentials for ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), {
      headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U" },
      body: '{"accessToken":"gho_1234567890abcdefghijklmnopqrstuv","login":"octocat"}',
      url: "/mcp/oauth-status?state=abc123&serverId=linear",
    });
    logDiagnostic("mcp", error);
    const entry = listDiagnostics()[0];
    expect(entry?.message).toBe("Bad credentials for [redacted-github-token]");
    const detail = entry?.detail ?? "";
    expect(detail).not.toContain("gho_1234567890");
    expect(detail).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(detail).toContain('"accessToken":"[redacted]"');
    expect(detail).toContain('"login":"octocat"');
    expect(detail).toContain("state=[redacted]&serverId=linear");
  });

  it("journals every failed backend round-trip with route, status, headers and body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "server_auth_missing", detail: [{ id: "github", grantPresent: false }] }), {
          status: 400,
          headers: { "Content-Type": "application/json", "CF-Ray": "8f00-DME" },
        }),
      ),
    );
    const response = await authedFetch("/mcp/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: { id: "github", catalogId: "github", token: "ghp_secretsecretsecretsecret1234" } }),
    });
    expect(response.status).toBe(400);
    // The caller's body is untouched by the journal's clone.
    expect(await response.json()).toMatchObject({ error: "server_auth_missing" });
    await flush();
    const entry = listDiagnostics()[0];
    expect(entry?.scope).toBe("api");
    expect(entry?.message).toBe("HTTP 400 · POST /mcp/check");
    const detail = entry?.detail ?? "";
    expect(detail).toContain("route: POST /mcp/check");
    expect(detail).toContain("status: 400");
    expect(detail).toContain("server.id=github");
    expect(detail).toContain('"CF-Ray":"8f00-DME"');
    expect(detail).toContain('"error":"server_auth_missing"');
    expect(detail).toContain('"grantPresent":false');
    expect(detail).not.toContain("ghp_secretsecret");
  });

  it("journals network failures with the route and the underlying error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(authedFetch("/github-proxy?serverId=github&path=%2Fuser")).rejects.toThrow("Failed to fetch");
    await flush();
    const entry = listDiagnostics()[0];
    expect(entry?.scope).toBe("api");
    expect(entry?.message).toBe("network · GET /github-proxy · Failed to fetch");
    expect(entry?.detail).toContain("route: GET /github-proxy?serverId=github&path=%2Fuser");
    expect(entry?.detail).toContain("status: no response");
  });

  it("never journals the journal's own routes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    await authedFetch("/diag/append", { method: "POST", body: "{}" });
    await flush();
    expect(listDiagnostics()).toHaveLength(0);
  });

  it("records relay failures with the upstream target", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "Content-Type": "application/json" } })),
    );
    const response = await relayFetch("/mcp-proxy", "https://mcp.example.com/mcp", { method: "POST", body: "{}" });
    expect(response.status).toBe(404);
    await flush();
    const entry = listDiagnostics()[0];
    expect(entry?.message).toBe("HTTP 404 · POST /mcp-proxy");
    expect(entry?.detail).toContain("route: POST /mcp-proxy → https://mcp.example.com/mcp");
  });

  it("attaches the server check verdict to the connector error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: "server_auth_missing",
            detail: [
              { id: "mcp-legacy-7", grantPresent: false, revoked: false, secret: "none", state: "ready" },
              { id: "github", grantPresent: false, revoked: true, secret: "none", state: "ready" },
            ],
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const server: McpServerConfig = {
      id: "mcp-legacy-7",
      catalogId: "github",
      name: "GitHub",
      url: "",
      enabled: true,
      status: "connected",
      authMode: "auto",
      token: "gera-account:github",
      headersJson: "",
      disabledTools: [],
      tools: [],
      credentialStored: true,
    };
    let caught: unknown;
    try {
      await connectMcpServer(server);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(McpAuthError);
    expect((caught as Error).message).toContain("mcp-legacy-7: no grant; github: no grant");
    const context = diagnosticContextOf(caught);
    expect(context).toMatchObject({
      path: "POST /mcp/check",
      status: 400,
      code: "server_auth_missing",
      serverId: "mcp-legacy-7",
      catalogId: "github",
    });
    expect(Array.isArray(context?.serverDetail)).toBe(true);
    const text = describeError(caught);
    expect(text).toContain('"revoked":true');
  });
});

describe("redactSecrets", () => {
  it("scrubs provider tokens, bearer values, JWTs and credential JSON fields", () => {
    const text = [
      "Authorization: Bearer gho_abcdefghijklmnopqrstuvwxyz0123",
      "slack xoxb-1234567890-abcdefghij",
      "pat github_pat_11AAAAAAA0abcdefghijklmnop",
      '{"refresh_token":"r-1","client_secret":"s","login":"ok"}',
      "sk-proj-abcdefghijklmnopqrstuvwxyz",
    ].join("\n");
    const out = redactSecrets(text);
    expect(out).not.toMatch(/gho_|xoxb-|github_pat_|sk-proj/);
    expect(out).toContain("Bearer [redacted]");
    expect(out).toContain('"refresh_token":"[redacted]"');
    expect(out).toContain('"client_secret":"[redacted]"');
    expect(out).toContain('"login":"ok"');
  });

  it("leaves ordinary ids and paths alone", () => {
    const text = "GET /github-proxy?serverId=github&path=%2Fuser%2Frepos flowId=abc";
    expect(redactSecrets(text)).toBe(text);
  });
});
