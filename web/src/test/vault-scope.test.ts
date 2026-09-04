// Phase 5.1 — vault scopes move from the storage owner to the Rork Auth
// account: the one-time sweep re-seals every credential row, is idempotent
// and resumable, keeps (and counts) rows it cannot open, and the old scope is
// unreadable outside the sweep. The shard adopts the account id from the
// Worker header or the registry lookup and refuses a contradicting id.
import { describe, expect, it } from "vitest";

import type { ChatSql, SqlRowValue } from "../../../functions/chat-shared";
import {
  grantScope,
  openGrantPayload,
  openRotationValue,
  openServerSecret,
  sealGrantPayload,
  sealRotationValue,
  sealServerSecret,
  type ServerSecret,
} from "../../../functions/secret-rows";
import { SecretVault, SecretVaultError } from "../../../functions/secret-vault";
import {
  CredentialScope,
  ensureVaultScope,
  lookupAccountId,
  readAccountId,
  VAULT_SCOPE_KEY,
  type VaultScopeMarker,
} from "../../../functions/vault-scope";
import {
  accountSubject,
  ensureAccountIdColumns,
  rescopeValue,
  sweepVaultScope,
  type ScopeStorage,
} from "../../../functions/vault-scope-sweep";

const KEY = "b3JhbmdlcyBhcmUgbm90IHRoZSBvbmx5IGZydWl0ISEhIQ==";
const OWNER = "old-address@example.com";
const ACCOUNT = "usr_7f3c9a";

type Row = Record<string, SqlRowValue>;

/** Enough SQLite for the sweep's fixed statements: ALTER ADD COLUMN, SELECT … WHERE owner_email, UPDATE … SET … WHERE. */
class FakeSql implements ChatSql {
  readonly tables = new Map<string, Row[]>();
  readonly columns = new Map<string, Set<string>>();
  statements: string[] = [];

  seed(table: string, rows: Row[]): void {
    this.tables.set(table, rows.map((row) => ({ ...row })));
    this.columns.set(table, new Set(Object.keys(rows[0] ?? {})));
  }

  exec<T extends Record<string, SqlRowValue>>(query: string, ...bindings: unknown[]): { toArray(): T[] } {
    const sql = query.replace(/\s+/g, " ").trim();
    this.statements.push(sql);
    const alter = /^ALTER TABLE (\w+) ADD COLUMN (\w+) /.exec(sql);
    if (alter) {
      const cols = this.columns.get(alter[1]) ?? new Set<string>();
      if (cols.has(alter[2])) {
        throw new Error(`duplicate column name: ${alter[2]}`);
      }
      cols.add(alter[2]);
      this.columns.set(alter[1], cols);
      for (const row of this.tables.get(alter[1]) ?? []) {
        row[alter[2]] = "";
      }
      return { toArray: () => [] };
    }
    const select = /^SELECT (.+?) FROM (\w+) WHERE owner_email = \?$/.exec(sql);
    if (select) {
      const rows = (this.tables.get(select[2]) ?? []).filter((row) => row.owner_email === bindings[0]);
      return { toArray: () => rows.map((row) => ({ ...row })) as unknown as T[] };
    }
    const update = /^UPDATE (\w+) SET (.+?) WHERE (.+)$/.exec(sql);
    if (update) {
      const sets = update[2].split(",").map((part) => part.trim().split(" = ")[0]);
      const wheres = update[3].split(" AND ").map((part) => part.trim().split(" = ")[0]);
      const values = bindings.slice(0, sets.length);
      const keys = bindings.slice(sets.length);
      for (const row of this.tables.get(update[1]) ?? []) {
        if (wheres.every((column, index) => row[column] === keys[index])) {
          sets.forEach((column, index) => {
            row[column] = values[index] as SqlRowValue;
          });
        }
      }
      return { toArray: () => [] };
    }
    throw new Error(`FakeSql cannot run: ${sql}`);
  }
}

class FakeStorage implements ScopeStorage {
  readonly map = new Map<string, unknown>();
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
  }
  async list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [key, value] of this.map) {
      if (!options?.prefix || key.startsWith(options.prefix)) {
        out.set(key, value as T);
      }
    }
    return out;
  }
}

async function vaultError(run: () => Promise<unknown>): Promise<SecretVaultError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SecretVaultError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a SecretVaultError");
}

const GRANT = { accessToken: "at-linear", refreshToken: "rt-linear", tokenEndpoint: "https://as.example/token", clientId: "cid" };

