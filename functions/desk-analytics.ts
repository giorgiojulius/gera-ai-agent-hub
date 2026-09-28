// Team-performance analytics: deterministic aggregates over the harvested
// Intercom reply log (response-time SLA buckets, weekday × hour load, weekly
// trend, per-teammate digest) plus the prompt for the "Ask the analyst" chat.
//
// Platform-neutral and pure: the worker feeds it rows from SQLite to build
// the analyst prompt, the web client feeds it the stats timeline to draw the
// same numbers — so the model and the charts always agree.

import type { EngineMessage } from "./agent-engine";

/** One harvested teammate reply; texts are optional (the client timeline has none). */
export type AnalyticsReply = {
  adminId: string;
  adminName?: string;
  conversationId: string;
  at: number;
  responseMs: number;
  grade: string;
  reason?: string;
  customer?: string;
  reply?: string;
};

export type ResponseBucket = { id: string; label: string; count: number };

export type TeammateDigest = {
  adminId: string;
  name: string;
  replies: number;
  conversations: number;
  good: number;
  bad: number;
  ungraded: number;
  /** good / (good + bad) as a whole percent; null without grades. */
  goodRate: number | null;
  medianMs: number;
  p90Ms: number;
  /** Share of timed replies sent within one hour, whole percent; null without timings. */
  withinHourRate: number | null;
};

export type WeeklyPoint = {
  /** Monday of the week, YYYY-MM-DD in the viewer's zone. */
  week: string;
  replies: number;
  good: number;
  bad: number;
  medianMs: number;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** 1970-01-05 was a Monday — week buckets start there. */
const MONDAY_EPOCH_MS = 4 * DAY_MS;

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const BUCKETS: Array<{ id: string; label: string; maxMs: number }> = [
  { id: "5m", label: "< 5 min", maxMs: 5 * 60 * 1000 },
  { id: "15m", label: "5–15 min", maxMs: 15 * 60 * 1000 },
  { id: "1h", label: "15–60 min", maxMs: HOUR_MS },
  { id: "4h", label: "1–4 h", maxMs: 4 * HOUR_MS },
  { id: "24h", label: "4–24 h", maxMs: DAY_MS },
  { id: "more", label: "> 24 h", maxMs: Number.POSITIVE_INFINITY },
];

/** Replies with a customer waiting, spread over SLA buckets (proactive replies skipped). */
export function responseBuckets(points: ReadonlyArray<{ responseMs: number }>): ResponseBucket[] {
  const counts = BUCKETS.map((bucket) => ({ id: bucket.id, label: bucket.label, count: 0 }));
  for (const point of points) {
    if (point.responseMs <= 0) {
      continue;
    }
    const index = BUCKETS.findIndex((bucket) => point.responseMs < bucket.maxMs);
    counts[index === -1 ? counts.length - 1 : index].count += 1;
  }
  return counts;
}

/** Wall-clock ms in the viewer's zone (`tzOffsetMinutes` = Date#getTimezoneOffset()). */
function localMs(at: number, tzOffsetMinutes: number): number {
  return at - tzOffsetMinutes * 60 * 1000;
}

/** 7 × 24 reply counts: rows Monday…Sunday, columns hour 0…23 in the viewer's zone. */
export function loadHeatmap(points: ReadonlyArray<{ at: number }>, tzOffsetMinutes: number): number[][] {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const point of points) {
    if (point.at <= 0) {
      continue;
    }
    const local = new Date(localMs(point.at, tzOffsetMinutes));
    const weekday = (local.getUTCDay() + 6) % 7;
    grid[weekday][local.getUTCHours()] += 1;
  }
  return grid;
}

/** The busiest weekday/hour cells, highest first (ties: earlier in the week). */
export function peakSlots(grid: number[][], limit = 5): Array<{ weekday: number; hour: number; count: number }> {
  const cells: Array<{ weekday: number; hour: number; count: number }> = [];
  grid.forEach((row, weekday) => {
    row.forEach((count, hour) => {
      if (count > 0) {
        cells.push({ weekday, hour, count });
      }
    });
  });
  return cells.sort((a, b) => b.count - a.count || a.weekday - b.weekday || a.hour - b.hour).slice(0, limit);
}

function median(sorted: number[]): number {
  return sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
}

