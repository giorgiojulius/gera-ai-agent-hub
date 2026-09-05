// Desk routes of the ProjectStore shard — screens, the Intercom inbox desk
// (inbox / thread / details / reply / mention-admins / suggest / action /
// ask-gera), website page-view tracking, desk ↔ Slack awareness, desk stats
// and screen chat. Moved verbatim out of project-store.ts: the shard stays a
// thin dispatcher and lends storage, its member / agent / screen lookups and
// the widget credentials through DeskContext. Secrets never leave the shard —
// tokens are resolved per request and only ever reach the connector calls.

import {
  capText,
  DEFAULT_CHAT_MODEL,
  type EngineMessage,
  streamGatewayCompletion,
} from "./agent-engine";
import { asStr, type ChatSql, isRecord, json } from "./chat-shared";
import {
  buildGradeMessages,
  buildSuggestMessages,
  type GradePromptInput,
  parseGradePayload,
  parseSuggestPayload,
} from "./desk-intelligence";
import {
  type DeskPageView,
  PAGE_VIEW_RETENTION_MS,
  PAGE_VIEWS_PER_CONTACT,
  pageViewContactKeys,
  parsePageViewPayload,
} from "./desk-pageviews";
import {
  buildSlackThreadBlock,
  type DeskSlackMessage,
  matchSlackDiscussions,
  slackPermalink,
  slackThreadActive,
} from "./desk-slack";
import {
  attachmentLabel,
  fetchIntercomConversationDetails,
  fetchIntercomInboxData,
  fetchIntercomThreadData,
  harvestIntercomReplyPairs,
  type IntercomAdminLite,
  type IntercomInboxState,
  listIntercomAdmins,
  manageIntercomConversationData,
  postIntercomReplyData,
} from "./native-intercom";
import {
  fetchChannelHistoryData,
  fetchSlackThreadTailData,
  fetchSlackUserNames,
  listBotChannels,
  type SlackThreadTail,
  verifySlackToken,
} from "./native-slack";
import {
  type AgentRow,
  type MemberRow,
  newId,
  parseWidgets,
  type ScreenChatRow,
  screenChatWire,
  type ScreenJobRow,
  type ScreenRow,
  screenWire,
  storedExecutionOutcome,
} from "./project-rows";
import {
  canManageProject,
  MAX_SCREENS,
  MESSAGE_BODY_LIMIT,
  type ProjectRole,
  SCREEN_CHAT_KEEP,
  SCREEN_NAME_LIMIT,
  validateScreenWidgets,
} from "./project-shared";

/** What the ProjectStore shard lends the desk routes: storage plus its lookups and widget credentials. */
export type DeskContext = {
  sql: ChatSql;
  /** Worker env — the AI gateway key for desk completions. */
  workerEnv: { EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY?: string; RORK_TOOLKIT_SECRET_KEY?: string };
  metaValue(key: string): string;
  loadMember(email: string): MemberRow | null;
  memberRole(member: MemberRow): ProjectRole;
  loadAgent(id: string): AgentRow | undefined;
  loadScreen(id: string): ScreenRow | undefined;
  /** The inbox widget's agent supplies the Intercom credential for the screen. */
  screenIntercomToken(screen: ScreenRow): Promise<{ token: string } | { error: string }>;
  /** The screen's Slack-capable agent supplies the bot token. */
  screenSlackToken(screen: ScreenRow): Promise<{ token: string } | { error: string }>;
};

// Desk intelligence: suggestion cache window, memory caps, grading batch size.
const DESK_SUGGEST_TTL_MS = 15 * 60 * 1000;
const DESK_SUGGESTIONS_KEEP = 300;
const DESK_REPLIES_KEEP = 2_000;
const DESK_GRADE_BATCH = 24;
const DESK_CONVERSATIONS_SCAN = 300;
/** Reply drafts ride Luna — a fixed fast writer; grading keeps the inbox agent's model. */
const DESK_SUGGEST_MODEL = "openai/gpt-5.6-luna";
const DESK_QUESTION_LIMIT = 600;
// Desk ↔ Slack awareness: channel-pool sync TTL and caps, ask-run windows.
const DESK_SLACK_TTL_MS = 150_000;
const DESK_SLACK_CHANNELS_CAP = 8;
const DESK_SLACK_HISTORY_LIMIT = 40;
const DESK_SLACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DESK_SLACK_RELATED_CAP = 3;
const DESK_SLACK_TAIL_LINES = 8;
const DESK_SLACK_NAMES_CAP = 300;
const DESK_SLACK_POOL_MESSAGES_CAP = 500;
/** A research run younger than this blocks duplicates for the same conversation. */
const DESK_ASK_DEDUP_MS = 10 * 60 * 1000;
/** How long a finished "Ask Gera" answer stays visible on the conversation. */
const DESK_ASK_VISIBLE_MS = 7 * 24 * 60 * 60 * 1000;

