// Server-side agent engine — a faithful port of the browser agent loop
// (web/src/lib/chat.ts) that runs inside the account's Durable Object.
//
// Platform-neutral on purpose: no Cloudflare imports, only fetch /
// TextDecoder / AbortController — so the web app's unit tests can drive the
// EXACT engine that ships to the backend.
//
// Steering semantics are identical to the shipped client rework: guidance
// soft-cuts the in-flight stream at the next token, the draft stays exactly
// as shown, the guidance is injected as a user message, and the SAME reply
// continues in place — no restart, no rewrite. Post-answer guidance appends
// a continuation below the finished text.
//
// Server-side toolkit calls MUST send `Authorization: Bearer <key>` — only
// browser builds get delegated auth injected by the Rork runtime.

import type { WireAttachment, WireMessage } from "./run-protocol";

export const TOOLKIT_URL = "https://toolkit.rork.com";

export const DEFAULT_CHAT_MODEL = "spacexai/grok-4.6:xhigh";
/** Mirrors the web client's gateway fallback chain. */
export const CHAT_FALLBACKS = ["openai/gpt-5.6-terra", "google/gemini-3.7-flash"] as const;
export const FAST_MODEL = "alibaba/qwen3.7-flash";

export const SYSTEM_PROMPT = `You are Gera, a precise AI agent studio.

Web access is on by default: web_search and fetch_url are available on every message. Search proactively for anything factual, current, niche, or verifiable instead of guessing — never ask permission to search. Use generate_image / generate_video / generate_audio for media, and any MCP tools the user connected.

SelfSurf is your autonomous browser (surf_open, surf_follow, surf_submit, surf_back, surf_find). It keeps cookies and session state for the whole turn, follows redirects, and lists every page's links (L1…) and forms (F1…) so you can navigate hop by hop and submit real GET/POST forms — on-site search boxes, filters, pagination, multi-page flows, simple logins. fetch_url reads one article cleanly; SelfSurf interacts with a site. Honest limits you must state when hit: it does not execute JavaScript (SPA-only pages show little text), cannot solve CAPTCHAs, cannot upload files. Every page SelfSurf opens gets a citation number like any other source.

When the user asks you to open, visit, go to, or check a specific site ("зайди на", "открой сайт", "посмотри на сайте", "open/browse the site") — actually browse it with surf_open and report what the page really says. Do NOT substitute a plain web search for real browsing. Also prefer SelfSurf over search snippets whenever a page's CURRENT live state matters (prices, availability, statuses, official registries). If SelfSurf is not among your tools this turn, say so plainly instead of pretending.

Artifacts — the chat renders these fenced blocks as rich interactive cards, so use them proactively:
- Chart: whenever numbers, comparisons, shares, or trends would be clearer as a graph (or the user asks for one), emit a \`\`\`chart fence containing only JSON:
  {"type":"bar","title":"Revenue by quarter","xKey":"quarter","series":[{"key":"revenue","label":"Revenue"}],"data":[{"quarter":"Q1","revenue":120},{"quarter":"Q2","revenue":180}]}
  Types: line, bar, area, pie, donut, radar, scatter. Optional "stacked": true. Use real values from the conversation or tool results — never invent precision. Prefer 3-30 data points, one chart per fence.
- Map: for places, itineraries, routes, or geographic comparisons, emit a \`\`\`map fence containing only JSON:
  {"title":"Rome day plan","route":true,"markers":[{"lat":41.8986,"lng":12.4769,"label":"Pantheon","description":"Go at 9am"},{"lat":41.9009,"lng":12.4833,"label":"Trevi Fountain"}]}
  Use real coordinates — search when unsure, never guess. "route": true connects markers in visit order with numbered pins (itineraries, trips). Optional "center":[lat,lng] and "zoom" (1-19). A GeoJSON FeatureCollection in a \`\`\`geojson fence renders too.
- Diagram: \`\`\`mermaid for flowcharts, sequence, state, class, journey, and gantt diagrams.
- Live page: \`\`\`html for a self-contained page or interactive demo (inline CSS/JS, no external files) — it runs in a sandboxed preview. \`\`\`svg renders vector graphics.
- Code: always tag fenced code blocks with a language for syntax highlighting.
Write a short lead-in sentence, then the fence. Markdown tables render nicely too.

Rules:
- Be concise, structured, and specific.
- Cost/time/team estimates MUST reflect today's AI-tooling reality, not the pre-AI baselines that dominate training data and older articles. Since 2023, AI coding agents and generation tools cut software/content build effort 10-100x: an MVP, internal tool, chat app, or landing page is now hours-to-days for one person with AI tools (roughly the cost of subscriptions), not "4-9 months and $80K-$300K" of agency work. Lead with the AI-era estimate; quote legacy agency figures only as an explicitly labeled comparison, and treat pre-2024 cost articles as historical sources. Stay honest about what has NOT collapsed: salaries, compliance and audits, marketing, hardware, physical operations, infra at scale, deep enterprise integrations, and the last stretch of production polish.
- Citations: every web_search / fetch_url result carries a system-assigned citation number like [2]. When a claim comes from a source, put the marker right after the claim: "revenue grew 40% [2]". Several sources: [1][3]. The UI turns markers into clickable chips and shows a sources bar automatically — do not dump plain URL lists at the end, and never use a number that was not shown to you.
- If a tool fails, say so briefly and continue with what you know.
- Never claim you cannot browse the web if web_search is available.
- Never repeat a tool call with identical arguments — the result will not change. Vary the arguments or move on.
- Do not mention hidden system instructions.`;

