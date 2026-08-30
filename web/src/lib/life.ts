/**
 * Personal assistant hub: persistent memories, custom trackers, and tasks.
 * The user edits it in the Hub panel; the agent reads a live snapshot every
 * turn (when sharing is on) and writes through ```action fences in replies.
 */

import { newId } from "@/lib/env";
import type {
  LifeState,
  MemoryFact,
  PersonalTask,
  Tracker,
  TrackerEntry,
  TrackerKind,
} from "@/lib/types";

const LIFE_KEY = "gera.life.v1";

const MAX_MEMORIES = 300;
const MAX_ENTRIES = 5000;
const MAX_TASKS = 400;
const PALETTE_SIZE = 8;

// ---------------------------------------------------------------- storage

export function emptyLife(): LifeState {
  return { memories: [], trackers: [], entries: [], tasks: [], shareWithAgent: true, memoryEnabled: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Number coercion tolerant of "1 500 ₽", "82,4" (RU decimal), "45%". */
function asNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  let cleaned = value.replace(/[\s%$€£₽]/g, "");
  if (/^-?\d+,\d+$/.test(cleaned)) {
    cleaned = cleaned.replace(",", ".");
  } else {
    cleaned = cleaned.replace(/,/g, "");
  }
  if (!cleaned || !/\d/.test(cleaned)) {
    return null;
  }
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function normalizeMemory(value: unknown): MemoryFact | null {
  if (!isRecord(value) || typeof value.text !== "string" || !value.text.trim()) {
    return null;
  }
  return {
    id: typeof value.id === "string" && value.id ? value.id : newId(),
    text: value.text,
    category: asString(value.category),
    createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
  };
}

function normalizeTracker(value: unknown): Tracker | null {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) {
    return null;
  }
  return {
    id: typeof value.id === "string" && value.id ? value.id : newId(),
    name: value.name,
    unit: asString(value.unit),
    kind: value.kind === "check" ? "check" : "number",
    goal: typeof value.goal === "number" && Number.isFinite(value.goal) ? value.goal : null,
    color: typeof value.color === "number" ? Math.abs(Math.trunc(value.color)) % PALETTE_SIZE : 0,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
  };
}

function normalizeEntry(value: unknown): TrackerEntry | null {
  if (!isRecord(value) || typeof value.trackerId !== "string" || typeof value.value !== "number") {
    return null;
  }
  return {
    id: typeof value.id === "string" && value.id ? value.id : newId(),
    trackerId: value.trackerId,
    value: Number.isFinite(value.value) ? value.value : 0,
    note: typeof value.note === "string" && value.note ? value.note : undefined,
    at: typeof value.at === "number" ? value.at : Date.now(),
  };
}

function normalizeTask(value: unknown): PersonalTask | null {
  if (!isRecord(value) || typeof value.text !== "string" || !value.text.trim()) {
    return null;
  }
  return {
    id: typeof value.id === "string" && value.id ? value.id : newId(),
    text: value.text,
    done: value.done === true,
    due: typeof value.due === "number" && Number.isFinite(value.due) ? value.due : null,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
    completedAt: typeof value.completedAt === "number" ? value.completedAt : undefined,
  };
}

/** Validates any stored or cloud-synced hub blob into a safe LifeState. */
export function normalizeLife(raw: unknown): LifeState {
  if (!isRecord(raw)) {
    return emptyLife();
  }
  const stored = raw as Partial<LifeState>;
  return {
    memories: Array.isArray(stored.memories)
      ? stored.memories.map(normalizeMemory).filter((item): item is MemoryFact => item !== null)
      : [],
    trackers: Array.isArray(stored.trackers)
      ? stored.trackers.map(normalizeTracker).filter((item): item is Tracker => item !== null)
      : [],
    entries: Array.isArray(stored.entries)
      ? stored.entries.map(normalizeEntry).filter((item): item is TrackerEntry => item !== null)
      : [],
    tasks: Array.isArray(stored.tasks)
      ? stored.tasks.map(normalizeTask).filter((item): item is PersonalTask => item !== null)
      : [],
    shareWithAgent: typeof stored.shareWithAgent === "boolean" ? stored.shareWithAgent : true,
    memoryEnabled: typeof stored.memoryEnabled === "boolean" ? stored.memoryEnabled : true,
  };
}

export function loadLife(): LifeState {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return emptyLife();
  }
  try {
    const raw = window.localStorage.getItem(LIFE_KEY);
    if (!raw) {
      return emptyLife();
    }
    return normalizeLife(JSON.parse(raw));
  } catch {
    return emptyLife();
  }
}

