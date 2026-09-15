// Run recovery — the pure half of "a server run survives its node".
//
// A Durable Object is evicted after 70–140 s without incoming traffic (a
// pending waitUntil or a plain fetch() does not keep it alive) and every
// backend deploy kills it outright. Before this module a run that died that
// way was finalised as "interrupted" with whatever the 1.5 s heartbeat had
// snapshotted — for deep research that meant 200+ sources gathered and no
// report. Now the manager persists the START BODY (minus credentials) and,
// for research, a CHECKPOINT after every wave; when the node comes back
// (keepalive alarm or the next request) it resumes the run from those.
//
// Platform-neutral on purpose: no Durable Object APIs here, so the web unit
// tests drive it directly.

import type { GitHubRepoMeta } from "./native-github";
import type {
  ResearchStep,
  RunSnapshot,
  RunSteerItem,
  RunToolRecord,
  StartRunBody,
  StartRunConfig,
  WireMcpServer,
  WireMessage,
  WireToolCall,
} from "./run-protocol";

/** Stored seed rows must stay well under the 2 MB SQLite value limit. */
export const SEED_PAYLOAD_LIMIT = 1_500_000;
/** Same bound for research checkpoints (page texts are water-filled to fit). */
export const CHECKPOINT_PAYLOAD_LIMIT = 1_200_000;
/** A run that keeps dying is finalised honestly after this many restarts. */
export const MAX_RUN_RESTARTS = 4;
/** Longest a tool result replayed into a resumed context may be. */
const RESUME_TOOL_RESULT_CHARS = 4_000;
/** Inline media larger than this is dropped from a stored seed before the size cap bites. */
const INLINE_MEDIA_KEEP_CHARS = 20_000;

/**
 * Rides along when the NODE running a reply restarted mid-generation. The
 * kept text stays on screen; the model repeats a few words so the seam can
 * be spliced (joinResumedText), then keeps writing.
 */
export const SERVER_RESUME_NOTE =
  "[continuation] The server node running your reply above restarted mid-generation — the reply is NOT finished, and the user sees it exactly as written. The tool results above are what those calls returned before the restart. What you write now is appended directly after the reply as one continuous text. First repeat, verbatim, the last few words before the cut (a handful of words, at most one short line — the app splices the overlap automatically), then keep writing from exactly that point. Do not restart, summarize, apologize, or mention the interruption. If the cut fell inside a code block, the fence is still open: keep writing the code without opening a new fence and close it when the code ends. A tool call that was still running when the node restarted did NOT complete — issue it again in full if you still need it.";

/** Result stamped on a tool call the restart caught mid-flight. */
export const RESTART_TOOL_RESULT =
  "The server restarted while this call was running — it did not complete. Call it again if the result is still needed.";

/** Credential-bearing fields a shipped connector config may carry; never persisted. */
const CREDENTIAL_FIELDS = ["token", "headersJson", "accessToken", "refreshToken", "clientSecret", "authorization"];

function stripServerCredentials(server: WireMcpServer): WireMcpServer {
  const out: WireMcpServer = {};
  for (const [key, value] of Object.entries(server)) {
    if (!CREDENTIAL_FIELDS.includes(key)) {
      out[key] = value;
    }
  }
  return out;
}

function stripInlineMedia(message: WireMessage): WireMessage {
  if (!message.attachments || message.attachments.length === 0) {
    return message;
  }
  return {
    ...message,
    attachments: message.attachments.map((attachment) =>
      attachment.dataUrl.length > INLINE_MEDIA_KEEP_CHARS ? { ...attachment, dataUrl: "" } : attachment,
    ),
  };
}

/**
 * The start body as it may be stored: no chat seed (already applied to the
 * chat table), no connector credentials (the run re-reads them from the
 * durable profile anyway), no client GitHub authorization. Incognito runs
 * return null — their history must leave nothing behind on the server.
 * Oversized bodies lose inline media, then the grounding block; a body that
 * still does not fit is not stored (the run then finalises as interrupted).
 */
export function seedForStorage(body: StartRunBody, limit = SEED_PAYLOAD_LIMIT): string | null {
  if (body.config.ephemeral === true) {
    return null;
  }
  const { chatSeed: _chatSeed, ...rest } = body;
  const config: StartRunConfig = {
    ...rest.config,
    mcpServers: (rest.config.mcpServers ?? []).map(stripServerCredentials),
  };
  if (config.research) {
    const { githubAuth: _githubAuth, ...research } = config.research;
    config.research = research;
  }
  let seed: StartRunBody = { ...rest, config };
  let json = JSON.stringify(seed);
  if (json.length > limit) {
    seed = { ...seed, config: { ...seed.config, history: seed.config.history.map(stripInlineMedia) } };
    json = JSON.stringify(seed);
  }
  if (json.length > limit && seed.config.grounding) {
    const { grounding: _grounding, ...withoutGrounding } = seed.config;
    seed = { ...seed, config: withoutGrounding };
    json = JSON.stringify(seed);
  }
  return json.length > limit ? null : json;
}