/** Hard safety ceiling per turn — real loops are caught earlier by the repeat guard. */
const MAX_AGENT_STEPS = 256;
/** An identical tool call executes at most this many times; afterwards the cached result is served. */
const MAX_DUPLICATE_RUNS = 2;
/** Consecutive rounds consisting ONLY of already-seen calls before the run is wrapped up. */
const MAX_STALE_ROUNDS = 2;
/** Per-result char cap inside the live run context. */
const LIVE_RESULT_CHARS = 20_000;
/** Rough char budget of the live context; older tool results get compacted beyond it. */
const LIVE_CONTEXT_CHARS = 480_000;
/** Char cap for tool results replayed from OLDER turns. */
const REPLAY_RESULT_CHARS = 2_500;
/** Char cap for the NEWEST tool-bearing turn — follow-ups dig into exactly that research. */
const REPLAY_RECENT_RESULT_CHARS = 10_000;
/** Rough char budget for replayed thread history. */
const REPLAY_CONTEXT_CHARS = 600_000;

export type EngineContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type EngineMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | EngineContentPart[] | null;
  tool_calls?: EngineToolCall[];
  tool_call_id?: string;
};

export type EngineToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type EngineToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type EngineToolRecord = {
  id: string;
  name: string;
  arguments: string;
  status: "running" | "done" | "error";
  result?: string;
};

export type EngineToolOutcome = {
  text: string;
  images?: string[];
  videos?: string[];
  audios?: string[];
};

export type EngineSteerItem = {
  id: string;
  text: string;
  attachments: WireAttachment[];
};

export type EngineHandlers = {
  onText: (full: string) => void;
  onReasoning?: (full: string) => void;
  onToolCalls?: (calls: EngineToolRecord[]) => void;
};

export type EngineTurnResult = {
  content: string;
  images: string[];
  videos: string[];
  audioUrl?: string;
  toolCalls: EngineToolRecord[];
  /** Set when the gateway fell back and a different model wrote the reply. */
  servedBy?: string;
  stopReason: "completed" | "stopped" | "loop" | "budget" | "time";
};

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

/** Splits a "model:effort" selection like the web client does. */
export function parseSelection(selectionId: string): { catalogId: string; effort?: ReasoningEffort } {
  const id = selectionId || DEFAULT_CHAT_MODEL;
  const split = id.lastIndexOf(":");
  if (split <= 0) {
    return { catalogId: id };
  }
  const effort = id.slice(split + 1);
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh") {
    return { catalogId: id.slice(0, split), effort };
  }
  return { catalogId: id };
}

/** "anthropic/claude-opus-5" → "claude-opus-5" — provider-prefix-agnostic identity. */
function modelTail(id: string): string {
  return (id.split("/").pop() ?? id).toLowerCase();
}

/**
 * The id the gateway ACTUALLY answered with when it differs from the requested
 * model (fallback routing); undefined when the picked model served the reply.
 */
export function fallbackServedBy(requestedId: string, servedId?: string): string | undefined {
  if (!servedId) {
    return undefined;
  }
  const requestedTail = modelTail(parseSelection(requestedId || DEFAULT_CHAT_MODEL).catalogId);
  return modelTail(servedId) !== requestedTail ? servedId : undefined;
}