async function seededShard(vault: SecretVault): Promise<{ sql: FakeSql; storage: FakeStorage }> {
  const sql = new FakeSql();
  const storage = new FakeStorage();
  sql.seed("mcp_oauth_grants", [
    { owner_email: OWNER, server_id: "linear", payload: await sealGrantPayload(vault, OWNER, "linear", GRANT) },
    // Sealed for another owner: opens under neither scope → unreadable, kept.
    { owner_email: OWNER, server_id: "stray", payload: await sealGrantPayload(vault, "someone-else@example.com", "stray", GRANT) },
  ]);
  const secret: ServerSecret = { token: "sk-live", headersJson: '{"X-Key":"k"}' };
  sql.seed("mcp_server_secrets", [
    { owner_email: OWNER, server_id: "srv", payload: await sealServerSecret(vault, OWNER, "srv", secret) },
  ]);
  sql.seed("mcp_oauth_pending", [
    {
      owner_email: OWNER,
      state: "s1",
      verifier: await vault.seal("pkce-verifier", `mcp-oauth-pending:${OWNER}:s1#verifier`),
      authorization_code: "",
      browser_nonce: await vault.seal("nonce", `mcp-oauth-pending:${OWNER}:s1#browser_nonce`),
      callback_challenge: "",
    },
  ]);
  sql.seed("mcp_github_device_pending", [
    { owner_email: OWNER, flow_id: "f1", device_code: await vault.seal("dev-code", `mcp-github-device:${OWNER}:f1#device_code`) },
  ]);
  await storage.put(`oauthref:${OWNER}:linear`, await sealRotationValue(vault, OWNER, "linear", { serverId: "linear", bases: ["at-old"], token: GRANT }));
  return { sql, storage };
}

describe("rescopeValue", () => {
  const vault = SecretVault.forTesting(KEY);

  it("re-seals owner-scoped values, keeps account-scoped ones, seals plaintext, and flags foreign ones", async () => {
    const owner = "grant:owner#accessToken";
    const account = "grant:acct:u1#accessToken";
    const old = await vault.seal("tok", owner);
    const moved = await rescopeValue(vault, old, owner, account);
    expect(moved.outcome).toBe("resealed");
    expect(await vault.open(moved.value, account)).toBe("tok");
    expect((await rescopeValue(vault, moved.value, owner, account)).outcome).toBe("current");
    const plain = await rescopeValue(vault, "legacy-plain", owner, account);
    expect(plain.outcome).toBe("resealed");
    expect(await vault.open(plain.value, account)).toBe("legacy-plain");
    const foreign = await vault.seal("tok", "grant:other#accessToken");
    const kept = await rescopeValue(vault, foreign, owner, account);
    expect(kept).toEqual({ value: foreign, outcome: "unreadable" });
    expect(await rescopeValue(vault, "", owner, account)).toEqual({ value: "", outcome: "current" });
  });
});

