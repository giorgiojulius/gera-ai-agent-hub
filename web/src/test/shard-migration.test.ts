// Shard migration moves an account out of the legacy global ChatStore into
// its own Durable Object, page by page, then keeps its automations firing by
// reporting the next due time into the global schedule index. A regression
// here silently strands accounts mid-migration — pin the paging protocol,
// fail-closed stall handling, owner normalization, and the sweep's isolation
// of per-owner failures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  chatShardId,
  migrateOwnerToShard,
  sweepGlobalMigrations,
} from "../../../functions/shard-migration";

const ORIGIN = "https://worker.example";

type DoCall = { doId: string; path: string; body: Record<string, unknown> };
type DoReply = { status?: number; json?: unknown; headers?: Record<string, string> };
type MigrationEnv = { DO: { fetch(request: Request): Promise<Response> } };

function makeEnv(respond: (call: DoCall, index: number) => DoReply): {
  env: MigrationEnv;
  calls: DoCall[];
} {
  const calls: DoCall[] = [];
  const env: MigrationEnv = {
    DO: {
      fetch: async (request: Request): Promise<Response> => {
        const body = (await request.json()) as Record<string, unknown>;
        const call: DoCall = {
          doId: request.headers.get("X-Rork-DO-Id") ?? "",
          path: new URL(request.url).pathname,
          body,
        };
        const reply = respond(call, calls.length);
        calls.push(call);
        return new Response(JSON.stringify(reply.json ?? {}), {
          status: reply.status ?? 200,
          headers: reply.headers,
        });
      },
    },
  };
  return { env, calls };
}

