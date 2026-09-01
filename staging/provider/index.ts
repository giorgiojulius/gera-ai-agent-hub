import { DurableObject } from "cloudflare:workers";

type ProviderEnv = {
  PROVIDER_STATE: DurableObjectNamespace;
  CONTROL_SECRET: string;
};

type ProviderConfig = {
  accessTtlSeconds: number;
  mcpDelayMs: number;
  refreshDelayMs: number;
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
  generation: number;
};

type AuthorizationCode = {
  challenge: string;
  redirectUri: string;
  clientId: string;
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
  generation: 0,
};

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
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
      const body = (await request.json().catch(() => null)) as { redirect_uris?: unknown } | null;
      const redirectUri = Array.isArray(body?.redirect_uris) ? String(body?.redirect_uris[0] ?? "") : "";
      if (!redirectUri.startsWith("https://")) return json({ error: "invalid_redirect_uri" }, 400);
      return json({ client_id: "gera-blackbox-client", client_secret_expires_at: 0 });
    }
    if (url.pathname === "/authorize" && request.method === "GET") {
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const challenge = url.searchParams.get("code_challenge") ?? "";
      const clientId = url.searchParams.get("client_id") ?? "";
      if (!redirectUri.startsWith("https://") || !state || !challenge || !clientId) {
        return json({ error: "invalid_request" }, 400);
      }
      const code = randomValue("code");
      const item: AuthorizationCode = { challenge, redirectUri, clientId, used: false };
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
      return this.handleToken(request);
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      return this.handleMcp(request);
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

  private async handleToken(request: Request): Promise<Response> {
    const params = new URLSearchParams(await request.text());
    const grantType = params.get("grant_type") ?? "";
    const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
    if (idempotencyKey) {
      const replay = await this.ctx.storage.get<{ status: number; body: unknown }>(`idem:${idempotencyKey}`);
      if (replay) return json(replay.body, replay.status);
    }
    if (grantType === "authorization_code") {
      const code = params.get("code") ?? "";
      const verifier = params.get("code_verifier") ?? "";
      const stored = await this.ctx.storage.get<AuthorizationCode>(`code:${code}`);
      if (!stored || stored.used || !verifier || (await s256(verifier)) !== stored.challenge) {
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
    return json(body);
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
      }, 200, { "Mcp-Session-Id": `session-${pair.generation}` });
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