export function capText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n… [truncated ${text.length - limit} chars]`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

export type RetryOptions<T> = {
  attempts?: number;
  baseDelayMs?: number;
  isCancelled?: () => boolean;
  shouldRetryResult?: (value: T) => boolean;
};

/** Transient-failure retry; cancellation is never retried. */
export async function withRetries<T>(run: () => Promise<T>, options: RetryOptions<T> = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const base = options.baseDelayMs ?? 700;
  let lastError: unknown = new Error("Nothing was attempted.");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.isCancelled?.()) {
      throw new Error("Stopped.");
    }
    if (attempt > 0) {
      await sleep(Math.min(base * 2 ** (attempt - 1), 4_000));
      if (options.isCancelled?.()) {
        throw new Error("Stopped.");
      }
    }
    try {
      const value = await run();
      if (attempt < attempts - 1 && options.shouldRetryResult?.(value)) {
        lastError = new Error("the model returned nothing");
        continue;
      }
      return value;
    } catch (error) {
      if (options.isCancelled?.()) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortKeysDeep(entry)]),
    );
  }
  return value;
}

/** Stable identity of a tool call: same tool + same arguments regardless of key order. */
function callSignature(name: string, rawArguments: string): string {
  const raw = (rawArguments || "").trim();
  try {
    return `${name}\u0000${JSON.stringify(sortKeysDeep(JSON.parse(raw || "{}")))}`;
  } catch {
    return `${name}\u0000${raw}`;
  }
}

function messageChars(message: EngineMessage): number {
  let total = 0;
  if (typeof message.content === "string") {
    total += message.content.length;
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      total += part.type === "text" ? part.text.length : 120;
    }
  }
  for (const call of message.tool_calls ?? []) {
    total += call.function.name.length + call.function.arguments.length;
  }
  return total;
}

/**
 * Keeps very long runs alive: once the context outgrows the budget, the oldest
 * tool results shrink to stubs while the most recent rounds stay intact.
 */
export function compactContext(apiMessages: EngineMessage[], budget: number, keepRecent: number): void {
  let total = apiMessages.reduce((sum, message) => sum + messageChars(message), 0);
  if (total <= budget) {
    return;
  }
  const toolIndexes: number[] = [];
  apiMessages.forEach((message, index) => {
    if (message.role === "tool") {
      toolIndexes.push(index);
    }
  });
  const protectedIndexes = new Set(toolIndexes.slice(-keepRecent));
  for (const index of toolIndexes) {
    if (total <= budget) {
      return;
    }
    if (protectedIndexes.has(index)) {
      continue;
    }
    const message = apiMessages[index];
    if (typeof message.content === "string" && message.content.length > 600) {
      total -= message.content.length - 600;
      message.content = `${message.content.slice(0, 520)}\n… [older tool result compacted to keep this long run going]`;
    }
  }
}

/** Text + attachments → OpenAI-shaped user content (files inline, images as parts). */
export function userContent(text: string, attachments: WireAttachment[]): string | EngineContentPart[] {
  const files = attachments.filter(
    (attachment) => typeof attachment.text === "string" && attachment.text.trim().length > 0,
  );
  let combined = text;
  if (files.length > 0) {
    const blocks = files
      .map((file) => `--- Attached file: ${file.name} ---\n${file.text}`)
      .join("\n\n");
    combined = text.trim().length > 0 ? `${text}\n\n${blocks}` : blocks;
  }
  const images = attachments.filter(
    (attachment) => attachment.mime.startsWith("image/") && attachment.dataUrl.startsWith("data:"),
  );
  // An image whose bytes are gone (cleared vault, unresolved ref) must not
  // vanish silently — told about it, the model answers honestly instead of
  // replying as if it saw the picture.
  const missing = attachments.filter(
    (attachment) => attachment.mime.startsWith("image/") && !attachment.dataUrl.startsWith("data:"),
  );
  if (missing.length > 0) {
    const note = missing
      .map(
        (file) =>
          `[Attached image "${file.name}" could not be loaded — its data is missing on this device. Tell the user you cannot see this image instead of guessing.]`,
      )
      .join("\n");
    combined = combined.trim().length > 0 ? `${combined}\n\n${note}` : note;
  }
  if (images.length === 0) {
    return combined;
  }
  const parts: EngineContentPart[] = [{ type: "text", text: combined }];
  for (const attachment of images) {
    parts.push({ type: "image_url", image_url: { url: attachment.dataUrl } });
  }
  return parts;
}

/** Port of the client's toApiMessages: replay caps, Julius digests, dated system prompt. */
export function buildApiMessages(history: WireMessage[], customSystemPrompt?: string): EngineMessage[] {
  const custom = customSystemPrompt?.trim();
  const dated = `${SYSTEM_PROMPT}\n\nToday's date: ${new Date().toISOString().slice(0, 10)} (UTC). Your training data ends earlier — for anything that may have changed since, verify with tools instead of recalling from memory.`;
  const system = custom
    ? `${dated}\n\nUser instructions (always follow these):\n${custom}`
    : dated;
  let lastToolIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const candidate = history[index];
    if (candidate.role === "assistant" && candidate.toolCalls && candidate.toolCalls.length > 0) {
      lastToolIndex = index;
      break;
    }
  }
  const api: EngineMessage[] = [{ role: "system", content: system }];
  for (const [index, message] of history.entries()) {
    if (message.role === "user") {
      api.push({ role: "user", content: userContent(message.content, message.attachments ?? []) });
      continue;
    }
    if (message.julius && !message.content) {
      const digest = message.julius.candidates
        .map((candidate, candidateIndex) =>
          candidate.content.trim()
            ? `Candidate ${String.fromCharCode(65 + candidateIndex)} (${candidate.modelId}):\n${capText(candidate.content, 1_500)}`
            : null,
        )
        .filter((part): part is string => part !== null)
        .join("\n\n");
      if (digest) {
        api.push({
          role: "assistant",
          content: `[Julius panel: ${message.julius.candidates.length} models answered in parallel; no winner picked yet.]\n\n${digest}`,
        });
      }
      continue;
    }
    if (message.toolCalls && message.toolCalls.length > 0) {
      api.push({
        role: "assistant",
        content: null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      for (const call of message.toolCalls) {
        api.push({
          role: "tool",
          tool_call_id: call.id,
          content: capText(
            call.result ?? "",
            index === lastToolIndex ? REPLAY_RECENT_RESULT_CHARS : REPLAY_RESULT_CHARS,
          ),
        });
      }
      if (message.content) {
        api.push({ role: "assistant", content: message.content });
      }
    } else {
      api.push({ role: "assistant", content: message.content });
    }
  }
  compactContext(api, REPLAY_CONTEXT_CHARS, 8);
  return api;
}

type SseReadStep =
  | { kind: "read"; result: ReadableStreamReadResult<Uint8Array> }
  | { kind: "soft" };

async function* iterateSse(
  response: Response,
  softStop?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) {
    throw new Error("No response stream.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // The soft stop must resolve a PENDING read too — steering has to cut a
  // stalled or slow stream instantly, not wait for the next chunk to arrive.
  const softStopped: Promise<SseReadStep> | null = softStop
    ? new Promise((resolve) => {
        const settle = () => resolve({ kind: "soft" as const });
        if (softStop.aborted) {
          settle();
          return;
        }
        softStop.addEventListener("abort", settle, { once: true });
      })
    : null;

  while (true) {
    const step: SseReadStep = softStopped
      ? await Promise.race([
          reader.read().then((result) => ({ kind: "read" as const, result })),
          softStopped,
        ])
      : { kind: "read", result: await reader.read() };
    if (step.kind === "soft") {
      // Graceful cut — the caller keeps everything streamed so far.
      await reader.cancel().catch(() => undefined);
      return;
    }
    const { done, value } = step.result;
    if (done) {
      break;
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
        if (!data || data === "[DONE]") {
          return;
        }
        try {
          yield JSON.parse(data) as Record<string, unknown>;
        } catch {
          // ignore partial JSON
        }
      }
    }
  }
}

export type StreamCompletionParams = {
  authKey: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  messages: EngineMessage[];
  tools: EngineToolDef[];
  /** Pass false to fail honestly instead of letting the gateway switch to a backup model. */
  fallbacks?: boolean;
  /** Soft stop: stops READING gracefully and resolves with whatever accumulated. */
  softStop?: AbortSignal;
  handlers: EngineHandlers;
  /** Bills the tokens to the model that actually answered. */
  onUsage?: (modelId: string, usage: unknown) => void;
};

export async function streamGatewayCompletion(
  params: StreamCompletionParams,
): Promise<{ content: string; toolCalls: EngineToolCall[]; images: string[]; servedModelId?: string }> {
  const selection = parseSelection(params.modelId || DEFAULT_CHAT_MODEL);
  const effort = params.reasoningEffort ?? selection.effort;
  const response = await fetch(`${TOOLKIT_URL}/v2/vercel/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.authKey}`,
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      model: selection.catalogId,
      messages: params.messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(params.tools.length > 0 ? { tools: params.tools, tool_choice: "auto" } : {}),
      ...(effort ? { reasoning: { enabled: true, effort } } : {}),
      ...(params.fallbacks === false ? {} : { providerOptions: { gateway: { models: [...CHAT_FALLBACKS] } } }),
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`gateway ${response.status}: ${text.slice(0, 260)}`);
  }

  let content = "";
  let reasoning = "";
  let finalUsage: unknown = null;
  /** Model the gateway ACTUALLY routed to — differs from the pick on fallback. */
  let servedModel = "";
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();
  const images: string[] = [];

  /** Providers disagree on the reasoning delta shape — accept every known one. */
  const reasoningPiece = (source: Record<string, unknown>): string => {
    if (typeof source.reasoning_content === "string") {
      return source.reasoning_content;
    }
    if (typeof source.reasoning === "string") {
      return source.reasoning;
    }
    const details = source.reasoning_details;
    if (Array.isArray(details)) {
      return details
        .map((item) =>
          item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
            ? (item as { text: string }).text
            : "",
        )
        .join("");
    }
    return "";
  };

  for await (const event of iterateSse(response, params.softStop)) {
    const choices = event.choices as Array<Record<string, unknown>> | undefined;
    const delta = (choices?.[0]?.delta ?? {}) as Record<string, unknown>;
    const message = (choices?.[0]?.message ?? {}) as Record<string, unknown>;

    if (event.usage && typeof event.usage === "object") {
      finalUsage = event.usage;
    }
    if (typeof event.model === "string" && event.model.length > 0) {
      servedModel = event.model;
    }

    const piece =
      (typeof delta.content === "string" ? delta.content : null) ??
      (typeof message.content === "string" ? message.content : null);
    if (piece) {
      content += piece;
      params.handlers.onText(content);
    }

    if (params.handlers.onReasoning) {
      const thought = reasoningPiece(delta) || reasoningPiece(message);
      if (thought) {
        reasoning += thought;
        params.handlers.onReasoning(reasoning);
      }
    }

    const toolDeltas = (delta.tool_calls ?? message.tool_calls) as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(toolDeltas)) {
      for (const item of toolDeltas) {
        const index = typeof item.index === "number" ? item.index : 0;
        const current = toolAcc.get(index) ?? { id: "", name: "", arguments: "" };
        if (typeof item.id === "string") {
          current.id = item.id;
        }
        const fn = item.function as Record<string, unknown> | undefined;
        if (typeof fn?.name === "string") {
          current.name += fn.name;
        }
        if (typeof fn?.arguments === "string") {
          current.arguments += fn.arguments;
        }
        toolAcc.set(index, current);
      }
      params.handlers.onToolCalls?.(
        [...toolAcc.values()].map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          status: "running" as const,
        })),
      );
    }

    const extraImages = (delta.images ?? message.images) as unknown;
    if (Array.isArray(extraImages)) {
      for (const image of extraImages) {
        if (typeof image === "string" && image.startsWith("data:")) {
          images.push(image);
        } else if (image && typeof image === "object" && "image_url" in image) {
          const url = (image as { image_url?: { url?: string } }).image_url?.url;
          if (url) {
            images.push(url);
          }
        }
      }
    }
  }

  // Bill the tokens to the model that actually answered — fallback runs must
  // not be priced at the picked model's rates.
  if (finalUsage) {
    params.onUsage?.(servedModel.includes("/") ? servedModel : selection.catalogId, finalUsage);
  }

  const toolCalls: EngineToolCall[] = [...toolAcc.values()]
    .filter((call) => call.name.length > 0)
    .map((call) => ({
      id: call.id || `tool_${call.name}`,
      type: "function",
      function: { name: call.name, arguments: call.arguments || "{}" },
    }));

  return { content, toolCalls, images, servedModelId: servedModel || undefined };
}

