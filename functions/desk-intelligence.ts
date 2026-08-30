// Desk intelligence — the LLM glue behind the screen desk: reply suggestions
// written in a live-human voice (calibrated by 👍/👎 votes and the team's own
// graded replies), a snooze/close recommendation, functionality-question
// detection for "Ask Gera", and grading/coaching of real teammate replies —
// each judged INSIDE its full conversation transcript, never as a lone pair.
// This file is PURE (prompt builders + strict JSON parsers) so it unit-tests
// without a gateway; the actual completion call lives in project-store.

import type { EngineMessage } from "./agent-engine";

export type DeskSuggestParsed = {
  /** Up to 3 ready-to-send reply drafts in the customer's language. */
  replies: string[];
  /** The recommended next move for this thread. */
  action: "reply" | "snooze" | "close";
  actionReason: string;
  /** Non-empty when the customer asks how the product works — feeds "Ask Gera". */
  functionalityQuestion: string;
  /**
   * Set when the team's Slack already covers this case: "in_progress" = an
   * investigation is still running (wait, don't invent), "answered" = Slack
   * holds the outcome and the drafts used it.
   */
  investigation: { status: "in_progress" | "answered"; summary: string } | null;
};

export type DeskGradeParsed = {
  grades: Array<{ id: string; verdict: "good" | "bad"; reason: string }>;
  coaching: Array<{ adminId: string; text: string }>;
};

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Finds the outermost JSON object in an LLM answer; fences and prose tolerated. */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  for (const candidate of [fenced?.[1] ?? "", text]) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** Strict parse of the suggestion payload; null = unreadable (caller errors honestly). */
export function parseSuggestPayload(raw: string): DeskSuggestParsed | null {
  const obj = extractJsonObject(raw);
  if (!obj) {
    return null;
  }
  const replies = (Array.isArray(obj.replies) ? obj.replies : [])
    .map((item) => str(item))
    .filter((item) => item.length > 0)
    .slice(0, 3);
  const actionRaw = str(obj.action).toLowerCase();
  const action = actionRaw === "close" || actionRaw === "snooze" ? actionRaw : "reply";
  if (replies.length === 0 && action === "reply") {
    return null;
  }
  let investigation: DeskSuggestParsed["investigation"] = null;
  const invRaw = obj.investigation;
  if (invRaw && typeof invRaw === "object" && !Array.isArray(invRaw)) {
    const inv = invRaw as Record<string, unknown>;
    const status = str(inv.status).toLowerCase();
    if (status === "in_progress" || status === "answered") {
      investigation = { status, summary: str(inv.summary).slice(0, 280) };
    }
  }
  return {
    replies,
    action,
    actionReason: str(obj.action_reason ?? obj.actionReason).slice(0, 240),
    functionalityQuestion: str(obj.functionality_question ?? obj.functionalityQuestion).slice(0, 300),
    investigation,
  };
}

/** Strict parse of the grading payload; drops entries without an id or a good/bad verdict. */
export function parseGradePayload(raw: string): DeskGradeParsed | null {
  const obj = extractJsonObject(raw);
  if (!obj) {
    return null;
  }
  const grades: DeskGradeParsed["grades"] = [];
  for (const item of Array.isArray(obj.grades) ? obj.grades : []) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const id = str(entry.id);
    const verdictRaw = str(entry.verdict).toLowerCase();
    if (!id || (verdictRaw !== "good" && verdictRaw !== "bad")) {
      continue;
    }
    grades.push({ id, verdict: verdictRaw, reason: str(entry.reason).slice(0, 300) });
  }
  const coaching: DeskGradeParsed["coaching"] = [];
  for (const item of Array.isArray(obj.coaching) ? obj.coaching : []) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const adminId = str(entry.admin_id ?? entry.adminId);
    const text = str(entry.text).slice(0, 900);
    if (adminId && text) {
      coaching.push({ adminId, text });
    }
  }
  if (grades.length === 0 && coaching.length === 0) {
    return null;
  }
  return { grades, coaching };
}

export type SuggestPromptInput = {
  customer: string;
  state: string;
  /** Transcript lines, oldest first — "Customer (Anna): …", "Maria (teammate): …". */
  transcript: string[];
  /** Suggestions this team rated 👍 — the taste to match. */
  likedExamples: string[];
  /** Suggestions this team rated 👎 — patterns to avoid. */
  dislikedExamples: string[];
  /** Real teammate replies the grader marked good — the team's actual voice. */
  teamExamples: string[];
  /** Formatted Slack threads that reference this case (see desk-slack.ts). */
  slackThreads?: string[];
};

