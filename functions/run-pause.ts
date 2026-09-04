// Run pause board — the ONE mechanism an interactive server run uses to stop
// and ask the user something mid-tool-call: MCP elicitation (a form the
// server requested) and tool confirmations (a write / destructive tool the
// policy wants approved). The board holds the open requests, resolves them
// when `/runs/answer` arrives, and cancels them honestly on timeout, stop, or
// run end. Elicitation answers are validated against the request's field
// list before they resolve; submitted values never reach a log or a journal
// entry. Confirmation cards carry a redacted argument preview, never the
// arguments themselves.

import {
  validateElicitationContent,
  type McpElicitationAction,
  type McpElicitationField,
} from "./mcp-protocol";

export type RunPauseKind = "elicitation" | "confirmation";

/** What a confirmation card shows about the call it guards (no argument values beyond the redacted preview). */
export type RunPauseConfirmation = {
  toolName: string;
  risk: "write" | "destructive";
  /** Redacted, capped JSON preview of the arguments. */
  argumentsPreview: string;
};

/** One open question shown as a card in the thread (wire shape, no secrets). */
export type RunPauseRequest = {
  id: string;
  kind: RunPauseKind;
  serverId: string;
  serverName: string;
  /** Elicitation: the server's question. Confirmation: what the tool does. */
  message: string;
  fields: McpElicitationField[];
  createdAt: number;
  /** Epoch ms after which Gera answers `cancel` on the user's behalf. */
  expiresAt: number;
  /** Present on confirmation cards only. */
  confirm?: RunPauseConfirmation;
};

export type RunPauseAction = McpElicitationAction | "always";

/**
 * Elicitation: accept (with validated content), decline, cancel.
 * Confirmation: accept (run once), always (run and stop asking for this tool
 * in this chat), decline, cancel.
 */
export type RunPauseAnswer = { action: RunPauseAction; content?: Record<string, unknown> };

export type RunPauseAnswerOutcome =
  | { ok: true }
  | { ok: false; error: "not_found" | "invalid_answer" | "invalid_action"; errors?: string[] };

export type RunPauseBoard = {
  /** Open requests, oldest first. */
  pending(): RunPauseRequest[];
  /** Registers a question and waits for its answer (or the timeout → cancel). */
  request(
    input: Omit<RunPauseRequest, "id" | "createdAt" | "expiresAt">,
    timeoutMs: number,
  ): Promise<RunPauseAnswer>;
  /** Resolves one question with the user's answer after validating it. */
  answer(id: string, answer: unknown): RunPauseAnswerOutcome;
  /** Cancels every open question (stop, run end). */
  cancelAll(): void;
  /** Fires whenever the pending list changes. */
  subscribe(listener: () => void): () => void;
};

type OpenPause = {
  request: RunPauseRequest;
  resolve: (answer: RunPauseAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
};

const ELICITATION_ACTIONS: readonly RunPauseAction[] = ["accept", "decline", "cancel"];
const CONFIRMATION_ACTIONS: readonly RunPauseAction[] = ["accept", "always", "decline", "cancel"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createRunPauseBoard(options: { now?: () => number; newId?: () => string } = {}): RunPauseBoard {
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => `pause_${Math.random().toString(36).slice(2, 10)}${now().toString(36)}`);
  const open = new Map<string, OpenPause>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // a listener fault never breaks the run
      }
    }
  };
  const settle = (id: string, answer: RunPauseAnswer): boolean => {
    const entry = open.get(id);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timer);
    open.delete(id);
    entry.resolve(answer);
    notify();
    return true;
  };
  return {
    pending: () => [...open.values()].map((entry) => entry.request).sort((a, b) => a.createdAt - b.createdAt),
    request(input, timeoutMs) {
      const createdAt = now();
      const request: RunPauseRequest = {
        ...input,
        id: newId(),
        createdAt,
        expiresAt: createdAt + Math.max(1_000, timeoutMs),
      };
      return new Promise<RunPauseAnswer>((resolve) => {
        const timer = setTimeout(() => settle(request.id, { action: "cancel" }), Math.max(1_000, timeoutMs));
        open.set(request.id, { request, resolve, timer });
        notify();
      });
    },
    answer(id, raw) {
      const entry = open.get(id);
      if (!entry) {
        return { ok: false, error: "not_found" };
      }
      const action = isRecord(raw) && typeof raw.action === "string" ? raw.action : "";
      const allowed = entry.request.kind === "confirmation" ? CONFIRMATION_ACTIONS : ELICITATION_ACTIONS;
      if (!allowed.includes(action as RunPauseAction)) {
        return { ok: false, error: "invalid_action" };
      }
      if (entry.request.kind === "confirmation" || action !== "accept") {
        settle(id, { action: action as RunPauseAction });
        return { ok: true };
      }
      const valid = validateElicitationContent(
        { message: entry.request.message, mode: "form", fields: entry.request.fields },
        isRecord(raw) ? raw.content : {},
      );
      if (valid.ok === false) {
        return { ok: false, error: "invalid_answer", errors: valid.errors };
      }
      settle(id, { action: "accept", content: valid.content });
      return { ok: true };
    },
    cancelAll() {
      for (const id of [...open.keys()]) {
        settle(id, { action: "cancel" });
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
