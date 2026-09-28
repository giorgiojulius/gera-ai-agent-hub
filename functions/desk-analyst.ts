// Team-performance intelligence on the strongest reasoning line: the model
// that grades Intercom replies and the "Ask the analyst" route. Both pin the
// newest Claude Opus at xhigh effort (claude-opus-5.5:xhigh today, the next
// Opus the day the gateway lists it) and never fall back silently to another
// model — a grade or an answer always names the model that produced it.

import { capText, type EngineMessage, streamGatewayCompletion } from "./agent-engine";
import { asStr, isRecord, json } from "./chat-shared";
import {
  ANALYST_QUESTION_LIMIT,
  ANALYST_TRANSCRIPTS,
  type AnalyticsReply,
  buildAnalystMessages,
  parseAnalystHistory,
} from "./desk-analytics";
import type { DeskContext } from "./desk-routes";
import { latestModelSelection, modelMaxOutputTokens } from "./model-catalog";
import type { MemberRow } from "./project-rows";
import { canManageProject } from "./project-shared";

/** Seed of the grading / analyst line; moved to the newest Opus at call time. */
export const DESK_ANALYST_SEED = "anthropic/claude-opus-5.5:xhigh";
const ANALYST_ROWS_CAP = 2_000;

/** The newest Opus selection, always at xhigh effort. */
export async function deskAnalystModel(): Promise<string> {
  const latest = await latestModelSelection(DESK_ANALYST_SEED);
  const base = latest.includes(":") ? latest.slice(0, latest.lastIndexOf(":")) : latest;
  return `${base}:xhigh`;
}

/** One tool-less completion on the analyst line; returns the text and the model that wrote it. */
export async function deskAnalystCompletion(
  ctx: DeskContext,
  messages: EngineMessage[],
): Promise<{ content: string; modelId: string }> {
  const authKey = ctx.workerEnv.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY ?? ctx.workerEnv.RORK_TOOLKIT_SECRET_KEY ?? "";
  if (!authKey) {
    throw new Error("The backend has no AI key configured — ask the workspace admin.");
  }
  const modelId = await deskAnalystModel();
  const result = await streamGatewayCompletion({
    authKey,
    modelId,
    reasoningEffort: "xhigh",
    messages,
    tools: [],
    fallbacks: false,
    maxOutputTokens: await modelMaxOutputTokens(modelId),
    handlers: { onText: () => undefined },
  });
  if (result.cut) {
    throw new Error("The analysis stream was cut before the model finished — run it again.");
  }
  const served = result.servedModelId || modelId.slice(0, modelId.lastIndexOf(":"));
  return { content: result.content, modelId: served };
}

type ReplyRow = {
  id: string;
  conversation_id: string;
  admin_id: string;
  admin_name: string;
  customer_text: string;
  reply_text: string;
  response_ms: number;
  at: number;
  grade: string;
  grade_reason: string;
};

function rangeOf(record: Record<string, unknown>): { from: number; to: number } {
  const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return { from: num(record.from), to: num(record.to) };
}

/**
 * POST /intercom/stats/ask — answers a free-form question about the desk's
 * team performance from the harvested replies, grades, coaching and the
 * transcripts behind bad replies. Admins ask about the whole team; members
 * only ever get their own linked replies into the prompt (same visibility as
 * the stats cards). Read-only: nothing is stored, the client keeps the chat.
 */
