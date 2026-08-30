// Cloud-automation domain logic for the ChatStore shard — schedule math,
// profile-blob coercion, webhook delivery queues, and the skills digest that
// rides into cloud runs. Platform-neutral on purpose: the web app's unit
// tests import this module directly (the due ⟺ next-due invariant is pinned
// there), so nothing Cloudflare-specific may appear here.

import { asNum, asStr, capStr, isRecord } from "./chat-shared";

/** Incoming webhook triggers: per-automation delivery queues. */
export const HOOK_QUEUE_PREFIX = "hookq:";
export const HOOK_TOKEN_PATTERN = /^wh_[A-Za-z0-9]{20,64}$/;
/** Bursts coalesce: at most this many pending deliveries run as one batch. */
export const HOOK_QUEUE_CAP = 5;
export const HOOK_PAYLOAD_STORE_CHARS = 16_000;
export const HOOKS_INDEX_CAP = 20;

/** Automation fields the scheduler needs, as stored inside the profile blob. */
export type StoredAutomation = {
  id: string;
  name: string;
  prompt: string;
  cadence: "interval" | "daily" | "weekly";
  intervalMinutes: number;
  time: string;
  weekday: number;
  agentId: string | null;
  mcpServerIds: string[] | null;
  skillIds: string[] | null;
  /** Incoming webhook trigger token (`wh_…`); null = webhook trigger off. */
  webhookToken: string | null;
  enabled: boolean;
  runOn: string;
  tzOffsetMinutes: number;
  conversationId: string;
  lastRunAt: number;
  createdAt: number;
};

/** Restores the scheduler-relevant automation fields from a profile blob. */
export function storedAutomation(value: unknown): StoredAutomation | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) {
    return null;
  }
  const cadence =
    value.cadence === "interval" || value.cadence === "weekly" ? value.cadence : "daily";
  return {
    id: value.id,
    name: asStr(value.name) || "Automation",
    prompt: asStr(value.prompt),
    cadence,
    intervalMinutes: Math.max(5, asNum(value.intervalMinutes, 60)),
    time: /^\d{1,2}:\d{2}$/.test(asStr(value.time)) ? asStr(value.time) : "09:00",
    weekday: Math.min(6, Math.max(0, Math.round(asNum(value.weekday, 1)))),
    agentId: typeof value.agentId === "string" && value.agentId ? value.agentId : null,
    mcpServerIds: Array.isArray(value.mcpServerIds)
      ? value.mcpServerIds.filter((item): item is string => typeof item === "string")
      : null,
    skillIds: Array.isArray(value.skillIds)
      ? value.skillIds.filter((item): item is string => typeof item === "string")
      : null,
    webhookToken:
      typeof value.webhookToken === "string" && HOOK_TOKEN_PATTERN.test(value.webhookToken)
        ? value.webhookToken
        : null,
    enabled: value.enabled !== false,
    runOn: asStr(value.runOn),
    tzOffsetMinutes: Math.max(-840, Math.min(840, asNum(value.tzOffsetMinutes, 0))),
    conversationId: asStr(value.conversationId),
    lastRunAt: asNum(value.lastRunAt, 0),
    createdAt: asNum(value.createdAt, 0),
  };
}

function parseTimeHM(time: string): { hours: number; minutes: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  return {
    hours: match ? Math.min(23, Math.max(0, Number(match[1]))) : 9,
    minutes: match ? Math.min(59, Math.max(0, Number(match[2]))) : 0,
  };
}

/**
 * Whether a scheduled slot newer than `base` (last run / creation) has
 * arrived. Daily/weekly slots are computed on the user's wall clock via the
 * tz offset captured when the schedule was saved (DST shifts of ±1h are an
 * accepted approximation).
 */
export function automationDue(auto: StoredAutomation, base: number, now: number): boolean {
  if (auto.cadence === "interval") {
    return now - base >= auto.intervalMinutes * 60_000;
  }
  const offsetMs = auto.tzOffsetMinutes * 60_000;
  const local = now - offsetMs;
  const { hours, minutes } = parseTimeHM(auto.time);
  const day = new Date(local);
  let slot = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hours, minutes, 0, 0);
  if (slot > local) {
    slot -= 86_400_000;
  }
  if (auto.cadence === "weekly") {
    const dow = new Date(slot).getUTCDay();
    const delta = (dow - auto.weekday + 7) % 7;
    slot -= delta * 86_400_000;
  }
  return slot + offsetMs > base;
}

/**
 * The next real-time instant strictly after `base` when the automation is
 * due — the forward-looking twin of `automationDue`, used to arm exact
 * per-account alarms (`automationDue(auto, base, t)` ⟺ `nextDueAt(auto,
 * base) <= t`). Same tz-offset approximation as the due check.
 */
