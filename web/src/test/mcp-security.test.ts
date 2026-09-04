import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { armCloudMcp } from "../../../functions/automation-runner";
import { INTERCOM_NATIVE_TOOLS as CLOUD_INTERCOM_TOOLS } from "../../../functions/native-intercom";
import { SLACK_NATIVE_TOOLS as CLOUD_SLACK_TOOLS } from "../../../functions/native-slack";
import {
  callCloudMcpTool,
  cloudMcpFunctionName,
  cloudMcpServersForAutomation,
  connectCloudMcp,
  forceRefreshCloudOAuth,
  redactCloudMcpText,
  redactCloudMcpValue,
  type CloudMcpServer,
  type CloudMcpSession,
  type CloudOAuthToken,
} from "../../../functions/mcp-cloud";
import { fetchPublicHttps, isForbiddenHost, safePublicHttpsUrl } from "../../../functions/network-safety";
import { relayFetch } from "@/lib/backend";
import { normalizeStoredSettings } from "@/lib/history";
import { INTERCOM_NATIVE_TOOLS as BROWSER_INTERCOM_TOOLS } from "@/lib/intercom-native";
import { FEATURED_MCP_IDS, MCP_CATALOG, findCatalogEntry } from "@/lib/mcp-catalog";
import {
  callMcpTool,
  clearMcpSessionCache,
  connectMcpServerLegacy,
  mcpFunctionName,
} from "@/lib/mcp";
import {
  beginOAuthGrantFlow,
  hasOAuthToken,
  oauthAuthHeader,
  safeOAuthEndpoint,
  storeExternalOAuthToken,
} from "@/lib/mcp-oauth";
import { SLACK_NATIVE_TOOLS as BROWSER_SLACK_TOOLS } from "@/lib/slack-native";
import type { McpServerConfig } from "@/lib/types";

const ACCESS_TOKEN_KEY = "rork:access_token";

function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "custom",
    name: "Custom",
    url: "https://mcp.example.com/mcp",
    headersJson: "",
    enabled: true,
    status: "connected",
    tools: [],
    disabledTools: [],
    ...overrides,
  };
}

function cloudGrant(overrides: Partial<CloudOAuthToken> = {}): CloudOAuthToken {
  return {
    accessToken: "oauth-access",
    refreshToken: "oauth-refresh",
    expiresAt: Date.now() + 60_000,
    tokenEndpoint: "https://auth.example.com/token",
    clientId: "client",
    mcpUrl: "https://mcp.example.com/mcp",
    ...overrides,
  };
}

function rpcJson(id: number | undefined, result: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), result }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
  });
}

function requestBody(init?: RequestInit): { id?: number; method?: string; params?: Record<string, unknown> } {
  return JSON.parse(String(init?.body ?? "{}")) as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
  };
}