function p90(sorted: number[]): number {
  return sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)] : 0;
}

function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

/** Per-teammate aggregates, busiest first. */
export function teammateDigests(rows: ReadonlyArray<AnalyticsReply>): TeammateDigest[] {
  const byAdmin = new Map<string, AnalyticsReply[]>();
  for (const row of rows) {
    const list = byAdmin.get(row.adminId) ?? [];
    list.push(row);
    byAdmin.set(row.adminId, list);
  }
  return [...byAdmin.entries()]
    .map(([adminId, list]) => {
      const times = list
        .map((row) => row.responseMs)
        .filter((ms) => ms > 0)
        .sort((a, b) => a - b);
      const good = list.filter((row) => row.grade === "good").length;
      const bad = list.filter((row) => row.grade === "bad").length;
      return {
        adminId,
        name: list.find((row) => row.adminName)?.adminName || `Admin #${adminId}`,
        replies: list.length,
        conversations: new Set(list.map((row) => row.conversationId)).size,
        good,
        bad,
        ungraded: list.length - good - bad,
        goodRate: percent(good, good + bad),
        medianMs: median(times),
        p90Ms: p90(times),
        withinHourRate: percent(times.filter((ms) => ms <= HOUR_MS).length, times.length),
      };
    })
    .sort((a, b) => b.replies - a.replies);
}

/** Replies per Monday-start week in the viewer's zone, oldest first. */
export function weeklyTrend(rows: ReadonlyArray<AnalyticsReply>, tzOffsetMinutes: number): WeeklyPoint[] {
  const byWeek = new Map<number, AnalyticsReply[]>();
  for (const row of rows) {
    if (row.at <= 0) {
      continue;
    }
    const index = Math.floor((localMs(row.at, tzOffsetMinutes) - MONDAY_EPOCH_MS) / WEEK_MS);
    const list = byWeek.get(index) ?? [];
    list.push(row);
    byWeek.set(index, list);
  }
  return [...byWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, list]) => {
      const times = list
        .map((row) => row.responseMs)
        .filter((ms) => ms > 0)
        .sort((a, b) => a - b);
      return {
        week: new Date(index * WEEK_MS + MONDAY_EPOCH_MS).toISOString().slice(0, 10),
        replies: list.length,
        good: list.filter((row) => row.grade === "good").length,
        bad: list.filter((row) => row.grade === "bad").length,
        medianMs: median(times),
      };
    });
}

/** "45s" / "12m" / "3.5h" / "2d" — compact duration for prompts and labels. */
export function shortDuration(ms: number): string {
  if (ms <= 0) {
    return "—";
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return `${minutes}m`;
  }
  const hours = ms / HOUR_MS;
  if (hours < 36) {
    return `${Math.round(hours * 10) / 10}h`;
  }
  return `${Math.round(hours / 24)}d`;
}

// ---------------------------------------------------------------------------
// "Ask the analyst" prompt.

export type AnalystTurn = { role: "user" | "assistant"; content: string };

export type AnalystInput = {
  question: string;
  history: AnalystTurn[];
  rows: AnalyticsReply[];
  coaching: Array<{ adminId: string; name: string; text: string }>;
  /** Full transcripts of conversations holding bad replies — the "why" behind grades. */
  transcripts: Array<{ conversationId: string; transcript: string }>;
  range: { from: number; to: number };
  tzOffsetMinutes: number;
  now: number;
  coverage: { scannedConversations: number; analyzedConversations: number; limitReached: boolean } | null;
  /** Non-admins only ever see their own linked replies. */
  scope: "team" | "self";
};

export const ANALYST_QUESTION_LIMIT = 2_000;
export const ANALYST_HISTORY_TURNS = 8;
const ANALYST_TURN_CHARS = 6_000;
const SAMPLE_BAD = 90;
const SAMPLE_GOOD = 45;
const SAMPLE_UNGRADED = 25;
const SAMPLE_TEXT = 420;
const TRANSCRIPT_CHARS = 3_200;
export const ANALYST_TRANSCRIPTS = 14;

