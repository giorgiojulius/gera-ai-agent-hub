// AccessRegistry — singleton Durable Object (id "global") holding the invite
// allowlist and the waitlist of access requests. The Worker entrypoint only
// dispatches here after the platform has verified the caller's Rork Auth JWT,
// stamping the normalized identity into X-Gera-Email / X-Gera-Name.
import { DurableObject } from "cloudflare:workers";

/** The first invite — seeded as admin so invites can be granted from day one. */
export const SEED_ADMIN_EMAIL = "georgekvirkvelia@gmail.com";

/**
 * Domain allowlist: anyone signing in with an email on these domains becomes
 * a member automatically — no manual invite needed. The provisioned row lands
 * in the invites table, so the admin overview shows exactly who got in.
 */
const AUTO_INVITE_DOMAINS = new Set(["rork.com"]);

function autoInviteDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) {
    return null;
  }
  const domain = email.slice(at + 1);
  return AUTO_INVITE_DOMAINS.has(domain) ? domain : null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOTE_LIMIT = 500;

type InviteRow = {
  email: string;
  role: string;
  invited_by: string | null;
  created_at: number;
};

type RequestRow = {
  email: string;
  name: string | null;
  note: string | null;
  status: string;
  created_at: number;
};

type PrincipalRow = {
  user_id: string;
  storage_owner: string;
  shard_id: string;
  current_email: string;
  created_at: number;
  last_seen_at: number;
};

type PrincipalAliasRow = {
  email: string;
  user_id: string;
};

type OAuthRouteRow = {
  state: string;
  shard_id: string;
  storage_owner: string;
  expires_at: number;
};

class PrincipalUnclaimedError extends Error {
  constructor() {
    super("principal has not been safely claimed");
    this.name = "PrincipalUnclaimedError";
  }
}

class PrincipalConflictError extends Error {
  constructor() {
    super("verified email is already bound to another account principal");
    this.name = "PrincipalConflictError";
  }
}

/**
 * Repairs UTF-8 text that was read as Latin-1 (mojibake like "ÐÐµÐ¾Ñ..."
 * instead of Cyrillic). Strict decoding leaves genuine Latin-1 text untouched.
 */
function repairUtf8(value: string): string {
  if (!/[\u0080-\u00ff]/.test(value) || /[\u0100-\uffff]/.test(value)) {
    return value;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(value, (char) => char.charCodeAt(0)));
  } catch {
    return value;
  }
}