describe("sweepVaultScope", () => {
  const vault = SecretVault.forTesting(KEY);
  const subject = accountSubject(ACCOUNT);

  it("moves every credential row and the KV escrow to the account scope and stamps account_id", async () => {
    const { sql, storage } = await seededShard(vault);
    const strayBefore = sql.tables.get("mcp_oauth_grants")!.find((row) => row.server_id === "stray")!.payload;
    const report = await sweepVaultScope({ sql, storage, vault, owner: OWNER, subject, accountId: ACCOUNT });
    // linear grant (2 fields) + server secret (2) + pending (2) + device code (1) + escrow (1) = 8; stray grant = 2 unreadable.
    expect(report).toEqual({ resealed: 8, current: 0, unreadable: 2 });

    const grants = sql.tables.get("mcp_oauth_grants")!;
    const linear = grants.find((row) => row.server_id === "linear")!;
    expect(linear.account_id).toBe(ACCOUNT);
    expect((await openGrantPayload(vault, subject, "linear", linear.payload as string))?.refreshToken).toBe("rt-linear");
    // The owner scope is dead for the moved row — only the sweep ever opened it.
    expect((await vaultError(() => openGrantPayload(vault, OWNER, "linear", linear.payload as string))).code).toBe("secret_unreadable");
    // A changed email does not matter any more: the subject is the account.
    expect((await openGrantPayload(vault, accountSubject(ACCOUNT), "linear", linear.payload as string))?.accessToken).toBe("at-linear");

    // The unreadable row is kept exactly as it was (never deleted), just stamped.
    const stray = grants.find((row) => row.server_id === "stray")!;
    expect(stray.payload).toBe(strayBefore);
    expect(stray.account_id).toBe(ACCOUNT);
    expect((await vaultError(() => openGrantPayload(vault, subject, "stray", stray.payload as string))).code).toBe("secret_unreadable");

    const secret = sql.tables.get("mcp_server_secrets")![0];
    const storedSecret = JSON.parse(secret.payload as string) as ServerSecret;
    expect(await openServerSecret(vault, subject, "srv", storedSecret)).toEqual({ token: "sk-live", headersJson: '{"X-Key":"k"}' });

    const pending = sql.tables.get("mcp_oauth_pending")![0];
    expect(await vault.open(pending.verifier as string, `mcp-oauth-pending:${subject}:s1#verifier`)).toBe("pkce-verifier");
    expect(pending.authorization_code).toBe("");
    const device = sql.tables.get("mcp_github_device_pending")![0];
    expect(await vault.open(device.device_code as string, `mcp-github-device:${subject}:f1#device_code`)).toBe("dev-code");

    const escrow = await storage.get(`oauthref:${OWNER}:linear`);
    expect((await openRotationValue(vault, subject, "linear", escrow) as { bases: string[] }).bases).toEqual(["at-old"]);
    expect((await vaultError(() => openRotationValue(vault, OWNER, "linear", escrow))).code).toBe("secret_unreadable");
  });

  it("is idempotent: a second pass changes nothing and still reports the unreadable rows", async () => {
    const { sql, storage } = await seededShard(vault);
    await sweepVaultScope({ sql, storage, vault, owner: OWNER, subject, accountId: ACCOUNT });
    const snapshot = JSON.stringify([...sql.tables.entries()]);
    const again = await sweepVaultScope({ sql, storage, vault, owner: OWNER, subject, accountId: ACCOUNT });
    expect(again).toEqual({ resealed: 0, current: 8, unreadable: 2 });
    expect(JSON.stringify([...sql.tables.entries()])).toBe(snapshot);
  });

  it("adds the account_id column once and tolerates re-running the ALTER", () => {
    const sql = new FakeSql();
    sql.seed("mcp_oauth_grants", [{ owner_email: OWNER, server_id: "x", payload: "{}" }]);
    for (const table of ["mcp_server_secrets", "mcp_oauth_pending", "mcp_github_device_pending"]) {
      sql.seed(table, []);
    }
    ensureAccountIdColumns(sql);
    ensureAccountIdColumns(sql);
    expect(sql.tables.get("mcp_oauth_grants")![0].account_id).toBe("");
    expect(sql.statements.filter((statement) => statement.startsWith("ALTER TABLE"))).toHaveLength(8);
  });

  it("scope strings put the account subject exactly where the owner used to be", () => {
    expect(grantScope(accountSubject("u1"), "linear")).toBe("mcp-oauth-grant:acct:u1:linear");
    expect(grantScope("o@x", "linear")).toBe("mcp-oauth-grant:o@x:linear");
  });
});