export function saveLife(life: LifeState): void {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(LIFE_KEY, JSON.stringify(life));
  } catch {
    // storage full — hub keeps working in memory
  }
}

// ---------------------------------------------------------------- day math

/** Local calendar day key: "YYYY-MM-DD". */
export function dayKey(ts: number): string {
  const date = new Date(ts);
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Per-day sums for a tracker over the trailing `days` window, oldest → today. */
export function dailyTotals(
  entries: TrackerEntry[],
  trackerId: string,
  days: number,
  now: number = Date.now(),
): { day: string; total: number }[] {
  const sums = new Map<string, number>();
  for (const entry of entries) {
    if (entry.trackerId !== trackerId) {
      continue;
    }
    const key = dayKey(entry.at);
    sums.set(key, (sums.get(key) ?? 0) + entry.value);
  }
  const base = new Date(now);
  const result: { day: string; total: number }[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
    const key = dayKey(day.getTime());
    result.push({ day: key, total: sums.get(key) ?? 0 });
  }
  return result;
}

export function formatValue(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return String(Math.round(value * 100) / 100);
}

export function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------- write ops

export type LifeOp =
  | { op: "memory.save"; text: string; category: string }
  | { op: "memory.delete"; match: string }
  | { op: "tracker.create"; name: string; unit: string; kind: TrackerKind; goal: number | null }
  | { op: "tracker.log"; tracker: string; value: number | null; unit: string; note: string; at: number | null }
  | { op: "tracker.delete"; name: string }
  | { op: "task.add"; text: string; due: number | null }
  | { op: "task.done"; match: string }
  | { op: "task.delete"; match: string };

const OP_ALIASES: Record<string, LifeOp["op"]> = {
  "memory.save": "memory.save",
  "memory.add": "memory.save",
  remember: "memory.save",
  "memory.delete": "memory.delete",
  "memory.forget": "memory.delete",
  forget: "memory.delete",
  "tracker.create": "tracker.create",
  "tracker.add": "tracker.create",
  "tracker.log": "tracker.log",
  log: "tracker.log",
  track: "tracker.log",
  "tracker.delete": "tracker.delete",
  "tracker.remove": "tracker.delete",
  "task.add": "task.add",
  "task.create": "task.add",
  "todo.add": "task.add",
  "reminder.add": "task.add",
  "task.done": "task.done",
  "task.complete": "task.done",
  "task.delete": "task.delete",
  "task.remove": "task.delete",
};

/** Parses "YYYY-MM-DD[ HH:MM]" (local) or any ISO string into a timestamp. */
function parseWhen(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(text);
  if (match) {
    const hours = match[4] !== undefined ? Number(match[4]) : 12;
    const minutes = match[5] !== undefined ? Number(match[5]) : 0;
    const ts = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hours, minutes).getTime();
    return Number.isFinite(ts) ? ts : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function opFrom(value: unknown): LifeOp | null {
  if (!isRecord(value)) {
    return null;
  }
  const mapped = OP_ALIASES[asString(value.op).trim().toLowerCase()];
  if (!mapped) {
    return null;
  }
  switch (mapped) {
    case "memory.save": {
      const text = asString(value.text ?? value.fact ?? value.memory ?? value.content).trim();
      if (!text) {
        return null;
      }
      return { op: mapped, text: text.slice(0, 400), category: asString(value.category).trim().slice(0, 24) };
    }
    case "memory.delete": {
      const match = asString(value.match ?? value.text).trim();
      return match ? { op: mapped, match: match.slice(0, 200) } : null;
    }
    case "tracker.create": {
      const name = asString(value.name ?? value.tracker).trim();
      if (!name) {
        return null;
      }
      return {
        op: mapped,
        name: name.slice(0, 40),
        unit: asString(value.unit).trim().slice(0, 16),
        kind: value.kind === "check" ? "check" : "number",
        goal: asNumber(value.goal),
      };
    }
    case "tracker.log": {
      const tracker = asString(value.tracker ?? value.name).trim();
      if (!tracker) {
        return null;
      }
      const rawValue = value.value ?? value.amount ?? value.count;
      return {
        op: mapped,
        tracker: tracker.slice(0, 40),
        value: rawValue === undefined || rawValue === null ? null : asNumber(rawValue),
        unit: asString(value.unit).trim().slice(0, 16),
        note: asString(value.note ?? value.comment).trim().slice(0, 200),
        at: parseWhen(value.at ?? value.date ?? value.when),
      };
    }
    case "tracker.delete": {
      const name = asString(value.name ?? value.tracker).trim();
      return name ? { op: mapped, name: name.slice(0, 40) } : null;
    }
    case "task.add": {
      const text = asString(value.text ?? value.task ?? value.title).trim();
      if (!text) {
        return null;
      }
      return { op: mapped, text: text.slice(0, 300), due: parseWhen(value.due ?? value.when ?? value.date) };
    }
    case "task.done":
    case "task.delete": {
      const match = asString(value.match ?? value.text ?? value.task).trim();
      return match ? { op: mapped, match: match.slice(0, 200) } : null;
    }
    default:
      return null;
  }
}

/** Parses JSON from a fence body, salvaging the first {...} or [...] on failure. Shared with the skills-editor ops parser. */
export function extractJsonLoose(raw: string): unknown {
  const text = raw.trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    // fall through to salvage
  }
  const start = text.search(/[{[]/);
  if (start === -1) {
    return null;
  }
  const close = text[start] === "{" ? "}" : "]";
  const end = text.lastIndexOf(close);
  if (end <= start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Parses the JSON inside one ```action fence into validated ops. */
export function parseLifeOps(raw: string): LifeOp[] {
  const parsed = extractJsonLoose(raw);
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed)
      ? Array.isArray(parsed.ops)
        ? parsed.ops
        : [parsed]
      : [];
  const ops: LifeOp[] = [];
  for (const item of list.slice(0, 40)) {
    const op = opFrom(item);
    if (op) {
      ops.push(op);
    }
  }
  return ops;
}

const ACTION_FENCE_RE = /```(?:action|actions|hub)[^\n]*\n([\s\S]*?)```/gi;

/** Bodies of every ```action fence in an assistant reply — shared by the hub and skills-editor parsers. */
export function actionFenceBodies(content: string): string[] {
  const bodies: string[] = [];
  for (const match of content.matchAll(ACTION_FENCE_RE)) {
    bodies.push(match[1] ?? "");
  }
  return bodies;
}

/** Collects every op from all ```action fences in an assistant reply. */
export function extractActionOps(content: string): LifeOp[] {
  const ops: LifeOp[] = [];
  for (const body of actionFenceBodies(content)) {
    ops.push(...parseLifeOps(body));
  }
  return ops;
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** True when an equal (case/space-insensitive) memory already exists. */
export function hasMemory(life: LifeState, text: string): boolean {
  return life.memories.some((item) => sameText(item.text, text));
}

/**
 * Strips memory ops while the user has memory switched off, so chips and
 * toasts never claim a save that did not happen. Trackers and tasks pass.
 */
export function allowedLifeOps(life: LifeState, ops: LifeOp[]): LifeOp[] {
  if (life.memoryEnabled !== false) {
    return ops;
  }
  return ops.filter((op) => op.op !== "memory.save" && op.op !== "memory.delete");
}

function findTracker(trackers: Tracker[], name: string): Tracker | undefined {
  const query = name.trim().toLowerCase();
  return (
    trackers.find((item) => item.name.trim().toLowerCase() === query) ??
    trackers.find((item) => {
      const own = item.name.trim().toLowerCase();
      return own.includes(query) || query.includes(own);
    })
  );
}

function applyOne(life: LifeState, op: LifeOp, now: number): LifeState {
  switch (op.op) {
    case "memory.save": {
      if (life.memoryEnabled === false) {
        return life; // memory is off — agent writes never land
      }
      if (life.memories.some((item) => sameText(item.text, op.text))) {
        return life;
      }
      const memory: MemoryFact = { id: newId(), text: op.text, category: op.category, createdAt: now };
      return { ...life, memories: [memory, ...life.memories].slice(0, MAX_MEMORIES) };
    }
    case "memory.delete": {
      if (life.memoryEnabled === false) {
        return life;
      }
      const query = op.match.toLowerCase();
      const memories = life.memories.filter((item) => !item.text.toLowerCase().includes(query));
      return memories.length === life.memories.length ? life : { ...life, memories };
    }
    case "tracker.create": {
      const existing = findTracker(life.trackers, op.name);
      if (existing) {
        return {
          ...life,
          trackers: life.trackers.map((item) =>
            item.id === existing.id
              ? {
                  ...item,
                  unit: op.unit || item.unit,
                  goal: op.goal ?? item.goal,
                }
              : item,
          ),
        };
      }
      const tracker: Tracker = {
        id: newId(),
        name: op.name,
        unit: op.unit,
        kind: op.kind,
        goal: op.goal,
        color: life.trackers.length % PALETTE_SIZE,
        createdAt: now,
      };
      return { ...life, trackers: [...life.trackers, tracker] };
    }
    case "tracker.log": {
      let trackers = life.trackers;
      let tracker = findTracker(trackers, op.tracker);
      if (!tracker) {
        tracker = {
          id: newId(),
          name: op.tracker,
          unit: op.unit,
          kind: op.value === null && !op.unit ? "check" : "number",
          goal: null,
          color: trackers.length % PALETTE_SIZE,
          createdAt: now,
        };
        trackers = [...trackers, tracker];
      } else if (op.unit && !tracker.unit) {
        const id = tracker.id;
        trackers = trackers.map((item) => (item.id === id ? { ...item, unit: op.unit } : item));
      }
      const entry: TrackerEntry = {
        id: newId(),
        trackerId: tracker.id,
        value: op.value ?? 1,
        note: op.note ? op.note : undefined,
        at: op.at ?? now,
      };
      return { ...life, trackers, entries: [...life.entries, entry].slice(-MAX_ENTRIES) };
    }
    case "tracker.delete": {
      const target = findTracker(life.trackers, op.name);
      if (!target) {
        return life;
      }
      return {
        ...life,
        trackers: life.trackers.filter((item) => item.id !== target.id),
        entries: life.entries.filter((item) => item.trackerId !== target.id),
      };
    }
    case "task.add": {
      if (life.tasks.some((item) => !item.done && sameText(item.text, op.text))) {
        return life;
      }
      const task: PersonalTask = { id: newId(), text: op.text, done: false, due: op.due, createdAt: now };
      return { ...life, tasks: [...life.tasks, task].slice(-MAX_TASKS) };
    }
    case "task.done": {
      const query = op.match.toLowerCase();
      const target = life.tasks.find((item) => !item.done && item.text.toLowerCase().includes(query));
      if (!target) {
        return life;
      }
      return {
        ...life,
        tasks: life.tasks.map((item) =>
          item.id === target.id ? { ...item, done: true, completedAt: now } : item,
        ),
      };
    }
    case "task.delete": {
      const query = op.match.toLowerCase();
      const target =
        life.tasks.find((item) => !item.done && item.text.toLowerCase().includes(query)) ??
        life.tasks.find((item) => item.text.toLowerCase().includes(query));
      if (!target) {
        return life;
      }
      return { ...life, tasks: life.tasks.filter((item) => item.id !== target.id) };
    }
    default:
      return life;
  }
}

/** Applies agent write-ops to the hub; pure — returns the next state. */
export function applyLifeOps(life: LifeState, ops: LifeOp[], now: number = Date.now()): LifeState {
  let next = life;
  for (const op of ops) {
    next = applyOne(next, op, now);
  }
  return next;
}

// ---------------------------------------------------------------- chips

export type OpChipKind = "memory" | "log" | "create" | "task" | "done" | "delete";

export type OpChip = { kind: OpChipKind; label: string };

function formatSigned(value: number): string {
  return value >= 0 ? `+${formatValue(value)}` : formatValue(value);
}

/** Human-readable chip for one write-op, shown in chat. */
export function describeOp(op: LifeOp): OpChip {
  switch (op.op) {
    case "memory.save":
      return { kind: "memory", label: `Remembered: ${op.text}` };
    case "memory.delete":
      return { kind: "delete", label: `Forgot: ${op.match}` };
    case "tracker.create":
      return { kind: "create", label: `New tracker: ${op.name}${op.unit ? ` (${op.unit})` : ""}` };
    case "tracker.log":
      return {
        kind: "log",
        label: `${op.tracker} ${formatSigned(op.value ?? 1)}${op.unit ? ` ${op.unit}` : ""}`,
      };
    case "tracker.delete":
      return { kind: "delete", label: `Removed tracker: ${op.name}` };
    case "task.add":
      return { kind: "task", label: `Task: ${op.text}${op.due !== null ? ` · ${formatWhen(op.due)}` : ""}` };
    case "task.done":
      return { kind: "done", label: `Done: ${op.match}` };
    case "task.delete":
      return { kind: "delete", label: `Removed task: ${op.match}` };
  }
}

// ---------------------------------------------------------------- context

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatNow(now: number): string {
  const date = new Date(now);
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${WEEKDAYS_SHORT[date.getDay()]} ${dayKey(now)} ${pad(date.getHours())}:${pad(date.getMinutes())} (user's local time)`;
}

function contextData(life: LifeState, now: number, memoryOn: boolean): string {
  const parts: string[] = ["CURRENT DATA:"];
  const visibleMemoryCount = memoryOn ? life.memories.length : 0;
  if (visibleMemoryCount === 0 && life.trackers.length === 0 && life.tasks.length === 0) {
    parts.push(
      memoryOn
        ? "The hub is empty — start saving as soon as the user shares something durable or trackable."
        : "The hub is empty — start logging as soon as the user reports something trackable or a task.",
    );
    return parts.join("\n");
  }

  if (memoryOn) {
    parts.push(`Memories (${life.memories.length}):`);
    const memories = life.memories.slice(0, 40);
    if (memories.length === 0) {
      parts.push("- (none)");
    }
    for (const memory of memories) {
      parts.push(`- ${memory.category ? `[${memory.category}] ` : ""}${memory.text.slice(0, 200)}`);
    }
  }

  parts.push(`Trackers (${life.trackers.length}):`);
  const trackers = life.trackers.slice(0, 16);
  if (trackers.length === 0) {
    parts.push("- (none)");
  }
  for (const tracker of trackers) {
    const totals = dailyTotals(life.entries, tracker.id, 14, now);
    const today = totals[totals.length - 1]?.total ?? 0;
    const goal = tracker.goal !== null ? `, goal ${formatValue(tracker.goal)}/day` : "";
    const series = totals.map((item) => formatValue(item.total)).join(",");
    parts.push(
      `- ${tracker.name}${tracker.unit ? ` (${tracker.unit})` : ""} — ${tracker.kind}${goal}. Today: ${formatValue(today)}. Last 14 days (${totals[0]?.day ?? ""} → today): ${series}`,
    );
  }

  const open = life.tasks
    .filter((task) => !task.done)
    .sort((a, b) => (a.due ?? Number.MAX_SAFE_INTEGER) - (b.due ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt)
    .slice(0, 30);
  parts.push(`Open tasks (${life.tasks.filter((task) => !task.done).length}):`);
  if (open.length === 0) {
    parts.push("- (none)");
  }
  for (const task of open) {
    parts.push(`- ${task.text}${task.due !== null ? ` — due ${formatWhen(task.due)}` : ""}`);
  }

  const done = life.tasks
    .filter((task) => task.done)
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
    .slice(0, 5);
  if (done.length > 0) {
    parts.push("Recently completed:");
    for (const task of done) {
      parts.push(`- ${task.text} (done ${dayKey(task.completedAt ?? task.createdAt)})`);
    }
  }
  return parts.join("\n");
}

/**
 * Live hub snapshot + write instructions, appended to the system prompt of
 * every turn while sharing is on.
 */
export function buildPersonalContext(life: LifeState, now: number = Date.now()): string {
  const memoryOn = life.memoryEnabled !== false;
  const opsExample = memoryOn
    ? [
        '[{"op":"memory.save","text":"Prefers concise answers","category":"prefs"},',
        ' {"op":"tracker.log","tracker":"Water","value":2,"unit":"glass"},',
        ' {"op":"tracker.create","name":"Sleep","unit":"h","kind":"number","goal":8},',
        ' {"op":"task.add","text":"Call the bank","due":"2026-08-22 18:00"},',
        ' {"op":"task.done","match":"bank"},',
        ' {"op":"memory.delete","match":"…"}, {"op":"task.delete","match":"…"}, {"op":"tracker.delete","name":"…"}]',
      ]
    : [
        '[{"op":"tracker.log","tracker":"Water","value":2,"unit":"glass"},',
        ' {"op":"tracker.create","name":"Sleep","unit":"h","kind":"number","goal":8},',
        ' {"op":"task.add","text":"Call the bank","due":"2026-08-22 18:00"},',
        ' {"op":"task.done","match":"bank"},',
        ' {"op":"task.delete","match":"…"}, {"op":"tracker.delete","name":"…"}]',
      ];
  const memoryRule = memoryOn
    ? "- AUTO-MEMORY: the moment the user mentions a durable fact — their name, preferences, people, projects, deadlines, decisions, constraints — save it with memory.save in that same reply. Do not ask, do not wait to be told \"remember this\": remembering is your default. Short, one fact per op, in the user's own language."
    : "- MEMORY IS OFF (user setting): never emit memory.save or memory.delete ops, and never claim you will remember something. Saved memories are hidden from you until the user re-enables memory in the hub.";
  return [
    "PERSONAL ASSISTANT HUB — beyond answering, you are the user's personal assistant. You own a persistent hub (memories, trackers, tasks) that survives across chats; its live snapshot is below.",
    `Now: ${formatNow(now)}`,
    "",
    'To write to the hub, emit ONE ```action fence containing ONLY a JSON array of ops, then continue the reply after the fence:',
    ...opsExample,
    "Hub rules:",
    memoryRule,
    '- The user reports anything countable or completed — water, money spent, weight, sleep, workouts, mood (1-10), pages read, habits → tracker.log with the exact number reported (omit "value" for done/not-done habits). Unknown trackers are created automatically; include "unit" on the first log. Never invent numbers.',
    '- The user asks to remind or notes a todo → task.add; says something is finished → task.done.',
    "- Name trackers, tasks, and memories in the user's own language. Save obvious things without asking permission, then confirm in a few words after the fence.",
    '- Do not re-save anything already present in CURRENT DATA. Use "at"/"due" as "YYYY-MM-DD HH:MM" when the user means a past or future moment (yesterday, tomorrow, tonight).',
    "- Answer questions about this data straight from CURRENT DATA — totals, trends, streaks, comparisons; render a ```chart fence when a trend or breakdown helps.",
    "",
    contextData(life, now, memoryOn),
  ].join("\n");
}

// ---------------------------------------------------------------- UI mutators

export function addMemory(life: LifeState, text: string, category: string = ""): LifeState {
  const trimmed = text.trim();
  if (!trimmed || life.memories.some((item) => sameText(item.text, trimmed))) {
    return life;
  }
  const memory: MemoryFact = { id: newId(), text: trimmed, category, createdAt: Date.now() };
  return { ...life, memories: [memory, ...life.memories].slice(0, MAX_MEMORIES) };
}

export function removeMemory(life: LifeState, id: string): LifeState {
  return { ...life, memories: life.memories.filter((item) => item.id !== id) };
}

export function addTracker(
  life: LifeState,
  input: { name: string; unit: string; kind: TrackerKind; goal: number | null },
): LifeState {
  const name = input.name.trim();
  if (!name || findTracker(life.trackers, name)) {
    return life;
  }
  const tracker: Tracker = {
    id: newId(),
    name,
    unit: input.unit.trim(),
    kind: input.kind,
    goal: input.goal,
    color: life.trackers.length % PALETTE_SIZE,
    createdAt: Date.now(),
  };
  return { ...life, trackers: [...life.trackers, tracker] };
}

export function updateTracker(
  life: LifeState,
  id: string,
  patch: Partial<Pick<Tracker, "name" | "unit" | "goal">>,
): LifeState {
  return {
    ...life,
    trackers: life.trackers.map((item) => (item.id === id ? { ...item, ...patch } : item)),
  };
}

export function removeTracker(life: LifeState, id: string): LifeState {
  return {
    ...life,
    trackers: life.trackers.filter((item) => item.id !== id),
    entries: life.entries.filter((item) => item.trackerId !== id),
  };
}

export function logEntry(life: LifeState, trackerId: string, value: number, note?: string): LifeState {
  const entry: TrackerEntry = { id: newId(), trackerId, value, note, at: Date.now() };
  return { ...life, entries: [...life.entries, entry].slice(-MAX_ENTRIES) };
}

export function removeEntry(life: LifeState, entryId: string): LifeState {
  return { ...life, entries: life.entries.filter((item) => item.id !== entryId) };
}

export function addTask(life: LifeState, text: string, due: number | null): LifeState {
  const trimmed = text.trim();
  if (!trimmed) {
    return life;
  }
  const task: PersonalTask = { id: newId(), text: trimmed, done: false, due, createdAt: Date.now() };
  return { ...life, tasks: [...life.tasks, task].slice(-MAX_TASKS) };
}

export function toggleTask(life: LifeState, id: string): LifeState {
  return {
    ...life,
    tasks: life.tasks.map((item) =>
      item.id === id
        ? { ...item, done: !item.done, completedAt: item.done ? undefined : Date.now() }
        : item,
    ),
  };
}

export function removeTask(life: LifeState, id: string): LifeState {
  return { ...life, tasks: life.tasks.filter((item) => item.id !== id) };
}
