// Client SDK for server-side agent runs. The whole agent loop executes in
// the account's backend node; this module starts runs, attaches the tab to
// the live event stream (snapshot first, then deltas), steers and stops
// through the backend, and resolves cloud-stored media.
//
// Delivery is honest about transport: primary channel is a streamed SSE
// response; when the stream stalls or drops, the tab falls back to polling
// run snapshots and keeps reconnecting — the run itself never depends on
// this tab being alive.

import { authedFetch, parseOrThrow } from "@/lib/backend";
import { logDiagnostic } from "@/lib/diagnostics";
import type {
  Attachment,
  BuiltinToolId,
  ChatMessage,
  Conversation,
  JuliusSettings,
  JuliusState,
  McpServerConfig,
  ResearchDepth,
  ResearchState,
  ResearchSource,
  ToolCallRecord,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Wire types (mirror functions/run-protocol.ts).

export type ServerWireAttachment = {
  name: string;
  mime: string;
  dataUrl: string;
  text?: string;
};

export type ServerWireMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: ServerWireAttachment[];
  toolCalls?: Array<{ id: string; name: string; arguments: string; result?: string }>;
  julius?: { candidates: Array<{ modelId: string; content: string }> };
};

export type ServerRunKind = "chat" | "research" | "julius";

export type ServerSteerItem = {
  id: string;
  text: string;
  attachments: ServerWireAttachment[];
};

export type ServerRunConfig = {
  systemPrompt?: string;
  history: ServerWireMessage[];
  prompt: string;
  builtins: Record<BuiltinToolId, boolean>;
  mcpServers: McpServerConfig[];
  /** Thread-pinned owner/repo; server modes treat it as the structured default. */
  githubRepo?: string;
  grounding?: { block: string; sources: ResearchSource[] };
  steeringWrapNote?: string;
  resume?: { messageId: string; partial: string };
  research?: {
    depth: ResearchDepth;
    citations?: "numeric" | "links";
    githubAuth?: string;
    githubDisabledTools?: string[];
  };
  julius?: { settings: JuliusSettings; research?: boolean };
  ephemeral?: boolean;
};

export type StartServerRunRequest = {
  runId: string;
  conversationId: string;
  assistantMessageId: string;
  kind: ServerRunKind;
  title: string;
  modelId: string;
  agentId?: string;
  automationId?: string;
  chatSeed?: { payload: string; updatedAt: number };
  config: ServerRunConfig;
};

export type ServerRunStatus = "running" | "done" | "stopped" | "interrupted" | "error";

export type ServerRunFinalMessage = {
  id: string;
  content: string;
  toolCalls?: ToolCallRecord[];
  sources?: ResearchSource[];
  servedBy?: string;
  research?: ResearchState;
  julius?: JuliusState;
  images?: string[];
  videos?: string[];
  audioUrl?: string;
  interrupted?: boolean;
};

export type ServerRunDone = {
  status: Exclude<ServerRunStatus, "running">;
  message: ServerRunFinalMessage;
  usageEvents: Array<{ modelId: string; usage: unknown; service?: boolean }>;
  steered: ServerSteerItem[];
  chatUpdatedAt: number;
  error?: string;
};

export type ServerRunSnapshot = {
  runId: string;
  conversationId: string;
  kind: ServerRunKind;
  status: ServerRunStatus;
  startedAt: number;
  content: string;
  reasoningTail?: string;
  toolCalls?: ToolCallRecord[];
  sources?: ResearchSource[];
  research?: ResearchState;
  julius?: JuliusState;
  steered?: ServerSteerItem[];
};

export type ServerRunEvent =
  | { t: "snapshot"; seq: number; snapshot: ServerRunSnapshot }
  | { t: "text"; seq: number; content: string }
  | { t: "reasoning"; seq: number; tail: string }
  | { t: "tools"; seq: number; toolCalls: ToolCallRecord[] }
  | { t: "sources"; seq: number; sources: ResearchSource[] }
  | { t: "research"; seq: number; research: ResearchState }
  | { t: "julius"; seq: number; julius: JuliusState; sources?: ResearchSource[] }
  | { t: "steered"; seq: number; items: ServerSteerItem[] }
  | ({ t: "done"; seq: number } & ServerRunDone)
  | { t: "ping"; seq: number };