describe("MCP catalog contract", () => {
  it("keeps all 98 entries unique and every featured id real", () => {
    expect(MCP_CATALOG).toHaveLength(98);
    expect(new Set(MCP_CATALOG.map((entry) => entry.id)).size).toBe(MCP_CATALOG.length);
    expect(new Set(MCP_CATALOG.map((entry) => entry.url.replace(/\/$/, ""))).size).toBe(MCP_CATALOG.length);
    expect(FEATURED_MCP_IDS.every((id) => Boolean(findCatalogEntry(id)))).toBe(true);
    expect(MCP_CATALOG.every((entry) => safePublicHttpsUrl(entry.url) !== null)).toBe(true);
  });

  it("keeps native Slack and Intercom browser/Worker tool contracts identical", () => {
    expect(BROWSER_SLACK_TOOLS).toEqual(CLOUD_SLACK_TOOLS);
    expect(BROWSER_INTERCOM_TOOLS).toEqual(CLOUD_INTERCOM_TOOLS);
    expect(BROWSER_SLACK_TOOLS.length).toBeGreaterThan(0);
    expect(BROWSER_INTERCOM_TOOLS.length).toBeGreaterThan(0);
  });

  it("uses the providers' current safe token placements and canonical URLs", () => {
    expect(findCatalogEntry("firecrawl")).toMatchObject({
      url: "https://mcp.firecrawl.dev/v2/mcp",
      tokenOptional: true,
    });
    expect(findCatalogEntry("firecrawl")?.tokenUrlTemplate).toBeUndefined();
    expect(findCatalogEntry("exa")?.tokenHeader).toBe("x-api-key");
    expect(findCatalogEntry("searchapi")?.tokenHeader).toBe("X-MCP-Token");
    expect(findCatalogEntry("chainstack")?.tokenOptional).toBe(true);
    expect(findCatalogEntry("zapier")).toMatchObject({
      url: "https://mcp.zapier.com/api/v1/connect",
      auth: "token",
    });
    expect(findCatalogEntry("octagon")?.url).toBe("https://mcp.octagonai.co/mcp");
    expect(findCatalogEntry("datadog")?.url).toBe("https://mcp.datadoghq.com/v1/mcp");
    expect(findCatalogEntry("box")?.auth).toBe("token");
  });

  it("migrates persisted stale catalog endpoints without touching custom URLs", () => {
    const settings = normalizeStoredSettings({
      mcpServers: [
        config({ id: "firecrawl", catalogId: "firecrawl", url: "https://mcp.firecrawl.dev/mcp" }),
        config({ id: "zapier", catalogId: "zapier", url: "https://mcp.zapier.com" }),
        config({ id: "custom", url: "https://customer.example.com/mcp" }),
      ],
    });
    expect(settings.mcpServers.map((server) => server.url)).toEqual([
      "https://mcp.firecrawl.dev/v2/mcp",
      "https://mcp.zapier.com/api/v1/connect",
      "https://customer.example.com/mcp",
    ]);
  });
});

describe("MCP outbound network safety", () => {
  it("blocks private, local, mapped, documentation, and credential-bearing destinations", () => {
    const blockedHosts = [
      "localhost.",
      "service.internal",
      "127.0.0.1",
      "10.1.2.3",
      "100.64.0.1",
      "169.254.169.254",
      "172.31.0.2",
      "192.168.1.2",
      "198.18.0.1",
      "203.0.113.10",
      "::1",
      "::ffff:7f00:1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "127.0.0.1.nip.io",
      "192.168.1.2.sslip.io",
      "localtest.me",
      "64:ff9b::7f00:1",
      "2002:7f00:0001::",
    ];
    for (const host of blockedHosts) {
      expect(isForbiddenHost(host), host).toBe(true);
    }
    expect(safePublicHttpsUrl("http://mcp.example.com")).toBeNull();
    expect(safePublicHttpsUrl("https://user:pass@mcp.example.com")).toBeNull();
    expect(safePublicHttpsUrl("https://mcp.context7.com/mcp")?.hostname).toBe("mcp.context7.com");
  });

  it("refuses private and cross-origin POST redirects before sending credentials twice", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        calls.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") });
        return new Response(null, { status: 307, headers: { Location: "https://127.0.0.1/private" } });
      }),
    );
    await expect(
      fetchPublicHttps("https://public.example.com/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        body: "{}",
      }),
    ).rejects.toThrow(/redirect target/i);
    expect(calls).toEqual([{ url: "https://public.example.com/mcp", authorization: "Bearer secret" }]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> =>
        new Response(null, { status: 307, headers: { Location: "https://other.example.com/mcp" } }),
      ),
    );
    await expect(
      fetchPublicHttps("https://public.example.com/mcp", { method: "POST", body: "{}" }),
    ).rejects.toThrow(/cross-origin/i);
  });
});