type DeskReplyRow = {
  screen_id: string;
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
type DeskSuggestionRow = {
  id: string;
  screen_id: string;
  conversation_id: string;
  text: string;
  verdict: string;
  created_at: number;
};
type DeskLinkRow = {
  admin_id: string;
  email: string;
  admin_name: string;
  admin_email: string;
  linked_at: number;
};
type DeskCoachRow = { admin_id: string; text: string; updated_at: number };
type DeskStatsMetaRow = {
  screen_id: string;
  scanned_conversations: number;
  analyzed_conversations: number;
  range_from: number;
  range_to: number;
  collected_at: number;
  limit_reached: number;
};
type DeskStatsRange = { from: number; to: number };
/** Synced Slack pool for one screen — watched channels + recent messages. */
type DeskSlackPoolData = {
  team: string;
  teamUrl: string;
  channels: Array<{ id: string; name: string }>;
  /** Slack user-id → display name captured at sync time. */
  names: Record<string, string>;
  messages: DeskSlackMessage[];
  syncedAt: number;
};
/** One related Slack discussion on the wire (and in the suggest prompt). */
type DeskSlackThreadWire = {
  channelId: string;
  channelName: string;
  rootTs: string;
  permalink: string;
  matchedBy: "conversation" | "email" | "name";
  lastActivityTs: number;
  active: boolean;
  replyCount: number;
  lines: Array<{ author: string; text: string; ts: string }>;
};

/** Validated inclusive millisecond range; zero means that side is unbounded. */
function deskStatsRange(body: unknown): DeskStatsRange {
  const record = isRecord(body) ? body : {};
  const rawFrom = typeof record.from === "number" ? record.from : Number(record.from ?? 0);
  const rawTo = typeof record.to === "number" ? record.to : Number(record.to ?? 0);
  const from = Number.isFinite(rawFrom) ? Math.max(0, Math.trunc(rawFrom)) : 0;
  const to = Number.isFinite(rawTo) ? Math.max(0, Math.trunc(rawTo)) : 0;
  return from > 0 && to > 0 && from > to ? { from: to, to: from } : { from, to };
}

export function handleScreenUpsert(ctx: DeskContext, me: MemberRow, body: unknown): Response {
  if (!canManageProject(ctx.memberRole(me))) {
    return json({ error: "admin_required" }, 403);
  }
  if (!isRecord(body)) {
    return json({ error: "invalid_body" }, 400);
  }
  const sql = ctx.sql;
  const id = asStr(body.id);
  const existing = id ? ctx.loadScreen(id) : undefined;
  if (id && !existing) {
    return json({ error: "screen_not_found" }, 404);
  }
  if (!existing) {
    const count = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM screens").toArray()[0]?.n ?? 0;
    if (count >= MAX_SCREENS) {
      return json({ error: "too_many_screens", limit: MAX_SCREENS }, 400);
    }
  }
  const name = asStr(body.name).trim().slice(0, SCREEN_NAME_LIMIT);
  if (!name) {
    return json({ error: "invalid_name" }, 400);
  }
  const emoji = asStr(body.emoji).slice(0, 8);
  const agentIds = new Set(
    sql.exec<{ id: string }>("SELECT id FROM agents").toArray().map((row) => row.id),
  );
  const channelIds = new Set(
    sql.exec<{ id: string }>("SELECT id FROM channels").toArray().map((row) => row.id),
  );
  const checked = validateScreenWidgets(body.widgets, agentIds, channelIds);
  if (!checked.ok) {
    return json({ error: checked.error }, 400);
  }
  const now = Date.now();
  const screenId = existing?.id ?? newId("s");
  if (existing) {
    sql.exec(
      "UPDATE screens SET name = ?, emoji = ?, widgets = ?, updated_at = ? WHERE id = ?",
      name,
      emoji,
      JSON.stringify(checked.widgets),
      now,
      screenId,
    );
  } else {
    sql.exec(
      "INSERT INTO screens (id, name, emoji, widgets, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      screenId,
      name,
      emoji,
      JSON.stringify(checked.widgets),
      now,
      now,
    );
  }
  const row = ctx.loadScreen(screenId);
  return json({ ok: true, screen: row ? screenWire(row) : null });
}

export function handleScreenDelete(ctx: DeskContext, me: MemberRow, body: unknown): Response {
  if (!canManageProject(ctx.memberRole(me))) {
    return json({ error: "admin_required" }, 403);
  }
  const id = isRecord(body) ? asStr(body.id) : "";
  if (!id) {
    return json({ error: "invalid_body" }, 400);
  }
  const sql = ctx.sql;
  sql.exec("DELETE FROM screens WHERE id = ?", id);
  sql.exec("DELETE FROM screen_chat WHERE screen_id = ?", id);
  sql.exec("DELETE FROM screen_jobs WHERE screen_id = ?", id);
  sql.exec("DELETE FROM desk_suggestions WHERE screen_id = ?", id);
  sql.exec("DELETE FROM desk_suggest_cache WHERE screen_id = ?", id);
  sql.exec("DELETE FROM desk_replies WHERE screen_id = ?", id);
  sql.exec("DELETE FROM desk_transcripts WHERE screen_id = ?", id);
  sql.exec("DELETE FROM desk_stats_meta WHERE screen_id = ?", id);
  sql.exec("DELETE FROM desk_slack_pool WHERE screen_id = ?", id);
  return json({ ok: true });
}

export async function handleIntercomInbox(ctx: DeskContext, body: unknown): Promise<Response> {
  const record = isRecord(body) ? body : {};
  const screenId = asStr(record.screenId);
  const stateRaw = asStr(record.state);
  // Intercom's own inbox defaults to open conversations — so does the desk.
  const state: IntercomInboxState =
    stateRaw === "closed" || stateRaw === "snoozed" || stateRaw === "all" ? stateRaw : "open";
  const screen = screenId ? ctx.loadScreen(screenId) : undefined;
  if (!screen) {
    return json({ error: "screen_not_found" }, 404);
  }
  const resolved = await ctx.screenIntercomToken(screen);
  if ("error" in resolved) {
    return json({ error: resolved.error }, 400);
  }
  try {
    const conversations = await fetchIntercomInboxData(resolved.token, 30, state);
    return json({ conversations, now: Date.now() });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Intercom request failed." }, 502);
  }
}

export async function handleIntercomThread(ctx: DeskContext, body: unknown): Promise<Response> {
  const record = isRecord(body) ? body : {};
  const screenId = asStr(record.screenId);
  const conversationId = asStr(record.conversationId).slice(0, 64);
  const screen = screenId ? ctx.loadScreen(screenId) : undefined;
  if (!screen) {
    return json({ error: "screen_not_found" }, 404);
  }
  if (!conversationId) {
    return json({ error: "invalid_body" }, 400);
  }
  const resolved = await ctx.screenIntercomToken(screen);
  if ("error" in resolved) {
    return json({ error: resolved.error }, 400);
  }
  try {
    const thread = await fetchIntercomThreadData(resolved.token, conversationId);
    return json({ thread, now: Date.now() });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Intercom request failed." }, 502);
  }
}

/** Right-panel payload: assignee/team, tags, contact profile, custom attributes. */
export async function handleIntercomDetails(ctx: DeskContext, me: MemberRow, body: unknown): Promise<Response> {
  const record = isRecord(body) ? body : {};
  const screenId = asStr(record.screenId);
  const conversationId = asStr(record.conversationId).slice(0, 64);
  const screen = screenId ? ctx.loadScreen(screenId) : undefined;
  if (!screen) {
    return json({ error: "screen_not_found" }, 404);
  }
  if (!conversationId) {
    return json({ error: "invalid_body" }, 400);
  }
  const resolved = await ctx.screenIntercomToken(screen);
  if ("error" in resolved) {
    return json({ error: resolved.error }, 400);
  }
  try {
    const details = await fetchIntercomConversationDetails(resolved.token, conversationId);
    // Intercom's API keeps page views private — these are Gera's own
    // first-party views, matched to the contact by email / external id.
    const pageViews = contactPageViews(ctx, details.contact?.email ?? "", details.contact?.userId ?? "");
    return json({
      details,
      pageViews,
      tracking: trackingKey(ctx).length > 0,
      viewerIsAdmin: canManageProject(ctx.memberRole(me)),
      now: Date.now(),
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Intercom request failed." }, 502);
  }
}

// --- First-party page views ("Recent page views") -------------------------

/** Write-only key for the public page-view beacon ("" until an admin sets it up). */
function trackingKey(ctx: DeskContext): string {
  return ctx.metaValue("pv_key");
}

/** Admin-only: returns the beacon key, creating it on first call. */
export function handleTrackingSetup(ctx: DeskContext, me: MemberRow): Response {
  if (!canManageProject(ctx.memberRole(me))) {
    return json({ error: "admin_required" }, 403);
  }
  let key = trackingKey(ctx);
  if (!key) {
    key = crypto.randomUUID().replace(/-/g, "");
    ctx.sql.exec("INSERT INTO meta (key, value) VALUES ('pv_key', ?)", key);
  }
  return json({ key });
}

/**
 * Public beacon sink for the pv.js snippet. Rows are written under every
 * identity key (email + external user id) so the desk matches the Intercom
 * contact by either. Retention: 30 days, newest 40 per contact; same-URL
 * repeats within 15s collapse (SPA routers double-fire transitions).
 */
export function handlePageViewIngest(ctx: DeskContext, rawBody: string): Response {
  const configured = trackingKey(ctx);
  if (!configured) {
    return json({ error: "tracking_not_configured" }, 404);
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const payload = parsePageViewPayload(body);
  if (!payload) {
    return json({ error: "invalid_body" }, 400);
  }
  if (payload.key !== configured) {
    return json({ error: "forbidden" }, 403);
  }
  const sql = ctx.sql;
  sql.exec("DELETE FROM desk_pageviews WHERE at < ?", Date.now() - PAGE_VIEW_RETENTION_MS);
  let stored = 0;
  for (const contactKey of pageViewContactKeys(payload.email, payload.userId)) {
    let previous = sql
      .exec<{ url: string; at: number }>(
        "SELECT url, at FROM desk_pageviews WHERE contact_key = ? ORDER BY at DESC LIMIT 1",
        contactKey,
      )
      .toArray()[0];
    for (const view of payload.views) {
      if (previous && previous.url === view.url && Math.abs(view.at - previous.at) < 15_000) {
        continue;
      }
      sql.exec(
        "INSERT INTO desk_pageviews (id, contact_key, url, title, at) VALUES (?, ?, ?, ?, ?)",
        newId("pv"),
        contactKey,
        view.url,
        view.title,
        view.at,
      );
      previous = { url: view.url, at: view.at };
      stored += 1;
    }
    sql.exec(
      `DELETE FROM desk_pageviews WHERE contact_key = ? AND id NOT IN (
         SELECT id FROM desk_pageviews WHERE contact_key = ? ORDER BY at DESC LIMIT ?
       )`,
      contactKey,
      contactKey,
      PAGE_VIEWS_PER_CONTACT,
    );
  }
  return json({ ok: true, stored });
}

/** Newest tracked views for one contact — matched by email or external id. */
function contactPageViews(ctx: DeskContext, email: string, userId: string): DeskPageView[] {
  const keys = pageViewContactKeys(email, userId);
  if (keys.length === 0) {
    return [];
  }
  const sql = ctx.sql;
  const rows = keys.flatMap((contactKey) =>
    sql
      .exec<{ url: string; title: string; at: number }>(
        "SELECT url, title, at FROM desk_pageviews WHERE contact_key = ? ORDER BY at DESC LIMIT 12",
        contactKey,
      )
      .toArray(),
  );
  const seen = new Set<string>();
  return rows
    .sort((a, b) => b.at - a.at)
    .filter((row) => {
      const signature = `${row.at}:${row.url}`;
      if (seen.has(signature)) {
        return false;
      }
      seen.add(signature);
      return true;
    })
    .slice(0, 12)
    .map((row) => ({ url: row.url, title: row.title, at: row.at }));
}

export async function handleIntercomReply(ctx: DeskContext, me: MemberRow, body: unknown): Promise<Response> {
  const record = isRecord(body) ? body : {};
  const screenId = asStr(record.screenId);
  const conversationId = asStr(record.conversationId).slice(0, 64);
  const text = asStr(record.body).trim();
  const asNote = record.note === true;
  // @-mentions ride only with notes — name+id pairs picked in the composer.
  const mentions = (Array.isArray(record.mentions) ? record.mentions : [])
    .filter(isRecord)
    .map((item) => ({ id: asStr(item.id).slice(0, 40), name: asStr(item.name).slice(0, 100) }))
    .filter((item) => item.id.length > 0 && item.name.length > 0)
    .slice(0, 8);
  const screen = screenId ? ctx.loadScreen(screenId) : undefined;
  if (!screen) {
    return json({ error: "screen_not_found" }, 404);
  }
  if (!conversationId || text.length === 0 || text.length > MESSAGE_BODY_LIMIT) {
    return json({ error: "invalid_body", limit: MESSAGE_BODY_LIMIT }, 400);
  }
  const resolved = await ctx.screenIntercomToken(screen);
  if ("error" in resolved) {
    return json({ error: resolved.error }, 400);
  }
  try {
    const result = await postIntercomReplyData(
      resolved.token,
      conversationId,
      text,
      asNote,
      asNote ? mentions : [],
    );
    console.log("screen intercom", asNote ? "note" : "reply", "by", ctx.memberRole(me));
    return json({ ok: true, admin: result.admin });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Intercom request failed." }, 502);
  }
}

/** Teammate directory for @-mentions in notes — anyone who can write notes sees it. */
export async function handleIntercomMentionAdmins(ctx: DeskContext, body: unknown): Promise<Response> {
  const record = isRecord(body) ? body : {};
  const screenId = asStr(record.screenId);
  const screen = screenId ? ctx.loadScreen(screenId) : undefined;
  if (!screen) {
    return json({ error: "screen_not_found" }, 404);
  }
  const resolved = await ctx.screenIntercomToken(screen);
  if ("error" in resolved) {
    return json({ error: resolved.error }, 400);
  }
  try {
    return json({ admins: await listIntercomAdmins(resolved.token) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Intercom request failed." }, 502);
  }
}

// --- Desk intelligence ----------------------------------------------------
// Reply suggestions in a live-human voice (calibrated by 👍/👎 votes and the
// team's own graded replies), snooze/close actions, "Ask Gera" research runs,
// and human-teammate stats with on-demand LLM grading + coaching. All model
// output is parsed strictly — unreadable payloads become honest errors.

function deskAuthKey(ctx: DeskContext): string {
  return ctx.workerEnv.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY ?? ctx.workerEnv.RORK_TOOLKIT_SECRET_KEY ?? "";
}

/** The inbox widget's agent picks the grading model; suggestions ride DESK_SUGGEST_MODEL. */
function screenDeskModel(ctx: DeskContext, screen: ScreenRow): string {
  const inbox = parseWidgets(screen.widgets).find((widget) => widget.kind === "intercom-inbox");
  const agent = inbox?.agentId ? ctx.loadAgent(inbox.agentId) : undefined;
  return agent?.model || DEFAULT_CHAT_MODEL;
}

/** One plain completion for desk intelligence — no tools; suggestions run low effort, grading medium. */
async function deskCompletion(
  ctx: DeskContext,
  modelId: string,
  messages: EngineMessage[],
  reasoningEffort: "low" | "medium" = "low",
): Promise<string> {
  const authKey = deskAuthKey(ctx);
  if (!authKey) {
    throw new Error("The backend has no AI key configured — ask the workspace admin.");
  }
  const result = await streamGatewayCompletion({
    authKey,
    modelId,
    reasoningEffort,
    messages,
    tools: [],
    handlers: { onText: () => undefined },
  });
  return result.content;
}

export async function handleIntercomSuggest(ctx: DeskContext, body: unknown): Promise<Response> {
  const record = isRecord(body) ? body : {};
  const screenId = asStr(record.screenId);
  const conversationId = asStr(record.conversationId).slice(0, 64);
  const force = record.force === true;
  const screen = screenId ? ctx.loadScreen(screenId) : undefined;
  if (!screen) {
    return json({ error: "screen_not_found" }, 404);
  }
  if (!conversationId) {
    return json({ error: "invalid_body" }, 400);
  }
  const resolved = await ctx.screenIntercomToken(screen);
  if ("error" in resolved) {
    return json({ error: resolved.error }, 400);
  }
  const sql = ctx.sql;
  try {
    const thread = await fetchIntercomThreadData(resolved.token, conversationId);
    const lastPart = thread.parts[thread.parts.length - 1];
    if (!lastPart) {
      return json({ error: "This conversation has no readable messages to suggest from." }, 400);
    }
    if (!force) {
      const cached = sql
        .exec<{ last_part_id: string; payload: string; created_at: number }>(
          "SELECT last_part_id, payload, created_at FROM desk_suggest_cache WHERE screen_id = ? AND conversation_id = ?",
          screenId,
          conversationId,
        )
        .toArray()[0];
      if (
        cached &&
        cached.last_part_id === lastPart.id &&
        Date.now() - cached.created_at < DESK_SUGGEST_TTL_MS
      ) {
        return json({ ...(JSON.parse(cached.payload) as Record<string, unknown>), cached: true });
      }
    }
    const suggestionCols =
      "SELECT id, screen_id, conversation_id, text, verdict, created_at FROM desk_suggestions";
    const liked = sql
      .exec<DeskSuggestionRow>(
        `${suggestionCols} WHERE screen_id = ? AND verdict = 'up' ORDER BY created_at DESC LIMIT 6`,
        screenId,
      )
      .toArray();
    const disliked = sql
      .exec<DeskSuggestionRow>(
        `${suggestionCols} WHERE screen_id = ? AND verdict = 'down' ORDER BY created_at DESC LIMIT 6`,
        screenId,
      )
      .toArray();
    const teamGood = sql
      .exec<DeskReplyRow>(
        "SELECT screen_id, id, conversation_id, admin_id, admin_name, customer_text, reply_text, response_ms, at, grade, grade_reason FROM desk_replies WHERE screen_id = ? AND grade = 'good' ORDER BY at DESC LIMIT 6",
        screenId,
      )
      .toArray();
    const transcript = thread.parts.slice(-24).map((part) => {
      // Attachment-only turns arrive with body "" — the "[attached: …]" label
      // keeps the drafts aware a screenshot/file exists without inventing it.
      const withFiles = (text: string, cap: number): string =>
        [capText(text, cap), attachmentLabel(part.attachments)]
          .filter((piece) => piece.length > 0)
          .join(" ");
      if (part.note) {
        return `Internal note by ${part.author}: ${withFiles(part.body, 500)}`;
      }
      if (part.role === "teammate") {
        return `${part.author} (teammate): ${withFiles(part.body, 500)}`;
      }
      if (part.role === "bot") {
        return `Bot: ${withFiles(part.body, 400)}`;
      }
      return `Customer (${part.author}): ${withFiles(part.body, 500)}`;
    });
    // Slack awareness: the team's own discussions about this case ride into
    // the prompt so drafts can wait for (or use) the internal outcome.
    let slackThreads: string[] = [];
    let slackLastTs = 0;
    const slackResolved = await ctx.screenSlackToken(screen);
    if ("token" in slackResolved) {
      try {
        const { threads } = await deskSlackThreads(ctx, screen, slackResolved.token, {
          conversationId,
          email: thread.email,
          name: thread.author,
        });
        slackThreads = threads.map((item) =>
          buildSlackThreadBlock(
            {
              channelName: item.channelName,
              active: item.active,
              lastActivityTs: item.lastActivityTs,
              lines: item.lines,
            },
            Date.now(),
          ),
        );
        slackLastTs = threads.reduce((max, item) => Math.max(max, item.lastActivityTs), 0);
      } catch {
        // Slack being down must not break reply drafting — drafts go without it.
      }
    }
    const raw = await deskCompletion(
      ctx,
      DESK_SUGGEST_MODEL,
      buildSuggestMessages({
        customer: thread.author,
        state: thread.state,
        transcript,
        likedExamples: liked.map((row) => row.text),
        dislikedExamples: disliked.map((row) => row.text),
        teamExamples: teamGood.map((row) => row.reply_text),
        slackThreads,
      }),
    );
    const parsed = parseSuggestPayload(raw);
    if (!parsed) {
      return json({ error: "The model returned an unreadable suggestions payload — try again." }, 502);
    }
    const now = Date.now();
    const suggestions = parsed.replies.map((text) => ({ id: newId("sg"), text: capText(text, 900) }));
    for (const suggestion of suggestions) {
      sql.exec(
        "INSERT INTO desk_suggestions (id, screen_id, conversation_id, text, verdict, created_at) VALUES (?, ?, ?, ?, '', ?)",
        suggestion.id,
        screenId,
        conversationId,
        suggestion.text,
        now,
      );
    }
    sql.exec(
      `DELETE FROM desk_suggestions WHERE screen_id = ? AND id NOT IN (
         SELECT id FROM desk_suggestions WHERE screen_id = ? ORDER BY created_at DESC LIMIT ?
       )`,
      screenId,
      screenId,
      DESK_SUGGESTIONS_KEEP,
    );
    const wire = {
      suggestions,
      action: parsed.action,
      actionReason: parsed.actionReason,
      functionalityQuestion: parsed.functionalityQuestion,
      investigation: parsed.investigation,
      /** Seconds — the latest Slack activity these drafts were generated against. */
      slackLastTs,
      generatedAt: now,
    };
    sql.exec(
      "INSERT OR REPLACE INTO desk_suggest_cache (screen_id, conversation_id, last_part_id, payload, created_at) VALUES (?, ?, ?, ?, ?)",
      screenId,
      conversationId,
      lastPart.id,
      JSON.stringify(wire),
      now,
    );
    return json(wire);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Suggestion run failed." }, 502);
  }
}

/** 👍/👎 on one suggestion — the calibration memory future prompts learn from. */
export function handleSuggestRate(ctx: DeskContext, body: unknown): Response {
  const record = isRecord(body) ? body : {};
  const screenId = asStr(record.screenId);
  const suggestionId = asStr(record.suggestionId);
  const verdict = record.verdict === "up" || record.verdict === "down" ? record.verdict : "";
  if (!screenId || !suggestionId || !verdict) {
    return json({ error: "invalid_body" }, 400);
  }
  ctx.sql.exec(
    "UPDATE desk_suggestions SET verdict = ? WHERE id = ? AND screen_id = ?",
    verdict,
    suggestionId,
    screenId,
  );
  return json({ ok: true });
}

/** Cached (short TTL) pool of the watched channels' recent messages for one screen. */
async function deskSlackPool(ctx: DeskContext, screen: ScreenRow, token: string): Promise<DeskSlackPoolData> {
  const sql = ctx.sql;
  const row = sql
    .exec<{ payload: string; created_at: number }>(
      "SELECT payload, created_at FROM desk_slack_pool WHERE screen_id = ?",
      screen.id,
    )
    .toArray()[0];
  if (row && Date.now() - row.created_at < DESK_SLACK_TTL_MS) {
    try {
      return JSON.parse(row.payload) as DeskSlackPoolData;
    } catch {
      // Corrupt cache — fall through to a fresh sync.
    }
  }
  const [identity, channels, names] = await Promise.all([
    verifySlackToken(token),
    listBotChannels(token),
    fetchSlackUserNames(token),
  ]);
  const watched = channels.slice(0, DESK_SLACK_CHANNELS_CAP);
  const oldest = Math.floor((Date.now() - DESK_SLACK_WINDOW_MS) / 1000);
  const messages: DeskSlackMessage[] = [];
  for (const channel of watched) {
    try {
      const history = await fetchChannelHistoryData(token, channel.id, oldest, DESK_SLACK_HISTORY_LIMIT);
      for (const message of history) {
        messages.push({
          channelId: channel.id,
          channelName: channel.name,
          ts: message.ts,
          threadTs: message.threadTs,
          author: names.get(message.authorId) ?? message.authorId,
          text: message.text,
          replyCount: message.replyCount,
          lastActivityTs: message.lastActivityTs,
        });
      }
    } catch {
      // One unreadable channel (bot kicked mid-sync, archived) must not
      // break the pool — the remaining channels still sync.
    }
  }
  const pool: DeskSlackPoolData = {
    team: identity.team,
    teamUrl: identity.url,
    channels: watched,
    names: Object.fromEntries([...names.entries()].slice(0, DESK_SLACK_NAMES_CAP)),
    messages: messages.slice(0, DESK_SLACK_POOL_MESSAGES_CAP),
    syncedAt: Date.now(),
  };
  sql.exec(
    "INSERT OR REPLACE INTO desk_slack_pool (screen_id, payload, created_at) VALUES (?, ?, ?)",
    screen.id,
    JSON.stringify(pool),
    pool.syncedAt,
  );
  return pool;
}

/** Pool → discussions matched to one conversation, with LIVE thread tails. */
async function deskSlackThreads(
  ctx: DeskContext,
  screen: ScreenRow,
  token: string,
  target: { conversationId: string; email: string; name: string },
): Promise<{ pool: DeskSlackPoolData; threads: DeskSlackThreadWire[] }> {
  const pool = await deskSlackPool(ctx, screen, token);
  const matches = matchSlackDiscussions(
    { conversationId: target.conversationId, customerEmail: target.email, customerName: target.name },
    pool.messages,
    DESK_SLACK_RELATED_CAP,
  );
  const threads: DeskSlackThreadWire[] = [];
  for (const match of matches) {
    let tail: SlackThreadTail;
    try {
      tail = await fetchSlackThreadTailData(token, match.channelId, match.rootTs, DESK_SLACK_TAIL_LINES);
    } catch {
      continue; // Thread deleted or the bot was kicked — skip it honestly.
    }
    const lastActivityTs = Math.max(match.lastActivityTs, tail.lastTs);
    threads.push({
      channelId: match.channelId,
      channelName: match.channelName,
      rootTs: match.rootTs,
      permalink: slackPermalink(pool.teamUrl, match.channelId, match.rootTs),
      matchedBy: match.matchedBy,
      lastActivityTs,
      active: slackThreadActive(lastActivityTs, Date.now()),
      replyCount: tail.replyCount,
      lines: tail.lines.map((line) => ({
        author: pool.names[line.authorId] ?? line.authorId,
        text: capText(line.text, 400),
        ts: line.ts,
      })),
    });
  }
  threads.sort((a, b) => b.lastActivityTs - a.lastActivityTs);
  return { pool, threads };
}

/**
 * POST /intercom/slack-related — Slack awareness for one open conversation:
 * the watched channels (= the bot's memberships) and the internal
 * discussions that reference this customer/conversation, with live thread
 * tails. The desk polls this while a conversation is open — "wait, then
 * show the outcome" instead of double-investigating.
 */
export async function handleDeskSlackRelated(ctx: DeskContext, body: unknown): Promise<Response> {
  const record = isRecord(body) ? body : {};
  const screenId = asStr(record.screenId);
  const conversationId = asStr(record.conversationId).slice(0, 64);
  const screen = screenId ? ctx.loadScreen(screenId) : undefined;
  if (!screen) {
    return json({ error: "screen_not_found" }, 404);
  }
  if (!conversationId) {
    return json({ error: "invalid_body" }, 400);
  }
  const slack = await ctx.screenSlackToken(screen);
  if ("error" in slack) {
    // No Slack agent on this screen is a normal setup — quiet null, honest reason.
    return json({ slack: null, reason: slack.error, now: Date.now() });
  }
  const intercom = await ctx.screenIntercomToken(screen);
  if ("error" in intercom) {
    return json({ slack: null, reason: intercom.error, now: Date.now() });
  }
  try {
    const thread = await fetchIntercomThreadData(intercom.token, conversationId);
    const { pool, threads } = await deskSlackThreads(ctx, screen, slack.token, {
      conversationId,
      email: thread.email,
      name: thread.author,
    });
    return json({
      slack: { team: pool.team, channels: pool.channels, related: threads, syncedAt: pool.syncedAt },
      now: Date.now(),
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Slack sync failed." }, 502);
  }
}

/** Snooze (until tomorrow) or close the conversation as the connected admin. */
export async function handleIntercomAction(ctx: DeskContext, me: MemberRow, body: unknown): Promise<Response> {
  const record = isRecord(body) ? body : {};
  const screenId = asStr(record.screenId);
  const conversationId = asStr(record.conversationId).slice(0, 64);
  const action = record.action === "close" ? "close" : record.action === "snooze" ? "snooze" : null;
  const screen = screenId ? ctx.loadScreen(screenId) : undefined;
  if (!screen) {
    return json({ error: "screen_not_found" }, 404);
  }
  if (!conversationId || !action) {
    return json({ error: "invalid_body" }, 400);
  }
  const resolved = await ctx.screenIntercomToken(screen);
  if ("error" in resolved) {
    return json({ error: resolved.error }, 400);
  }
  try {
    const snoozedUntil = action === "snooze" ? Math.floor(Date.now() / 1000) + 24 * 3600 : undefined;
    const result = await manageIntercomConversationData(resolved.token, conversationId, action, snoozedUntil);
    console.log("screen intercom", action, "by", ctx.memberRole(me));
    return json({ ok: true, state: result.state, admin: result.admin, snoozedUntil: snoozedUntil ?? 0 });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Intercom request failed." }, 502);
  }
}

/**
 * "Ask Gera" — forwards a customer's functionality question into the member's
 * PRIVATE assistant chat as a research run: the agent digs with its own tools
 * and, given GitHub write access, files a knowledge-base page in the repo.
 */
export function handleAskGera(ctx: DeskContext, me: MemberRow, body: unknown): Response {
  if (!isRecord(body)) {
    return json({ error: "invalid_body" }, 400);
  }
  const screenId = asStr(body.screenId);
  const widgetId = asStr(body.widgetId);
  const question = asStr(body.question).trim().slice(0, DESK_QUESTION_LIMIT);
  const conversationId = asStr(body.conversationId).slice(0, 64);
  const screen = screenId ? ctx.loadScreen(screenId) : undefined;
  if (!screen) {
    return json({ error: "screen_not_found" }, 404);
  }
  const widget = parseWidgets(screen.widgets).find(
    (item) => item.id === widgetId && item.kind === "agent-chat",
  );
  if (!widget?.agentId) {
    return json({ error: "widget_not_found" }, 404);
  }
  const agent = ctx.loadAgent(widget.agentId);
  if (!agent) {
    return json({ error: "agent_deleted" }, 404);
  }
  if (question.length === 0) {
    return json({ error: "invalid_body" }, 400);
  }
  const sql = ctx.sql;
  // An investigation already running for this conversation is never
  // duplicated — the strip shows the running card and waits for the outcome.
  if (conversationId) {
    const running = sql
      .exec<{ id: string }>(
        `SELECT id FROM screen_jobs WHERE screen_id = ? AND conversation_id = ? AND kind = 'research'
           AND status IN ('queued', 'running') AND created_at > ? LIMIT 1`,
        screenId,
        conversationId,
        Date.now() - DESK_ASK_DEDUP_MS,
      )
      .toArray()[0];
    if (running) {
      return json({ ok: true, alreadyRunning: true, jobs: [] });
    }
  }
  const now = Date.now();
  const messageId = newId("m");
  const authorName = me.display_name || me.email.split("@")[0];
  sql.exec(
    `INSERT INTO screen_chat (id, screen_id, widget_id, email, author_kind, author_name, body, pending, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'user', ?, ?, 0, ?, ?)`,
    messageId,
    screenId,
    widgetId,
    me.email,
    authorName,
    `Ask Gera: ${question}`,
    now,
    now,
  );
  const placeholderId = newId("m");
  sql.exec(
    `INSERT INTO screen_chat (id, screen_id, widget_id, email, author_kind, author_name, body, pending, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'agent', ?, '', 1, ?, ?)`,
    placeholderId,
    screenId,
    widgetId,
    me.email,
    agent.name,
    now + 1,
    now + 1,
  );
  const jobId = newId("j");
  sql.exec(
    `INSERT INTO screen_jobs (id, agent_id, screen_id, widget_id, email, placeholder_id, conversation_id, status, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'research', ?)`,
    jobId,
    agent.id,
    screenId,
    widgetId,
    me.email,
    placeholderId,
    conversationId,
    now,
  );
  sql.exec(
    `DELETE FROM screen_chat WHERE screen_id = ? AND widget_id = ? AND email = ? AND id NOT IN (
       SELECT id FROM screen_chat WHERE screen_id = ? AND widget_id = ? AND email = ?
       ORDER BY created_at DESC LIMIT ?
     )`,
    screenId,
    widgetId,
    me.email,
    screenId,
    widgetId,
    me.email,
    SCREEN_CHAT_KEEP,
  );
  return json({ ok: true, id: messageId, jobs: [jobId] });
}

/**
 * POST /intercom/ask-status — the latest "Ask Gera" research for one
 * conversation, visible to EVERY member: an investigation someone already
 * started is never duplicated — the desk waits and then shows the outcome.
 */
export function handleAskStatus(ctx: DeskContext, body: unknown): Response {
  const record = isRecord(body) ? body : {};
  const screenId = asStr(record.screenId);
  const conversationId = asStr(record.conversationId).slice(0, 64);
  if (!screenId || !conversationId || !ctx.loadScreen(screenId)) {
    return json({ error: "screen_not_found" }, 404);
  }
  const sql = ctx.sql;
  const job = sql
    .exec<ScreenJobRow & { created_at: number }>(
      `SELECT id, agent_id, screen_id, widget_id, email, placeholder_id, conversation_id, status, kind, created_at
       FROM screen_jobs WHERE screen_id = ? AND conversation_id = ? AND kind = 'research'
       ORDER BY created_at DESC LIMIT 1`,
      screenId,
      conversationId,
    )
    .toArray()[0];
  if (!job || Date.now() - job.created_at > DESK_ASK_VISIBLE_MS) {
    return json({ ask: null });
  }
  const placeholder = sql
    .exec<ScreenChatRow>(
      `SELECT id, screen_id, widget_id, email, author_kind, author_name, body, pending, outcome, created_at, updated_at
       FROM screen_chat WHERE id = ?`,
      job.placeholder_id,
    )
    .toArray()[0];
  if (!placeholder) {
    // The private chat pruned the rows — nothing readable to show anymore.
    return json({ ask: null });
  }
  // The question row rides exactly 1ms before its placeholder (see handleAskGera).
  const questionRow = sql
    .exec<{ body: string }>(
      "SELECT body FROM screen_chat WHERE screen_id = ? AND widget_id = ? AND email = ? AND author_kind = 'user' AND created_at = ?",
      screenId,
      job.widget_id,
      job.email,
      placeholder.created_at - 1,
    )
    .toArray()[0];
  const member = ctx.loadMember(job.email);
  const status =
    job.status === "error"
      ? "error"
      : placeholder.pending === 1 || job.status === "queued" || job.status === "running"
        ? "running"
        : "done";
  const execution = storedExecutionOutcome(placeholder.outcome);
  return json({
    ask: {
      status,
      question: (questionRow?.body ?? "").replace(/^Ask Gera:\s*/i, ""),
      answer: placeholder.pending === 1 ? "" : placeholder.body,
      ...(execution ? { execution } : {}),
      by: member?.display_name || job.email.split("@")[0],
      at: job.created_at,
    },
  });
}

/** Aggregates the harvested reply log into date-filtered teammate cards. */
function deskStatsPayload(
  ctx: DeskContext,
  me: MemberRow,
  screen: ScreenRow,
  range: DeskStatsRange = { from: 0, to: 0 },
): Record<string, unknown> {
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
  const replies = sql
    .exec<DeskReplyRow>(
      `SELECT screen_id, id, conversation_id, admin_id, admin_name, customer_text, reply_text, response_ms, at, grade, grade_reason
       FROM desk_replies WHERE ${conditions.join(" AND ")} ORDER BY at DESC LIMIT ?`,
      ...bindings,
      DESK_REPLIES_KEEP,
    )
    .toArray();
  const links = new Map(
    sql
      .exec<DeskLinkRow>("SELECT admin_id, email, admin_name, admin_email, linked_at FROM desk_links")
      .toArray()
      .map((row) => [row.admin_id, row]),
  );
  const coach = new Map(
    sql
      .exec<DeskCoachRow>("SELECT admin_id, text, updated_at FROM desk_coach")
      .toArray()
      .map((row) => [row.admin_id, row.text]),
  );
  const byAdmin = new Map<string, DeskReplyRow[]>();
  for (const row of replies) {
    const list = byAdmin.get(row.admin_id) ?? [];
    list.push(row);
    byAdmin.set(row.admin_id, list);
  }
  const teammates = [...byAdmin.entries()]
    .map(([adminId, rows]) => {
      const times = rows
        .map((row) => row.response_ms)
        .filter((ms) => ms > 0)
        .sort((a, b) => a - b);
      const good = rows.filter((row) => row.grade === "good").length;
      const bad = rows.filter((row) => row.grade === "bad").length;
      const withinOneHour = times.filter((ms) => ms <= 60 * 60 * 1000).length;
      const link = links.get(adminId);
      return {
        adminId,
        name: rows[0]?.admin_name || link?.admin_name || `Admin #${adminId}`,
        linkedEmail: link?.email ?? "",
        replies: rows.length,
        conversations: new Set(rows.map((row) => row.conversation_id)).size,
        responseSamples: times.length,
        medianResponseMs: times.length > 0 ? times[Math.floor(times.length / 2)] : 0,
        p90ResponseMs: times.length > 0 ? times[Math.min(times.length - 1, Math.ceil(times.length * 0.9) - 1)] : 0,
        withinOneHour,
        good,
        bad,
        ungraded: rows.length - good - bad,
        firstAt: rows[rows.length - 1]?.at ?? 0,
        lastAt: rows[0]?.at ?? 0,
        coaching: coach.get(adminId) ?? "",
        examples: rows
          .filter((row) => row.grade !== "")
          .slice(0, 10)
          .map((row) => ({
            customer: row.customer_text,
            reply: row.reply_text,
            grade: row.grade,
            reason: row.grade_reason,
            at: row.at,
            responseMs: row.response_ms,
          })),
      };
    })
    .sort((a, b) => b.replies - a.replies);
  const visible = isAdmin ? teammates : teammates.filter((teammate) => teammate.linkedEmail === me.email);
  const visibleAdminIds = new Set(visible.map((teammate) => teammate.adminId));
  const summaryReplies = isAdmin ? replies : replies.filter((row) => visibleAdminIds.has(row.admin_id));
  const meta = sql
    .exec<DeskStatsMetaRow>(
      "SELECT screen_id, scanned_conversations, analyzed_conversations, range_from, range_to, collected_at, limit_reached FROM desk_stats_meta WHERE screen_id = ?",
      screen.id,
    )
    .toArray()[0];
  const responseTimes = summaryReplies
    .map((row) => row.response_ms)
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);
  const payload: Record<string, unknown> = {
    isAdmin,
    teammates: visible,
    totalReplies: summaryReplies.length,
    conversations: new Set(summaryReplies.map((row) => row.conversation_id)).size,
    gradedReplies: summaryReplies.filter((row) => row.grade !== "").length,
    badReplies: summaryReplies.filter((row) => row.grade === "bad").length,
    responseSamples: responseTimes.length,
    withinOneHour: responseTimes.filter((ms) => ms <= 60 * 60 * 1000).length,
    p90ResponseMs:
      responseTimes.length > 0
        ? responseTimes[Math.min(responseTimes.length - 1, Math.ceil(responseTimes.length * 0.9) - 1)]
        : 0,
    ungraded: summaryReplies.filter((row) => row.grade === "").length,
    range,
    coverage: meta
      ? {
          scannedConversations: meta.scanned_conversations,
          analyzedConversations: meta.analyzed_conversations,
          from: meta.range_from,
          to: meta.range_to,
          collectedAt: meta.collected_at,
          limitReached: meta.limit_reached === 1,
        }
      : null,
    now: Date.now(),
  };
  if (isAdmin) {
    payload.members = sql
      .exec<MemberRow>("SELECT email, role, display_name, added_at FROM members")
      .toArray()
      .map((row) => ({ email: row.email, name: row.display_name || row.email.split("@")[0] }));
  }
  return payload;
}

export async function handleDeskStats(ctx: DeskContext, me: MemberRow, body: unknown): Promise<Response> {
  const record = isRecord(body) ? body : {};
  const screenId = asStr(record.screenId);
  const screen = screenId ? ctx.loadScreen(screenId) : undefined;
  if (!screen) {
    return json({ error: "screen_not_found" }, 404);
  }
  const payload = deskStatsPayload(ctx, me, screen, deskStatsRange(body));
  if (payload.isAdmin === true) {
    // Admins also get the Intercom teammate directory for manual linking.
    const resolved = await ctx.screenIntercomToken(screen);
    if ("token" in resolved) {
      try {
        payload.intercomAdmins = await listIntercomAdmins(resolved.token);
      } catch {
        payload.intercomAdmins = [];
      }
    } else {
      payload.intercomAdmins = [];
    }
  }
  return json(payload);
}

/**
 * Admin-triggered stats pass: harvest the latest teammate replies AND full
 * conversation transcripts from Intercom, auto-link admins to members by
 * matching email, grade up to DESK_GRADE_BATCH ungraded replies in ONE
 * model call — grouped by conversation so every reply is judged inside its
 * whole transcript. On demand only — no cron, no silent background spend.
 */
export async function handleDeskStatsRefresh(ctx: DeskContext, me: MemberRow, body: unknown): Promise<Response> {
  if (!canManageProject(ctx.memberRole(me))) {
    return json({ error: "admin_required" }, 403);
  }
  const record = isRecord(body) ? body : {};
  const screenId = asStr(record.screenId);
  const screen = screenId ? ctx.loadScreen(screenId) : undefined;
  if (!screen) {
    return json({ error: "screen_not_found" }, 404);
  }
  const resolved = await ctx.screenIntercomToken(screen);
  if ("error" in resolved) {
    return json({ error: resolved.error }, 400);
  }
  const sql = ctx.sql;
  const range = deskStatsRange(body);
  try {
    const harvest = await harvestIntercomReplyPairs(resolved.token, {
      from: range.from,
      to: range.to,
      maxConversations: DESK_CONVERSATIONS_SCAN,
    });
    const pairs = harvest.replies;
    const countRows = (): number =>
      sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM desk_replies WHERE screen_id = ?", screen.id)
        .toArray()[0]?.n ?? 0;
    const before = countRows();
    for (const pair of pairs) {
      sql.exec(
        `INSERT OR IGNORE INTO desk_replies (screen_id, id, conversation_id, admin_id, admin_name, customer_text, reply_text, response_ms, at, grade, grade_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '')`,
        screen.id,
        pair.id,
        pair.conversationId,
        pair.adminId,
        pair.adminName,
        capText(pair.customerText, 600),
        capText(pair.replyText, 900),
        pair.responseMs,
        pair.at,
      );
    }
    const added = countRows() - before;
    sql.exec(
      `INSERT OR REPLACE INTO desk_stats_meta
       (screen_id, scanned_conversations, analyzed_conversations, range_from, range_to, collected_at, limit_reached)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      screen.id,
      harvest.scannedConversations,
      harvest.analyzedConversations,
      range.from,
      range.to,
      Date.now(),
      harvest.limitReached ? 1 : 0,
    );
    // Refresh the grading context: one full transcript per harvested conversation.
    for (const item of harvest.transcripts) {
      sql.exec(
        "INSERT OR REPLACE INTO desk_transcripts (screen_id, conversation_id, transcript, updated_at) VALUES (?, ?, ?, ?)",
        screen.id,
        item.conversationId,
        item.transcript,
        Date.now(),
      );
    }
    sql.exec(
      `DELETE FROM desk_replies WHERE screen_id = ? AND id NOT IN (
         SELECT id FROM desk_replies WHERE screen_id = ? ORDER BY at DESC LIMIT ?
       )`,
      screen.id,
      screen.id,
      DESK_REPLIES_KEEP,
    );
    sql.exec(
      `DELETE FROM desk_transcripts WHERE screen_id = ? AND conversation_id NOT IN (
         SELECT DISTINCT conversation_id FROM desk_replies WHERE screen_id = ?
       )`,
      screen.id,
      screen.id,
    );

    // Auto-link Intercom admins to Gera members when emails match.
    let intercomAdmins: IntercomAdminLite[] = [];
    try {
      intercomAdmins = await listIntercomAdmins(resolved.token);
    } catch {
      intercomAdmins = [];
    }
    const memberEmails = new Set(
      sql.exec<{ email: string }>("SELECT email FROM members").toArray().map((row) => row.email),
    );
    for (const admin of intercomAdmins) {
      const email = admin.email.trim().toLowerCase();
      const existing = sql
        .exec<DeskLinkRow>(
          "SELECT admin_id, email, admin_name, admin_email, linked_at FROM desk_links WHERE admin_id = ?",
          admin.id,
        )
        .toArray()[0];
      if (existing) {
        sql.exec(
          "UPDATE desk_links SET admin_name = ?, admin_email = ? WHERE admin_id = ?",
          admin.name,
          admin.email,
          admin.id,
        );
        continue;
      }
      if (email && memberEmails.has(email)) {
        sql.exec(
          "INSERT INTO desk_links (admin_id, email, admin_name, admin_email, linked_at) VALUES (?, ?, ?, ?, ?)",
          admin.id,
          email,
          admin.name,
          admin.email,
          Date.now(),
        );
      }
    }

    // Grade the newest ungraded replies + refresh coaching — one model call.
    let graded = 0;
    let gradeError = "";
    const gradeConditions = ["screen_id = ?", "grade = ''"];
    const gradeBindings: Array<string | number> = [screen.id];
    if (range.from > 0) {
      gradeConditions.push("at >= ?");
      gradeBindings.push(range.from);
    }
    if (range.to > 0) {
      gradeConditions.push("at <= ?");
      gradeBindings.push(range.to);
    }
    const ungraded = sql
      .exec<DeskReplyRow>(
        `SELECT screen_id, id, conversation_id, admin_id, admin_name, customer_text, reply_text, response_ms, at, grade, grade_reason
         FROM desk_replies WHERE ${gradeConditions.join(" AND ")} ORDER BY at DESC LIMIT ?`,
        ...gradeBindings,
        DESK_GRADE_BATCH,
      )
      .toArray();
    if (ungraded.length > 0) {
      try {
        // Grade every reply INSIDE its conversation: group the batch by
        // conversation and hand the model the full stored transcript.
        const byConversation = new Map<string, DeskReplyRow[]>();
        for (const row of ungraded) {
          const group = byConversation.get(row.conversation_id) ?? [];
          group.push(row);
          byConversation.set(row.conversation_id, group);
        }
        const conversations: GradePromptInput["conversations"] = [];
        const orphans: GradePromptInput["orphans"] = [];
        for (const [conversationId, rows] of byConversation) {
          const ordered = rows.slice().sort((a, b) => a.at - b.at);
          const transcript =
            sql
              .exec<{ transcript: string }>(
                "SELECT transcript FROM desk_transcripts WHERE screen_id = ? AND conversation_id = ?",
                screen.id,
                conversationId,
              )
              .toArray()[0]?.transcript ?? "";
          if (transcript) {
            conversations.push({
              conversationId,
              transcript,
              replies: ordered.map((row) => ({
                id: row.id,
                adminId: row.admin_id,
                adminName: row.admin_name,
                responseMs: row.response_ms,
              })),
            });
          } else {
            for (const row of ordered) {
              orphans.push({
                id: row.id,
                adminId: row.admin_id,
                adminName: row.admin_name,
                responseMs: row.response_ms,
                customerText: row.customer_text,
                replyText: row.reply_text,
              });
            }
          }
        }
        const raw = await deskCompletion(
          ctx,
          screenDeskModel(ctx, screen),
          buildGradeMessages({ conversations, orphans }),
          "medium",
        );
        const parsed = parseGradePayload(raw);
        if (!parsed) {
          gradeError = "The model returned an unreadable grading payload — run it again.";
        } else {
          const known = new Set(ungraded.map((row) => row.id));
          for (const grade of parsed.grades) {
            if (!known.has(grade.id)) {
              continue;
            }
            sql.exec(
              "UPDATE desk_replies SET grade = ?, grade_reason = ? WHERE screen_id = ? AND id = ?",
              grade.verdict,
              capText(grade.reason, 300),
              screen.id,
              grade.id,
            );
            graded += 1;
          }
          const adminsInBatch = new Set(ungraded.map((row) => row.admin_id));
          for (const entry of parsed.coaching) {
            if (!adminsInBatch.has(entry.adminId)) {
              continue;
            }
            sql.exec(
              "INSERT OR REPLACE INTO desk_coach (admin_id, text, updated_at) VALUES (?, ?, ?)",
              entry.adminId,
              capText(entry.text, 900),
              Date.now(),
            );
          }
        }
      } catch (error) {
        gradeError = error instanceof Error ? error.message : "Grading run failed.";
      }
    }
    const payload = deskStatsPayload(ctx, me, screen, range);
    payload.intercomAdmins = intercomAdmins;
    payload.collected = pairs.length;
    payload.scannedConversations = harvest.scannedConversations;
    payload.analyzedConversations = harvest.analyzedConversations;
    payload.limitReached = harvest.limitReached;
    payload.added = added;
    payload.graded = graded;
    if (gradeError) {
      payload.gradeError = gradeError;
    }
    return json(payload);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Intercom request failed." }, 502);
  }
}

/** Clears harvested performance results for one screen while preserving identity links. */
export async function handleDeskStatsClear(ctx: DeskContext, me: MemberRow, body: unknown): Promise<Response> {
  if (!canManageProject(ctx.memberRole(me))) {
    return json({ error: "admin_required" }, 403);
  }
  const record = isRecord(body) ? body : {};
  const screenId = asStr(record.screenId);
  const screen = screenId ? ctx.loadScreen(screenId) : undefined;
  if (!screen) {
    return json({ error: "screen_not_found" }, 404);
  }
  const sql = ctx.sql;
  const adminIds = sql
    .exec<{ admin_id: string }>("SELECT DISTINCT admin_id FROM desk_replies WHERE screen_id = ?", screen.id)
    .toArray()
    .map((row) => row.admin_id);
  sql.exec("DELETE FROM desk_replies WHERE screen_id = ?", screen.id);
  sql.exec("DELETE FROM desk_transcripts WHERE screen_id = ?", screen.id);
  sql.exec("DELETE FROM desk_stats_meta WHERE screen_id = ?", screen.id);
  for (const adminId of adminIds) {
    const usedElsewhere = sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM desk_replies WHERE admin_id = ?", adminId)
      .toArray()[0]?.n ?? 0;
    if (usedElsewhere === 0) {
      sql.exec("DELETE FROM desk_coach WHERE admin_id = ?", adminId);
    }
  }
  const payload = deskStatsPayload(ctx, me, screen, deskStatsRange(body));
  const resolved = await ctx.screenIntercomToken(screen);
  if ("token" in resolved) {
    try {
      payload.intercomAdmins = await listIntercomAdmins(resolved.token);
    } catch {
      payload.intercomAdmins = [];
    }
  } else {
    payload.intercomAdmins = [];
  }
  payload.cleared = true;
  return json(payload);
}

/** Manual Intercom-admin ↔ Gera-member link; empty email unlinks. */
export function handleDeskLink(ctx: DeskContext, me: MemberRow, body: unknown): Response {
  if (!canManageProject(ctx.memberRole(me))) {
    return json({ error: "admin_required" }, 403);
  }
  const record = isRecord(body) ? body : {};
  const adminId = asStr(record.adminId).slice(0, 64);
  const email = asStr(record.email).trim().toLowerCase();
  if (!adminId) {
    return json({ error: "invalid_body" }, 400);
  }
  const sql = ctx.sql;
  if (!email) {
    sql.exec("DELETE FROM desk_links WHERE admin_id = ?", adminId);
    return json({ ok: true, linked: false });
  }
  if (!ctx.loadMember(email)) {
    return json({ error: "not_a_member" }, 400);
  }
  sql.exec(
    "INSERT OR REPLACE INTO desk_links (admin_id, email, admin_name, admin_email, linked_at) VALUES (?, ?, ?, ?, ?)",
    adminId,
    email,
    asStr(record.adminName).slice(0, 120),
    asStr(record.adminEmail).slice(0, 200),
    Date.now(),
  );
  return json({ ok: true, linked: true });
}

export function handleScreenChatGet(ctx: DeskContext, me: MemberRow, url: URL): Response {
  const screenId = url.searchParams.get("screen") ?? "";
  const widgetId = url.searchParams.get("widget") ?? "";
  if (!screenId || !widgetId || !ctx.loadScreen(screenId)) {
    return json({ error: "screen_not_found" }, 404);
  }
  const rows = ctx.sql
    .exec<ScreenChatRow>(
      `SELECT id, screen_id, widget_id, email, author_kind, author_name, body, pending, outcome, created_at, updated_at
       FROM screen_chat WHERE screen_id = ? AND widget_id = ? AND email = ?
       ORDER BY created_at DESC LIMIT ?`,
      screenId,
      widgetId,
      me.email,
      SCREEN_CHAT_KEEP,
    )
    .toArray()
    .reverse();
  return json({ messages: rows.map(screenChatWire), now: Date.now() });
}

export function handleScreenChatSend(ctx: DeskContext, me: MemberRow, body: unknown): Response {
  if (!isRecord(body)) {
    return json({ error: "invalid_body" }, 400);
  }
  const screenId = asStr(body.screenId);
  const widgetId = asStr(body.widgetId);
  const text = asStr(body.body).trim();
  const conversationId = asStr(body.conversationId).slice(0, 64);
  const screen = screenId ? ctx.loadScreen(screenId) : undefined;
  if (!screen) {
    return json({ error: "screen_not_found" }, 404);
  }
  const widget = parseWidgets(screen.widgets).find(
    (item) => item.id === widgetId && item.kind === "agent-chat",
  );
  if (!widget?.agentId) {
    return json({ error: "widget_not_found" }, 404);
  }
  const agent = ctx.loadAgent(widget.agentId);
  if (!agent) {
    return json({ error: "agent_deleted" }, 404);
  }
  if (text.length === 0 || text.length > MESSAGE_BODY_LIMIT) {
    return json({ error: "invalid_message", limit: MESSAGE_BODY_LIMIT }, 400);
  }
  const sql = ctx.sql;
  const now = Date.now();
  const messageId = newId("m");
  const authorName = me.display_name || me.email.split("@")[0];
  sql.exec(
    `INSERT INTO screen_chat (id, screen_id, widget_id, email, author_kind, author_name, body, pending, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'user', ?, ?, 0, ?, ?)`,
    messageId,
    screenId,
    widgetId,
    me.email,
    authorName,
    text,
    now,
    now,
  );
  const placeholderId = newId("m");
  sql.exec(
    `INSERT INTO screen_chat (id, screen_id, widget_id, email, author_kind, author_name, body, pending, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'agent', ?, '', 1, ?, ?)`,
    placeholderId,
    screenId,
    widgetId,
    me.email,
    agent.name,
    now + 1,
    now + 1,
  );
  const jobId = newId("j");
  sql.exec(
    `INSERT INTO screen_jobs (id, agent_id, screen_id, widget_id, email, placeholder_id, conversation_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    jobId,
    agent.id,
    screenId,
    widgetId,
    me.email,
    placeholderId,
    conversationId,
    now,
  );
  // Bound the private desk chat — oldest rows fall off past the cap.
  sql.exec(
    `DELETE FROM screen_chat WHERE screen_id = ? AND widget_id = ? AND email = ? AND id NOT IN (
       SELECT id FROM screen_chat WHERE screen_id = ? AND widget_id = ? AND email = ?
       ORDER BY created_at DESC LIMIT ?
     )`,
    screenId,
    widgetId,
    me.email,
    screenId,
    widgetId,
    me.email,
    SCREEN_CHAT_KEEP,
  );
  return json({ ok: true, id: messageId, jobs: [jobId] });
}