export type ActiveServerRun = {
  runId: string;
  conversationId: string;
  kind: ServerRunKind;
  status: ServerRunStatus;
  startedAt: number;
  title: string;
  assistantMessageId: string;
  snapshot: ServerRunSnapshot | null;
  result: ServerRunDone | null;
};

// ---------------------------------------------------------------------------
// Cloud media refs.

export const CLOUD_MEDIA_PREFIX = "gera-cloud:v1:";

export function parseCloudMediaRef(ref: string): { runId: string; index: number } | null {
  if (!ref.startsWith(CLOUD_MEDIA_PREFIX)) {
    return null;
  }
  const rest = ref.slice(CLOUD_MEDIA_PREFIX.length);
  const split = rest.lastIndexOf(":");
  if (split <= 0) {
    return null;
  }
  const rawIndex = rest.slice(split + 1);
  if (!/^\d+$/.test(rawIndex)) {
    return null;
  }
  return { runId: rest.slice(0, split), index: Number(rawIndex) };
}

// ---------------------------------------------------------------------------
// Live-connection status store (per conversation) for honest UI badges.

export type CloudRunPhase = "live" | "polling" | "reconnecting";

const phases = new Map<string, CloudRunPhase>();
const phaseListeners = new Set<() => void>();
/** Stable snapshot for useSyncExternalStore — rebuilt only on change. */
let phasesVersion = 0;

function setPhase(conversationId: string, phase: CloudRunPhase | null): void {
  const current = phases.get(conversationId) ?? null;
  if (current === phase) {
    return;
  }
  if (phase === null) {
    phases.delete(conversationId);
  } else {
    phases.set(conversationId, phase);
  }
  phasesVersion += 1;
  for (const listener of phaseListeners) {
    listener();
  }
}

export function subscribeCloudRuns(listener: () => void): () => void {
  phaseListeners.add(listener);
  return () => {
    phaseListeners.delete(listener);
  };
}

export function cloudRunsVersion(): number {
  return phasesVersion;
}

export function cloudRunPhase(conversationId: string | null): CloudRunPhase | null {
  return conversationId ? phases.get(conversationId) ?? null : null;
}

export function hasActiveCloudRun(conversationId: string | null): boolean {
  return conversationId !== null && phases.has(conversationId);
}

// ---------------------------------------------------------------------------
// REST calls.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function abortError(): DOMException {
  return new DOMException("Stopped.", "AbortError");
}

export async function startServerRun(
  body: StartServerRunRequest,
): Promise<{ ok: boolean; runId: string; historyOnServer: boolean }> {
  // A just-stopped previous run may still be finalizing — retry run_active briefly.
  for (let attempt = 0; ; attempt += 1) {
    const response = await authedFetch("/runs/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status === 409 && attempt < 4) {
      await sleep(900);
      continue;
    }
    if (response.status === 409) {
      throw new Error("Another reply is still running in this chat — stop it or wait for it to finish.");
    }
    return parseOrThrow(response, "Could not start the run on the server");
  }
}

export async function steerServerRun(
  conversationId: string,
  item: ServerSteerItem,
): Promise<{ accepted: boolean; reason?: string }> {
  const response = await authedFetch("/runs/steer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, item }),
  });
  return parseOrThrow(response, "Could not steer the run");
}

export async function retractServerSteer(conversationId: string, itemId: string): Promise<void> {
  try {
    await authedFetch("/runs/retract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, itemId }),
    });
  } catch {
    // Best effort — if it was already consumed, the steered event shows it.
  }
}

export async function stopServerRun(conversationId: string): Promise<{ ok: boolean; reason?: string }> {
  const response = await authedFetch("/runs/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId }),
  });
  return parseOrThrow(response, "Could not stop the run");
}