describe("MCP OAuth boundaries", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    vi.stubGlobal("window", { localStorage: storage, dispatchEvent: vi.fn() });
    vi.stubGlobal("localStorage", storage);
  });

  afterEach(() => {
    clearMcpSessionCache();
    vi.unstubAllGlobals();
  });

  it("rejects executable, insecure, and credential-bearing metadata endpoints", () => {
    for (const endpoint of [
      "javascript:alert(document.domain)",
      "data:text/html,boom",
      "http://auth.example.com/authorize",
      "https://user:pass@auth.example.com/authorize",
      "https://127.0.0.1/authorize",
      "https://127.0.0.1.nip.io/authorize",
      "not a url",
    ]) {
      expect(() => safeOAuthEndpoint(endpoint), endpoint).toThrow();
    }
    expect(safeOAuthEndpoint("https://auth.example.com/authorize")).toBe(
      "https://auth.example.com/authorize",
    );
  });

  it("surfaces a Gera relay gate failure instead of treating it as a provider 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> =>
        new Response(JSON.stringify({ error: "sign_in_required" }), {
          status: 401,
          headers: { "X-Gera-Relay-Auth": "required" },
        }),
      ),
    );
    await expect(
      relayFetch("/mcp-proxy", "https://provider.example.com/mcp", {
        headers: { Authorization: "Bearer provider-secret" },
      }),
    ).rejects.toThrow(/Sign in to Gera/i);
  });

  it("binds new grants to their MCP endpoint", async () => {
    const flow = beginOAuthGrantFlow("bound");
    storeExternalOAuthToken("bound", {
      accessToken: "secret",
      refreshToken: "refresh",
      tokenEndpoint: "https://auth.example.com/token",
      clientId: "client",
      mcpUrl: "https://one.example.com/mcp",
    }, flow);
    expect(hasOAuthToken("bound", "https://one.example.com/mcp")).toBe(true);
    expect(hasOAuthToken("bound", "https://two.example.com/mcp")).toBe(false);
    await expect(oauthAuthHeader("bound", "https://two.example.com/mcp")).resolves.toBeNull();
  });

  it("separates Gera auth from provider auth and does not retry a provider 401", async () => {
    store.set(ACCESS_TOKEN_KEY, "gera-jwt");
    const requests: Array<{ auth: string | null; upstream: string | null; target: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        requests.push({
          auth: headers.get("Authorization"),
          upstream: headers.get("X-Gera-Upstream-Authorization"),
          target: headers.get("X-Gera-Upstream-Url"),
        });
        return new Response("unauthorized", { status: 401 });
      }),
    );
    const response = await relayFetch("/mcp-proxy", "https://provider.example.com/mcp", {
      headers: { Authorization: "Bearer provider-secret" },
    });
    expect(response.status).toBe(401);
    expect(requests).toEqual([
      {
        auth: "Bearer gera-jwt",
        upstream: "Bearer provider-secret",
        target: "https://provider.example.com/mcp",
      },
    ]);
  });
});

