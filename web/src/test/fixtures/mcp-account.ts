import type { ChatSql, SqlRowValue } from "../../../../functions/chat-shared";
import { SecretVault } from "../../../../functions/secret-vault";
import type { OAuthStoreContext } from "../../../../functions/mcp-oauth-store";

type Row = Record<string, SqlRowValue>;
/** Minimal account SQL for integration tests; unknown writes fail instead of silently succeeding. */
export function mcpAccountFixture(owner: string, servers: unknown[]) {
  const rows = new Map<string, Row[]>([["profiles", [{ owner_email: owner, payload: JSON.stringify({ settings: { mcpServers: servers, mcpToolLoading: "deferred" } }) }]]]);
  const sql: ChatSql = {
    exec<T extends Record<string, SqlRowValue>>(query: string, ...params: unknown[]) {
      const q = query.replace(/\s+/g, " ").trim();
      let result: Row[] = [];
      const select = /^SELECT .+? FROM (\w+)/.exec(q);
      if (select) {
        result = (rows.get(select[1]) ?? []).filter((row) => row.owner_email === params[0] && (!/server_id = \?/.test(q) || row.server_id === params[1]));
      } else if (q.startsWith("CREATE TABLE")) {
        result = [];
      } else if (q.startsWith("INSERT OR REPLACE INTO mcp_tool_catalog")) {
        const table = (rows.get("mcp_tool_catalog") ?? []).filter((row) => row.owner_email !== params[0] || row.server_id !== params[1]);
        table.push({ owner_email: String(params[0]), server_id: String(params[1]), payload: String(params[2]), updated_at: Number(params[3]) });
        rows.set("mcp_tool_catalog", table);
      } else if (q.startsWith("DELETE FROM")) {
        const table = q.split(" ")[2];
        rows.set(table, (rows.get(table) ?? []).filter((row) => row.owner_email !== params[0] || row.server_id !== params[1]));
      } else { throw new Error(`Unsupported fixture SQL: ${q}`); }
      return { toArray: () => result as T[] };
    },
  };
  const ctx: OAuthStoreContext = {
    sql, subject: (email) => email,
    vault: SecretVault.forTesting("XWtIHN16zXsdcxtMZnNBsL6qQxVqG45bVMb1llWkYtg="),
    storage: { get: async () => undefined, delete: async () => false, list: async () => new Map() },
  };
  return { ctx, rows };
}