function readIdentity(request: Request, header: string): string {
  const raw = request.headers.get(header) ?? "";
  try {
    return repairUtf8(decodeURIComponent(raw)).trim();
  } catch {
    return raw.trim();
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export class AccessRegistry extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS invites (
        email TEXT PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'member',
        invited_by TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        email TEXT PRIMARY KEY,
        name TEXT,
        note TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO invites (email, role, invited_by, created_at) VALUES (?, 'admin', 'seed', ?)",
      SEED_ADMIN_EMAIL,
      Date.now(),
    );
    // Stable account principal registry. Existing accounts keep their original
    // email-named ChatStore shard, but the verified immutable subject becomes
    // the routing authority from the first request on. An alias is first-claim-
    // wins, so a recycled email can never open another subject's old shard.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS principal_subjects (
        user_id TEXT PRIMARY KEY,
        storage_owner TEXT NOT NULL,
        shard_id TEXT NOT NULL,
        current_email TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS principal_aliases (
        email TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_principal_alias_user ON principal_aliases (user_id)",
    );
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS oauth_callback_routes (
        state TEXT PRIMARY KEY,
        shard_id TEXT NOT NULL,
        storage_owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  }

  private inviteFor(email: string): InviteRow | null {
    const rows = this.ctx.storage.sql
      .exec<InviteRow>("SELECT email, role, invited_by, created_at FROM invites WHERE email = ?", email)
      .toArray();
    return rows[0] ?? null;
  }

  private requestFor(email: string): RequestRow | null {
    const rows = this.ctx.storage.sql
      .exec<RequestRow>("SELECT email, name, note, status, created_at FROM requests WHERE email = ?", email)
      .toArray();
    return rows[0] ?? null;
  }

  /** Resolves or first-claims the immutable app subject without moving legacy data. */
  private resolvePrincipal(userId: string, currentEmail: string, allowCreate: boolean): PrincipalRow {
    if (!userId || userId.length > 512 || userId.includes("\0")) {
      throw new Error("invalid principal subject");
    }
    const now = Date.now();
    const existing = this.ctx.storage.sql
      .exec<PrincipalRow>(
        "SELECT user_id, storage_owner, shard_id, current_email, created_at, last_seen_at FROM principal_subjects WHERE user_id = ?",
        userId,
      )
      .toArray()[0];
    const alias = this.ctx.storage.sql
      .exec<PrincipalAliasRow>("SELECT email, user_id FROM principal_aliases WHERE email = ?", currentEmail)
      .toArray()[0];
    if (alias && alias.user_id !== userId) {
      throw new PrincipalConflictError();
    }
    if (existing) {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO principal_aliases (email, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
        currentEmail,
        userId,
        now,
        now,
      );
      this.ctx.storage.sql.exec(
        "UPDATE principal_aliases SET last_seen_at = ? WHERE email = ? AND user_id = ?",
        now,
        currentEmail,
        userId,
      );
      this.ctx.storage.sql.exec(
        "UPDATE principal_subjects SET current_email = ?, last_seen_at = ? WHERE user_id = ?",
        currentEmail,
        now,
        userId,
      );
      return { ...existing, current_email: currentEmail, last_seen_at: now };
    }
    // A legacy email shard may predate immutable-subject metadata. The Worker
    // probes both legacy and destination stores before granting this marker;
    // without it, first-touch is fail-closed against recycled-email takeover.
    if (!allowCreate && alias?.user_id !== userId) {
      throw new PrincipalUnclaimedError();
    }
    const storageOwner = currentEmail;
    const principal: PrincipalRow = {
      user_id: userId,
      storage_owner: storageOwner,
      shard_id: `acct:${encodeURIComponent(storageOwner)}`,
      current_email: currentEmail,
      created_at: now,
      last_seen_at: now,
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO principal_subjects
        (user_id, storage_owner, shard_id, current_email, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      principal.user_id,
      principal.storage_owner,
      principal.shard_id,
      principal.current_email,
      principal.created_at,
      principal.last_seen_at,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO principal_aliases (email, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
      currentEmail,
      userId,
      now,
      now,
    );
    return principal;
  }

  /** Access follows the stable account invite, with a newly invited current alias as recovery. */
  private accessEmail(principal: PrincipalRow, currentEmail: string): string {
    if (this.inviteFor(principal.storage_owner)) {
      return principal.storage_owner;
    }
    return this.inviteFor(currentEmail) ? currentEmail : principal.storage_owner;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("X-Gera-Internal-Route") === "oauth") {
      return this.handleOAuthRoute(request, url.pathname);
    }
    if (
      request.headers.get("X-Gera-Internal-Route") === "principal-bootstrap" &&
      request.method === "POST" &&
      url.pathname === "/principal/bootstrap"
    ) {
      return this.handlePrincipalBind(request);
    }
    const email = readIdentity(request, "X-Gera-Email").toLowerCase();
    if (!email) {
      return json({ error: "sign_in_required" }, 401);
    }
    const userId = readIdentity(request, "X-Gera-User-Id");
    const name = readIdentity(request, "X-Gera-Name");
    let principal: PrincipalRow | null = null;
    if (userId) {
      try {
        const allowCreate = request.headers.get("X-Gera-Principal-Create") === "empty-owner";
        principal = this.resolvePrincipal(userId, email, allowCreate);
      } catch (error) {
        if (error instanceof PrincipalConflictError) {
          return json({ error: "principal_conflict" }, 409);
        }
        if (error instanceof PrincipalUnclaimedError) {
          return json({ error: "principal_unclaimed" }, 404);
        }
        return json({ error: "invalid_principal" }, 400);
      }
    }

    // Domain rule runs before any route: @rork.com callers are provisioned
    // as members on first contact, and a pending request (if any) flips to
    // approved so the waitlist stays truthful.
    const domain = autoInviteDomain(email);
    if (domain && !this.inviteFor(email)) {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO invites (email, role, invited_by, created_at) VALUES (?, 'member', ?, ?)",
        email,
        `domain:${domain}`,
        Date.now(),
      );
      this.ctx.storage.sql.exec("UPDATE requests SET status = 'approved' WHERE email = ?", email);
    }

    const accountEmail = principal ? this.accessEmail(principal, email) : email;
    if (request.method === "POST" && url.pathname === "/principal/resolve") {
      if (!principal) {
        return json({ error: "sign_in_required" }, 401);
      }
      const invite = this.inviteFor(accountEmail);
      return json({
        userId: principal.user_id,
        currentEmail: email,
        storageOwner: principal.storage_owner,
        shardId: principal.shard_id,
        accessEmail: accountEmail,
        status: invite ? "invited" : "none",
        role: invite?.role === "admin" ? "admin" : invite ? "member" : null,
      });
    }
    if (request.method === "GET" && url.pathname === "/status") {
      return this.handleStatus(email, accountEmail);
    }
    if (request.method === "POST" && url.pathname === "/request") {
      return this.handleRequest(request, email, name);
    }

    // Everything below is admin-only.
    const caller = this.inviteFor(accountEmail);
    if (!caller || caller.role !== "admin") {
      return json({ error: "admin_only" }, 403);
    }
    if (request.method === "GET" && url.pathname === "/admin/overview") {
      return this.handleOverview();
    }
    if (request.method === "POST" && url.pathname === "/admin/invite") {
      return this.handleInvite(request, accountEmail);
    }
    if (request.method === "POST" && url.pathname === "/admin/revoke") {
      return this.handleRevoke(request);
    }
    if (request.method === "POST" && url.pathname === "/admin/principal-bind") {
      return this.handlePrincipalBind(request);
    }
    if (request.method === "POST" && url.pathname === "/admin/role") {
      return this.handleRole(request, accountEmail);
    }
    if (request.method === "POST" && url.pathname === "/admin/dismiss") {
      return this.handleDismiss(request);
    }
    return json({ error: "not_found" }, 404);
  }

  private async handleOAuthRoute(request: Request, pathname: string): Promise<Response> {
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }
    let body: { state?: unknown; shardId?: unknown; storageOwner?: unknown; expiresAt?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const state = typeof body.state === "string" ? body.state : "";
    if (!/^[a-f0-9]{64}$/.test(state)) {
      return json({ error: "invalid_state" }, 400);
    }
    this.ctx.storage.sql.exec("DELETE FROM oauth_callback_routes WHERE expires_at < ?", Date.now());
    if (pathname === "/oauth-route/register") {
      const shardId = typeof body.shardId === "string" ? body.shardId : "";
      const storageOwner = typeof body.storageOwner === "string" ? body.storageOwner.trim().toLowerCase() : "";
      const expiresAt = typeof body.expiresAt === "number" ? Math.floor(body.expiresAt) : 0;
      if (
        !shardId ||
        shardId.length > 1_000 ||
        !EMAIL_PATTERN.test(storageOwner) ||
        shardId !== `acct:${encodeURIComponent(storageOwner)}` ||
        expiresAt <= Date.now() ||
        expiresAt > Date.now() + 15 * 60_000
      ) {
        return json({ error: "invalid_route" }, 400);
      }
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO oauth_callback_routes (state, shard_id, storage_owner, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
        state,
        shardId,
        storageOwner,
        expiresAt,
        Date.now(),
      );
      return json({ ok: true });
    }
    const row = this.ctx.storage.sql
      .exec<OAuthRouteRow>(
        "SELECT state, shard_id, storage_owner, expires_at FROM oauth_callback_routes WHERE state = ?",
        state,
      )
      .toArray()[0];
    if (!row || row.expires_at < Date.now()) {
      return json({ error: "oauth_state_unknown" }, 404);
    }
    if (pathname === "/oauth-route/resolve") {
      return json({ shardId: row.shard_id, storageOwner: row.storage_owner, expiresAt: row.expires_at });
    }
    if (pathname === "/oauth-route/consume") {
      this.ctx.storage.sql.exec("DELETE FROM oauth_callback_routes WHERE state = ?", state);
      return json({ ok: true });
    }
    return json({ error: "not_found" }, 404);
  }

  private handleStatus(displayEmail: string, accessEmail: string): Response {
    const invite = this.inviteFor(accessEmail);
    if (invite) {
      return json({
        email: displayEmail,
        status: "invited",
        role: invite.role === "admin" ? "admin" : "member",
        requestedAt: null,
      });
    }
    const pending = this.requestFor(displayEmail);
    if (pending && pending.status === "pending") {
      return json({ email: displayEmail, status: "pending", role: null, requestedAt: pending.created_at });
    }
    return json({ email: displayEmail, status: "none", role: null, requestedAt: null });
  }

  private async handleRequest(request: Request, email: string, name: string): Promise<Response> {
    if (this.inviteFor(email)) {
      return json({ ok: true, status: "invited" });
    }
    let note = "";
    try {
      const body = (await request.json()) as { note?: unknown };
      if (typeof body.note === "string") {
        note = body.note.trim().slice(0, NOTE_LIMIT);
      }
    } catch {
      // empty body is fine — the note is optional
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO requests (email, name, note, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)
       ON CONFLICT(email) DO UPDATE SET
         name = excluded.name,
         note = excluded.note,
         status = 'pending'`,
      email,
      name || null,
      note || null,
      Date.now(),
    );
    return json({ ok: true, status: "pending" });
  }

  private handleOverview(): Response {
    const invites = this.ctx.storage.sql
      .exec<InviteRow>("SELECT email, role, invited_by, created_at FROM invites ORDER BY created_at ASC")
      .toArray()
      .map((row) => ({
        email: row.email,
        role: row.role === "admin" ? "admin" : "member",
        invitedBy: row.invited_by,
        createdAt: row.created_at,
      }));
    const requests = this.ctx.storage.sql
      .exec<RequestRow>("SELECT email, name, note, status, created_at FROM requests ORDER BY created_at DESC")
      .toArray()
      .map((row) => ({
        email: row.email,
        name: row.name === null ? null : repairUtf8(row.name),
        note: row.note === null ? null : repairUtf8(row.note),
        status: row.status,
        createdAt: row.created_at,
      }));
    return json({ invites, requests });
  }

  private async handleInvite(request: Request, invitedBy: string): Promise<Response> {
    let target = "";
    try {
      const body = (await request.json()) as { email?: unknown };
      if (typeof body.email === "string") {
        target = body.email.trim().toLowerCase();
      }
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    if (!EMAIL_PATTERN.test(target)) {
      return json({ error: "invalid_email" }, 400);
    }
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO invites (email, role, invited_by, created_at) VALUES (?, 'member', ?, ?)",
      target,
      invitedBy,
      Date.now(),
    );
    this.ctx.storage.sql.exec("UPDATE requests SET status = 'approved' WHERE email = ?", target);
    return json({ ok: true });
  }

  private async handlePrincipalBind(request: Request): Promise<Response> {
    let targetEmail = "";
    let targetUserId = "";
    try {
      const body = (await request.json()) as { email?: unknown; userId?: unknown };
      targetEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      targetUserId = typeof body.userId === "string" ? body.userId.trim() : "";
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    if (!EMAIL_PATTERN.test(targetEmail) || !targetUserId || targetUserId.length > 512 || targetUserId.includes("\0")) {
      return json({ error: "invalid_principal" }, 400);
    }
    if (!this.inviteFor(targetEmail)) {
      return json({ error: "invite_required" }, 409);
    }
    const existingSubject = this.ctx.storage.sql
      .exec<PrincipalRow>(
        "SELECT user_id, storage_owner, shard_id, current_email, created_at, last_seen_at FROM principal_subjects WHERE user_id = ?",
        targetUserId,
      )
      .toArray()[0];
    const existingAlias = this.ctx.storage.sql
      .exec<PrincipalAliasRow>("SELECT email, user_id FROM principal_aliases WHERE email = ?", targetEmail)
      .toArray()[0];
    if (
      (existingSubject && existingSubject.storage_owner !== targetEmail) ||
      (existingAlias && existingAlias.user_id !== targetUserId)
    ) {
      return json({ error: "principal_conflict" }, 409);
    }
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO principal_subjects
        (user_id, storage_owner, shard_id, current_email, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      targetUserId,
      targetEmail,
      `acct:${encodeURIComponent(targetEmail)}`,
      targetEmail,
      now,
      now,
    );
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO principal_aliases (email, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
      targetEmail,
      targetUserId,
      now,
      now,
    );
    return json({ ok: true });
  }

  private async handleRevoke(request: Request): Promise<Response> {
    let target = "";
    try {
      const body = (await request.json()) as { email?: unknown };
      if (typeof body.email === "string") {
        target = body.email.trim().toLowerCase();
      }
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const existing = this.inviteFor(target);
    if (!existing) {
      return json({ error: "not_invited" }, 404);
    }
    if (existing.role === "admin") {
      return json({ error: "Admins can't be revoked — make them a member first" }, 400);
    }
    // Honest limit: the domain rule would re-provision this account on its
    // next visit, so a revoke here would silently not stick.
    if (autoInviteDomain(target)) {
      return json({ error: `${target.split("@")[1]} accounts are auto-invited by the domain rule` }, 400);
    }
    this.ctx.storage.sql.exec("DELETE FROM invites WHERE email = ? AND role != 'admin'", target);
    return json({ ok: true });
  }

  /**
   * Promote/demote between member and admin. Callers can never change their
   * own role — that guarantees at least one admin always remains, because the
   * caller was verified as an admin to get here.
   */
  private async handleRole(request: Request, caller: string): Promise<Response> {
    let target = "";
    let role = "";
    try {
      const body = (await request.json()) as { email?: unknown; role?: unknown };
      if (typeof body.email === "string") {
        target = body.email.trim().toLowerCase();
      }
      if (typeof body.role === "string") {
        role = body.role;
      }
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    if (role !== "admin" && role !== "member") {
      return json({ error: "invalid_role" }, 400);
    }
    if (target === caller) {
      return json({ error: "You can't change your own role" }, 400);
    }
    const existing = this.inviteFor(target);
    if (!existing) {
      return json({ error: "not_invited" }, 404);
    }
    if (existing.role !== role) {
      this.ctx.storage.sql.exec("UPDATE invites SET role = ? WHERE email = ?", role, target);
    }
    return json({ ok: true });
  }

  /**
   * Dismisses a pending waitlist request. The row stays (status 'dismissed')
   * so the panel keeps the honest history — and an invite still works later.
   */
  private async handleDismiss(request: Request): Promise<Response> {
    let target = "";
    try {
      const body = (await request.json()) as { email?: unknown };
      if (typeof body.email === "string") {
        target = body.email.trim().toLowerCase();
      }
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    if (!this.requestFor(target)) {
      return json({ error: "no_request" }, 404);
    }
    if (this.inviteFor(target)) {
      return json({ error: "Already invited — revoke instead" }, 400);
    }
    this.ctx.storage.sql.exec("UPDATE requests SET status = 'dismissed' WHERE email = ?", target);
    return json({ ok: true });
  }
}