export function nextDueAt(auto: StoredAutomation, base: number): number {
  if (auto.cadence === "interval") {
    return base + auto.intervalMinutes * 60_000;
  }
  const offsetMs = auto.tzOffsetMinutes * 60_000;
  const { hours, minutes } = parseTimeHM(auto.time);
  const day = new Date(base - offsetMs);
  let slot = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hours, minutes, 0, 0);
  if (auto.cadence === "weekly") {
    const dow = new Date(slot).getUTCDay();
    slot += ((auto.weekday - dow + 7) % 7) * 86_400_000;
    while (slot + offsetMs <= base) {
      slot += 7 * 86_400_000;
    }
  } else {
    while (slot + offsetMs <= base) {
      slot += 86_400_000;
    }
  }
  return slot + offsetMs;
}

/** One queued incoming webhook delivery (payload already size-capped). */
export type HookDelivery = {
  at: number;
  payload: string;
  contentType: string;
  event: string;
  delivery: string;
};

/** Per-automation delivery queue — bursts coalesce into one run. */
export type HookQueue = { entries: HookDelivery[]; dropped: number };

/**
 * Appends queued webhook deliveries to the automation prompt — the model
 * sees the actual event payloads, and the thread records why the run fired.
 * Four-backtick fences so JSON payloads containing ``` cannot break out.
 */
export function withHookContext(prompt: string, queue: HookQueue): string {
  const total = queue.entries.length;
  const blocks = queue.entries.map((entry, index) => {
    const meta = [
      `received ${new Date(entry.at).toISOString()}`,
      entry.contentType ? `content-type: ${entry.contentType}` : "",
      entry.event ? `event: ${entry.event}` : "",
      entry.delivery ? `delivery: ${entry.delivery}` : "",
    ]
      .filter((part) => part.length > 0)
      .join(" · ");
    const body = entry.payload.trim().length > 0 ? entry.payload : "(empty body)";
    return `Delivery ${index + 1} of ${total} — ${meta}\n\`\`\`\`\n${body}\n\`\`\`\``;
  });
  const dropped =
    queue.dropped > 0
      ? `\n\n(${queue.dropped} older deliveries in this burst were dropped — only the newest ${HOOK_QUEUE_CAP} are kept.)`
      : "";
  return `${prompt}\n\n---\n\n[Webhook trigger] This run was fired by ${total} incoming webhook ${
    total === 1 ? "delivery" : "deliveries"
  } to this automation's hook URL — not by the schedule. Treat the payload below as the event(s) to act on.\n\n${blocks.join("\n\n")}${dropped}`;
}

/**
 * Cloud-run mirror of the browser's skills block (chat surface). Skills live
 * in the synced profile blob; disabled ones, non-chat ones, and ones outside
 * the agent's or the automation's allow-list stay out. Budget-capped so a
 * huge skill set never starves the automation prompt.
 */
export function cloudSkillsBlock(
  rawSkills: unknown,
  agent: Record<string, unknown> | undefined,
  automationAllow: string[] | null,
): string {
  if (!Array.isArray(rawSkills)) {
    return "";
  }
  const allow = agent && Array.isArray(agent.skillIds) ? new Set(agent.skillIds.map(String)) : null;
  const parts: string[] = [];
  let used = 0;
  for (const value of rawSkills) {
    if (!isRecord(value) || value.enabled === false) {
      continue;
    }
    const content = asStr(value.content).trim();
    if (!content) {
      continue;
    }
    const surfaces = isRecord(value.surfaces) ? value.surfaces : {};
    if (surfaces.chat === false) {
      continue;
    }
    if (allow && !allow.has(asStr(value.id))) {
      continue;
    }
    if (automationAllow !== null && !automationAllow.includes(asStr(value.id))) {
      continue;
    }
    const description = asStr(value.description).trim();
    const entry = [
      `### Skill: ${capStr(asStr(value.name).trim() || "Skill", 80)}`,
      description ? `When to apply: ${capStr(description, 240)}` : "",
      capStr(content, 6_000),
    ]
      .filter((line) => line.length > 0)
      .join("\n");
    if (used + entry.length > 16_000) {
      break;
    }
    parts.push(entry);
    used += entry.length;
  }
  if (parts.length === 0) {
    return "";
  }
  return `SKILLS — reusable instruction packs the user enabled. Apply each skill whose "When to apply" matches the task at hand; skip the ones that clearly do not. A direct user request always wins over a skill.\n\n${parts.join("\n\n")}`;
}
