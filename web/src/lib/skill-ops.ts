/**
 * Chat-driven skill editing: the model creates and edits the user's Skills
 * through the same ```action fence protocol the personal hub uses. Ops are
 * parsed from the assistant's reply and applied once when the turn settles.
 * There is deliberately no delete op — removal stays on the Skills page.
 */

import { newId } from "@/lib/env";
import { actionFenceBodies, extractJsonLoose, type OpChip } from "@/lib/life";
import {
  MAX_SKILL_CONNECTORS,
  MAX_SKILL_CONTENT_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_FOLDER_CHARS,
  MAX_SKILL_NAME_CHARS,
  MAX_SKILLS,
  type SkillConnectorRef,
} from "@/lib/skills";
import type { McpServerConfig, Skill, SkillSurface } from "@/lib/types";

const SURFACE_KEYS: SkillSurface[] = ["chat", "research", "julius"];

/** Registry char budget — the editor block rides every chat turn, so it must stay cheap. */
const REGISTRY_BUDGET_CHARS = 12_000;
/** Per-skill content preview inside the registry (full text of enabled chat skills already rides in SKILLS). */
const REGISTRY_PREVIEW_CHARS = 280;

export type SkillCreateOp = {
  op: "skill.create";
  name: string;
  description: string;
  content: string;
  folder: string;
  /** null = default (all surfaces on). */
  surfaces: SkillSurface[] | null;
  enabled: boolean;
  /** Connector names or ids to bind; null = none given. Resolved at apply time. */
  connectors: string[] | null;
};

export type SkillUpdateOp = {
  op: "skill.update";
  /** Skill id from the registry, or an exact (case-insensitive) name. */
  target: string;
  set: {
    name?: string;
    description?: string;
    content?: string;
    folder?: string;
    enabled?: boolean;
    surfaces?: SkillSurface[];
    /** Full replacement of the binding; [] clears it. */
    connectors?: string[];
  };
};

export type SkillOp = SkillCreateOp | SkillUpdateOp;

export type SkillOpOutcome =
  | { kind: "created"; name: string; note?: string }
  | { kind: "updated"; name: string; note?: string }
  | { kind: "rejected"; name: string; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

const SKILL_OP_ALIASES: Record<string, SkillOp["op"]> = {
  "skill.create": "skill.create",
  "skill.add": "skill.create",
  "skill.save": "skill.create",
  "skill.new": "skill.create",
  "skill.update": "skill.update",
  "skill.edit": "skill.update",
  "skill.patch": "skill.update",
};

/** Accepts ["chat","julius"] or {chat:true,...}; null when nothing valid was named. */
function surfacesFrom(value: unknown): SkillSurface[] | null {
  if (Array.isArray(value)) {
    const picked = SURFACE_KEYS.filter((key) =>
      value.some((item) => typeof item === "string" && item.trim().toLowerCase() === key),
    );
    return picked.length > 0 ? picked : null;
  }
  if (isRecord(value)) {
    const picked = SURFACE_KEYS.filter((key) => value[key] === true);
    return picked.length > 0 ? picked : null;
  }
  return null;
}

function surfaceRecord(list: SkillSurface[]): Record<SkillSurface, boolean> {
  return {
    chat: list.includes("chat"),
    research: list.includes("research"),
    julius: list.includes("julius"),
  };
}

/** Connector names/ids from an op; null when the field is absent or junk ([] = explicit clear). */
function connectorsFrom(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const entry = item.trim();
    if (entry.length > 0 && !list.includes(entry)) {
      list.push(entry);
    }
  }
  return list.slice(0, 12);
}

