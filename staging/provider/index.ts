import { DurableObject } from "cloudflare:workers";

type ProviderEnv = {
  PROVIDER_STATE: DurableObjectNamespace;
  CONTROL_SECRET: string;
  GATEWAY_SECRET: string;
};

type ProviderConfig = {
  accessTtlSeconds: number;
  mcpDelayMs: number;
  refreshDelayMs: number;
  refreshResponseDelayMs: number;
  idempotencyReplayDelayMs: number;
  gatewayFinalDelayMs: number;
  holdRefreshResponse: boolean;
  holdGatewayFinal: boolean;
  mcp401Once: boolean;
  refresh503Once: boolean;
  invalidGrant: boolean;
};

type ProviderStats = {
  registrations: number;
  authorizations: number;
  codeExchanges: number;
  refreshes: number;
  initialize: number;
  toolLists: number;
  toolCalls: number;
  gatewayCalls: number;
  violations: number;
  generation: number;
};

type AuthorizationCode = {
  challenge: string;
  redirectUri: string;
  clientId: string;
  resource: string;
  used: boolean;
};

type TokenPair = {
  access: string;
  refresh: string;
  expiresAt: number;
  generation: number;
};

const DEFAULT_CONFIG: ProviderConfig = {
  accessTtlSeconds: 3,
  mcpDelayMs: 0,
  refreshDelayMs: 0,
  refreshResponseDelayMs: 0,
  idempotencyReplayDelayMs: 0,
  gatewayFinalDelayMs: 0,
  holdRefreshResponse: false,
  holdGatewayFinal: false,
  mcp401Once: false,
  refresh503Once: false,
  invalidGrant: false,
};

const DEFAULT_STATS: ProviderStats = {
  registrations: 0,
  authorizations: 0,
  codeExchanges: 0,
  refreshes: 0,
  initialize: 0,
  toolLists: 0,
  toolCalls: 0,
  gatewayCalls: 0,
  violations: 0,
  generation: 0,
};

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
  });
}

function delayedJson(data: unknown, delayMs: number, status: number = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await sleep(delayMs);
      controller.enqueue(encoder.encode(JSON.stringify(data)));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function sse(events: unknown[]): Response {
  const payload = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(payload, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
    },
  });
}

function randomValue(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function s256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, 55_000))));
}

export class ProviderState extends DurableObject<ProviderEnv> {
  private tokenQueue: Promise<void> = Promise.resolve();

  private async withTokenLock<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.tokenQueue;
    let release: () => void = () => undefined;
    this.tokenQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async config(): Promise<ProviderConfig> {
    return { ...DEFAULT_CONFIG, ...((await this.ctx.storage.get<Partial<ProviderConfig>>("config")) ?? {}) };
  }

  private async stats(): Promise<ProviderStats> {
    return { ...DEFAULT_STATS, ...((await this.ctx.storage.get<Partial<ProviderStats>>("stats")) ?? {}) };
  }

  private async bump(key: keyof ProviderStats): Promise<ProviderStats> {
    const stats = await this.stats();
    stats[key] += 1;
    await this.ctx.storage.put("stats", stats);
    return stats;
  }

  private async tokenPair(): Promise<TokenPair | null> {
    return (await this.ctx.storage.get<TokenPair>("tokenPair")) ?? null;
  }