export async function handleDeskAnalystAsk(ctx: DeskContext, me: MemberRow, body: unknown): Promise<Response> {
  const record = isRecord(body) ? body : {};
  const screenId = asStr(record.screenId);
  const screen = screenId ? ctx.loadScreen(screenId) : undefined;
  if (!screen) {
    return json({ error: "screen_not_found" }, 404);
  }
  const question = asStr(record.question).trim().slice(0, ANALYST_QUESTION_LIMIT);
  if (!question) {
    return json({ error: "question_required" }, 400);
  }
  const range = rangeOf(record);
  const tzRaw = record.tzOffsetMinutes;
  const tzOffsetMinutes =
    typeof tzRaw === "number" && Number.isFinite(tzRaw) && Math.abs(tzRaw) <= 14 * 60 ? Math.round(tzRaw) : 0;
  const sql = ctx.sql;
  const isAdmin = canManageProject(ctx.memberRole(me));
  const conditions = ["screen_id = ?"];
  const bindings: Array<string | number> = [screen.id];
  if (range.from > 0) {
    conditions.push("at >= ?");
    bindings.push(range.from);
  }
  if (range.to > 0) {
    conditions.push("at <= ?");
    bindings.push(range.to);
  }
  if (!isAdmin) {
    const own = sql
      .exec<{ admin_id: string }>("SELECT admin_id FROM desk_links WHERE email = ?", me.email)
      .toArray()
      .map((row) => row.admin_id);
    if (own.length === 0) {
      return json({ error: "not_linked", message: "Your account is not linked to an Intercom teammate yet — ask an admin." }, 403);
    }
    conditions.push(`admin_id IN (${own.map(() => "?").join(", ")})`);
    bindings.push(...own);
  }
  const replies = sql
    .exec<ReplyRow>(
      `SELECT id, conversation_id, admin_id, admin_name, customer_text, reply_text, response_ms, at, grade, grade_reason
       FROM desk_replies WHERE ${conditions.join(" AND ")} ORDER BY at DESC LIMIT ?`,
      ...bindings,
      ANALYST_ROWS_CAP,
    )
    .toArray();
  if (replies.length === 0) {
    return json({ error: "no_data", message: "No replies collected for this range yet — run Analyze conversations first." }, 409);
  }
  const rows: AnalyticsReply[] = replies.map((row) => ({
    adminId: row.admin_id,
    adminName: row.admin_name,
    conversationId: row.conversation_id,
    at: row.at,
    responseMs: row.response_ms,
    grade: row.grade,
    reason: row.grade_reason,
    customer: row.customer_text,
    reply: row.reply_text,
  }));
  const adminIds = new Set(rows.map((row) => row.adminId));
  const names = new Map(rows.map((row) => [row.adminId, row.adminName ?? ""]));
  const coaching = sql
    .exec<{ admin_id: string; text: string }>("SELECT admin_id, text FROM desk_coach")
    .toArray()
    .filter((row) => adminIds.has(row.admin_id) && row.text)
    .map((row) => ({ adminId: row.admin_id, name: names.get(row.admin_id) || `Admin #${row.admin_id}`, text: row.text }));
  const badConversations: string[] = [];
  for (const row of replies) {
    if (row.grade === "bad" && !badConversations.includes(row.conversation_id)) {
      badConversations.push(row.conversation_id);
    }
    if (badConversations.length >= ANALYST_TRANSCRIPTS) {
      break;
    }
  }
  const transcripts = badConversations
    .map((conversationId) => ({
      conversationId,
      transcript:
        sql
          .exec<{ transcript: string }>(
            "SELECT transcript FROM desk_transcripts WHERE screen_id = ? AND conversation_id = ?",
            screen.id,
            conversationId,
          )
          .toArray()[0]?.transcript ?? "",
    }))
    .filter((item) => item.transcript);
  const meta = sql
    .exec<{ scanned_conversations: number; analyzed_conversations: number; limit_reached: number }>(
      "SELECT scanned_conversations, analyzed_conversations, limit_reached FROM desk_stats_meta WHERE screen_id = ?",
      screen.id,
    )
    .toArray()[0];
  const messages = buildAnalystMessages({
    question,
    history: parseAnalystHistory(record.history),
    rows,
    coaching,
    transcripts,
    range,
    tzOffsetMinutes,
    now: Date.now(),
    coverage: meta
      ? {
          scannedConversations: meta.scanned_conversations,
          analyzedConversations: meta.analyzed_conversations,
          limitReached: meta.limit_reached === 1,
        }
      : null,
    scope: isAdmin ? "team" : "self",
  });
  try {
    const answer = await deskAnalystCompletion(ctx, messages);
    if (!answer.content.trim()) {
      return json({ error: "empty_answer", message: "The model returned an empty answer — ask again." }, 502);
    }
    console.log("desk analyst answered", replies.length, answer.modelId);
    return json({
      answer: capText(answer.content, 40_000),
      modelId: answer.modelId,
      basis: {
        replies: rows.length,
        graded: rows.filter((row) => row.grade === "good" || row.grade === "bad").length,
        transcripts: transcripts.length,
        scope: isAdmin ? "team" : "self",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analyst run failed.";
    console.error("desk analyst failed", message.slice(0, 160));
    return json({ error: "analyst_failed", message }, 502);
  }
}