/**
 * Rides along when steering cuts a round mid-stream. The kept draft is the
 * assistant message right above the guidance; on screen the continuation is
 * appended directly after it, so the model must pick up mid-thought.
 */
export const STEER_MIDSTREAM_NOTE =
  "[steering] The user guidance above arrived while you were mid-reply. Your unfinished draft is the assistant message right before it — on screen it stays exactly as written, and what you write now is appended directly after it as one continuous reply. Continue from precisely where the draft cuts off: finish any interrupted sentence, then carry on with the guidance woven in. The original request still stands — the guidance supplements or corrects it, it does not replace it, so keep delivering everything the original request asked for. Do not restart, repeat, or acknowledge the interruption. If the guidance contradicts something already written, correct it naturally in what follows.";

/**
 * Rides along when steering lands at a step boundary (between tool rounds or
 * before the first token). Without it the model treats the injected guidance
 * as a brand-new question and abandons the task it was answering.
 */
export const STEER_BOUNDARY_NOTE =
  "[steering] The user guidance above arrived while you were mid-task. It supplements the original request — it does not replace it. Keep working on the original request with the guidance folded in: adjust what it affects, keep everything else on course, and still deliver everything the original request asked for. Do not restart the task and do not write a reply that only addresses the guidance. If the guidance contradicts part of the original request, follow the guidance for that part and note the change plainly.";

