// Shared wire types for server-side agent runs. Platform-neutral on purpose:
// this module (and agent-engine.ts) must import nothing Cloudflare-specific so
// the web app's unit tests can exercise the exact engine that ships to the DO.

export type RunKind = "chat" | "research" | "julius";

export type WireAttachment = {
  name: string;
  mime: string;
  /** Data URL for images; empty for text-like files. */
  dataUrl: string;
  /** Extracted plain text for text-like files. */
  text?: string;
};

export type WireToolCall = {
  id: string;
  name: string;
  arguments: string;
  result?: string;
};

/** One thread message as the client ships it to the server run. */
export type WireMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: WireAttachment[];
  toolCalls?: WireToolCall[];
  /** Julius panel digest source (candidates replayed when no winner picked). */
  julius?: { candidates: Array<{ modelId: string; content: string }> };
};

export type ToolRecordStatus = "running" | "done" | "error";

export type RunToolRecord = {
  id: string;
  name: string;
  arguments: string;
  status: ToolRecordStatus;
  result?: string;
};

export type RunSource = { url: string; title: string };

export type ResearchStepKind = "plan" | "search" | "read" | "browse" | "synthesize";

export type ResearchStep = {
  id: string;
  kind: ResearchStepKind;
  label: string;
  detail?: string;
  status: "running" | "done" | "error";
};

export type ResearchState = {
  status: "running" | "done" | "error";
  steps: ResearchStep[];
  sources: RunSource[];
  startedAt: number;
  finishedAt?: number;
};

export type ResearchDepth = "eco" | "balanced" | "max";

export type JuliusDecision = "manual" | "council";

export type JuliusRunStatus =
  | "waiting"
  | "candidates"
  | "debate"
  | "synthesis"
  | "choice"
  | "done"
  | "error";

export type JuliusCandidateState = {
  id: string;
  modelId: string;
  label?: string;
  content: string;
  status: "running" | "done" | "error";
  error?: string;
  toolCalls?: RunToolRecord[];
  research?: ResearchState;
  thinking?: string;
  servedBy?: string;
};

export type JuliusReviewState = {
  role: "proponent" | "critic" | "verifier";
  modelId: string;
  content: string;
  status: "running" | "done" | "error";
  toolCalls?: RunToolRecord[];
  thinking?: string;
  servedBy?: string;
};

export type JuliusState = {
  decision: JuliusDecision;
  status: JuliusRunStatus;
  candidates: JuliusCandidateState[];
  reviews: JuliusReviewState[];
  verdict?: string;
  chairmanModelId?: string;
  chairmanServedBy?: string;
  chairmanThinking?: string;
  winner?: number;
  decidedBy?: "user" | "chairman";
  hubOpsApplied?: number[];
  sources?: RunSource[];
  startedAt: number;
  finishedAt?: number;
};

export type JuliusWireSettings = {
  candidateModelIds: string[];
  decision: JuliusDecision;
  proponentModelId: string;
  criticModelId: string;
  verifierModelId: string;
  chairmanModelId: string;
};

export type BuiltinToolId =
  | "web_search"
  | "fetch_url"
  | "selfsurf"
  | "generate_image"
  | "generate_video"
  | "generate_audio";

/** One steering item handed to a live run. */
export type RunSteerItem = {
  id: string;
  text: string;
  attachments: WireAttachment[];
};

/** MCP server config as the client ships it (mirrors the profile blob shape). */
export type WireMcpServer = Record<string, unknown>;

export type StartRunConfig = {
  systemPrompt?: string;
  history: WireMessage[];
  prompt: string;
  builtins: Record<BuiltinToolId, boolean>;
  mcpServers: WireMcpServer[];
  grounding?: { block: string; sources: RunSource[] };
  steeringWrapNote?: string;
  /** Resume: continue an existing assistant message instead of appending. */
  resume?: { messageId: string; partial: string };
  research?: { depth: ResearchDepth; citations?: "numeric" | "links"; githubAuth?: string };
  julius?: { settings: JuliusWireSettings; research?: boolean };
  /** Incognito threads: the run never writes into server chat history. */
  ephemeral?: boolean;
};

export type StartRunBody = {
  runId: string;
  conversationId: string;
  assistantMessageId: string;
  kind: RunKind;
  title: string;
  /** Model selection id (may carry :effort suffix). */
  modelId: string;
  agentId?: string;
  automationId?: string;
  /** Serialized conversation INCLUDING the new user message (no pending bubble). */
  chatSeed?: { payload: string; updatedAt: number };
  config: StartRunConfig;
};

export type RunUsageEvent = {
  modelId: string;
  usage: unknown;
  /** True for internal helper calls (research planner) — excluded from model standings. */
  service?: boolean;
};

/** Cloud media reference stored in chat messages: gera-cloud:v1:<runId>:<idx>. */
export const CLOUD_MEDIA_PREFIX = "gera-cloud:v1:";

export function cloudMediaRef(runId: string, index: number): string {
  return `${CLOUD_MEDIA_PREFIX}${runId}:${index}`;
}

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

/** Final assistant message payload produced by a settled run. */
export type RunFinalMessage = {
  id: string;
  content: string;
  toolCalls?: RunToolRecord[];
  sources?: RunSource[];
  servedBy?: string;
  research?: ResearchState;
  julius?: JuliusState;
  /** Cloud media refs (resolve via /runs/media). */
  images?: string[];
  videos?: string[];
  audioUrl?: string;
  interrupted?: boolean;
};

export type RunStatus = "running" | "done" | "stopped" | "interrupted" | "error";

export type RunSnapshot = {
  runId: string;
  conversationId: string;
  kind: RunKind;
  status: RunStatus;
  startedAt: number;
  /** Streamed text as currently shown (steering base already stitched in). */
  content: string;
  reasoningTail?: string;
  toolCalls?: RunToolRecord[];
  sources?: RunSource[];
  research?: ResearchState;
  julius?: JuliusState;
  /** Steer items already woven into the live context, in consumption order. */
  steered?: RunSteerItem[];
  error?: string;
};

/** Server → client live events over the run stream. */
export type RunEvent =
  | { t: "snapshot"; seq: number; snapshot: RunSnapshot }
  | { t: "text"; seq: number; content: string }
  | { t: "reasoning"; seq: number; tail: string }
  | { t: "tools"; seq: number; toolCalls: RunToolRecord[] }
  | { t: "sources"; seq: number; sources: RunSource[] }
  | { t: "research"; seq: number; research: ResearchState }
  | { t: "julius"; seq: number; julius: JuliusState; sources?: RunSource[] }
  | { t: "steered"; seq: number; items: RunSteerItem[] }
  | {
      t: "done";
      seq: number;
      status: Exclude<RunStatus, "running">;
      message: RunFinalMessage;
      usageEvents: RunUsageEvent[];
      steered: RunSteerItem[];
      chatUpdatedAt: number;
      error?: string;
    }
  | { t: "ping"; seq: number };
