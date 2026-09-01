import { describe, expect, it } from "vitest";

import {
  handleOwners,
  type ChatStoreRouteContext,
} from "../../../functions/chat-migration-routes";
import type { ChatSql, SqlRowValue } from "../../../functions/chat-shared";

const OWNER_TABLES = [
  "profiles",
  "chats",
  "diagnostics",
  "diag_meta",
  "tombstones",
  "server_runs",
  "mcp_server_secrets",
  "mcp_oauth_grants",
  "mcp_oauth_revocations",
  "mcp_oauth_states",
  "mcp_oauth_clients",
  "mcp_oauth_pending",
  "mcp_github_device_pending",
  "automation_run_receipts",
  "agent_runs",
  "agent_run_receipts",
  "agent_run_media",
] as const;

function routeContext(sql: ChatSql): ChatStoreRouteContext {
  return {
    sql,
    diagMeta: () => ({ seen_at: 0, cleared_at: 0 }),
    nextDueForOwner: async () => 0,
    hooksIndexValue: () => "",
    markShardInitialized: async () => undefined,
    shardOwner: async () => "",
    hasOwnerStorage: async () => false,
    prepareProfilePayload: async (_owner: string, payload: string) => payload,
    exportOwnerStorage: async () => [],
    importOwnerStorage: async () => undefined,
  };
}

describe("legacy owner enumeration", () => {
  it("keeps every compound SELECT within workerd's five-term SQLite limit", async () => {
    let query = "";
    let bindings: unknown[] = [];
    const sql: ChatSql = {
      exec<T extends Record<string, SqlRowValue>>(statement: string, ...values: unknown[]) {
        query = statement;
        bindings = values;
        return {
          toArray: () => [
            { owner_email: "a@example.com" },
            { owner_email: "z@example.com" },
          ] as unknown as T[],
        };
      },
    };

    const response = await handleOwners(
      routeContext(sql),
      new Request("https://worker.example/owners", {
        method: "POST",
        body: JSON.stringify({ limit: 99 }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      owners: ["a@example.com", "z@example.com"],
    });
    expect(bindings).toEqual([20]);
    for (const table of OWNER_TABLES) {
      expect(query).toContain(`FROM ${table}`);
    }
    const groups = [...query.matchAll(/owner_group_\d AS \(([\s\S]*?)\n\s*\)(?:,|\n)/g)];
    expect(groups).toHaveLength(4);
    for (const group of groups) {
      expect(group[1].match(/SELECT owner_email/g)?.length ?? 0).toBeLessThanOrEqual(5);
    }
    const allOwners = query.match(/all_owners AS \(([\s\S]*?)\n\s*\)\n\s*SELECT owner_email/);
    expect(allOwners?.[1].match(/SELECT owner_email/g)?.length ?? 0).toBe(4);
    expect(query).toContain("NOT IN (SELECT owner_email FROM migrated_owners)");
    expect(query).toContain("ORDER BY owner_email");
  });
});