function skillOpFrom(value: unknown): SkillOp | null {
  if (!isRecord(value)) {
    return null;
  }
  const mapped = SKILL_OP_ALIASES[asString(value.op).trim().toLowerCase()];
  if (!mapped) {
    return null;
  }
  if (mapped === "skill.create") {
    const name = asString(value.name ?? value.title).trim().slice(0, MAX_SKILL_NAME_CHARS);
    const content = asString(value.content ?? value.instructions ?? value.text).slice(
      0,
      MAX_SKILL_CONTENT_CHARS,
    );
    if (!name || !content.trim()) {
      return null;
    }
    return {
      op: "skill.create",
      name,
      description: asString(value.description ?? value.when).trim().slice(0, MAX_SKILL_DESCRIPTION_CHARS),
      content,
      folder: asString(value.folder ?? value.group).trim().slice(0, MAX_SKILL_FOLDER_CHARS),
      surfaces: surfacesFrom(value.surfaces),
      enabled: value.enabled !== false,
      connectors: connectorsFrom(value.connectors ?? value.mcp),
    };
  }
  const target = asString(value.id ?? value.skillId ?? value.target ?? value.name).trim();
  if (!target) {
    return null;
  }
  // Models emit either {"set":{...}} or the patch fields at the top level.
  const source = isRecord(value.set) ? value.set : isRecord(value.patch) ? value.patch : value;
  const topLevel = source === value;
  const targetedById =
    value.id !== undefined || value.skillId !== undefined || value.target !== undefined;
  const set: SkillUpdateOp["set"] = {};
  // A top-level "name" that served as the target is not a rename.
  if (!topLevel || targetedById) {
    const name = asString(source.name).trim();
    if (name) {
      set.name = name.slice(0, MAX_SKILL_NAME_CHARS);
    }
  }
  if (typeof source.description === "string") {
    set.description = source.description.trim().slice(0, MAX_SKILL_DESCRIPTION_CHARS);
  }
  if (typeof source.content === "string" && source.content.trim().length > 0) {
    set.content = source.content.slice(0, MAX_SKILL_CONTENT_CHARS);
  }
  if (typeof source.folder === "string") {
    set.folder = source.folder.trim().slice(0, MAX_SKILL_FOLDER_CHARS);
  }
  if (typeof source.enabled === "boolean") {
    set.enabled = source.enabled;
  }
  const surfaces = surfacesFrom(source.surfaces);
  if (surfaces) {
    set.surfaces = surfaces;
  }
  const connectors = connectorsFrom(source.connectors ?? source.mcp);
  if (connectors !== null) {
    set.connectors = connectors;
  }
  if (Object.keys(set).length === 0) {
    return null;
  }
  return { op: "skill.update", target, set };
}

/** Parses the JSON inside one ```action fence into validated skill ops (hub ops are ignored). */
export function parseSkillOps(raw: string): SkillOp[] {
  const parsed = extractJsonLoose(raw);
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed)
      ? Array.isArray(parsed.ops)
        ? parsed.ops
        : [parsed]
      : [];
  const ops: SkillOp[] = [];
  for (const item of list.slice(0, 40)) {
    const op = skillOpFrom(item);
    if (op) {
      ops.push(op);
    }
  }
  return ops;
}

/** Collects every skill op from all ```action fences in an assistant reply. */
export function extractSkillOps(content: string): SkillOp[] {
  const ops: SkillOp[] = [];
  for (const body of actionFenceBodies(content)) {
    ops.push(...parseSkillOps(body));
  }
  return ops;
}

/** Resolves connector names/ids to configured server ids; unknown entries are reported, never silently dropped. */
function resolveConnectors(
  requested: string[],
  pool: Array<Pick<McpServerConfig, "id" | "name">>,
): { ids: string[]; unknown: string[] } {
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const item of requested) {
    const server =
      pool.find((entry) => entry.id === item) ??
      pool.find((entry) => entry.name.trim().toLowerCase() === item.trim().toLowerCase());
    if (server) {
      if (!ids.includes(server.id)) {
        ids.push(server.id);
      }
    } else {
      unknown.push(item);
    }
  }
  return { ids: ids.slice(0, MAX_SKILL_CONNECTORS), unknown };
}

function unknownNote(unknown: string[]): string | undefined {
  return unknown.length > 0
    ? `Unknown connectors ignored: ${unknown.join(", ")} — check the Connections page.`
    : undefined;
}

export type SkillOpContext = {
  /** Configured connectors — the pool "connectors" fields resolve against. */
  connectors?: Array<Pick<McpServerConfig, "id" | "name">>;
  now?: number;
};

/**
 * Applies skill write-ops; pure — returns the next list plus an honest
 * outcome per op (created / updated / rejected with a reason). Creating a
 * name that already exists updates that skill instead, so a settle replayed
 * after a resume never duplicates. Connector bindings resolve against the
 * context pool; unknown names ride back as a note, never silently.
 */