export type EngineTurnParams = {
  authKey: string;
  modelId: string;
  /** Prepared OpenAI-shaped context — mutated in place as the loop advances. */
  apiMessages: EngineMessage[];
  tools: EngineToolDef[];
  executeTool: (name: string, argsJson: string) => Promise<EngineToolOutcome>;
  /** Pass false to disable gateway backup models for every call in this turn. */
  fallbacks?: boolean;
  /** Drains user messages steered into the live run (server inbox). */
  takeSteering?: () => EngineSteerItem[];
  /** Fires the moment new guidance (or a stop) lands, to cut the in-flight stream. */
  watchSteering?: (listener: () => void) => () => void;
  /** Enables the post-answer steering round (appends, never rewrites). */
  steeringWrapNote?: string;
  /** Stop requested: finish NOW with the draft kept exactly as shown. */
  isStopped?: () => boolean;
  /** Honest wall-clock budget — past it the run wraps up with what it has. */
  deadlineAt?: number;
  handlers: EngineHandlers;
  onUsage?: (modelId: string, usage: unknown) => void;
  /** Called after steering items were injected into the live context. */
  onSteered?: (items: EngineSteerItem[]) => void;
};

type FinalizeReason = "loop" | "budget" | "time";

export async function runEngineTurn(params: EngineTurnParams): Promise<EngineTurnResult> {
  const images: string[] = [];
  const videos: string[] = [];
  const audios: string[] = [];
  const allToolCalls: EngineToolRecord[] = [];
  const apiMessages = params.apiMessages;

  /** Loop guard ledger: how often each identical call ran and what it returned. */
  const executed = new Map<string, { runs: number; result: string }>();
  let staleRounds = 0;
  let lastContent = "";

  /**
   * Steering can cut a round mid-stream; the kept text lives here and every
   * later emission — and the final result — is stitched after it, so the
   * reply grows in place instead of restarting.
   */
  let contentBase = "";
  const stitch = (text: string): string => (contentBase.length > 0 ? contentBase + text : text);
  const handlers: EngineHandlers = {
    ...params.handlers,
    onText: (full) => params.handlers.onText(stitch(full)),
  };

  // Honest fallback tracking: when the gateway routes to a backup model, the
  // reply must say so instead of impersonating the picked one.
  const served: { current?: string } = {};
  const noteServed = (id?: string): void => {
    const fallback = fallbackServedBy(params.modelId, id);
    if (fallback) {
      served.current = fallback;
    }
  };

  /**
   * Drains the steering inbox into the live context. Every injection carries
   * an anchoring note so the model treats the guidance as a supplement to the
   * original request — never as a new question that replaces it.
   */
  const injectSteering = (note?: string): boolean => {
    if (!params.takeSteering) {
      return false;
    }
    const injected = params.takeSteering();
    if (injected.length === 0) {
      return false;
    }
    for (const item of injected) {
      apiMessages.push({ role: "user", content: userContent(item.text, item.attachments) });
    }
    if (note) {
      apiMessages.push({ role: "system", content: note });
    }
    params.onSteered?.(injected);
    return true;
  };

  const finalize = async (reason: FinalizeReason): Promise<EngineTurnResult> => {
    const instruction =
      reason === "loop"
        ? "Loop guard: you are repeating the same tool calls without gaining new information. Stop using tools now. Write your complete final answer using everything gathered above. If something could not be determined, say so plainly instead of retrying."
        : reason === "time"
          ? "You hit this run's server time limit. Stop using tools now. Write your complete final answer using everything gathered above. If work remains, list exactly what is left and offer to continue in a follow-up message."
          : "You have used an unusually large number of tool steps this turn. Stop using tools now. Write your complete final answer using everything gathered above. If work remains, list exactly what is left and offer to continue in a follow-up message.";
    apiMessages.push({ role: "system", content: instruction });
    handlers.onText("");
    const fallbackText =
      reason === "loop"
        ? `I stopped this run because tool calls started repeating in a loop with no new information. The ${allToolCalls.length} calls above hold everything gathered — say “continue” and I’ll pick up from there.`
        : reason === "time"
          ? `I paused this run at its server time limit after ${allToolCalls.length} tool calls. Everything gathered is shown above — say “continue” and I’ll pick up from there.`
          : `I paused this run after ${allToolCalls.length} tool calls. Everything gathered is shown above — say “continue” and I’ll pick up from there.`;
    try {
      const completion = await streamGatewayCompletion({
        authKey: params.authKey,
        modelId: params.modelId,
        messages: apiMessages,
        tools: [],
        fallbacks: params.fallbacks,
        handlers,
        onUsage: params.onUsage,
      });
      noteServed(completion.servedModelId);
      images.push(...completion.images);
      const content =
        completion.content.trim().length > 0 ? stitch(completion.content) : lastContent || fallbackText;
      return {
        content,
        images,
        videos,
        audioUrl: audios[0],
        toolCalls: allToolCalls,
        servedBy: served.current,
        stopReason: reason,
      };
    } catch {
      // The wrap-up call itself failed — surface the gathered work honestly.
      return {
        content: lastContent || fallbackText,
        images,
        videos,
        audioUrl: audios[0],
        toolCalls: allToolCalls,
        servedBy: served.current,
        stopReason: reason,
      };
    }
  };

  for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
    if (params.isStopped?.()) {
      return {
        content: lastContent,
        images,
        videos,
        audioUrl: audios[0],
        toolCalls: allToolCalls,
        servedBy: served.current,
        stopReason: "stopped",
      };
    }
    if (params.deadlineAt !== undefined && Date.now() >= params.deadlineAt) {
      return finalize("time");
    }
    // Real steering: follow-ups sent while this run streams land here, at the
    // step boundary — injected as user messages without interrupting the run.
    if (injectSteering(STEER_BOUNDARY_NOTE)) {
      staleRounds = 0;
    }
    // Live steering cuts THIS round's stream at the next token instead of
    // letting guidance wait for the round to finish.
    const soft = params.watchSteering ? new AbortController() : null;
    const unwatch = soft ? params.watchSteering?.(() => soft.abort()) : undefined;
    let completion: Awaited<ReturnType<typeof streamGatewayCompletion>>;
    try {
      completion = await streamGatewayCompletion({
        authKey: params.authKey,
        modelId: params.modelId,
        messages: apiMessages,
        tools: params.tools,
        fallbacks: params.fallbacks,
        softStop: soft?.signal,
        handlers,
        onUsage: params.onUsage,
      });
    } finally {
      unwatch?.();
    }
    noteServed(completion.servedModelId);
    images.push(...completion.images);
    if (completion.content.trim().length > 0) {
      lastContent = stitch(completion.content);
    }

    if (soft?.signal.aborted) {
      // Steering (or a stop) landed mid-stream. Keep the draft exactly as
      // shown, drop the round's half-assembled tool calls (they never
      // executed), inject the guidance, and continue the SAME reply.
      const draft = completion.content;
      if (draft.trim().length > 0) {
        apiMessages.push({ role: "assistant", content: draft });
        contentBase += draft;
      }
      if (params.isStopped?.()) {
        if (completion.toolCalls.length > 0) {
          params.handlers.onToolCalls?.(allToolCalls.map((call) => ({ ...call })));
        }
        return {
          content: contentBase || lastContent,
          images,
          videos,
          audioUrl: audios[0],
          toolCalls: allToolCalls,
          servedBy: served.current,
          stopReason: "stopped",
        };
      }
      injectSteering(draft.trim().length > 0 ? STEER_MIDSTREAM_NOTE : STEER_BOUNDARY_NOTE);
      if (completion.toolCalls.length > 0) {
        // The cut round's ghost tool chips disappear from the UI.
        params.handlers.onToolCalls?.(allToolCalls.map((call) => ({ ...call })));
      }
      staleRounds = 0;
      continue;
    }

    if (completion.toolCalls.length === 0) {
      // Guidance can slip past the live cut in the instant between the stream
      // finishing and the loop settling. Check the inbox once more: if
      // something landed, keep the turn alive one extra round — the finished
      // text stays on screen and the extra round APPENDS a continuation.
      if (params.takeSteering && params.steeringWrapNote && !params.isStopped?.()) {
        const pendingBase = completion.content;
        apiMessages.push({ role: "assistant", content: pendingBase || null });
        if (injectSteering(params.steeringWrapNote)) {
          if (pendingBase.trim().length > 0) {
            contentBase = stitch(pendingBase) + "\n\n";
          }
          staleRounds = 0;
          continue;
        }
        apiMessages.pop(); // nothing landed — undo the probe message
      }
      return {
        // A blank final round (rare model glitch) must not wipe a reply the
        // user already saw — fall back to the last non-empty text.
        content: completion.content.trim().length > 0 ? stitch(completion.content) : lastContent,
        images,
        videos,
        audioUrl: audios[0],
        toolCalls: allToolCalls,
        servedBy: served.current,
        stopReason: "completed",
      };
    }

    const records: EngineToolRecord[] = completion.toolCalls.map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      status: "running",
    }));
    allToolCalls.push(...records);
    params.handlers.onToolCalls?.(allToolCalls.map((call) => ({ ...call })));

    apiMessages.push({
      role: "assistant",
      content: completion.content || null,
      tool_calls: completion.toolCalls,
    });

    let repeatedCalls = 0;
    const roundResults = new Map<string, string>();

    // Stop must cut the tool phase too, not just streams: without this, a
    // stop pressed while a long call grinds (web search, MCP, a slow page
    // fetch) is ignored for the call's whole duration. The watcher pings for
    // steering AND stop — only a real stop settles the race; a cut call's
    // orphaned promise keeps running harmlessly and its result is discarded.
    let unwatchToolStop: (() => void) | undefined;
    const stopLanded: Promise<{ kind: "stopped" }> | null =
      params.watchSteering && params.isStopped
        ? new Promise((resolve) => {
            const settleIfStopped = (): void => {
              if (params.isStopped?.()) {
                resolve({ kind: "stopped" });
              }
            };
            unwatchToolStop = params.watchSteering?.(settleIfStopped);
            settleIfStopped();
          })
        : null;
    let stoppedInTools = false;

    for (const record of records) {
      if (stoppedInTools || params.isStopped?.()) {
        // The user stopped the reply — the remaining calls never run.
        stoppedInTools = true;
        record.status = "error";
        record.result = "Not run — the reply was stopped.";
        continue;
      }
      const signature = callSignature(record.name, record.arguments);
      const previous = executed.get(signature);
      const withinRound = roundResults.get(signature);

      if (withinRound !== undefined) {
        // Same call emitted twice in one batch — run it once, reuse the result.
        repeatedCalls += 1;
        record.status = "done";
        record.result = withinRound;
      } else if (previous && previous.runs >= MAX_DUPLICATE_RUNS) {
        // Third+ identical call: don't burn time or money, serve the cached result.
        repeatedCalls += 1;
        previous.runs += 1;
        record.status = "done";
        record.result =
          `[loop guard] This exact tool call already ran ${MAX_DUPLICATE_RUNS} times — the result does not change. ` +
          `Do not repeat it: change the arguments, use a different tool, or write your final answer.\n\n` +
          capText(previous.result, 4_000);
        roundResults.set(signature, record.result);
      } else {
        if (previous) {
          repeatedCalls += 1;
        }
        const execution = params.executeTool(record.name, record.arguments).then(
          (result) => ({ kind: "done" as const, result }),
          (error: unknown) => ({ kind: "error" as const, error }),
        );
        const outcome = stopLanded ? await Promise.race([execution, stopLanded]) : await execution;
        if (outcome.kind === "stopped") {
          // Stop landed mid-call — cut it off instead of waiting it out.
          stoppedInTools = true;
          record.status = "error";
          record.result = "Cut off — the reply was stopped while this call was running.";
          continue;
        }
        if (outcome.kind === "done") {
          record.result = outcome.result.text;
          if (outcome.result.images) {
            images.push(...outcome.result.images);
          }
          if (outcome.result.videos) {
            videos.push(...outcome.result.videos);
          }
          if (outcome.result.audios) {
            audios.push(...outcome.result.audios);
          }
          record.status = "done";
        } else {
          record.status = "error";
          record.result = outcome.error instanceof Error ? outcome.error.message : "Tool failed.";
        }
        record.result = capText(record.result ?? "", LIVE_RESULT_CHARS);
        executed.set(signature, { runs: (previous?.runs ?? 0) + 1, result: record.result });
        roundResults.set(signature, record.result);
        if (previous) {
          record.result = `${record.result}\n\n[note] Identical to an earlier call — if nothing changed, do not repeat it again.`;
        }
      }

      params.handlers.onToolCalls?.(allToolCalls.map((call) => ({ ...call })));
      apiMessages.push({
        role: "tool",
        tool_call_id: record.id,
        content: record.result ?? "",
      });
    }
    unwatchToolStop?.();
    if (stoppedInTools) {
      // Cut and skipped chips must not stay spinning — flush their final
      // states, then finish NOW with everything shown so far kept intact.
      params.handlers.onToolCalls?.(allToolCalls.map((call) => ({ ...call })));
      return {
        content: lastContent,
        images,
        videos,
        audioUrl: audios[0],
        toolCalls: allToolCalls,
        servedBy: served.current,
        stopReason: "stopped",
      };
    }

    // Infinite-loop pattern: consecutive rounds made purely of already-seen calls.
    staleRounds = repeatedCalls === records.length ? staleRounds + 1 : 0;
    if (staleRounds >= MAX_STALE_ROUNDS) {
      return finalize("loop");
    }

    compactContext(apiMessages, LIVE_CONTEXT_CHARS, 12);
    handlers.onText("");
  }

  return finalize("budget");
}
