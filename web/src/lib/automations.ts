import { FUNCTIONS_URL, authedFetch } from "@/lib/backend";
import { newId } from "@/lib/env";
import { findCatalogEntry } from "@/lib/mcp-catalog";
import { hasOAuthToken } from "@/lib/mcp-oauth";
import type { Automation, AutomationCadence, McpServerConfig } from "@/lib/types";

/** Fields the editor manages; ids and schedule bookkeeping are derived. */
export type AutomationDraftInput = Omit<
  Automation,
  "id" | "createdAt" | "conversationId" | "nextRunAt" | "lastRunAt"
>;

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const INTERVAL_OPTIONS: { value: number; label: string }[] = [
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
  { value: 60, label: "1 hour" },
  { value: 120, label: "2 hours" },
  { value: 180, label: "3 hours" },
  { value: 360, label: "6 hours" },
  { value: 720, label: "12 hours" },
];

/** Webhook trigger tokens: `wh_` + 20-64 random alphanumerics. */
export const WEBHOOK_TOKEN_PATTERN = /^wh_[A-Za-z0-9]{20,64}$/;

/** Unguessable webhook token — the URL itself is the credential. */
export function newWebhookToken(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += alphabet[byte % alphabet.length];
  }
  return `wh_${out}`;
}

/** The public URL external services POST to — treat it like a password. */
export function webhookUrlFor(token: string): string {
  return `${FUNCTIONS_URL}/hooks/${token}`;
}

type ScheduleFields = Pick<Automation, "cadence" | "intervalMinutes" | "time" | "weekday">;

function parseTime(value: string): { hours: number; minutes: number } {
  const [h, m] = value.split(":");
  const hours = Number(h);
  const minutes = Number(m);
  return {
    hours: Number.isFinite(hours) ? Math.min(23, Math.max(0, hours)) : 9,
    minutes: Number.isFinite(minutes) ? Math.min(59, Math.max(0, minutes)) : 0,
  };
}

/** Next fire time strictly after `from`, in local time. */
export function computeNextRunAt(schedule: ScheduleFields, from: number): number {
  if (schedule.cadence === "interval") {
    return from + Math.max(5, schedule.intervalMinutes) * 60_000;
  }
  const { hours, minutes } = parseTime(schedule.time);
  const next = new Date(from);
  next.setHours(hours, minutes, 0, 0);
  if (schedule.cadence === "daily") {
    if (next.getTime() <= from) {
      next.setDate(next.getDate() + 1);
    }
    return next.getTime();
  }
  const target = Math.min(6, Math.max(0, Math.round(schedule.weekday)));
  let delta = (target - next.getDay() + 7) % 7;
  if (delta === 0 && next.getTime() <= from) {
    delta = 7;
  }
  next.setDate(next.getDate() + delta);
  return next.getTime();
}

