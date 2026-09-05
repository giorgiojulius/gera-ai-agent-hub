// Row shapes and row → wire mappers shared by the ProjectStore shard
// (project-store.ts) and its desk routes (desk-routes.ts). Pure: no storage,
// no secrets — the sealed `agents.secrets` blob is opened only in the shard.

import { isRecord } from "./chat-shared";
import {
  isScreenWidgetKind,
  type ProjectScreenWire,
  type ScreenChatMessageWire,
  type ScreenWidgetWire,
} from "./project-shared";
import { type ExecutionOutcome, normalizeExecutionOutcome } from "./run-protocol";

export type MemberRow = { email: string; role: string; display_name: string; added_at: number };
export type AgentRow = {
  id: string;
  name: string;
  handle: string;
  emoji: string;
  instructions: string;
  model: string;
  access: string;
  secrets: string;
  created_at: number;
  updated_at: number;
};
export type ScreenRow = {
  id: string;
  name: string;
  emoji: string;
  widgets: string;
  created_at: number;
  updated_at: number;
};
export type ScreenChatRow = {
  id: string;
  screen_id: string;
  widget_id: string;
  email: string;
  author_kind: string;
  author_name: string;
  body: string;
  pending: number;
  outcome: string;
  created_at: number;
  updated_at: number;
};
export type ScreenJobRow = {
  id: string;
  agent_id: string;
  screen_id: string;
  widget_id: string;
  email: string;
  placeholder_id: string;
  conversation_id: string;
  status: string;
  /** 'chat' = regular assistant turn; 'research' = an "Ask Gera" run. */
  kind: string;
};

export function newId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function parseWidgets(raw: string): ScreenWidgetWire[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: ScreenWidgetWire[] = [];
    for (const item of parsed) {
      if (!isRecord(item) || typeof item.id !== "string" || !isScreenWidgetKind(item.kind)) {
        continue;
      }
      out.push({
        id: item.id,
        kind: item.kind,
        agentId: typeof item.agentId === "string" ? item.agentId : null,
        channelId: typeof item.channelId === "string" ? item.channelId : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function screenWire(row: ScreenRow): ProjectScreenWire {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    widgets: parseWidgets(row.widgets),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function storedExecutionOutcome(value: string): ExecutionOutcome | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return normalizeExecutionOutcome(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

export function screenChatWire(row: ScreenChatRow): ScreenChatMessageWire {
  const execution = storedExecutionOutcome(row.outcome);
  return {
    id: row.id,
    kind: row.author_kind === "agent" ? "agent" : "user",
    authorName: row.author_name,
    body: row.body,
    pending: row.pending === 1,
    ...(execution ? { execution } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