const ANALYST_SYSTEM = [
  "You are Gera's senior support-operations analyst. You answer questions about ONE support team's real Intercom performance, using ONLY the dataset in the user message: deterministic aggregates computed from every harvested reply, the reply log sample with model grades and reasons, coaching notes, and full transcripts behind bad replies.",
  "",
  "Rules:",
  "- Answer in the language of the question. Lead with the direct answer, then the evidence.",
  "- Every claim cites real numbers from the dataset (counts, %, medians). Never invent data, customers, teammates or periods that are not there.",
  "- State sample sizes and flag weak evidence (fewer than ~10 graded replies, a single week, ungraded share over half). Say plainly when the data cannot answer something and what to collect instead (wider date range, run Analyze again to grade more).",
  "- Response time: median and p90 are for replies where a customer was waiting; proactive follow-ups carry no wait.",
  "- Go beyond restating numbers: find patterns (who slips, when, on which topics), likely causes from the grade reasons and transcripts, and give concrete prioritized actions with an owner and a measurable target.",
  "- Quote short snippets of real replies when they illustrate a point; name teammates, never reply ids.",
  "- Use compact markdown: short headers, bullets, small tables where they help.",
  "- When a comparison, distribution or trend is clearer as a graph, emit a ```chart fence containing only JSON, e.g.",
  '  {"type":"bar","title":"Good-reply rate by teammate","xKey":"name","series":[{"key":"good","label":"Good %"}],"data":[{"name":"Anna","good":82}]}',
  '  Types: line, bar, area, pie, donut, radar, scatter; optional "stacked": true. Real values only, 3–30 points, one chart per fence.',
].join("\n");

