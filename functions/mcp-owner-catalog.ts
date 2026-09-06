import { isValidId } from "./chat-shared";
import { createSqlMcpCatalogStore, normalizeMcpCatalogEntries } from "./mcp-catalog";
import { cloudServerRedactions } from "./mcp-cloud";
import { isRecord, redactMcpValue } from "./mcp-protocol-shared";
import { resolveOwnerMcpServers, type OAuthStoreContext } from "./mcp-oauth-store";

/** Synchronous revision capture, rechecked immediately before catalog publication. */
function ownerCatalogSnapshot(ctx: OAuthStoreContext, owner: string, serverId: string): string {
  const profile = ctx.sql.exec<{ payload: string }>("SELECT payload FROM profiles WHERE owner_email = ?", owner).toArray()[0]?.payload ?? "";
  const secrets = ctx.sql.exec<{ server_id: string; updated_at: number }>("SELECT server_id, updated_at FROM mcp_server_secrets WHERE owner_email = ?", owner).toArray();
  const grants = ctx.sql.exec<{ server_id: string; updated_at: number }>("SELECT server_id, updated_at FROM mcp_oauth_grants WHERE owner_email = ?", owner).toArray();
  return JSON.stringify([serverId, profile, secrets, grants]);
}
/** Opaque internal generation: never returns the captured profile or credential values. */
export async function ownerCatalogGeneration(ctx: OAuthStoreContext, owner: string, serverId: string, snapshot: string = ownerCatalogSnapshot(ctx, owner, serverId)): Promise<string> {
  const data = new TextEncoder().encode(snapshot);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Internal owner-account write-back only; never added to the public MCP relay allowlist. */
export async function handleMcpCatalogWrite(ctx: OAuthStoreContext, request: Request, owner: string): Promise<Response> {
  const text = await request.text();
  if (text.length > 1_500_000) return Response.json({ error: "catalog_too_large" }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text) as unknown; } catch { return Response.json({ error: "invalid_body" }, { status: 400 }); }
  if (!isRecord(body) || typeof body.generation !== "string") return Response.json({ error: "invalid_body" }, { status: 400 });
  const entry = normalizeMcpCatalogEntries([body.entry])[0];
  if (!entry || !isValidId(entry.serverId)) return Response.json({ error: "invalid_catalog" }, { status: 400 });
  const snapshot = ownerCatalogSnapshot(ctx, owner, entry.serverId);
  const resolved = await resolveOwnerMcpServers(ctx, owner, [entry.serverId], new Set(), { refresh: false });
  const server = resolved?.servers.find((item) => item.id === entry.serverId);
  if (!server) return Response.json({ error: "server_unavailable" }, { status: 404 });
  const generation = await ownerCatalogGeneration(ctx, owner, entry.serverId, snapshot);
  request.signal.throwIfAborted();
  if (generation !== body.generation || snapshot !== ownerCatalogSnapshot(ctx, owner, entry.serverId)) return Response.json({ error: "catalog_generation_changed" }, { status: 409 });
  const clean = normalizeMcpCatalogEntries([redactMcpValue(entry, cloudServerRedactions(server))])[0];
  if (!clean) return Response.json({ error: "invalid_catalog" }, { status: 400 });
  const catalog = createSqlMcpCatalogStore(ctx.sql, owner);
  if ((catalog.read(entry.serverId)?.fetchedAt ?? 0) > clean.fetchedAt) return Response.json({ ok: true, superseded: true });
  catalog.write({ ...clean, serverName: server.name, fetchedAt: Math.min(Date.now(), clean.fetchedAt) });
  return Response.json({ ok: true });
}