describe("browser/cloud MCP auth parity", () => {
  it("makes none, bearer, headers, oauth, and auto mutually consistent in cloud runs", () => {
    const grant = cloudGrant();
    const resolve = (
      patch: Record<string, unknown>,
      oauth: Record<string, CloudOAuthToken> = { custom: grant },
    ): CloudMcpServer | undefined =>
      cloudMcpServersForAutomation(
        [
          {
            ...config(),
            token: "stale-token",
            headersJson: '{"Authorization":"Bearer stale","X-Key":"custom"}',
            ...patch,
          },
        ],
        null,
        oauth,
      )[0];

    expect(resolve({ authMode: "none" })).toMatchObject({ headers: {}, oauth: undefined });
    expect(resolve({ authMode: "bearer", token: "fresh" })?.headers.Authorization).toBe("Bearer fresh");
    expect(resolve({ authMode: "bearer", token: "" })).toBeUndefined();
    expect(resolve({ authMode: "headers" })).toMatchObject({
      headers: { Authorization: "Bearer stale", "X-Key": "custom" },
      oauth: undefined,
    });
    expect(resolve({ authMode: "oauth" })).toMatchObject({ headers: {}, oauth: grant });
    expect(resolve({ authMode: "auto", token: "fresh" })?.headers.Authorization).toBe("Bearer fresh");
    expect(
      resolve({ authMode: "auto", token: "", headersJson: '{"X-Key":"custom"}' }),
    ).toMatchObject({ headers: { "X-Key": "custom" }, oauth: grant });
    expect(resolve({ authMode: "headers", headersJson: "not json" })).toBeUndefined();
    expect(resolve({ status: "error" })).toBeUndefined();
  });

  it("honors every catalog token-placement exception and open Chainstack", () => {
    const resolveCatalog = (id: string, token: string): CloudMcpServer | undefined => {
      const entry = findCatalogEntry(id);
      if (!entry) {
        throw new Error(`missing ${id}`);
      }
      return cloudMcpServersForAutomation(
        [{ ...config({ id, catalogId: id, name: entry.name, url: entry.url }), token }],
        null,
      )[0];
    };
    expect(resolveCatalog("exa", "exa-secret")?.headers).toEqual({ "x-api-key": "exa-secret" });
    expect(resolveCatalog("searchapi", "search-secret")?.headers).toEqual({
      "X-MCP-Token": "search-secret",
    });
    expect(resolveCatalog("firecrawl", "fc-secret")).toMatchObject({
      url: "https://mcp.firecrawl.dev/v2/mcp",
      headers: { Authorization: "Bearer fc-secret" },
    });
    expect(resolveCatalog("octagon", "oct-secret")?.url).toBe(
      "https://mcp.octagonai.co/oct-secret/mcp",
    );
    expect(resolveCatalog("chainstack", "")?.url).toBe("https://mcp.chainstack.com/mcp");
  });

  it("rejects endpoint-swapped OAuth and private cloud endpoints", () => {
    expect(
      cloudMcpServersForAutomation(
        [{ ...config({ authMode: "oauth", url: "https://other.example.com/mcp" }) }],
        null,
        { custom: cloudGrant() },
      ),
    ).toEqual([]);
    expect(
      cloudMcpServersForAutomation(
        [{ ...config({ url: "https://127.0.0.1/mcp", authMode: "none" }) }],
        null,
      ),
    ).toEqual([]);
  });
});