function oneLine(text: string, limit: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

function dateLabel(ms: number, tzOffsetMinutes: number): string {
  return new Date(localMs(ms, tzOffsetMinutes)).toISOString().slice(0, 16).replace("T", " ");
}

/** Bad replies first (the most instructive), then good, then a few ungraded — newest first inside each. */
export function analystSample(rows: ReadonlyArray<AnalyticsReply>): AnalyticsReply[] {
  const newest = rows.slice().sort((a, b) => b.at - a.at);
  return [
    ...newest.filter((row) => row.grade === "bad").slice(0, SAMPLE_BAD),
    ...newest.filter((row) => row.grade === "good").slice(0, SAMPLE_GOOD),
    ...newest.filter((row) => row.grade !== "good" && row.grade !== "bad").slice(0, SAMPLE_UNGRADED),
  ];
}

function datasetBlock(input: AnalystInput): string {
  const { rows, tzOffsetMinutes } = input;
  const graded = rows.filter((row) => row.grade === "good" || row.grade === "bad");
  const good = graded.filter((row) => row.grade === "good").length;
  const times = rows
    .map((row) => row.responseMs)
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);
  const rangeText =
    input.range.from > 0 || input.range.to > 0
      ? `${input.range.from > 0 ? dateLabel(input.range.from, tzOffsetMinutes) : "start"} → ${input.range.to > 0 ? dateLabel(input.range.to, tzOffsetMinutes) : "now"}`
      : "all collected replies";
  const offsetHours = -tzOffsetMinutes / 60;
  const lines: string[] = [
    `DATASET (${input.scope === "team" ? "whole team" : "only the asking teammate's own replies"}) · range: ${rangeText} · viewer zone UTC${offsetHours >= 0 ? "+" : ""}${offsetHours} · generated ${dateLabel(input.now, tzOffsetMinutes)}`,
    input.coverage
      ? `Coverage of the last Analyze pass: read ${input.coverage.analyzedConversations} of ${input.coverage.scannedConversations} scanned conversations${input.coverage.limitReached ? " — SCAN LIMIT REACHED, older conversations in the range are missing" : ""}.`
      : "Coverage: no Analyze pass recorded.",
    "",
    "## Totals",
    `replies ${rows.length} · conversations ${new Set(rows.map((row) => row.conversationId)).size} · graded ${graded.length} (good ${good}, bad ${graded.length - good}, good-rate ${percent(good, graded.length) ?? "n/a"}%) · ungraded ${rows.length - graded.length}`,
    `response time (customer waiting, n=${times.length}): median ${shortDuration(median(times))} · p90 ${shortDuration(p90(times))} · within 1h ${percent(times.filter((ms) => ms <= HOUR_MS).length, times.length) ?? "n/a"}%`,
    "",
    "## Teammates",
    "name | admin_id | replies | conversations | good | bad | ungraded | good-rate | median | p90 | within 1h",
    ...teammateDigests(rows).map(
      (t) =>
        `${t.name} | ${t.adminId} | ${t.replies} | ${t.conversations} | ${t.good} | ${t.bad} | ${t.ungraded} | ${t.goodRate ?? "n/a"}% | ${shortDuration(t.medianMs)} | ${shortDuration(t.p90Ms)} | ${t.withinHourRate ?? "n/a"}%`,
    ),
    "",
    "## Response-time distribution",
    responseBuckets(rows)
      .map((bucket) => `${bucket.label}: ${bucket.count}`)
      .join(" · "),
    "",
    "## Weekly trend (Monday-start weeks)",
    "week | replies | good | bad | median",
    ...weeklyTrend(rows, tzOffsetMinutes).map(
      (week) => `${week.week} | ${week.replies} | ${week.good} | ${week.bad} | ${shortDuration(week.medianMs)}`,
    ),
  ];
  const grid = loadHeatmap(rows, tzOffsetMinutes);
  lines.push(
    "",
    "## Load by weekday (replies per hour 00…23)",
    ...grid.map((row, weekday) => `${WEEKDAY_LABELS[weekday]}: ${row.join(" ")}`),
    `Peaks: ${
      peakSlots(grid)
        .map((slot) => `${WEEKDAY_LABELS[slot.weekday]} ${String(slot.hour).padStart(2, "0")}:00 (${slot.count})`)
        .join(", ") || "none"
    }`,
  );
  if (input.coaching.length > 0) {
    lines.push("", "## Coaching notes from the last grading pass");
    for (const note of input.coaching) {
      lines.push(`- ${note.name}: ${oneLine(note.text, 900)}`);
    }
  }
  const sample = analystSample(rows);
  if (sample.length > 0) {
    lines.push(
      "",
      `## Reply log sample (${sample.length} of ${rows.length}: bad first, then good, then ungraded)`,
    );
    for (const row of sample) {
      const head = `- ${dateLabel(row.at, tzOffsetMinutes)} · ${row.adminName || row.adminId} · conv ${row.conversationId} · wait ${row.responseMs > 0 ? shortDuration(row.responseMs) : "proactive"} · ${row.grade || "ungraded"}${row.reason ? ` — ${oneLine(row.reason, 220)}` : ""}`;
      const customer = row.customer ? `\n  customer: "${oneLine(row.customer, SAMPLE_TEXT)}"` : "";
      const reply = row.reply ? `\n  reply: "${oneLine(row.reply, SAMPLE_TEXT)}"` : "";
      lines.push(`${head}${customer}${reply}`);
    }
  }
  if (input.transcripts.length > 0) {
    lines.push("", "## Transcripts behind bad replies (oldest message first)");
    for (const item of input.transcripts.slice(0, ANALYST_TRANSCRIPTS)) {
      const text = item.transcript.length > TRANSCRIPT_CHARS ? `…${item.transcript.slice(-TRANSCRIPT_CHARS)}` : item.transcript;
      lines.push(`### Conversation ${item.conversationId}`, text);
    }
  }
  return lines.join("\n");
}

/** System + dataset + prior turns + the new question — ready for one completion. */
export function buildAnalystMessages(input: AnalystInput): EngineMessage[] {
  const history = input.history.slice(-ANALYST_HISTORY_TURNS).map((turn) => ({
    role: turn.role,
    content: turn.content.slice(0, ANALYST_TURN_CHARS),
  }));
  return [
    { role: "system", content: ANALYST_SYSTEM },
    { role: "user", content: `${datasetBlock(input)}\n\nAcknowledge nothing; wait for questions.` },
    { role: "assistant", content: "Dataset loaded. Ask your question." },
    ...history,
    { role: "user", content: input.question.slice(0, ANALYST_QUESTION_LIMIT) },
  ];
}

/** Strict parse of the client's prior turns; anything malformed is dropped. */
export function parseAnalystHistory(raw: unknown): AnalystTurn[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const turns: AnalystTurn[] = [];
  for (const item of raw.slice(-ANALYST_HISTORY_TURNS)) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if ((record.role === "user" || record.role === "assistant") && typeof record.content === "string" && record.content.trim()) {
      turns.push({ role: record.role, content: record.content.slice(0, ANALYST_TURN_CHARS) });
    }
  }
  return turns;
}