describe("shard migration (functions/shard-migration)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("derives one deterministic shard id per account", () => {
    expect(chatShardId("user@example.com")).toBe("acct:user%40example.com");
  });

  it("pages export → import, verifies counts, then unlocks and marks migrated", async () => {
    const { env, calls } = makeEnv((call) => {
      if (call.path === "/export" && call.body.cursor !== "c1") {
        return { json: { done: false, cursor: "c1", rows: ["r1"] } };
      }
      if (call.path === "/export") return { json: { done: true, rows: ["r2"] } };
      if (call.path === "/owner-counts") return { json: { counts: { chats: 2 } } };
      if (call.path === "/import" && call.body.done === true) {
        return { headers: { "X-Gera-Next-Due": "1234" } };
      }
      return {};
    });

    // Raw input is untrimmed and mixed-case — every wire call must carry the
    // normalized owner.
    await migrateOwnerToShard(env, ORIGIN, "  User@Example.COM  ");

    const shard = chatShardId("user@example.com");
    expect(calls.map((c) => `${c.doId} ${c.path}`)).toEqual([
      "global /export",
      `${shard} /import`,
      "global /export",
      `${shard} /import`,
      "global /owner-counts",
      `${shard} /owner-counts`,
      `${shard} /import`,
      "global /schedule-set",
      "global /mark-migrated",
    ]);
    expect(calls[0].body).toEqual({ owner: "user@example.com" });
    expect(calls[1].body).toMatchObject({ owner: "user@example.com", done: false, rows: ["r1"] });
    expect(calls[2].body).toEqual({ owner: "user@example.com", cursor: "c1" });
    expect(calls[3].body).toMatchObject({ done: false, rows: ["r2"] });
    expect(calls[6].body).toEqual({ owner: "user@example.com", done: true });
    expect(calls[7].body).toEqual({ owner: "user@example.com", nextDueAt: 1234 });
    expect(calls[8].body).toEqual({ owner: "user@example.com" });
    // Logs never carry the full address.
    expect(console.log).toHaveBeenCalledWith("shard migration: moved", "us…@example.com");
  });

  it("fails closed when the export cursor stops advancing", async () => {
    const { env, calls } = makeEnv((call) =>
      call.path === "/export"
        ? { json: { done: false, cursor: "", rows: ["r1"] } }
        : {},
    );

    await expect(migrateOwnerToShard(env, ORIGIN, "user@example.com")).rejects.toThrow(
      "export cursor made no forward progress",
    );
    expect(calls.map((c) => c.path)).toEqual(["/export", "/import"]);
    expect(calls.some((call) => call.body.done === true)).toBe(false);
    expect(calls.some((call) => call.path === "/mark-migrated")).toBe(false);
  });

  it("treats a missing next-due header as 0 without reading the body", async () => {
    const { env, calls } = makeEnv((call) => {
      if (call.path === "/export") return { json: { done: true } };
      if (call.path === "/owner-counts") return { json: { counts: {} } };
      if (call.path === "/import" && call.body.done === true) return { json: { nextDueAt: 42 } };
      return {};
    });

    await migrateOwnerToShard(env, ORIGIN, "user@example.com");

    const schedule = calls.find((c) => c.path === "/schedule-set");
    expect(schedule?.body).toEqual({ owner: "user@example.com", nextDueAt: 0 });
  });

  it("never unlocks or marks a count-mismatched migration", async () => {
    const { env, calls } = makeEnv((call) => {
      if (call.path === "/export") return { json: { done: true } };
      if (call.path === "/owner-counts" && call.doId === "global") {
        return { json: { counts: { mcp_oauth_grants: 1 } } };
      }
      if (call.path === "/owner-counts") return { json: { counts: { mcp_oauth_grants: 0 } } };
      return {};
    });
    await expect(migrateOwnerToShard(env, ORIGIN, "user@example.com")).rejects.toThrow(
      "migration verification failed (mcp_oauth_grants)",
    );
    expect(calls.some((call) => call.body.done === true)).toBe(false);
    expect(calls.some((call) => call.path === "/mark-migrated")).toBe(false);
  });

  it("propagates export failures and rejects empty owners", async () => {
    const failing = makeEnv(() => ({ status: 503 }));
    await expect(migrateOwnerToShard(failing.env, ORIGIN, "user@example.com")).rejects.toThrow(
      "export failed (503)",
    );

    const untouched = makeEnv(() => ({}));
    await expect(migrateOwnerToShard(untouched.env, ORIGIN, "   ")).rejects.toThrow("empty owner");
    expect(untouched.calls).toEqual([]);
  });

  it("gives up when paging never reaches done", async () => {
    const { env } = makeEnv((call) => {
      if (call.path === "/export") {
        // Cursor always advances but done never arrives.
        return { json: { done: false, cursor: `c${Math.random()}` } };
      }
      return {};
    });

    await expect(migrateOwnerToShard(env, ORIGIN, "user@example.com")).rejects.toThrow(
      "export paging never finished",
    );
  });

  it("sweep skips junk owners and keeps going past a failing one", async () => {
    const { env, calls } = makeEnv((call) => {
      if (call.path === "/owners") {
        return { json: { owners: ["bad@x.com", 7, "", "good@y.com"] } };
      }
      if (call.body.owner === "bad@x.com") return { status: 500 };
      if (call.path === "/export") return { json: { done: true } };
      if (call.path === "/owner-counts") return { json: { counts: {} } };
      if (call.path === "/import" && call.body.done === true) {
        return { headers: { "X-Gera-Next-Due": "0" } };
      }
      return {};
    });

    await sweepGlobalMigrations(env, ORIGIN);

    const marked = calls.filter((c) => c.path === "/mark-migrated");
    expect(marked).toHaveLength(1);
    expect(marked[0].body).toEqual({ owner: "good@y.com" });
    expect(console.error).toHaveBeenCalled();
  });

  it("sweep survives an unreachable owners list", async () => {
    const { env, calls } = makeEnv(() => ({ status: 500 }));
    await sweepGlobalMigrations(env, ORIGIN);
    expect(calls.map((c) => c.path)).toEqual(["/owners"]);
  });
});