/** Parses a stored seed; null for anything that is not a start body. */
export function parseStoredSeed(raw: string): StartRunBody | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as StartRunBody;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.runId !== "string" ||
      typeof parsed.conversationId !== "string" ||
      typeof parsed.assistantMessageId !== "string" ||
      !parsed.config ||
      !Array.isArray(parsed.config.history)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Tool records as the recovered run shows them: everything that settled stays
 * as-is, a call the restart caught running is marked failed with the reason.
 */
export function recoveredToolCalls(records: RunToolRecord[] | undefined): RunToolRecord[] {
  return (records ?? []).map((record) =>
    record.status === "running" ? { ...record, status: "error", result: RESTART_TOOL_RESULT } : record,
  );
}

function wireCalls(records: RunToolRecord[] | undefined): WireToolCall[] {
  return recoveredToolCalls(records).map((record) => ({
    id: record.id,
    name: record.name,
    arguments: record.arguments,
    result: (record.result ?? "").slice(0, RESUME_TOOL_RESULT_CHARS),
  }));
}

/** A client- or server-issued resume already appended an assistant/note pair — drop it before appending a fresher one. */
function stripTrailingResumePair(history: WireMessage[]): WireMessage[] {
  const last = history[history.length - 1];
  const beforeLast = history[history.length - 2];
  if (
    last &&
    beforeLast &&
    last.role === "user" &&
    beforeLast.role === "assistant" &&
    (last.content.startsWith("[recovery note]") || last.content.startsWith("[continuation]"))
  ) {
    return history.slice(0, -2);
  }
  return history;
}

function steeredAsHistory(items: RunSteerItem[]): WireMessage[] {
  return items.map((item) => ({
    role: "user" as const,
    content: item.text,
    ...(item.attachments.length > 0 ? { attachments: item.attachments } : {}),
  }));
}

/**
 * The start body a dead CHAT run is re-executed with. Whatever the run had
 * produced — steering consumed, tool calls made, text streamed — rides into
 * the context as its own history, followed by SERVER_RESUME_NOTE; the shown
 * text becomes the resume base so the continuation is stitched in place. A
 * run that had produced nothing simply restarts from its original body.
 */
export function resumeChatBody(seed: StartRunBody, snapshot: RunSnapshot | null, assistantMessageId: string): StartRunBody {
  const partial = (snapshot?.content ?? "").trimEnd();
  const calls = wireCalls(snapshot?.toolCalls);
  const steered = snapshot?.steered ?? [];
  if (!partial && calls.length === 0 && steered.length === 0) {
    return seed;
  }
  let history = seed.config.resume ? stripTrailingResumePair(seed.config.history) : [...seed.config.history];
  history = [...history, ...steeredAsHistory(steered)];
  if (partial || calls.length > 0) {
    history.push({ role: "assistant", content: partial, ...(calls.length > 0 ? { toolCalls: calls } : {}) });
    history.push({ role: "user", content: SERVER_RESUME_NOTE });
  }
  return {
    ...seed,
    config: {
      ...seed.config,
      history,
      ...(partial ? { resume: { messageId: assistantMessageId, partial } } : {}),
    },
  };
}

export type RecoveryDecision =
  | { action: "resume"; body: StartRunBody }
  | { action: "finalize"; reason: string };

/**
 * Whether a running row whose node died can be resumed, and with which body.
 * Every refusal names its reason — it lands in the interrupted bubble.
 */
export function decideRecovery(input: {
  kind: string;
  ephemeral: boolean;
  seed: StartRunBody | null;
  restarts: number;
  snapshot: RunSnapshot | null;
  startedAt: number;
  now: number;
  budgetMs: number;
  assistantMessageId: string;
  stopRequested?: boolean;
}): RecoveryDecision {
  if (input.stopRequested) {
    return { action: "finalize", reason: "it was stopped" };
  }
  if (input.ephemeral) {
    return { action: "finalize", reason: "incognito runs leave nothing on the server to resume from" };
  }
  if (input.kind === "julius") {
    return { action: "finalize", reason: "a Julius panel cannot be resumed mid-run" };
  }
  if (!input.seed) {
    return { action: "finalize", reason: "its request was not kept for recovery" };
  }
  if (input.restarts >= MAX_RUN_RESTARTS) {
    return { action: "finalize", reason: `it was already restarted ${input.restarts} times` };
  }
  if (input.now >= input.startedAt + input.budgetMs) {
    return { action: "finalize", reason: "its time budget ran out" };
  }
  const body = input.kind === "chat" ? resumeChatBody(input.seed, input.snapshot, input.assistantMessageId) : input.seed;
  return { action: "resume", body };
}