export function applySkillOps(
  skills: Skill[],
  ops: SkillOp[],
  context: SkillOpContext = {},
): { skills: Skill[]; outcomes: SkillOpOutcome[] } {
  const now = context.now ?? Date.now();
  const pool = context.connectors ?? [];
  let next = skills;
  const outcomes: SkillOpOutcome[] = [];
  for (const op of ops) {
    if (op.op === "skill.create") {
      const resolved = op.connectors !== null ? resolveConnectors(op.connectors, pool) : null;
      const note = resolved ? unknownNote(resolved.unknown) : undefined;
      const existing = next.find((skill) => sameName(skill.name, op.name));
      if (existing) {
        next = next.map((skill) =>
          skill.id === existing.id
            ? {
                ...skill,
                name: op.name,
                description: op.description || skill.description,
                content: op.content,
                folder: op.folder || (skill.folder ?? ""),
                enabled: op.enabled,
                surfaces: op.surfaces ? surfaceRecord(op.surfaces) : skill.surfaces,
                ...(resolved
                  ? { mcpServerIds: resolved.ids.length > 0 ? resolved.ids : undefined }
                  : {}),
              }
            : skill,
        );
        outcomes.push({ kind: "updated", name: op.name, ...(note ? { note } : {}) });
        continue;
      }
      if (next.length >= MAX_SKILLS) {
        outcomes.push({
          kind: "rejected",
          name: op.name,
          reason: `Limit: ${MAX_SKILLS} skills — remove one on the Skills page first.`,
        });
        continue;
      }
      next = [
        {
          id: newId(),
          name: op.name,
          description: op.description,
          content: op.content,
          folder: op.folder,
          enabled: op.enabled,
          surfaces: op.surfaces
            ? surfaceRecord(op.surfaces)
            : { chat: true, research: true, julius: true },
          ...(resolved && resolved.ids.length > 0 ? { mcpServerIds: resolved.ids } : {}),
          createdAt: now,
        },
        ...next,
      ];
      outcomes.push({ kind: "created", name: op.name, ...(note ? { note } : {}) });
      continue;
    }
    const found =
      next.find((skill) => skill.id === op.target) ??
      next.find((skill) => sameName(skill.name, op.target));
    if (!found) {
      outcomes.push({
        kind: "rejected",
        name: op.target,
        reason: "No skill with this id or name — check the registry.",
      });
      continue;
    }
    const resolved =
      op.set.connectors !== undefined ? resolveConnectors(op.set.connectors, pool) : null;
    const note = resolved ? unknownNote(resolved.unknown) : undefined;
    next = next.map((skill) =>
      skill.id === found.id
        ? {
            ...skill,
            ...(op.set.name !== undefined ? { name: op.set.name } : {}),
            ...(op.set.description !== undefined ? { description: op.set.description } : {}),
            ...(op.set.content !== undefined ? { content: op.set.content } : {}),
            ...(op.set.folder !== undefined ? { folder: op.set.folder } : {}),
            ...(op.set.enabled !== undefined ? { enabled: op.set.enabled } : {}),
            ...(op.set.surfaces !== undefined ? { surfaces: surfaceRecord(op.set.surfaces) } : {}),
            ...(resolved
              ? { mcpServerIds: resolved.ids.length > 0 ? resolved.ids : undefined }
              : {}),
          }
        : skill,
    );
    outcomes.push({ kind: "updated", name: op.set.name ?? found.name, ...(note ? { note } : {}) });
  }
  return { skills: next, outcomes };
}

/** UUIDs and id_… fallbacks — chips hide these instead of showing raw ids. */
const ID_LIKE = /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F-]{27}|id_[a-z0-9_]+)$/;

/** Human-readable chip for one skill op, rendered inside the action artifact. */
export function describeSkillOp(op: SkillOp): OpChip {
  if (op.op === "skill.create") {
    return { kind: "create", label: `Skill: ${op.name}` };
  }
  const shown = op.set.name ?? (ID_LIKE.test(op.target) ? "" : op.target);
  return { kind: "done", label: shown ? `Skill updated: ${shown}` : "Skill updated" };
}

function surfacesLabel(skill: Skill): string {
  const on = SURFACE_KEYS.filter((key) => skill.surfaces[key]);
  return on.length === 0 ? "none" : on.join("+");
}

/** Registry label for a skill's bound connectors — names, with stale pins disclosed. */
function connectorsLabel(skill: Skill, pool: SkillConnectorRef[]): string {
  const pins = skill.mcpServerIds ?? [];
  if (pins.length === 0) {
    return "";
  }
  const names: string[] = [];
  let stale = 0;
  for (const id of pins) {
    const server = pool.find((entry) => entry.id === id);
    if (server) {
      names.push(server.name);
    } else {
      stale += 1;
    }
  }
  const shown = names.join(", ");
  if (stale > 0) {
    return `${shown ? `${shown}, ` : ""}${stale} removed`;
  }
  return shown;
}

/**
 * System-prompt block for interactive chat turns: the write protocol plus a
 * compact registry of every skill (id, state, description, content preview)
 * and the bindable connector pool. Full text of enabled chat skills already
 * rides in the SKILLS block, so the registry only previews content — with an
 * honest rewrite rule instead.
 */