describe("CredentialScope + ensureVaultScope", () => {
  const vault = SecretVault.forTesting(KEY);

  function context(sql: FakeSql, storage: FakeStorage, scope: CredentialScope, registry?: { fetch(request: Request): Promise<Response> }) {
    return {
      sql,
      storage,
      vault,
      scope,
      blockConcurrencyWhile: <T>(work: () => Promise<T>) => work(),
      ...(registry ? { registry } : {}),
    };
  }

  const withAccount = (id: string): Request =>
    new Request("https://gera.internal/sync", { headers: { "X-Gera-Account-Id": encodeURIComponent(id) } });

  it("reads the Worker header and refuses malformed subjects", () => {
    expect(readAccountId(withAccount(" usr 1 "))).toBe("usr 1");
    expect(readAccountId(withAccount("a:b"))).toBe("");
    expect(readAccountId(new Request("https://gera.internal/sync"))).toBe("");
  });

  it("uses the owner as subject until the sweep ran, then the account", async () => {
    const scope = new CredentialScope();
    expect(scope.subject(OWNER)).toBe(OWNER);
    expect(scope.describe()).toEqual({ scope: "owner", unreadable: 0 });
    const marker: VaultScopeMarker = { version: 2, accountId: ACCOUNT, sweptAt: 1, unreadable: 3 };
    const storage = new FakeStorage();
    await storage.put(VAULT_SCOPE_KEY, marker);
    await scope.load(storage);
    expect(scope.subject(OWNER)).toBe(accountSubject(ACCOUNT));
    expect(scope.describe()).toEqual({ scope: "account", unreadable: 3 });
  });

  it("adopts the header on first sight, sweeps once, persists the marker, and refuses a different account later", async () => {
    const { sql, storage } = await seededShard(vault);
    const scope = new CredentialScope();
    expect(await ensureVaultScope(context(sql, storage, scope), withAccount(ACCOUNT), OWNER)).toBeNull();
    expect(scope.migrated).toBe(true);
    expect(scope.subject(OWNER)).toBe(accountSubject(ACCOUNT));
    const marker = (await storage.get(VAULT_SCOPE_KEY)) as VaultScopeMarker;
    expect(marker).toMatchObject({ version: 2, accountId: ACCOUNT, unreadable: 2 });
    const grant = sql.tables.get("mcp_oauth_grants")!.find((row) => row.server_id === "linear")!;
    expect((await openGrantPayload(vault, scope.subject(OWNER), "linear", grant.payload as string))?.accessToken).toBe("at-linear");

    const sweeps = sql.statements.filter((statement) => statement.startsWith("ALTER TABLE")).length;
    expect(await ensureVaultScope(context(sql, storage, scope), withAccount(ACCOUNT), OWNER)).toBeNull();
    expect(sql.statements.filter((statement) => statement.startsWith("ALTER TABLE")).length).toBe(sweeps);

    const refused = await ensureVaultScope(context(sql, storage, scope), withAccount("usr_other"), OWNER);
    expect(refused?.status).toBe(409);
    await expect(refused!.json()).resolves.toEqual({ error: "wrong_account" });
    // Requests without the header (cron fires) keep working on the migrated shard.
    expect(await ensureVaultScope(context(sql, storage, scope), new Request("https://gera.internal/fire"), OWNER)).toBeNull();
  });

  it("asks the registry when an internal call arrives first, and stays on the owner scope when it does not know", async () => {
    const { sql, storage } = await seededShard(vault);
    const scope = new CredentialScope();
    const seen: string[] = [];
    const unknownRegistry = {
      fetch: async (request: Request) => {
        seen.push(request.headers.get("X-Gera-Internal-Route") ?? "");
        return new Response(JSON.stringify({ error: "principal_unknown" }), { status: 404 });
      },
    };
    const internal = new Request("https://gera.internal/mcp/resolve", { method: "POST" });
    expect(await ensureVaultScope(context(sql, storage, scope, unknownRegistry), internal, OWNER)).toBeNull();
    expect(scope.migrated).toBe(false);
    expect(seen).toEqual(["principal-lookup"]);
    // A miss is remembered — the registry is not hammered on every request.
    expect(await ensureVaultScope(context(sql, storage, scope, unknownRegistry), internal, OWNER)).toBeNull();
    expect(seen).toHaveLength(1);

    const knowingRegistry = {
      fetch: async (request: Request) => {
        const body = (await request.json()) as { storageOwner: string };
        expect(body.storageOwner).toBe(OWNER);
        return new Response(JSON.stringify({ userId: ACCOUNT }), { status: 200 });
      },
    };
    const fresh = new CredentialScope();
    expect(await ensureVaultScope(context(sql, storage, fresh, knowingRegistry), internal, OWNER)).toBeNull();
    expect(fresh.migrated).toBe(true);
    expect(fresh.subject(OWNER)).toBe(accountSubject(ACCOUNT));
    expect(await lookupAccountId(knowingRegistry, OWNER)).toBe(ACCOUNT);
    expect(await lookupAccountId(unknownRegistry, OWNER)).toBeNull();
  });

  it("does nothing without a key (readers already fail closed) and without header or registry", async () => {
    const { sql, storage } = await seededShard(vault);
    const scope = new CredentialScope();
    expect(await ensureVaultScope(context(sql, storage, scope), new Request("https://gera.internal/sync"), OWNER)).toBeNull();
    expect(scope.migrated).toBe(false);
    const disabled = { ...context(sql, storage, scope), vault: SecretVault.fromEnv({}) };
    expect(await ensureVaultScope(disabled, withAccount(ACCOUNT), OWNER)).toBeNull();
    expect(scope.migrated).toBe(false);
  });
});