export function describeSchedule(schedule: ScheduleFields): string {
  if (schedule.cadence === "interval") {
    const minutes = Math.max(5, schedule.intervalMinutes);
    if (minutes < 60) {
      return `Every ${minutes} min`;
    }
    const hours = minutes / 60;
    return `Every ${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
  }
  if (schedule.cadence === "daily") {
    return `Daily · ${schedule.time}`;
  }
  const day = WEEKDAYS[Math.min(6, Math.max(0, schedule.weekday))];
  return `${day.slice(0, 3)} · ${schedule.time}`;
}

/** "in 2h 5m" style countdown to the next scheduled run. */
export function formatCountdown(nextRunAt: number, now: number): string {
  const ms = nextRunAt - now;
  if (ms <= 30_000) {
    return "due now";
  }
  const totalMinutes = Math.round(ms / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `in ${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `in ${hours}h ${minutes}m`;
  }
  return `in ${Math.max(1, minutes)}m`;
}

/** Restores a stored automation, filling gaps so old data can't crash the app. */
export function normalizeAutomation(item: Partial<Automation>): Automation {
  const cadence: AutomationCadence =
    item.cadence === "interval" || item.cadence === "weekly" ? item.cadence : "daily";
  const base = {
    id: typeof item.id === "string" && item.id ? item.id : newId(),
    name: typeof item.name === "string" && item.name.trim() ? item.name : "Automation",
    prompt: typeof item.prompt === "string" ? item.prompt : "",
    cadence,
    intervalMinutes:
      typeof item.intervalMinutes === "number" && item.intervalMinutes >= 5 ? item.intervalMinutes : 60,
    time: typeof item.time === "string" && /^\d{1,2}:\d{2}$/.test(item.time) ? item.time : "09:00",
    weekday: typeof item.weekday === "number" && item.weekday >= 0 && item.weekday <= 6 ? item.weekday : 1,
    agentId: typeof item.agentId === "string" && item.agentId ? item.agentId : null,
    mcpServerIds: Array.isArray(item.mcpServerIds)
      ? item.mcpServerIds.filter((id): id is string => typeof id === "string")
      : null,
    skillIds: Array.isArray(item.skillIds)
      ? item.skillIds.filter((id): id is string => typeof id === "string")
      : null,
    webhookToken:
      typeof item.webhookToken === "string" && WEBHOOK_TOKEN_PATTERN.test(item.webhookToken)
        ? item.webhookToken
        : null,
    deepResearch: item.deepResearch === true,
    enabled: item.enabled !== false,
    catchUp: item.catchUp !== false,
    runOn: item.runOn === "server" ? ("server" as const) : ("browser" as const),
    tzOffsetMinutes:
      typeof item.tzOffsetMinutes === "number" && Number.isFinite(item.tzOffsetMinutes)
        ? Math.max(-840, Math.min(840, Math.round(item.tzOffsetMinutes)))
        : new Date().getTimezoneOffset(),
    conversationId:
      typeof item.conversationId === "string" && item.conversationId ? item.conversationId : newId(),
    lastRunAt: typeof item.lastRunAt === "number" ? item.lastRunAt : undefined,
    createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
  };
  return {
    ...base,
    nextRunAt: typeof item.nextRunAt === "number" ? item.nextRunAt : computeNextRunAt(base, Date.now()),
  };
}

/**
 * Resolves an MCP allow-list against the connected servers: null = every
 * server; ids match either the server row id or its catalog id (so lists
 * written against catalog ids keep working). Shared by agent scoping and
 * per-automation scoping.
 */
export function filterMcpServersByIds(servers: McpServerConfig[], ids: string[] | null): McpServerConfig[] {
  if (ids === null) {
    return servers;
  }
  return servers.filter(
    (server) => ids.includes(server.id) || (server.catalogId ? ids.includes(server.catalogId) : false),
  );
}

/** Whether one MCP server can fire inside scheduled cloud automation runs. */
export type CloudMcpReadiness = "ready" | "needs-auth";

/**
 * Cloud runs reach every connected server straight from the backend: pasted
 * keys and custom headers sync inside the profile, browser sign-ins sync as
 * OAuth grants (refreshed server-side when they expire), and the native
 * GitHub/Slack/Intercom connectors run through server-side REST ports.
 * "needs-auth" = nothing is connected yet — sign in or paste a key first.
 */
export function cloudMcpReadiness(server: McpServerConfig): CloudMcpReadiness {
  const entry = findCatalogEntry(server.catalogId ?? server.id);
  const catalogKey = server.catalogId ?? server.id;
  const hasKey = (server.token ?? "").trim().length > 0;
  const hasHeaders = server.headersJson.trim().length > 0;
  const signedIn = hasOAuthToken(server.id);
  if (entry?.native) {
    if (catalogKey === "github") {
      return hasKey || signedIn ? "ready" : "needs-auth";
    }
    return hasKey ? "ready" : "needs-auth";
  }
  if (server.authMode === "oauth") {
    return signedIn ? "ready" : "needs-auth";
  }
  if (hasKey || hasHeaders || signedIn) {
    return "ready";
  }
  if (server.authMode === "bearer") {
    return "needs-auth";
  }
  if (entry) {
    return entry.auth === "none" || entry.tokenOptional === true ? "ready" : "needs-auth";
  }
  return "ready";
}

/**
 * Fires one cloud automation immediately: the backend flags it and rings
 * the account shard's alarm, so the manual run uses the exact same pipeline
 * as a scheduled trigger. Returns a machine-readable error for honest toasts.
 */
export async function requestCloudRunNow(automationId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await authedFetch("/automations/run-now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ automationId }),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: data.error ?? `http_${response.status}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "network" };
  }
}

export const AUTOMATION_TEMPLATES: AutomationDraftInput[] = [
  {
    name: "Morning brief",
    prompt:
      "Find the most important AI and tech news from the last 24 hours. Write a compact digest: 5-8 bullets with source links, each with one line on why it matters.",
    cadence: "daily",
    intervalMinutes: 60,
    time: "09:00",
    weekday: 1,
    agentId: null,
    mcpServerIds: null,
    skillIds: null,
    webhookToken: null,
    deepResearch: false,
    enabled: true,
    catchUp: true,
    runOn: "browser",
    tzOffsetMinutes: new Date().getTimezoneOffset(),
  },
  {
    name: "Weekly deep dive",
    prompt:
      "Research what changed in the AI agent ecosystem over the past week: model releases, agent products, notable funding, and open-source tools. Deliver a cited report that ends with a short \"worth trying\" list.",
    cadence: "weekly",
    intervalMinutes: 60,
    time: "10:00",
    weekday: 1,
    agentId: null,
    mcpServerIds: null,
    skillIds: null,
    webhookToken: null,
    deepResearch: true,
    enabled: true,
    catchUp: true,
    runOn: "browser",
    tzOffsetMinutes: new Date().getTimezoneOffset(),
  },
  {
    name: "Competitor pulse",
    prompt:
      "Scan the web for fresh news about AI coding agents (Cursor, Devin, Copilot, Claude Code). Summarize only what is new since the previous check in this thread. If nothing meaningful happened, say so in one line.",
    cadence: "interval",
    intervalMinutes: 180,
    time: "09:00",
    weekday: 1,
    agentId: null,
    mcpServerIds: null,
    skillIds: null,
    webhookToken: null,
    deepResearch: false,
    enabled: true,
    catchUp: false,
    runOn: "browser",
    tzOffsetMinutes: new Date().getTimezoneOffset(),
  },
  {
    name: "Feature map drift-check",
    prompt:
      "In the connected GitHub repo <owner/repo — edit me>, run a feature map drift check: fetch .agents/skills/verification/references/feature-map.md, compare it against the source files its header names, and if reality moved, open a PR correcting the map — never merge. If nothing drifted, answer in one line: no drift, plus the head commit you checked.",
    cadence: "daily",
    intervalMinutes: 60,
    time: "08:00",
    weekday: 1,
    agentId: null,
    mcpServerIds: null,
    skillIds: null,
    webhookToken: null,
    deepResearch: false,
    enabled: true,
    catchUp: true,
    runOn: "browser",
    tzOffsetMinutes: new Date().getTimezoneOffset(),
  },
];