describe("MCP protocol compatibility", () => {
  afterEach(() => {
    clearMcpSessionCache();
    vi.unstubAllGlobals();
  });

  it("paginates tools and uses the server-negotiated protocol in the browser", async () => {
    const seen: Array<{ method: string; protocol: string | null; session: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const body = requestBody(init);
        const headers = new Headers(init?.headers);
        seen.push({
          method: body.method ?? "",
          protocol: headers.get("MCP-Protocol-Version"),
          session: headers.get("Mcp-Session-Id"),
        });
        if (body.method === "initialize") {
          return rpcJson(body.id, {
            protocolVersion: "2025-03-26",
            serverInfo: { name: "Paged", version: "1" },
          }, { "Mcp-Session-Id": "session-1" });
        }
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (body.method === "tools/list" && body.params?.cursor === "next") {
          return rpcJson(body.id, { tools: [{ name: "second" }] });
        }
        if (body.method === "tools/list") {
          return rpcJson(body.id, { tools: [{ name: "first" }], nextCursor: "next" });
        }
        throw new Error(`unexpected ${body.method}`);
      }),
    );
    const connection = await connectMcpServerLegacy(config({ id: "paged-browser", authMode: "none" }));
    expect(connection.tools.map((tool) => tool.name)).toEqual(["first", "second"]);
    expect(seen.find((item) => item.method === "tools/list")).toMatchObject({
      protocol: "2025-03-26",
      session: "session-1",
    });
  });

  // Cloud pagination, version negotiation, the MCP-Protocol-Version header,
  // isError and resource_link handling run against the real SDK server in
  // mcp-conformance.test.ts — only failures a conforming server never
  // produces stay mocked here.

  it("finishes on a matching event even when an SSE stream stays open", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "early-result" }] } })}\n\n`,
          ),
        );
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> =>
        new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      ),
    );
    const session: CloudMcpSession = {
      url: "https://stream.example.com/mcp",
      headers: {},
      omitMcpHeaders: false,
      nextId: 0,
    };
    await expect(callCloudMcpTool(session, "read", {})).resolves.toBe("early-result");
  });

  it("does not replay a side-effectful call from JSON-RPC session wording", async () => {
    let initializeCalls = 0;
    let toolCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const body = requestBody(init);
        if (body.method === "initialize") {
          initializeCalls += 1;
          return rpcJson(body.id, { protocolVersion: "2025-06-18" }, { "Mcp-Session-Id": "s1" });
        }
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (body.method === "tools/list") {
          return rpcJson(body.id, { tools: [{ name: "mutate" }] });
        }
        if (body.method === "tools/call") {
          toolCalls += 1;
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "Session expired" } }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected ${body.method}`);
      }),
    );
    const server = config({ id: "no-rpc-replay", authMode: "none" });
    await connectMcpServerLegacy(server);
    await expect(callMcpTool(server, "mutate", {})).rejects.toThrow(/Session expired/);
    expect({ initializeCalls, toolCalls }).toEqual({ initializeCalls: 1, toolCalls: 1 });
  });

  it("redacts exact server credentials from provider text and structured values", async () => {
    const secret = "credential-with-special+/characters";
    expect(redactCloudMcpText(`echo ${secret} and ${encodeURIComponent(secret)}`, [secret]))
      .toBe("echo [REDACTED_CREDENTIAL] and [REDACTED_CREDENTIAL]");
    expect(redactCloudMcpValue({ nested: [secret, { key: `Bearer ${secret}` }] }, [`Bearer ${secret}`]))
      .toEqual({ nested: ["[REDACTED_CREDENTIAL]", { key: "[REDACTED_CREDENTIAL]" }] });
    let deep: unknown = secret;
    for (let index = 0; index < 25; index += 1) deep = { child: deep };
    const redactedDeep = JSON.stringify(redactCloudMcpValue(deep, [secret]));
    expect(redactedDeep).not.toContain(secret);
    expect(redactedDeep).toContain("REDACTED_DEEP_PROVIDER_VALUE");

    vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => rpcJson(1, {
      content: [{ type: "text", text: `provider echoed Bearer ${secret}` }],
      structuredContent: { leaked: secret },
    })));
    const result = await callCloudMcpTool({
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: `Bearer ${secret}` },
      omitMcpHeaders: false,
      protocolVersion: "2025-06-18",
      nextId: 0,
      redactions: [`Bearer ${secret}`, secret],
    }, "echo", {});
    expect(result).toContain("[REDACTED_CREDENTIAL]");
    expect(result).not.toContain(secret);
  });

  it("uses stable, valid, collision-resistant names in both clients", () => {
    const cases = [
      ["github", "get_contents"],
      ["ab-c", "read-file"],
      ["ab_c", "read_file"],
      ["сервер / one", "tool.with punctuation"],
      ["very-long-server-id-".repeat(5), "very-long-tool-name-".repeat(5)],
    ] as const;
    for (const [serverId, toolName] of cases) {
      const browser = mcpFunctionName(serverId, toolName);
      expect(cloudMcpFunctionName(serverId, toolName)).toBe(browser);
      expect(browser).toMatch(/^[a-z0-9_]+$/);
      expect(browser.length).toBeLessThanOrEqual(64);
    }
    expect(mcpFunctionName("ab-c", "read-file")).not.toBe(mcpFunctionName("ab_c", "read_file"));
    expect(mcpFunctionName("srv", "getUser")).not.toBe(mcpFunctionName("srv", "getuser"));
    expect(mcpFunctionName("srv", "...")).toBe(cloudMcpFunctionName("srv", "..."));
    expect(mcpFunctionName("github", "get_contents")).toBe("mcp_github_get_contents");
  });
});