const SUGGEST_SYSTEM = [
  "You draft reply suggestions for a HUMAN support teammate working a live Intercom conversation.",
  "",
  "Voice — sound like a real person typing in a live chat:",
  "- First person, contractions, warm but direct; short sentences.",
  "- Mirror the customer's language (Russian customer → suggest in Russian).",
  '- No corporate filler ("We apologize for any inconvenience"), no AI tells, no emoji unless the customer used them first.',
  "- 1–3 sentences per suggestion. Solve the case, or move it forward with THE one missing question.",
  "- Never invent facts, prices, links or promises. If the transcript lacks the answer, the honest draft says what you'll go check.",
  "",
  "Give 2–3 DIFFERENT options (e.g. one that resolves now, one that asks the key clarifying question).",
  "",
  "Then pick the next action for this thread:",
  '- "reply" — the customer is waiting on us.',
  '- "snooze" — the ball is with the customer or a third party; check back later.',
  '- "close" — resolved, thanked, or clearly finished.',
  "",
  'If the customer is asking how the PRODUCT works (features, limits, "is X supported", integrations), restate it as ONE short functionality question; otherwise use null.',
  "",
  'A "Team Slack" block may show the team\'s INTERNAL Slack discussions that reference this exact customer or conversation:',
  '- Slack already holds the answer/outcome → fold it into the drafts and set investigation {"status":"answered","summary":"one short line"}.',
  "- The team is still digging there (active thread, no outcome yet) → do NOT invent results: the lead draft honestly tells the customer we're on it, action is usually \"snooze\", and investigation is {\"status\":\"in_progress\",\"summary\":\"one short line\"}.",
  '- No Slack block, or it does not settle this case → "investigation": null. Never quote internal Slack verbatim to the customer.',
  "",
  "Answer with STRICT JSON only:",
  '{"replies":["…"],"action":"reply|snooze|close","action_reason":"short, human","functionality_question":"…"|null,"investigation":{"status":"in_progress|answered","summary":"…"}|null}',
].join("\n");

function numbered(items: string[], cap: number): string {
  return items
    .slice(0, cap)
    .map((item, index) => `${index + 1}. ${item.replace(/\s+/g, " ").slice(0, 400)}`)
    .join("\n");
}

export function buildSuggestMessages(input: SuggestPromptInput): EngineMessage[] {
  const blocks: string[] = [
    `Conversation with ${input.customer || "the customer"} (state: ${input.state || "open"}), oldest first:`,
    input.transcript.join("\n"),
  ];
  if (input.slackThreads && input.slackThreads.length > 0) {
    blocks.push(
      `Team Slack — internal discussions that reference this customer/conversation (newest first):\n\n${input.slackThreads
        .slice(0, 3)
        .join("\n\n")}`,
    );
  }
  if (input.teamExamples.length > 0) {
    blocks.push(
      `Calibration — REAL replies from this team that graded good (match this voice):\n${numbered(input.teamExamples, 6)}`,
    );
  }
  if (input.likedExamples.length > 0) {
    blocks.push(
      `Calibration — suggestions this team rated UP (more like these):\n${numbered(input.likedExamples, 6)}`,
    );
  }
  if (input.dislikedExamples.length > 0) {
    blocks.push(
      `Calibration — suggestions this team rated DOWN (avoid these patterns):\n${numbered(input.dislikedExamples, 6)}`,
    );
  }
  return [
    { role: "system", content: SUGGEST_SYSTEM },
    { role: "user", content: blocks.join("\n\n") },
  ];
}

export type GradeReplyRef = {
  /** Intercom part id — matches the [id] marker inside the transcript. */
  id: string;
  adminId: string;
  adminName: string;
  responseMs: number;
};

export type GradePromptInput = {
  /** Conversations with full transcripts; human replies carry [id] markers. */
  conversations: Array<{
    conversationId: string;
    /** Transcript lines, oldest first (see deriveConversationTranscript). */
    transcript: string;
    /** The ungraded replies inside this conversation, oldest first. */
    replies: GradeReplyRef[];
  }>;
  /** Replies whose conversation transcript is no longer stored — pair fallback. */
  orphans: Array<GradeReplyRef & { customerText: string; replyText: string }>;
};