export async function ackServerRun(runId: string): Promise<void> {
  try {
    await authedFetch("/runs/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    });
  } catch {
    // Best effort — unacked results expire on their own.
  }
}

export async function listActiveServerRuns(): Promise<ActiveServerRun[]> {
  const response = await authedFetch("/runs/active");
  const data = await parseOrThrow<{ runs?: ActiveServerRun[] }>(response, "Could not list runs");
  return Array.isArray(data.runs) ? data.runs : [];
}

export async function fetchRunMedia(runId: string, index: number): Promise<{ kind: string; dataUrl: string }> {
  const response = await authedFetch(
    `/runs/media?runId=${encodeURIComponent(runId)}&idx=${index}`,
  );
  return parseOrThrow(response, "Could not load run media");
}

/** Resolves gera-cloud refs to data URLs; other values pass through untouched. */
export async function resolveCloudMediaRefs(
  refs: string[],
): Promise<{ resolved: string[]; failed: number }> {
  const settled = await Promise.all(
    refs.map(async (ref) => {
      const parsed = parseCloudMediaRef(ref);
      if (!parsed) {
        return ref;
      }
      try {
        const media = await fetchRunMedia(parsed.runId, parsed.index);
        return media.dataUrl;
      } catch (error) {
        logDiagnostic("chat", `cloud media unavailable · ${ref.slice(0, 60)}`, error instanceof Error ? error.message : "");
        return null;
      }
    }),
  );
  const resolved = settled.filter((item): item is string => item !== null);
  return { resolved, failed: refs.length - resolved.length };
}

/** Pulled chats may carry cloud media refs — resolve them before vaulting. */
export async function resolveCloudMediaInConversation(conversation: Conversation): Promise<Conversation> {
  const needs = conversation.messages.some(
    (message) =>
      (message.images ?? []).some((ref) => ref.startsWith(CLOUD_MEDIA_PREFIX)) ||
      (message.videos ?? []).some((ref) => ref.startsWith(CLOUD_MEDIA_PREFIX)) ||
      (message.audioUrl?.startsWith(CLOUD_MEDIA_PREFIX) ?? false),
  );
  if (!needs) {
    return conversation;
  }
  const messages = await Promise.all(
    conversation.messages.map(async (message): Promise<ChatMessage> => {
      const images = message.images ? (await resolveCloudMediaRefs(message.images)).resolved : undefined;
      const videos = message.videos ? (await resolveCloudMediaRefs(message.videos)).resolved : undefined;
      let audioUrl = message.audioUrl;
      if (audioUrl?.startsWith(CLOUD_MEDIA_PREFIX)) {
        const { resolved } = await resolveCloudMediaRefs([audioUrl]);
        audioUrl = resolved[0];
      }
      return {
        ...message,
        images: images && images.length > 0 ? images : images ? undefined : message.images,
        videos: videos && videos.length > 0 ? videos : videos ? undefined : message.videos,
        audioUrl,
      };
    }),
  );
  return { ...conversation, messages };
}

// ---------------------------------------------------------------------------
// Attach: SSE stream with stall detection + polling fallback + reconnect.

/** No bytes (pings run every 15s) for this long means the stream is dead. */
const STREAM_STALL_MS = 32_000;
const POLL_INTERVAL_MS = 1_800;
const POLL_CYCLES_PER_ROUND = 4;

type PollState =
  | { kind: "missing" }
  | { kind: "finished"; done: ServerRunDone }
  | { kind: "running"; snapshot: ServerRunSnapshot | null };

function doneFromActive(run: ActiveServerRun): ServerRunDone | null {
  if (run.status === "running" || !run.result) {
    return null;
  }
  return run.result;
}

async function pollRunState(conversationId: string): Promise<PollState> {
  const runs = await listActiveServerRuns();
  const run = runs.find((item) => item.conversationId === conversationId);
  if (!run) {
    return { kind: "missing" };
  }
  const done = doneFromActive(run);
  if (done) {
    return { kind: "finished", done };
  }
  return { kind: "running", snapshot: run.snapshot };
}

/**
 * Reads one SSE stream until a terminal event. Returns the done payload,
 * or null when the stream ended/stalled without one (caller retries).
 */
async function streamRunOnce(params: {
  conversationId: string;
  onEvent: (event: ServerRunEvent) => void;
  signal?: AbortSignal;
}): Promise<ServerRunDone | null> {
  const response = await authedFetch(
    `/runs/stream?conversationId=${encodeURIComponent(params.conversationId)}`,
    { signal: params.signal },
  );
  if (response.status === 404) {
    const state = await pollRunState(params.conversationId);
    if (state.kind === "missing") {
      throw new Error("The run is no longer on the server.");
    }
    if (state.kind === "finished") {
      return state.done;
    }
    return null;
  }
  if (!response.ok || !response.body) {
    throw new Error(`Run stream failed (${response.status}).`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (params.signal?.aborted) {
        throw abortError();
      }
      const step = await Promise.race([
        reader.read().then((result) => ({ kind: "read" as const, result })),
        sleep(STREAM_STALL_MS).then(() => ({ kind: "stall" as const })),
      ]);
      if (step.kind === "stall") {
        return null; // dead stream — the caller falls back to polling
      }
      const { done, value } = step.result;
      if (done) {
        return null; // ended without a terminal event — reconnect
      }
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) {
            continue;
          }
          const data = line.slice(5).trim();
          if (!data) {
            continue;
          }
          let event: ServerRunEvent;
          try {
            event = JSON.parse(data) as ServerRunEvent;
          } catch {
            continue;
          }
          if (event.t === "ping") {
            continue;
          }
          if (event.t === "done") {
            return {
              status: event.status,
              message: event.message,
              usageEvents: event.usageEvents ?? [],
              steered: event.steered ?? [],
              chatUpdatedAt: event.chatUpdatedAt ?? 0,
              ...(event.error ? { error: event.error } : {}),
            };
          }
          params.onEvent(event);
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Attaches this tab to a live server run and resolves with the terminal
 * payload. Survives stream drops: falls back to snapshot polling, keeps
 * reconnecting while the run is alive, and never invents progress — every
 * shown byte came from the server. Abort (signal) detaches the TAB only;
 * the run keeps executing on the server.
 */
export async function attachServerRun(params: {
  conversationId: string;
  onEvent: (event: ServerRunEvent) => void;
  signal?: AbortSignal;
}): Promise<ServerRunDone> {
  const id = params.conversationId;
  try {
    while (true) {
      if (params.signal?.aborted) {
        throw abortError();
      }
      try {
        setPhase(id, "live");
        const done = await streamRunOnce(params);
        if (done) {
          return done;
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw error;
        }
        if (error instanceof Error && error.message === "The run is no longer on the server.") {
          throw error;
        }
        // network blip — fall through to polling
      }
      setPhase(id, "polling");
      let networkDown = false;
      for (let cycle = 0; cycle < POLL_CYCLES_PER_ROUND; cycle += 1) {
        if (params.signal?.aborted) {
          throw abortError();
        }
        let state: PollState | null = null;
        try {
          state = await pollRunState(id);
          networkDown = false;
        } catch {
          networkDown = true;
        }
        if (state) {
          if (state.kind === "missing") {
            throw new Error("The run is no longer on the server.");
          }
          if (state.kind === "finished") {
            return state.done;
          }
          if (state.snapshot) {
            params.onEvent({ t: "snapshot", seq: 0, snapshot: state.snapshot });
          }
        } else {
          setPhase(id, "reconnecting");
        }
        await sleep(networkDown ? 4_000 : POLL_INTERVAL_MS);
      }
    }
  } finally {
    setPhase(id, null);
  }
}

// ---------------------------------------------------------------------------
// Wire builders (used by the agent store).

export function toWireAttachment(attachment: Attachment): ServerWireAttachment {
  return {
    name: attachment.name,
    mime: attachment.mime,
    dataUrl: attachment.dataUrl,
    ...(attachment.text ? { text: attachment.text } : {}),
  };
}

/** Sanitizes resolved thread messages into the run's wire history. */
export function toWireMessages(messages: ChatMessage[]): ServerWireMessage[] {
  return messages.map((message): ServerWireMessage => {
    const wire: ServerWireMessage = { role: message.role, content: message.content };
    if (message.attachments && message.attachments.length > 0) {
      wire.attachments = message.attachments.map(toWireAttachment);
    }
    if (message.toolCalls && message.toolCalls.length > 0) {
      wire.toolCalls = message.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
        ...(call.result !== undefined ? { result: call.result } : {}),
      }));
    }
    if (message.julius && !message.content) {
      wire.julius = {
        candidates: message.julius.candidates.map((candidate) => ({
          modelId: candidate.modelId,
          content: candidate.content,
        })),
      };
    }
    return wire;
  });
}
