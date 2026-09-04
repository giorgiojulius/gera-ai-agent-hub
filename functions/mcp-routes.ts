// Account-shard MCP routes that go beyond tools: the composer's prompt (`/`)
// and resource (`@`) menus. Connection and credentials stay server-side — the
// browser only names a server id, a prompt name / resource URI, and
// arguments. Handlers are plain functions over a small seam (`McpRouteContext`)
// so ChatStore's dispatch stays a few lines and the logic is unit-testable.
//
// Phase 6 moves the remaining `/mcp/*` handlers (check, resolve, auth-lease,
// OAuth state machine) here through the same seam.

import type { ChatSql } from "./chat-shared";
import {
  connectCloudMcp,
  getCloudMcpPrompt,
  readCloudMcpResource,
  redactCloudMcpText,
  cloudServerRedactions,
  type CloudMcpServer,
} from "./mcp-cloud";
import { DEFERRED_TOOLS_PER_SERVER, CATALOG_TTL_MS, catalogHasInventory, createSqlMcpCatalogStore } from "./mcp-toolset";
import type { McpFetch } from "./mcp-protocol";

export type McpRouteContext = {
  sql: ChatSql;
  /**
   * Resolves the owner's connected generic MCP servers (auth attached, expiring
   * grants refreshed) for the given ids — the same path `/mcp/resolve` uses.
   */
  resolveServers(owner: string, ids: string[]): Promise<CloudMcpServer[]>;
  /** Injected transport for tests; production keeps the public-HTTPS guard. */
  fetch?: McpFetch;
  now?: () => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

const ID_LIMIT = 80;

function serverIdOf(body: Record<string, unknown>): string {
  const raw = typeof body.serverId === "string" ? body.serverId.trim() : "";
  return raw && raw.length <= ID_LIMIT ? raw : "";
}

async function resolveOne(ctx: McpRouteContext, owner: string, serverId: string): Promise<CloudMcpServer | null> {
  const servers = await ctx.resolveServers(owner, [serverId]);
  return servers.find((server) => server.id === serverId && server.kind === "mcp") ?? null;
}

function failure(server: CloudMcpServer | null, error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback;
  return server ? redactCloudMcpText(raw, cloudServerRedactions(server)) : raw;
}

/**
 * POST /mcp/inventory { serverId, refresh? } → { prompts, resources,
 * resourceTemplates, toolCount, cached }. Served from the account's catalog
 * cache when a recent handshake listed the inventory; otherwise one bounded
 * handshake refreshes the cache for the next menu open.
 */
export async function handleMcpInventory(ctx: McpRouteContext, request: Request, owner: string): Promise<Response> {
  const body = await readBody(request);
  const serverId = body ? serverIdOf(body) : "";
  if (!body || !serverId) {
    return json({ error: "invalid_body" }, 400);
  }
  const now = ctx.now ?? (() => Date.now());
  const catalog = createSqlMcpCatalogStore(ctx.sql, owner);
  const cached = catalog.read(serverId);
  if (body.refresh !== true && catalogHasInventory(cached) && now() - cached.fetchedAt < CATALOG_TTL_MS) {
    return json({
      prompts: cached.prompts,
      resources: cached.resources ?? [],
      resourceTemplates: cached.resourceTemplates ?? [],
      toolCount: cached.tools.length,
      cached: true,
    });
  }
  const server = await resolveOne(ctx, owner, serverId);
  if (!server) {
    return json({ error: "server_unavailable" }, 404);
  }
  try {
    const connection = await connectCloudMcp(server, {
      maxTools: DEFERRED_TOOLS_PER_SERVER,
      includeDisabled: true,
      inventory: true,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    });
    catalog.write({
      serverId: server.id,
      serverName: server.name,
      tools: connection.tools,
      fetchedAt: now(),
      prompts: connection.prompts,
      resources: connection.resources,
      resourceTemplates: connection.resourceTemplates,
      capabilities: connection.session.capabilities ?? {},
    });
    return json({
      prompts: connection.prompts,
      resources: connection.resources,
      resourceTemplates: connection.resourceTemplates,
      toolCount: connection.tools.length,
      cached: false,
    });
  } catch (error) {
    return json({ error: failure(server, error, "MCP server did not answer") }, 502);
  }
}

const PROMPT_ARG_CHARS = 20_000;

/** POST /mcp/prompt-get { serverId, name, arguments? } → { description?, messages }. */
export async function handleMcpPromptGet(ctx: McpRouteContext, request: Request, owner: string): Promise<Response> {
  const body = await readBody(request);
  const serverId = body ? serverIdOf(body) : "";
  const name = body && typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
  if (!body || !serverId || !name) {
    return json({ error: "invalid_body" }, 400);
  }
  const args: Record<string, string> = {};
  if (isRecord(body.arguments)) {
    for (const [key, value] of Object.entries(body.arguments).slice(0, 40)) {
      if (typeof value === "string") {
        args[key.slice(0, 100)] = value.slice(0, PROMPT_ARG_CHARS);
      } else if (typeof value === "number" || typeof value === "boolean") {
        args[key.slice(0, 100)] = String(value);
      }
    }
  }
  const server = await resolveOne(ctx, owner, serverId);
  if (!server) {
    return json({ error: "server_unavailable" }, 404);
  }
  try {
    const connection = await connectCloudMcp(server, {
      maxTools: 1,
      includeDisabled: true,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    });
    if (!connection.session.capabilities?.prompts) {
      return json({ error: `MCP server "${server.name}" does not offer prompts.` }, 400);
    }
    const prompt = await getCloudMcpPrompt(connection.session, name, args);
    return json(prompt);
  } catch (error) {
    return json({ error: failure(server, error, "prompts/get failed") }, 502);
  }
}

/** POST /mcp/resource-read { serverId, uri } → { contents }. */
export async function handleMcpResourceRead(ctx: McpRouteContext, request: Request, owner: string): Promise<Response> {
  const body = await readBody(request);
  const serverId = body ? serverIdOf(body) : "";
  const uri = body && typeof body.uri === "string" ? body.uri.trim().slice(0, 2_000) : "";
  if (!body || !serverId || !uri) {
    return json({ error: "invalid_body" }, 400);
  }
  const server = await resolveOne(ctx, owner, serverId);
  if (!server) {
    return json({ error: "server_unavailable" }, 404);
  }
  try {
    const connection = await connectCloudMcp(server, {
      maxTools: 1,
      includeDisabled: true,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    });
    if (!connection.session.capabilities?.resources) {
      return json({ error: `MCP server "${server.name}" does not offer resources.` }, 400);
    }
    const contents = await readCloudMcpResource(connection.session, uri);
    return json({ contents });
  } catch (error) {
    return json({ error: failure(server, error, "resources/read failed") }, 502);
  }
}