const GRADE_SYSTEM = [
  "You audit a support team's REAL replies to customers, then coach each teammate.",
  "",
  'You get full conversation transcripts, oldest first. Human team replies are marked with ids like [123]. Grade ONLY the ids listed in each "Grade:" list — customer messages, bot replies, internal notes and unlisted team replies are context, never grade those.',
  "",
  "Judge every listed reply IN THE CONTEXT OF THE WHOLE CONVERSATION — what the customer had already said, tried and been told by that point:",
  '- "good" — answered what the customer actually needed at that moment, honest, human, moved the case forward, reasonably fast.',
  '- "bad" — ignored the conversation context, missed the question, canned or robotic, wrong or invented facts, needlessly slow, or left the customer stuck.',
  "reason: ONE short sentence naming the decisive factor.",
  "",
  'Then coach every teammate that appears (keyed by admin_id): 2–4 sentences addressed as "you" — what you do well, where you slipped (name the pattern, not reply ids), and the one change that would make you faster or better.',
  "",
  "Answer with STRICT JSON only:",
  '{"grades":[{"id":"…","verdict":"good|bad","reason":"…"}],"coaching":[{"admin_id":"…","text":"…"}]}',
].join("\n");

/** "45s" / "12m" / "3h" — response-time label for the grading prompt. */
function humanDuration(ms: number): string {
  if (ms <= 0) {
    return "unknown";
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 36) {
    return `${hours}h`;
  }
  return `${Math.round(hours / 24)}d`;
}

const GRADE_TRANSCRIPT_MAX_LINES = 40;
const GRADE_TRANSCRIPT_MAX_CHARS = 4200;

/** Drops the OLDEST unmarked lines when over budget; replies being graded always survive. */
function trimTranscript(transcript: string, protectedIds: string[]): string {
  const lines = transcript
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim().slice(0, 320))
    .filter((line) => line.length > 0);
  const isProtected = (line: string): boolean =>
    protectedIds.some((id) => line.startsWith(`[${id}]`));
  let total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  let dropped = 0;
  while (lines.length > GRADE_TRANSCRIPT_MAX_LINES || total > GRADE_TRANSCRIPT_MAX_CHARS) {
    const index = lines.findIndex((line) => !isProtected(line));
    if (index === -1) {
      break;
    }
    total -= lines[index].length + 1;
    lines.splice(index, 1);
    dropped += 1;
  }
  return dropped > 0
    ? [`(… ${dropped} earlier messages trimmed)`, ...lines].join("\n")
    : lines.join("\n");
}

function gradeTargetLine(reply: GradeReplyRef): string {
  const wait =
    reply.responseMs > 0
      ? `customer waited ${humanDuration(reply.responseMs)}`
      : "proactive / follow-up (no customer message waiting)";
  return `[${reply.id}] ${reply.adminName} (admin_id ${reply.adminId}) — ${wait}`;
}

export function buildGradeMessages(input: GradePromptInput): EngineMessage[] {
  const blocks: string[] = [];
  input.conversations.forEach((conversation, index) => {
    const ids = conversation.replies.map((reply) => reply.id);
    blocks.push(
      [
        `Conversation ${index + 1} (id ${conversation.conversationId}), oldest first:`,
        trimTranscript(conversation.transcript, ids),
        `Grade:\n${conversation.replies.map((reply) => `- ${gradeTargetLine(reply)}`).join("\n")}`,
      ].join("\n\n"),
    );
  });
  if (input.orphans.length > 0) {
    const lines = input.orphans.map((row) => {
      const customer = row.customerText
        ? `customer said: "${row.customerText.replace(/\s+/g, " ").slice(0, 500)}"`
        : "no preceding customer message (proactive reply)";
      return [
        `- ${gradeTargetLine(row)}`,
        `  ${customer}`,
        `  reply: "${row.replyText.replace(/\s+/g, " ").slice(0, 700)}"`,
      ].join("\n");
    });
    blocks.push(
      `Replies whose conversation transcript is no longer stored — grade each from its pair alone:\n${lines.join("\n")}`,
    );
  }
  return [
    { role: "system", content: GRADE_SYSTEM },
    { role: "user", content: blocks.join("\n\n---\n\n") },
  ];
}
