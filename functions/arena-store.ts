// ArenaStore — singleton Durable Object (id "global") holding two journals:
// 1. battles — manual blind-duel votes (admin-only surface now);
// 2. usage_events — automatic telemetry: every member's real turns report
//    model id, mode, outcome and token counts (never message content), so
//    arena standings build themselves from actual usage.
// The Worker entrypoint enforces identity + invite before anything reaches
// this object, and the admin role for reads/clears. Rows are plain facts —
// ratings and shares are recomputed on read, so formulas can evolve without
// a data migration.
import { DurableObject } from "cloudflare:workers";

/** The journal keeps this many most-recent battles; older rows fall off. */
const MAX_BATTLES = 2000;
const PROMPT_LIMIT = 280;
const MODEL_ID_LIMIT = 120;

/** Usage telemetry caps: bounded table, bounded batch, sane token values. */
const MAX_USAGE_EVENTS = 50_000;
const USAGE_BATCH_LIMIT = 100;
const MODE_LIMIT = 24;
const TOKEN_CAP = 100_000_000;

type BattleRow = {
  id: string;
  voter_email: string;
  winner_id: string;
  loser_id: string;
  draw: number;
  prompt: string;
  winner_cost: number | null;
  loser_cost: number | null;
  created_at: number;
};

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

function asModelId(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MODEL_ID_LIMIT) : "";
}

/** Costs are USD estimates from gateway list rates; null when not metered. */
function asCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function asTokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Math.round(value), TOKEN_CAP);
}

type UsageStatRow = {
  model_id: string;
  mode: string;
  runs: number;
  errors: number | null;
  users: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  units: number | null;
  last_used: number | null;
};

function toApi(row: BattleRow) {
  return {
    id: row.id,
    voter: row.voter_email,
    winnerId: row.winner_id,
    loserId: row.loser_id,
    draw: row.draw === 1,
    prompt: row.prompt,
    winnerCost: row.winner_cost ?? undefined,
    loserCost: row.loser_cost ?? undefined,
    createdAt: row.created_at,
  };
}