export function buildSkillsEditorContext(
  skills: Skill[],
  connectors: SkillConnectorRef[] = [],
): string {
  const lines: string[] = [
    "SKILLS EDITOR — the user's Skills (reusable instruction packs that ride into chat, Deep Research, and Julius runs) are editable from this chat. When the user asks to save reusable instructions, a playbook, or a standing rule (\"always do X\"), or wants an existing skill changed — write it as ops. If the user keeps repeating the same instruction across turns, offer to save it as a skill.",
    "",
    'To create or edit skills, emit ONE ```action fence containing ONLY a JSON array of ops (skill ops may share the fence with hub ops), then continue the reply after the fence:',
    '[{"op":"skill.create","name":"Release notes","description":"Writing release notes for the app","content":"...full instructions in markdown...","folder":"Writing","surfaces":["chat","julius"],"connectors":["GitHub"]},',
    ' {"op":"skill.update","id":"<id from the registry below>","set":{"content":"...complete new text...","enabled":true}}]',
    "Skill rules:",
    '- description = one line saying WHEN the skill applies; content = the instructions themselves (markdown). Write instructions in English for precision unless the user asks otherwise; never put secrets or API keys into skills.',
    '- skill.update targets by "id" from the registry (or exact "name"); "set" carries only the fields to change: name, description, content, folder, enabled, surfaces (any of "chat"/"research"/"julius"), connectors.',
    '- "connectors" binds MCP connectors to the skill: whenever the skill rides a chat run, their tools are armed automatically. Use names or ids from the MCP CONNECTORS list below — nothing else resolves. In skill.update, "connectors" REPLACES the whole binding; [] clears it. Bind a connector when the skill depends on its tools (e.g. a PR-review skill binds GitHub).',
    "- Updating content REPLACES the old text entirely — always send the complete new text. The registry below only previews content; the full text of skills enabled for chat is in the SKILLS section. If you cannot see the full current text, ask before rewriting.",
    `- Limits: ${MAX_SKILLS} skills max; name ≤${MAX_SKILL_NAME_CHARS} chars, description ≤${MAX_SKILL_DESCRIPTION_CHARS}, content ≤${MAX_SKILL_CONTENT_CHARS}, folder ≤${MAX_SKILL_FOLDER_CHARS}, connectors ≤${MAX_SKILL_CONNECTORS}. Creating a name that already exists updates that skill instead.`,
    '- There is no delete op by design — deletion stays on the Skills page. To retire a skill, set {"enabled":false} and say so.',
    "- After the fence, confirm in one line what changed. Changes apply when this reply finishes and take effect from the NEXT message.",
    "",
  ];
  if (skills.length === 0) {
    lines.push("CURRENT SKILLS (0 of " + MAX_SKILLS + "): none yet — skill.create will add the first one.");
  } else {
    lines.push(`CURRENT SKILLS (${skills.length} of ${MAX_SKILLS}):`);
    let used = 0;
    let omitted = 0;
    for (const skill of skills) {
      const preview = skill.content.replace(/\s+/g, " ").trim();
      const clipped =
        preview.length > REGISTRY_PREVIEW_CHARS ? `${preview.slice(0, REGISTRY_PREVIEW_CHARS)}…` : preview;
      const bound = connectorsLabel(skill, connectors);
      const entry = [
        `- id: ${skill.id} | ${skill.name}${skill.folder?.trim() ? ` | folder: ${skill.folder.trim()}` : ""} | ${skill.enabled ? "enabled" : "DISABLED"} | surfaces: ${surfacesLabel(skill)}${bound ? ` | connectors: ${bound}` : ""}${skill.description.trim() ? ` | when: ${skill.description.trim()}` : ""}`,
        `  content (${skill.content.length} chars): ${clipped}`,
      ].join("\n");
      if (used + entry.length > REGISTRY_BUDGET_CHARS) {
        omitted += 1;
        continue;
      }
      lines.push(entry);
      used += entry.length;
    }
    if (omitted > 0) {
      lines.push(
        `…and ${omitted} more skill${omitted === 1 ? "" : "s"} not listed (registry budget) — ask the user or check the Skills page.`,
      );
    }
  }
  lines.push("");
  if (connectors.length === 0) {
    lines.push(
      "MCP CONNECTORS (bindable): none configured — the user adds them on the Connections page. Do not invent connector names.",
    );
  } else {
    lines.push("MCP CONNECTORS (bindable via \"connectors\"):");
    for (const server of connectors) {
      lines.push(
        `- id: ${server.id} | ${server.name} | ${server.enabled && server.status === "connected" ? "connected" : "NOT CONNECTED"}`,
      );
    }
  }
  return lines.join("\n");
}
