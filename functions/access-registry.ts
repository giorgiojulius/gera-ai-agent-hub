// AccessRegistry — singleton Durable Object (id "global") holding the invite
// allowlist and the waitlist of access requests. The Worker entrypoint only
// dispatches here after the platform has verified the caller's Rork Auth JWT,
// stamping the normalized identity into X-Gera-Email / X-Gera-Name.
import { DurableObject } from "cloudflare:workers";

/** The first invite — seeded as admin so invites can be granted from day one. */
const SEED_ADMIN_EMAIL = "georgekvirkvelia@gmail.com";

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

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const email = readIdentity(request, "X-Gera-Email").toLowerCase();
    if (!email) {
      return json({ error: "sign_in_required" }, 401);
    }
    const name = readIdentity(request, "X-Gera-Name");

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

    if (request.method === "GET" && url.pathname === "/status") {
      return this.handleStatus(email);
    }
    if (request.method === "POST" && url.pathname === "/request") {
      return this.handleRequest(request, email, name);
    }

    // Everything below is admin-only.
    const caller = this.inviteFor(email);
    if (!caller || caller.role !== "admin") {
      return json({ error: "admin_only" }, 403);
    }
    if (request.method === "GET" && url.pathname === "/admin/overview") {
      return this.handleOverview();
    }
    if (request.method === "POST" && url.pathname === "/admin/invite") {
      return this.handleInvite(request, email);
    }
    if (request.method === "POST" && url.pathname === "/admin/revoke") {
      return this.handleRevoke(request);
    }
    if (request.method === "POST" && url.pathname === "/admin/role") {
      return this.handleRole(request, email);
    }
    if (request.method === "POST" && url.pathname === "/admin/dismiss") {
      return this.handleDismiss(request);
    }
    return json({ error: "not_found" }, 404);
  }

  private handleStatus(email: string): Response {
    const invite = this.inviteFor(email);
    if (invite) {
      return json({
        email,
        status: "invited",
        role: invite.role === "admin" ? "admin" : "member",
        requestedAt: null,
      });
    }
    const pending = this.requestFor(email);
    if (pending && pending.status === "pending") {
      return json({ email, status: "pending", role: null, requestedAt: pending.created_at });
    }
    return json({ email, status: "none", role: null, requestedAt: null });
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