/** Honest bubble text for a run that died and could not be brought back. */
export function staleRunError(reason: string): string {
  return `The server node running this reply restarted and the run could not be resumed (${reason}) — the collected draft is shown as-is.`;
}

// ---------------------------------------------------------------------------
// Research checkpoints

export type ResearchCheckpointSource = {
  index: number;
  url: string;
  title: string;
  published?: string;
  highlights: string[];
  text?: string;
  liveAt?: string;
};

/**
 * Everything the research loop needs to continue where it stopped: the
 * dossier (sources with page texts), the queries spent and planned, the
 * reflector's notes, read/browse counters, the repo metadata and the trail.
 * `wave` counts completed waves — 0 means only the preparatory steps ran.
 */
export type ResearchCheckpoint = {
  version: 1;
  wave: number;
  /** Queries planned for the next wave; empty → the loop is over and the report is next. */
  queries: string[];
  usedQueries: string[];
  notes: string[];
  readsTotal: number;
  browsesTotal: number;
  browsedUrls: string[];
  readRepoPicks: string[];
  repos: GitHubRepoMeta[];
  sources: ResearchCheckpointSource[];
  steps: ResearchStep[];
  startedAt: number;
};

/** Water-fills page texts so the serialised checkpoint fits the row limit; metadata is never dropped. */
export function trimResearchCheckpoint(checkpoint: ResearchCheckpoint, limit = CHECKPOINT_PAYLOAD_LIMIT): ResearchCheckpoint {
  const json = JSON.stringify(checkpoint);
  if (json.length <= limit) {
    return checkpoint;
  }
  const totalText = checkpoint.sources.reduce((sum, source) => sum + (source.text?.length ?? 0), 0);
  const overhead = json.length - totalText;
  // JSON escaping inflates texts a little; keep a margin so one pass suffices.
  const budget = Math.max(0, Math.floor((limit - overhead) * 0.9));
  const withText = checkpoint.sources
    .filter((source) => (source.text?.length ?? 0) > 0)
    .sort((a, b) => (a.text?.length ?? 0) - (b.text?.length ?? 0));
  const allocation = new Map<number, number>();
  let remaining = budget;
  let left = withText.length;
  for (const source of withText) {
    const take = Math.min(source.text?.length ?? 0, Math.floor(remaining / left));
    allocation.set(source.index, take);
    remaining -= take;
    left -= 1;
  }
  return {
    ...checkpoint,
    sources: checkpoint.sources.map((source) => {
      if (!source.text) {
        return source;
      }
      const take = allocation.get(source.index) ?? 0;
      const { text: _text, ...rest } = source;
      return take > 0 ? { ...rest, text: source.text.slice(0, take) } : rest;
    }),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Parses a stored checkpoint; null for anything malformed (the run then restarts its research). */
export function parseResearchCheckpoint(raw: string): ResearchCheckpoint | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ResearchCheckpoint>;
    if (
      !parsed ||
      parsed.version !== 1 ||
      typeof parsed.wave !== "number" ||
      !isStringArray(parsed.queries) ||
      !isStringArray(parsed.usedQueries) ||
      !isStringArray(parsed.notes) ||
      typeof parsed.readsTotal !== "number" ||
      typeof parsed.browsesTotal !== "number" ||
      !isStringArray(parsed.browsedUrls) ||
      !isStringArray(parsed.readRepoPicks) ||
      !Array.isArray(parsed.repos) ||
      !Array.isArray(parsed.sources) ||
      !Array.isArray(parsed.steps) ||
      typeof parsed.startedAt !== "number"
    ) {
      return null;
    }
    const sources = parsed.sources.filter(
      (source): source is ResearchCheckpointSource =>
        Boolean(source) &&
        typeof source === "object" &&
        typeof (source as ResearchCheckpointSource).index === "number" &&
        typeof (source as ResearchCheckpointSource).url === "string" &&
        typeof (source as ResearchCheckpointSource).title === "string" &&
        isStringArray((source as ResearchCheckpointSource).highlights),
    );
    return { ...(parsed as ResearchCheckpoint), sources };
  } catch {
    return null;
  }
}
