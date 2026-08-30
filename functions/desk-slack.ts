// Desk ↔ Slack awareness — pure helpers behind "already in Slack / an
// investigation is running": matching the team's synced Slack messages to an
// open Intercom conversation, thread-activity status, permalinks, and the
// prompt block that teaches reply suggestions to wait for (or use) the
// outcome. PURE on purpose (no fetch) — unit-tested without a workspace.

/** One synced Slack message in a screen's channel pool. */
export type DeskSlackMessage = {
  channelId: string;
  channelName: string;
  /** Slack ts of this message ("1725012345.000100"). */
  ts: string;
  /** Thread root ts when the message lives inside a thread; "" for top-level. */
  threadTs: string;
  author: string;
  text: string;
  replyCount: number;
  /** Seconds — the thread's last known activity at sync time. */
  lastActivityTs: number;
};

export type DeskSlackMatchedBy = "conversation" | "email" | "name";

export type DeskSlackMatch = {
  channelId: string;
  channelName: string;
  /** The thread this discussion lives under (the message's own ts when unthreaded). */
  rootTs: string;
  matchedBy: DeskSlackMatchedBy;
  lastActivityTs: number;
};

export type DeskSlackTarget = {
  conversationId: string;
  customerEmail: string;
  customerName: string;
};

const MATCH_PRIORITY: Record<DeskSlackMatchedBy, number> = { conversation: 3, email: 2, name: 1 };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * How one Slack message references the conversation; null = unrelated.
 * Deterministic on purpose — explicit references only, no fuzzy topic
 * guessing: the conversation id (Intercom URL, "#id", or a bare id of 6+
 * digits with hard word boundaries), the customer's email, or the customer's
 * FULL name (single first names would flood the desk with false matches).
 */
export function classifySlackReference(text: string, target: DeskSlackTarget): DeskSlackMatchedBy | null {
  const lower = text.toLowerCase();
  const id = target.conversationId.trim();
  if (id.length > 0) {
    const escaped = escapeRegExp(id);
    if (new RegExp(`conversations?/${escaped}(?:\\b|$)`, "i").test(text)) {
      return "conversation";
    }
    if (new RegExp(`#${escaped}(?:\\b|$)`).test(text)) {
      return "conversation";
    }
    if (id.length >= 6 && new RegExp(`(?:^|[^\\w.])${escaped}(?:[^\\w.]|$)`).test(text)) {
      return "conversation";
    }
  }
  const email = target.customerEmail.trim().toLowerCase();
  if (email.includes("@") && email.length >= 6 && lower.includes(email)) {
    return "email";
  }
  const name = target.customerName.trim();
  if (name.includes(" ") && name.length >= 5 && lower.includes(name.toLowerCase())) {
    return "name";
  }
  return null;
}

/**
 * Finds the Slack threads that reference this conversation/customer.
 * Replies collapse into their thread root (one card per discussion), the
 * strongest signal wins the label, newest activity first, capped.
 */
export function matchSlackDiscussions(
  target: DeskSlackTarget,
  messages: DeskSlackMessage[],
  cap = 3,
): DeskSlackMatch[] {
  const byRoot = new Map<string, DeskSlackMatch>();
  for (const message of messages) {
    const matchedBy = classifySlackReference(message.text, target);
    if (!matchedBy) {
      continue;
    }
    const rootTs = message.threadTs || message.ts;
    const key = `${message.channelId}:${rootTs}`;
    const own = Number.parseFloat(message.ts);
    const last = Math.max(message.lastActivityTs, Number.isFinite(own) ? own : 0);
    const existing = byRoot.get(key);
    if (!existing) {
      byRoot.set(key, {
        channelId: message.channelId,
        channelName: message.channelName,
        rootTs,
        matchedBy,
        lastActivityTs: last,
      });
      continue;
    }
    if (MATCH_PRIORITY[matchedBy] > MATCH_PRIORITY[existing.matchedBy]) {
      existing.matchedBy = matchedBy;
    }
    existing.lastActivityTs = Math.max(existing.lastActivityTs, last);
  }
  return [...byRoot.values()].sort((a, b) => b.lastActivityTs - a.lastActivityTs).slice(0, cap);
}

/** A thread with activity in the last hour reads as a live investigation. */
export const DESK_SLACK_ACTIVE_WINDOW_MS = 60 * 60 * 1000;

export function slackThreadActive(lastActivityTs: number, nowMs: number): boolean {
  return lastActivityTs > 0 && nowMs - lastActivityTs * 1000 < DESK_SLACK_ACTIVE_WINDOW_MS;
}

/** Slack archive permalink — works for thread roots and plain messages. */
export function slackPermalink(teamUrl: string, channelId: string, ts: string): string {
  const base = teamUrl.replace(/\/+$/, "");
  return `${base}/archives/${channelId}/p${ts.replace(".", "")}`;
}

function ageLabel(lastActivityTs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - lastActivityTs * 1000) / 60_000));
  if (minutes < 90) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 36) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

export type DeskSlackThreadView = {
  channelName: string;
  active: boolean;
  lastActivityTs: number;
  lines: Array<{ author: string; text: string }>;
};

/** One thread as a prompt block — status first so the model can wait honestly. */
export function buildSlackThreadBlock(view: DeskSlackThreadView, nowMs: number): string {
  const status = view.active ? "ACTIVE — the team is working it right now" : "quiet";
  const lines = view.lines.map(
    (line) => `  @${line.author}: ${line.text.replace(/\s+/g, " ").slice(0, 300)}`,
  );
  return [
    `[#${view.channelName}] last activity ${ageLabel(view.lastActivityTs, nowMs)} (${status}):`,
    ...lines,
  ].join("\n");
}