  private authorized(request: Request): boolean {
    const expected = this.env.CONTROL_SECRET;
    return Boolean(expected) && request.headers.get("Authorization") === `Bearer ${expected}`;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;

    if (url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource") {
      return json({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["tools:read", "offline_access"],
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["tools:read", "offline_access"],
      });
    }
    if (url.pathname === "/register" && request.method === "POST") {
      await this.bump("registrations");
      const body = (await request.json().catch(() => null)) as {
        redirect_uris?: unknown;
        token_endpoint_auth_method?: unknown;
      } | null;
      const redirectUri = Array.isArray(body?.redirect_uris) ? String(body?.redirect_uris[0] ?? "") : "";
      if (!redirectUri.startsWith("https://") || body?.token_endpoint_auth_method !== "none") {
        return json({ error: "invalid_redirect_uri" }, 400);
      }
      await this.ctx.storage.put("client:gera-blackbox-client", { redirectUri });
      return json({ client_id: "gera-blackbox-client", client_secret_expires_at: 0 });
    }
    if (url.pathname === "/authorize" && request.method === "GET") {
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const challenge = url.searchParams.get("code_challenge") ?? "";
      const clientId = url.searchParams.get("client_id") ?? "";
      const resource = url.searchParams.get("resource") ?? "";
      const registration = await this.ctx.storage.get<{ redirectUri: string }>(`client:${clientId}`);
      if (
        !redirectUri.startsWith("https://") ||
        !state ||
        !challenge ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        url.searchParams.get("response_type") !== "code" ||
        !registration ||
        registration.redirectUri !== redirectUri ||
        resource !== `${origin}/mcp`
      ) {
        return json({ error: "invalid_request" }, 400);
      }
      const code = randomValue("code");
      const item: AuthorizationCode = { challenge, redirectUri, clientId, resource, used: false };
      await this.ctx.storage.put(`code:${code}`, item);
      await this.bump("authorizations");
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", state);
      target.searchParams.set("iss", origin);
      console.log("provider authorize issued");
      return new Response(null, { status: 302, headers: { Location: target.toString(), "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/token" && request.method === "POST") {
      return this.withTokenLock(() => this.handleToken(request));
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      return this.handleMcp(request);
    }
    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      return this.handleGateway(request);
    }
    if (url.pathname === "/control" && request.method === "POST") {
      if (!this.authorized(request)) return json({ error: "unauthorized" }, 401);
      const patch = (await request.json().catch(() => null)) as Partial<ProviderConfig> & { reset?: boolean } | null;
      if (!patch) return json({ error: "invalid_body" }, 400);
      if (patch.reset) {
        await this.ctx.storage.deleteAll();
        return json({ ok: true });
      }
      const current = await this.config();
      const next: ProviderConfig = {
        accessTtlSeconds: Number.isFinite(patch.accessTtlSeconds)
          ? Math.max(1, Math.min(3_600, Math.floor(patch.accessTtlSeconds ?? current.accessTtlSeconds)))
          : current.accessTtlSeconds,
        mcpDelayMs: Number.isFinite(patch.mcpDelayMs)
          ? Math.max(0, Math.min(55_000, Math.floor(patch.mcpDelayMs ?? current.mcpDelayMs)))
          : current.mcpDelayMs,
        refreshDelayMs: Number.isFinite(patch.refreshDelayMs)
          ? Math.max(0, Math.min(55_000, Math.floor(patch.refreshDelayMs ?? current.refreshDelayMs)))
          : current.refreshDelayMs,
        refreshResponseDelayMs: Number.isFinite(patch.refreshResponseDelayMs)
          ? Math.max(0, Math.min(55_000, Math.floor(patch.refreshResponseDelayMs ?? current.refreshResponseDelayMs)))
          : current.refreshResponseDelayMs,
        idempotencyReplayDelayMs: Number.isFinite(patch.idempotencyReplayDelayMs)
          ? Math.max(0, Math.min(55_000, Math.floor(patch.idempotencyReplayDelayMs ?? current.idempotencyReplayDelayMs)))
          : current.idempotencyReplayDelayMs,
        gatewayFinalDelayMs: Number.isFinite(patch.gatewayFinalDelayMs)
          ? Math.max(0, Math.min(55_000, Math.floor(patch.gatewayFinalDelayMs ?? current.gatewayFinalDelayMs)))
          : current.gatewayFinalDelayMs,
        holdRefreshResponse: patch.holdRefreshResponse ?? current.holdRefreshResponse,
        holdGatewayFinal: patch.holdGatewayFinal ?? current.holdGatewayFinal,
        mcp401Once: patch.mcp401Once ?? current.mcp401Once,
        refresh503Once: patch.refresh503Once ?? current.refresh503Once,
        invalidGrant: patch.invalidGrant ?? current.invalidGrant,
      };
      await this.ctx.storage.put("config", next);
      return json({ ok: true, config: next });
    }
    if (url.pathname === "/stats" && request.method === "GET") {
      if (!this.authorized(request)) return json({ error: "unauthorized" }, 401);
      const pair = await this.tokenPair();
      return json({
        stats: await this.stats(),
        config: await this.config(),
        grant: pair ? { generation: pair.generation, expired: pair.expiresAt <= Date.now() } : null,
      });
    }
    return json({ error: "not_found" }, 404);
  }

  private async waitUntilReleased(key: "holdRefreshResponse" | "holdGatewayFinal"): Promise<void> {
    const deadline = Date.now() + 55_000;
    while ((await this.config())[key] && Date.now() < deadline) {
      await sleep(100);
    }
  }

  private async handleToken(request: Request): Promise<Response> {
    const params = new URLSearchParams(await request.text());
    const grantType = params.get("grant_type") ?? "";
    const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
    if (idempotencyKey) {
      const replay = await this.ctx.storage.get<{ status: number; body: unknown }>(`idem:${idempotencyKey}`);
      if (replay) {
        const config = await this.config();
        if (config.holdRefreshResponse) {
          await this.waitUntilReleased("holdRefreshResponse");
        }
        return config.idempotencyReplayDelayMs > 0
          ? delayedJson(replay.body, config.idempotencyReplayDelayMs, replay.status)
          : json(replay.body, replay.status);
      }
    }
    if (grantType === "authorization_code") {
      const code = params.get("code") ?? "";
      const verifier = params.get("code_verifier") ?? "";
      const stored = await this.ctx.storage.get<AuthorizationCode>(`code:${code}`);
      if (
        !stored ||
        stored.used ||
        params.get("client_id") !== stored.clientId ||
        params.get("redirect_uri") !== stored.redirectUri ||
        params.get("resource") !== stored.resource ||
        !verifier ||
        (await s256(verifier)) !== stored.challenge
      ) {
        return json({ error: "invalid_grant" }, 400);
      }
      stored.used = true;
      await this.ctx.storage.put(`code:${code}`, stored);
      await this.bump("codeExchanges");
      const config = await this.config();
      const pair: TokenPair = {
        access: randomValue("access0"),
        refresh: randomValue("refresh0"),
        expiresAt: Date.now() + config.accessTtlSeconds * 1_000,
        generation: 0,
      };
      await this.ctx.storage.put("tokenPair", pair);
      const body = {
        access_token: pair.access,
        refresh_token: pair.refresh,
        expires_in: config.accessTtlSeconds,
        token_type: "Bearer",
      };
      console.log("provider code exchange", pair.generation);
      return json(body);
    }
    if (grantType !== "refresh_token") return json({ error: "unsupported_grant_type" }, 400);
    const config = await this.config();
    if (config.refreshDelayMs > 0) await sleep(config.refreshDelayMs);
    if (config.refresh503Once) {
      await this.ctx.storage.put("config", { ...config, refresh503Once: false });
      await this.bump("refreshes");
      return json({ error: "temporarily_unavailable" }, 503);
    }
    if (config.invalidGrant) {
      await this.bump("refreshes");
      return json({ error: "invalid_grant" }, 400);
    }
    const current = await this.tokenPair();
    if (!current || params.get("refresh_token") !== current.refresh) {
      await this.bump("refreshes");
      return json({ error: "invalid_grant" }, 400);
    }
    const stats = await this.bump("refreshes");
    const nextGeneration = current.generation + 1;
    const pair: TokenPair = {
      access: randomValue(`access${nextGeneration}`),
      refresh: randomValue(`refresh${nextGeneration}`),
      expiresAt: Date.now() + config.accessTtlSeconds * 1_000,
      generation: nextGeneration,
    };
    stats.generation = nextGeneration;
    await this.ctx.storage.put("stats", stats);
    await this.ctx.storage.put("tokenPair", pair);
    const body = {
      access_token: pair.access,
      refresh_token: pair.refresh,
      expires_in: config.accessTtlSeconds,
      token_type: "Bearer",
    };
    if (idempotencyKey) await this.ctx.storage.put(`idem:${idempotencyKey}`, { status: 200, body });
    console.log("provider refresh", nextGeneration);
    if (config.holdRefreshResponse) {
      await this.waitUntilReleased("holdRefreshResponse");
    }
    return config.refreshResponseDelayMs > 0 ? delayedJson(body, config.refreshResponseDelayMs) : json(body);
  }

  private async protocolViolation(message: string): Promise<Response> {
    await this.bump("violations");
    return json({ error: "protocol_violation", message }, 400);
  }

  private async handleGateway(request: Request): Promise<Response> {
    if (!this.env.GATEWAY_SECRET || request.headers.get("Authorization") !== `Bearer ${this.env.GATEWAY_SECRET}`) {
      return json({ error: "unauthorized" }, 401);
    }
    const body = (await request.json().catch(() => null)) as {
      model?: unknown;
      messages?: unknown;
      tools?: unknown;
    } | null;
    if (!body || !Array.isArray(body.messages)) {
      return json({ error: "invalid_request" }, 400);
    }
    const stats = await this.bump("gatewayCalls");
    if (body.model !== "staging/deterministic") {
      return this.protocolViolation("unexpected model");
    }
    const messages = body.messages.filter(
      (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
    );
    const hasToolResult = messages.some((message) => message.role === "tool");
    const model = typeof body.model === "string" && body.model ? body.model : "staging/deterministic";
    if (hasToolResult) {
      const toolMessage = messages.findLast((message) => message.role === "tool");
      const assistantCall = messages.findLast(
        (message) => message.role === "assistant" && Array.isArray(message.tool_calls),
      );
      const firstCall = Array.isArray(assistantCall?.tool_calls)
        ? assistantCall.tool_calls[0] as Record<string, unknown> | undefined
        : undefined;
      const expectedCallId = `blackbox-call-${stats.gatewayCalls - 1}`;
      if (
        !toolMessage ||
        toolMessage.tool_call_id !== expectedCallId ||
        firstCall?.id !== expectedCallId ||
        typeof toolMessage.content !== "string" ||
        !toolMessage.content.includes("durable-once")
      ) {
        return this.protocolViolation("tool result correlation failed");
      }
      const config = await this.config();
      if (config.holdGatewayFinal) {
        await this.waitUntilReleased("holdGatewayFinal");
      }
      if (config.gatewayFinalDelayMs > 0) {
        await sleep(config.gatewayFinalDelayMs);
      }
      return sse([
        {
          id: `staging-final-${stats.gatewayCalls}`,
          model,
          choices: [{ index: 0, delta: { content: "BLACKBOX_RUN_COMPLETE" }, finish_reason: "stop" }],
        },
        { model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ]);
    }
    const tools = Array.isArray(body.tools)
      ? body.tools.filter(
          (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
        )
      : [];
    const toolName = tools
      .map((tool) => {
        const fn = tool.function;
        return fn && typeof fn === "object" && !Array.isArray(fn) && typeof (fn as Record<string, unknown>).name === "string"
          ? String((fn as Record<string, unknown>).name)
          : "";
      })
      .find((name) => name.endsWith("_blackbox_echo"));
    if (!toolName || messages.at(-1)?.role !== "user") {
      return this.protocolViolation("MCP tool or user turn missing");
    }
    return sse([{
      id: `staging-tool-${stats.gatewayCalls}`,
      model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: `blackbox-call-${stats.gatewayCalls}`,
            type: "function",
            function: { name: toolName, arguments: '{"text":"durable-once"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }]);
  }

  private async handleMcp(request: Request): Promise<Response> {
    const config = await this.config();
    if (config.mcpDelayMs > 0) await sleep(config.mcpDelayMs);
    if (config.mcp401Once) {
      await this.ctx.storage.put("config", { ...config, mcp401Once: false });
      return json({ error: "forced_unauthorized" }, 401, { "WWW-Authenticate": `Bearer resource_metadata="${new URL(request.url).origin}/.well-known/oauth-protected-resource/mcp"` });
    }
    const pair = await this.tokenPair();
    const authorization = request.headers.get("Authorization") ?? "";
    if (!pair || authorization !== `Bearer ${pair.access}` || pair.expiresAt <= Date.now()) {
      return json({ error: "invalid_token" }, 401, { "WWW-Authenticate": `Bearer resource_metadata="${new URL(request.url).origin}/.well-known/oauth-protected-resource/mcp"` });
    }
    const rpc = (await request.json().catch(() => null)) as { id?: unknown; method?: unknown; params?: unknown } | null;
    if (!rpc || typeof rpc.method !== "string") return json({ error: "invalid_rpc" }, 400);
    const expectedSession = `session-${pair.generation}`;
    if (rpc.method !== "initialize" && request.headers.get("Mcp-Session-Id") !== expectedSession) {
      return json({ error: "session_not_found" }, 404);
    }
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpc.method === "initialize") {
      await this.bump("initialize");
      return json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "Gera black-box provider", version: "1.0.0" },
        },
      }, 200, { "Mcp-Session-Id": expectedSession });
    }
    if (rpc.method === "tools/list") {
      await this.bump("toolLists");
      return json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          tools: [{
            name: "blackbox_echo",
            description: "Returns the supplied text and increments a durable invocation counter.",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          }],
        },
      });
    }
    if (rpc.method === "tools/call") {
      await this.bump("toolCalls");
      const params = rpc.params && typeof rpc.params === "object" ? (rpc.params as Record<string, unknown>) : {};
      const args = params.arguments && typeof params.arguments === "object"
        ? (params.arguments as Record<string, unknown>)
        : {};
      if (params.name !== "blackbox_echo" || args.text !== "durable-once") {
        return this.protocolViolation("unexpected tool invocation");
      }
      return json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: { content: [{ type: "text", text: String(args.text ?? "") }] },
      });
    }
    return json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
  }
}

export default {
  fetch(request: Request, env: ProviderEnv): Promise<Response> {
    const id = env.PROVIDER_STATE.idFromName("global");
    return env.PROVIDER_STATE.get(id).fetch(request);
  },
};
