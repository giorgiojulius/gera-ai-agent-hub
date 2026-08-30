// ShareStore — singleton Durable Object (id "global") holding public
// read-only chat snapshots. The Worker entrypoint verifies identity for
// create/mine/revoke (platform-verified X-Rork-User-* headers, plus an
// invite check for create) and lets /get through with no identity at all —
// that is the whole point of a share link: anyone with the URL can read it.
import { DurableObject } from "cloudflare:workers";

/** Serialized snapshot cap — links must stay light and SQLite rows bounded. */
const PAYLOAD_LIMIT = 1_400_000;
const TITLE_LIMIT = 160;
const CHAT_ID_LIMIT = 120;
const MAX_MESSAGES = 500;
const MINE_LIMIT = 100;

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 14 random base62 chars — unguessable (~10^25) yet short enough for a URL. */
function newShareId(): string {
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) {
    id += ID_ALPHABET[byte % ID_ALPHABET.length];
  }
  return id;
}

type ShareRow = {
  id: string;
  owner_email: string;
  chat_id: string;
  title: string;
  created_at: number;
  updated_at: number;
};

type ShareRowWithPayload = ShareRow & { payload: string };

function readEmail(request: Request): string {
  const raw = request.headers.get("X-Gera-Email") ?? "";
  try {
    return decodeURIComponent(raw).trim().toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export class ShareStore extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS shares (
        id TEXT PRIMARY KEY,
        owner_email TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        title TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares (owner_email)");
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Public read — no identity on purpose.
    if (request.method === "GET" && url.pathname === "/get") {
      return this.handleGet(url);
    }

    const email = readEmail(request);
    if (!email) {
      return json({ error: "sign_in_required" }, 401);
    }
    if (request.method === "POST" && url.pathname === "/create") {
      return this.handleCreate(request, email);
    }
    if (request.method === "GET" && url.pathname === "/mine") {
      return this.handleMine(email);
    }
    if (request.method === "POST" && url.pathname === "/revoke") {
      return this.handleRevoke(request, email);
    }
    return json({ error: "not_found" }, 404);
  }

  private handleGet(url: URL): Response {
    const id = url.searchParams.get("id") ?? "";
    const rows = this.ctx.storage.sql
      .exec<ShareRowWithPayload>(
        "SELECT id, owner_email, chat_id, title, payload, created_at, updated_at FROM shares WHERE id = ?",
        id,
      )
      .toArray();
    const row = rows[0];
    if (!row) {
      return json({ error: "not_found" }, 404);
    }
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(row.payload);
    } catch {
      return json({ error: "not_found" }, 404);
    }
    return json({
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      snapshot,
    });
  }

  /** Creates a share, or refreshes the existing one for the same chat — the link never changes. */
  private async handleCreate(request: Request, email: string): Promise<Response> {
    let body: { chatId?: unknown; title?: unknown; snapshot?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const chatId = typeof body.chatId === "string" ? body.chatId.trim().slice(0, CHAT_ID_LIMIT) : "";
    if (!chatId) {
      return json({ error: "invalid_chat" }, 400);
    }
    const snapshot = body.snapshot;
    if (!snapshot || typeof snapshot !== "object") {
      return json({ error: "invalid_snapshot" }, 400);
    }
    const messages = (snapshot as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
      return json({ error: "invalid_snapshot" }, 400);
    }
    const payload = JSON.stringify(snapshot);
    if (payload.length > PAYLOAD_LIMIT) {
      return json({ error: "chat_too_large" }, 413);
    }
    const title =
      (typeof body.title === "string" ? body.title.replace(/\s+/g, " ").trim().slice(0, TITLE_LIMIT) : "") ||
      "Shared chat";

    const now = Date.now();
    const existing = this.ctx.storage.sql
      .exec<ShareRow>(
        "SELECT id, owner_email, chat_id, title, created_at, updated_at FROM shares WHERE owner_email = ? AND chat_id = ?",
        email,
        chatId,
      )
      .toArray()[0];

    if (existing) {
      this.ctx.storage.sql.exec(
        "UPDATE shares SET title = ?, payload = ?, updated_at = ? WHERE id = ?",
        title,
        payload,
        now,
        existing.id,
      );
      return json({ id: existing.id, chatId, title, createdAt: existing.created_at, updatedAt: now });
    }

    const id = newShareId();
    this.ctx.storage.sql.exec(
      "INSERT INTO shares (id, owner_email, chat_id, title, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      email,
      chatId,
      title,
      payload,
      now,
      now,
    );
    return json({ id, chatId, title, createdAt: now, updatedAt: now });
  }

  private handleMine(email: string): Response {
    const shares = this.ctx.storage.sql
      .exec<ShareRow>(
        "SELECT id, owner_email, chat_id, title, created_at, updated_at FROM shares WHERE owner_email = ? ORDER BY updated_at DESC LIMIT ?",
        email,
        MINE_LIMIT,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        chatId: row.chat_id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    return json({ shares });
  }

  private async handleRevoke(request: Request, email: string): Promise<Response> {
    let id = "";
    try {
      const body = (await request.json()) as { id?: unknown };
      if (typeof body.id === "string") {
        id = body.id.trim();
      }
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    if (!id) {
      return json({ error: "invalid_body" }, 400);
    }
    const row = this.ctx.storage.sql
      .exec<{ owner_email: string }>("SELECT owner_email FROM shares WHERE id = ?", id)
      .toArray()[0];
    if (!row || row.owner_email !== email) {
      // Same answer for "missing" and "not yours" — no share-id probing.
      return json({ error: "not_found" }, 404);
    }
    this.ctx.storage.sql.exec("DELETE FROM shares WHERE id = ?", id);
    return json({ ok: true });
  }
}
