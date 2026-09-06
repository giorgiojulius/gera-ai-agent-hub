import type { ChatSql } from "./chat-shared";
import type { CloudMcpTool } from "./mcp-cloud";
import { isRecord, normalizeServerCapabilities, normalizeToolAnnotations, type McpPromptInfo, type McpResourceInfo, type McpResourceTemplateInfo, type McpServerCapabilities, type McpWireInfo } from "./mcp-protocol";
import { normalizeCatalogWire } from "./mcp-catalog-wire";

export const CONNECT_BUDGET_MS = 20_000;
export const RUN_CATALOG_CHARS = 24_000_000;
export const DEFERRED_TOOLS_PER_SERVER = 5_000;
export const DEFERRED_SCHEMA_CHARS = 6_000_000;
export const CATALOG_TTL_MS = 10 * 60_000;
const CATALOG_ROW_CHARS = 1_500_000;
/** Full redacted remote table; per-run visibility filtering never changes the stored table. */
export type McpCatalogEntry = {
  serverId: string; serverName: string; tools: CloudMcpTool[]; fetchedAt: number;
  prompts?: McpPromptInfo[]; resources?: McpResourceInfo[]; resourceTemplates?: McpResourceTemplateInfo[];
  capabilities?: McpServerCapabilities; wire?: McpWireInfo;
};
export type McpCatalogStore = {
  read(serverId: string): McpCatalogEntry | null;
  write(entry: McpCatalogEntry): void;
  invalidate(serverId: string): void;
};
/** Inventory completeness marker, distinct from an empty but complete inventory. */
export function catalogHasInventory(entry: McpCatalogEntry | null): entry is McpCatalogEntry & { prompts: McpPromptInfo[] } {
  return entry !== null && Array.isArray(entry.prompts);
}
/** Full tool refreshes preserve previously gathered inventory and negotiation metadata. */
function mergeEntry(previous: McpCatalogEntry | null, entry: McpCatalogEntry): McpCatalogEntry {
  return { ...previous, ...entry, wire: normalizeCatalogWire(entry.wire ?? previous?.wire) };
}
/** Run-local catalog for tests and owner-catalog replicas. */
export function createMemoryMcpCatalogStore(): McpCatalogStore {
  const entries = new Map<string, McpCatalogEntry>();
  return { read: (id) => entries.get(id) ?? null, write: (entry) => { entries.set(entry.serverId, mergeEntry(entries.get(entry.serverId) ?? null, entry)); }, invalidate: (id) => { entries.delete(id); } };
}
const CATALOG_TABLE_READY = new WeakSet<object>();
function ensureCatalogTable(sql: ChatSql): void {
  if (CATALOG_TABLE_READY.has(sql)) return;
  sql.exec(`CREATE TABLE IF NOT EXISTS mcp_tool_catalog (
    owner_email TEXT NOT NULL, server_id TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_email, server_id)
  )`);
  CATALOG_TABLE_READY.add(sql);
}
function normalizeCatalogTools(value: unknown): CloudMcpTool[] {
  if (!Array.isArray(value)) return [];
  const tools: CloudMcpTool[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name) continue;
    const annotations = normalizeToolAnnotations(raw.annotations);
    tools.push({
      name: raw.name,
      description: typeof raw.description === "string" ? raw.description : raw.name,
      inputSchema: isRecord(raw.inputSchema) ? raw.inputSchema : { type: "object", properties: {} },
      ...(typeof raw.title === "string" && raw.title ? { title: raw.title } : {}),
      ...(annotations ? { annotations } : {}), ...(raw.uiOnly === true ? { uiOnly: true } : {}),
    });
  }
  return tools;
}
function normalizeCatalogInventory(parsed: Record<string, unknown>): Pick<McpCatalogEntry, "prompts" | "resources" | "resourceTemplates" | "capabilities"> {
  if (!Array.isArray(parsed.prompts)) return {};
  const list = <T>(value: unknown, key: string): T[] => Array.isArray(value) ? value.filter((item) => isRecord(item) && typeof item[key] === "string") as T[] : [];
  return { prompts: list<McpPromptInfo>(parsed.prompts, "name"), resources: list<McpResourceInfo>(parsed.resources, "uri"), resourceTemplates: list<McpResourceTemplateInfo>(parsed.resourceTemplates, "uriTemplate"), capabilities: normalizeServerCapabilities(parsed.capabilities) };
}
/** Owner-account SQL store. Large catalogs still work in a run without exceeding SQLite's row limit. */
export function createSqlMcpCatalogStore(sql: ChatSql, owner: string): McpCatalogStore {
  ensureCatalogTable(sql);
  const store: McpCatalogStore = {
    read(serverId) {
      const row = sql.exec<{ payload: string; updated_at: number }>("SELECT payload, updated_at FROM mcp_tool_catalog WHERE owner_email = ? AND server_id = ?", owner, serverId).toArray()[0];
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.payload) as unknown;
        if (!isRecord(parsed)) return null;
        const wire = normalizeCatalogWire(parsed.wire);
        return { serverId, serverName: typeof parsed.serverName === "string" ? parsed.serverName : serverId, tools: normalizeCatalogTools(parsed.tools), fetchedAt: row.updated_at, ...normalizeCatalogInventory(parsed), ...(wire ? { wire } : {}) };
      } catch { return null; }
    },
    write(input) {
      const entry = mergeEntry(store.read(input.serverId), input);
      const payload = JSON.stringify({ v: 2, serverName: entry.serverName, tools: entry.tools,
        ...(entry.wire ? { wire: entry.wire } : {}),
        ...(entry.prompts ? { prompts: entry.prompts, resources: entry.resources ?? [], resourceTemplates: entry.resourceTemplates ?? [], capabilities: entry.capabilities ?? {} } : {}),
      });
      if (payload.length > CATALOG_ROW_CHARS) return;
      sql.exec("INSERT OR REPLACE INTO mcp_tool_catalog (owner_email, server_id, payload, updated_at) VALUES (?, ?, ?, ?)", owner, entry.serverId, payload, entry.fetchedAt);
    },
    invalidate(serverId) { sql.exec("DELETE FROM mcp_tool_catalog WHERE owner_email = ? AND server_id = ?", owner, serverId); },
  };
  return store;
}
/** Revives non-secret catalog data arriving from the owner-account internal hop. */
export function normalizeMcpCatalogEntries(raw: unknown): McpCatalogEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: McpCatalogEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.serverId !== "string" || !item.serverId) continue;
    const wire = normalizeCatalogWire(item.wire);
    out.push({ serverId: item.serverId, serverName: typeof item.serverName === "string" && item.serverName ? item.serverName : item.serverId,
      tools: normalizeCatalogTools(item.tools), fetchedAt: typeof item.fetchedAt === "number" && Number.isFinite(item.fetchedAt) ? item.fetchedAt : 0,
      ...normalizeCatalogInventory(item), ...(wire ? { wire } : {}),
    });
  }
  return out;
}