describe("cloud OAuth refresh concurrency", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("redeems one rotating refresh token only once across concurrent runs", async () => {
    let requests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => {
        requests += 1;
        await Promise.resolve();
        return new Response(
          JSON.stringify({ access_token: "next", refresh_token: "next-refresh", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const makeServer = (): CloudMcpServer => ({
      id: "linear",
      name: "Linear",
      kind: "mcp",
      url: "https://mcp.linear.app/mcp",
      headers: {},
      omitMcpHeaders: false,
      disabledTools: [],
      oauth: cloudGrant({
        accessToken: "old",
        refreshToken: "same-refresh",
        mcpUrl: "https://mcp.linear.app/mcp",
      }),
    });
    const first = makeServer();
    const second = makeServer();
    const firstRotations: Array<{ serverId: string }> = [];
    const secondRotations: Array<{ serverId: string }> = [];
    await Promise.all([
      forceRefreshCloudOAuth(first, firstRotations as never[]),
      forceRefreshCloudOAuth(second, secondRotations as never[]),
    ]);
    expect(requests).toBe(1);
    expect(first.oauth?.accessToken).toBe("next");
    expect(second.oauth?.accessToken).toBe("next");
  });

  it("keeps a completed exchange reusable until stale callers commit it durably", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> =>
      new Response(JSON.stringify({ access_token: "durable-next", refresh_token: "durable-refresh" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const makeServer = (): CloudMcpServer => ({
      id: "durable",
      name: "Durable",
      kind: "mcp",
      url: "https://durable.example.net/mcp",
      headers: {},
      omitMcpHeaders: false,
      disabledTools: [],
      oauth: cloudGrant({
        accessToken: "durable-old",
        refreshToken: "durable-old-refresh",
        tokenEndpoint: "https://durable.example.net/token",
        mcpUrl: "https://durable.example.net/mcp",
      }),
    });
    const commits: string[] = [];
    const persist = async (rotation: { token: CloudOAuthToken }): Promise<void> => {
      commits.push(rotation.token.accessToken);
    };
    const first = makeServer();
    const secondStaleCopy = makeServer();

    await forceRefreshCloudOAuth(first, [], persist);
    await forceRefreshCloudOAuth(secondStaleCopy, [], persist);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(commits).toEqual(["durable-next", "durable-next"]);
    expect(first.oauth?.accessToken).toBe("durable-next");
    expect(secondStaleCopy.oauth?.accessToken).toBe("durable-next");
  });

  it("blocks a server after a permanent refresh failure and reports the durable state input", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const server: CloudMcpServer = {
      id: "expired-permanent",
      name: "Expired permanent",
      kind: "mcp",
      url: "https://permanent.example.com/mcp",
      headers: {},
      omitMcpHeaders: false,
      disabledTools: [],
      oauth: cloudGrant({
        accessToken: "expired-access",
        refreshToken: "expired-refresh",
        expiresAt: 1,
        tokenEndpoint: "https://permanent.example.com/token",
        mcpUrl: "https://permanent.example.com/mcp",
      }),
    };
    const reported: Array<{ serverId: string; code: string; transient: boolean }> = [];

    const runtime = await armCloudMcp([server], undefined, async (serverId, outcome) => {
      reported.push({ serverId, code: outcome.code, transient: outcome.transient });
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reported).toEqual([{ serverId: "expired-permanent", code: "invalid_grant", transient: false }]);
    expect(runtime.routes.size).toBe(0);
    expect(runtime.failures).toEqual([
      expect.objectContaining({ name: "mcp_auth", result: expect.stringContaining("sign-in must be renewed") }),
    ]);
    expect(server.oauth?.accessToken).toBe("expired-access");
  });

  it("never shares a refresh exchange across different resource boundaries", async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const body = String(init?.body ?? "");
        bodies.push(body);
        const resource = new URLSearchParams(body).get("resource") ?? "none";
        return new Response(JSON.stringify({ access_token: `token:${resource}`, expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const make = (resource: string, mcpUrl: string): CloudMcpServer => ({
      id: "same-id",
      name: "Scoped",
      kind: "mcp",
      url: mcpUrl,
      headers: {},
      omitMcpHeaders: false,
      disabledTools: [],
      oauth: cloudGrant({ accessToken: "old", refreshToken: "same-refresh", resource, mcpUrl }),
    });
    const first = make("https://resource-a.example.com", "https://a.example.com/mcp");
    const second = make("https://resource-b.example.com", "https://b.example.com/mcp");
    await Promise.all([
      forceRefreshCloudOAuth(first, []),
      forceRefreshCloudOAuth(second, []),
    ]);
    expect(bodies).toHaveLength(2);
    expect(first.oauth?.accessToken).toContain("resource-a");
    expect(second.oauth?.accessToken).toContain("resource-b");
  });
});