export class ArenaStore extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS battles (
        id TEXT PRIMARY KEY,
        voter_email TEXT NOT NULL,
        winner_id TEXT NOT NULL,
        loser_id TEXT NOT NULL,
        draw INTEGER NOT NULL DEFAULT 0,
        prompt TEXT NOT NULL,
        winner_cost REAL,
        loser_cost REAL,
        created_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_battles_created ON battles (created_at)");
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        model_id TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'chat',
        ok INTEGER NOT NULL DEFAULT 1,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events (created_at)");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_events (model_id)");
    // Media units (image count / video seconds / TTS characters) — added later;
    // existing tables gain the column in place, rethrowing real failures.
    try {
      this.ctx.storage.sql.exec("ALTER TABLE usage_events ADD COLUMN units INTEGER NOT NULL DEFAULT 0");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("duplicate column")) {
        throw error;
      }
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const email = readEmail(request);
    if (!email) {
      return json({ error: "sign_in_required" }, 401);
    }
    if (request.method === "GET" && url.pathname === "/list") {
      return this.handleList();
    }
    if (request.method === "POST" && url.pathname === "/log") {
      return this.handleLog(request, email);
    }
    if (request.method === "POST" && url.pathname === "/clear") {
      return this.handleClear();
    }
    if (request.method === "POST" && url.pathname === "/usage") {
      return this.handleUsageLog(request, email);
    }
    if (request.method === "GET" && url.pathname === "/usage/stats") {
      return this.handleUsageStats(url);
    }
    if (request.method === "POST" && url.pathname === "/usage/clear") {
      this.ctx.storage.sql.exec("DELETE FROM usage_events");
      return json({ ok: true });
    }
    return json({ error: "not_found" }, 404);
  }

  /**
   * Batch ingest of automatic usage events. Invalid entries are skipped, not
   * rejected — telemetry must never break a member's chat.
   */
  private async handleUsageLog(request: Request, email: string): Promise<Response> {
    let body: { events?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const rawEvents = Array.isArray(body.events) ? body.events.slice(0, USAGE_BATCH_LIMIT) : [];
    const now = Date.now();
    let accepted = 0;
    for (const item of rawEvents) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const event = item as Record<string, unknown>;
      const modelId = asModelId(event.modelId);
      if (!modelId) {
        continue;
      }
      const mode =
        typeof event.mode === "string" && event.mode.trim().length > 0
          ? event.mode.trim().slice(0, MODE_LIMIT)
          : "chat";
      this.ctx.storage.sql.exec(
        "INSERT INTO usage_events (email, model_id, mode, ok, prompt_tokens, completion_tokens, units, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        email,
        modelId,
        mode,
        event.ok === false ? 0 : 1,
        asTokens(event.promptTokens),
        asTokens(event.completionTokens),
        asTokens(event.units),
        now,
      );
      accepted += 1;
    }
    if (accepted > 0) {
      // Bound the log — oldest events fall off past the cap.
      this.ctx.storage.sql.exec(
        "DELETE FROM usage_events WHERE id NOT IN (SELECT id FROM usage_events ORDER BY id DESC LIMIT ?)",
        MAX_USAGE_EVENTS,
      );
    }
    return json({ ok: true, accepted });
  }

  /** Per-(model, mode) aggregates since a timestamp; 0 = all time. */
  private handleUsageStats(url: URL): Response {
    const sinceRaw = Number(url.searchParams.get("since") ?? "0");
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
    const rows = this.ctx.storage.sql
      .exec<UsageStatRow>(
        `SELECT model_id, mode,
           COUNT(*) AS runs,
           SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS errors,
           COUNT(DISTINCT email) AS users,
           SUM(prompt_tokens) AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(units) AS units,
           MAX(created_at) AS last_used
         FROM usage_events WHERE created_at >= ?
         GROUP BY model_id, mode
         ORDER BY runs DESC, model_id ASC`,
        since,
      )
      .toArray();
    return json({
      stats: rows.map((row) => ({
        modelId: row.model_id,
        mode: row.mode,
        runs: row.runs,
        errors: row.errors ?? 0,
        users: row.users,
        promptTokens: row.prompt_tokens ?? 0,
        completionTokens: row.completion_tokens ?? 0,
        units: row.units ?? 0,
        lastUsed: row.last_used ?? 0,
      })),
    });
  }

  /** Chronological order — exactly what an Elo replay needs. */
  private handleList(): Response {
    const rows = this.ctx.storage.sql
      .exec<BattleRow>(
        "SELECT id, voter_email, winner_id, loser_id, draw, prompt, winner_cost, loser_cost, created_at FROM battles ORDER BY created_at ASC, id ASC",
      )
      .toArray();
    return json({ battles: rows.map(toApi) });
  }

  private async handleLog(request: Request, email: string): Promise<Response> {
    let body: {
      winnerId?: unknown;
      loserId?: unknown;
      draw?: unknown;
      prompt?: unknown;
      winnerCost?: unknown;
      loserCost?: unknown;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const winnerId = asModelId(body.winnerId);
    const loserId = asModelId(body.loserId);
    if (!winnerId || !loserId || winnerId === loserId) {
      return json({ error: "invalid_models" }, 400);
    }
    const prompt =
      typeof body.prompt === "string" ? body.prompt.replace(/\s+/g, " ").trim().slice(0, PROMPT_LIMIT) : "";

    const row: BattleRow = {
      id: `bt_${crypto.randomUUID()}`,
      voter_email: email,
      winner_id: winnerId,
      loser_id: loserId,
      draw: body.draw === true ? 1 : 0,
      prompt,
      winner_cost: asCost(body.winnerCost),
      loser_cost: asCost(body.loserCost),
      created_at: Date.now(),
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO battles (id, voter_email, winner_id, loser_id, draw, prompt, winner_cost, loser_cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.id,
      row.voter_email,
      row.winner_id,
      row.loser_id,
      row.draw,
      row.prompt,
      row.winner_cost,
      row.loser_cost,
      row.created_at,
    );
    // Bound the journal — oldest rows fall off past the cap.
    this.ctx.storage.sql.exec(
      "DELETE FROM battles WHERE id NOT IN (SELECT id FROM battles ORDER BY created_at DESC, id DESC LIMIT ?)",
      MAX_BATTLES,
    );
    return json({ battle: toApi(row) });
  }

  private handleClear(): Response {
    this.ctx.storage.sql.exec("DELETE FROM battles");
    return json({ ok: true });
  }
}
