export type ModelType =
  | "language"
  | "image"
  | "video"
  | "embedding"
  | "speech"
  | "transcription"
  | "realtime"
  | "reranking";

export type CostTier = "value" | "standard" | "premium" | "flagship";

/** What the composer creates: chat replies, images, video clips, or audio. */
export type CreateMode = "chat" | "image" | "video" | "audio";

export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536";

export type VideoAspect = "16:9" | "9:16" | "1:1";

export type ModelPricing = {
  input?: number;
  output?: number;
  /** Discounted rate for provider-cached prompt tokens (input_cache_read). */
  inputCacheRead?: number;
  image?: number;
  videoPerSecond?: number;
  videoPerMillionTokens?: number;
  speechChar?: number;
  audioInput?: number;
  transcriptionPerSecond?: number;
};

export type GatewayModel = {
  id: string;
  name: string;
  description?: string;
  owned_by: string;
  type: ModelType;
  context_window?: number;
  max_tokens?: number;
  tags?: string[];
  pricing?: ModelPricing;
  modalities?: {
    input?: string[];
    output?: string[];
  };
};

export type Attachment = {
  id: string;
  name: string;
  mime: string;
  dataUrl: string;
  /** Extracted plain text for text-like files (md, csv, json, code…); absent for images. */
  text?: string;
};

/**
 * A follow-up captured while a run is still streaming — Cursor-style queue.
 * Dispatched FIFO when the run settles; steered items are injected into the
 * live agent loop at its next step without interrupting it.
 */
export type QueuedMessage = {
  id: string;
  text: string;
  attachments: Attachment[];
  mode: CreateMode;
  deepResearch: boolean;
  /** Run as a Julius panel: several models answer in parallel. */
  julius: boolean;
  /** Handed to the live run — lands at its next step instead of waiting in line. */
  steer?: boolean;
  createdAt: number;
};

export type ToolCallStatus = "running" | "done" | "error";

/** A binary tool-result part (audio, blob) the run persisted; `url` is a media ref or data URL. */
export type ToolCallFile = { name: string; mime: string; url: string; bytes?: number };

export type ToolCallRecord = {
  id: string;
  name: string;
  arguments: string;
  status: ToolCallStatus;
  result?: string;
  /** Images the tool returned (vault refs / data URLs) — thumbnails on the record. */
  images?: string[];
  /** Audio / blob parts the tool returned — saveable into the media vault. */
  files?: ToolCallFile[];
};

/** One repository file mutation rendered inside a chat turn's code workbench. */
export type CodeChangeFile = {
  id: string;
  path: string;
  action: "create" | "update" | "delete" | "patch";
  status: ToolCallStatus;
  language?: string;
  additions: number;
  deletions: number;
  patch?: string;
  truncated?: boolean;
  error?: string;
};

/** A runnable preview captured from committed HTML or a real deployment result. */
export type CodePreview =
  | { kind: "html"; label: string; html: string }
  | { kind: "url"; label: string; url: string };

export type CodeValidation = {
  status: "running" | "passed" | "failed" | "unknown";
  label: string;
  url?: string;
};

/** Live, persisted code-edit flow shown as Changes / Preview in the assistant message. */
export type CodeChangeState = {
  status: "running" | "done" | "error";
  files: CodeChangeFile[];
  startedAt: number;
  repository?: string;
  branch?: string;
  pullRequestUrl?: string;
  preview?: CodePreview;
  validation?: CodeValidation;
};

export type RepoPreviewPhase =
  | "queued"
  | "installing"
  | "building"
  | "packaging"
  | "uploading"
  | "ready"
  | "failed"
  | "cancelled"
  | "expired";

export type RepoPreviewFramework =
  | "vite"
  | "next"
  | "astro"
  | "nuxt"
  | "sveltekit"
  | "remix"
  | "react-scripts"
  | "angular"
  | "static"
  | "unknown";

export type RepoPreviewPackageManager = "bun" | "pnpm" | "yarn" | "npm" | "none";

/** Durable Rork-hosted launch of one immutable GitHub web-project commit. */
export type RepoPreviewJob = {
  id: string;
  repository: string;
  ref: string;
  commitSha: string;
  rootDirectory: string;
  outputDirectory?: string;
  framework: RepoPreviewFramework;
  packageManager: RepoPreviewPackageManager;
  phase: RepoPreviewPhase;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  previewUrl?: string;
  actionsUrl?: string;
  setupPullRequestUrl?: string;
  logs?: string;
  error?: string;
};

/** Who chose the project root: the user, the repo root, a Rork workspace's rork.json, or ranked app folders. */
export type RepoPreviewRootSource = "explicit" | "root" | "rork.json" | "detected";

export type RepoPreviewInspection = {
  repository: string;
  defaultBranch: string;
  ref: string;
  commitSha: string;
  rootDirectory: string;
  rootSource: RepoPreviewRootSource;
  outputDirectory?: string;
  rootSuggestions: string[];
  runner: "ready" | "missing" | "outdated";
  runnerVersion?: number;
  framework: RepoPreviewFramework;
  packageManager: RepoPreviewPackageManager;
  projectFound: boolean;
};

// Evidence-backed result attached only to autonomous runs (Automations + project agents).
export type ExecutionOutcomeStatus = "completed" | "needs_review" | "blocked" | "no_change" | "error";
export type ExecutionArtifactKind = "report" | "draft" | "external_object" | "code_change" | "message" | "check";
export type ExecutionEvidenceKind = "source" | "tool_result" | "code_change" | "check" | "preview" | "delivery";
export type ExecutionHandoffKind = "gera" | "requester" | "member";
export type ExecutionSignificanceKind = "none" | "change" | "risk" | "action" | "human_required";

export type ExecutionArtifact = {
  id: string;
  kind: ExecutionArtifactKind;
  label: string;
  url?: string;
};

export type ExecutionEvidence = {
  id: string;
  kind: ExecutionEvidenceKind;
  label: string;
  status: "verified" | "failed";
  url?: string;
  toolName?: string;
};

export type ExecutionHandoff = {
  kind: ExecutionHandoffKind;
  ownerId?: string;
  ownerName?: string;
  nextStep: string;
  unblockRequest?: string;
};

export type ExecutionOutcome = {
  version: 1;
  status: ExecutionOutcomeStatus;
  summary: string;
  artifacts: ExecutionArtifact[];
  evidence: ExecutionEvidence[];
  handoff: ExecutionHandoff;
  significance: {
    kind: ExecutionSignificanceKind;
    summary: string;
    notify: boolean;
  };
  validation: "verified" | "downgraded";
  validationReason?: string;
  validatedAt: number;
};

export type ResearchStepKind = "plan" | "search" | "read" | "browse" | "synthesize";

/** Resource budget preset for a deep-research run: iterations, reads, live browsing. */
export type ResearchDepth = "eco" | "balanced" | "max";

export type ResearchStep = {
  id: string;
  kind: ResearchStepKind;
  label: string;
  detail?: string;
  status: "running" | "done" | "error";
};

export type ResearchSource = {
  url: string;
  title: string;
};

/** Token tally for one model within a single assistant turn. */
export type ModelTokens = {
  prompt: number;
  completion: number;
  calls: number;
  /** Provider-cached prompt tokens (subset of `prompt`, billed at the cache-read rate). */
  cached?: number;
  /** Reasoning tokens (subset of `completion` per the OpenAI-compatible spec). */
  reasoning?: number;
};

/** Per-model media units generated within one turn (billed per asset, not tokens). */
export type MediaTally = {
  images?: number;
  videoSeconds?: number;
  speechChars?: number;
  calls: number;
};

/**
 * Usage aggregated across every call of one assistant turn — the chat loop
 * plus Julius phases in `byModel`, internal helpers (tool router, research
 * planner, thread titles) in `serviceByModel`, and per-asset media
 * generation in `media`. Top-level token totals cover byModel + service.
 */
export type TurnUsage = {
  prompt: number;
  completion: number;
  calls: number;
  byModel: Record<string, ModelTokens>;
  /** Internal helper calls (router, planner, titles) — kept out of model standings. */
  serviceByModel?: Record<string, ModelTokens>;
  /** Generated media units per model (images, video seconds, TTS characters). */
  media?: Record<string, MediaTally>;
};

/** Live trail of a deep-research run, persisted with the message. */
export type ResearchState = {
  status: "running" | "done" | "error";
  steps: ResearchStep[];
  sources: ResearchSource[];
  startedAt: number;
  finishedAt?: number;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: Attachment[];
  images?: string[];
  videos?: string[];
  audioUrl?: string;
  toolCalls?: ToolCallRecord[];
  /** Repository edits, their diff preview, verification, and runnable preview. */
  codeChanges?: CodeChangeState;
  /** Immutable web-repository build hosted by the Rork preview backend. */
  repoPreview?: RepoPreviewJob;
  /** Strict result contract for autonomous runs; absent on ordinary chat in v1. */
  execution?: ExecutionOutcome;
  /**
   * Web sources actually consulted this turn (from web_search / fetch_url),
   * in citation order: a [n] marker in the content refers to sources[n-1].
   * Collected by the tool layer, not the model — the list is a guarantee.
   */
  sources?: ResearchSource[];
  /** Labels of tools auto-armed for this turn by the prompt router. */
  toolPlan?: string[];
  /**
   * Model that actually wrote this reply when the gateway fell back from the
   * picked one (outage, overload). Set only when it differs — the UI shows an
   * honest "answered by" chip instead of letting a weaker model impersonate
   * the picked flagship.
   */
  servedBy?: string;
  /** Token tally for the whole turn; the UI prices it with gateway list rates. */
  usage?: TurnUsage;
  /** Deep-research trail when this reply was produced by research mode. */
  research?: ResearchState;
  /** Julius panel state when this reply was produced by parallel candidates. */
  julius?: JuliusState;
  /**
   * True while a run is writing into this message. Persisted on purpose: a
   * reload (app update, crash) that kills the run leaves the flag behind,
   * and the next load turns it into an honest `interrupted` marker.
   */
  pending?: boolean;
  /** Open questions (MCP elicitation) the live run is paused on — rendered as cards. Never persisted past the run. */
  pauses?: RunPauseRequest[];
  /** Set on load when a reload cut this reply mid-run — offers Continue/Retry. */
  interrupted?: boolean;
  createdAt: number;
};

/** How a Julius panel picks the winning answer. */
export type JuliusDecision = "manual" | "council";

/** Debate roles reviewing the candidates before the chairman rules. */
export type JuliusRole = "proponent" | "critic" | "verifier";

/**
 * "waiting" is legacy (old research-then-audit flow) — healed away on load.
 * "synthesis": the chairman is writing the final merged deliverable after ruling.
 */
export type JuliusRunStatus =
  | "waiting"
  | "candidates"
  | "debate"
  | "synthesis"
  | "choice"
  | "done"
  | "error";

/** One parallel answer inside a Julius panel run. */
export type JuliusCandidateState = {
  id: string;
  /** Model selection id that produced this answer. */
  modelId: string;
  /** Badge shown on the card, e.g. "Deep research" when this candidate ran research. */
  label?: string;
  content: string;
  status: "running" | "done" | "error";
  error?: string;
  toolCalls?: ToolCallRecord[];
  /** Per-candidate research trail when the panel runs in deep-research mode. */
  research?: ResearchState;
  /** Live reasoning tail while the model thinks silently; cleared when it settles. */
  thinking?: string;
  /** Set when the gateway answered with a DIFFERENT model — the card must disclose it. */
  servedBy?: string;
};

/** A council member's streamed review of the candidates. */
export type JuliusReviewState = {
  role: JuliusRole;
  modelId: string;
  content: string;
  status: "running" | "done" | "error";
  toolCalls?: ToolCallRecord[];
  /** Live reasoning tail while the model thinks silently; cleared when it settles. */
  thinking?: string;
  /** Set when the gateway answered with a DIFFERENT model — the row must disclose it. */
  servedBy?: string;
};

/** Live/persisted state of one Julius panel run, stored with the message. */
export type JuliusState = {
  decision: JuliusDecision;
  status: JuliusRunStatus;
  candidates: JuliusCandidateState[];
  /** Council reviews (proponent / critic / verifier) in council mode. */
  reviews: JuliusReviewState[];
  /** Chairman's ruling text, streamed live in council mode. */
  verdict?: string;
  chairmanModelId?: string;
  /** Set when a gateway fallback wrote the ruling — the verdict box must disclose it. */
  chairmanServedBy?: string;
  /** Chairman's live reasoning tail while deliberating; cleared once ruled. */
  chairmanThinking?: string;
  /** Index of the winning candidate once decided. */
  winner?: number;
  decidedBy?: "user" | "chairman";
  /**
   * Candidate indices whose ```action hub ops were already applied — set on
   * panel settle or a manual pick, so repeated picks never double-write.
   */
  hubOpsApplied?: number[];
  /**
   * Research mode: the shared deduped source list every candidate report
   * cites after renumbering — sources[n-1] resolves marker [n] in candidate
   * cards, council reviews, and the final merged report.
   */
  sources?: ResearchSource[];
  startedAt: number;
  finishedAt?: number;
};

/** Composer configuration for Julius panel runs. */
export type JuliusSettings = {
  /** Model selection ids answering in parallel (2-4). */
  candidateModelIds: string[];
  decision: JuliusDecision;
  proponentModelId: string;
  criticModelId: string;
  verifierModelId: string;
  chairmanModelId: string;
};

export type Conversation = {
  id: string;
  title: string;
  modelId: string;
  /** Agent profile driving this thread, when set. */
  agentId?: string;
  /** Set when this thread collects the runs of a scheduled automation. */
  automationId?: string;
  /** GitHub repository ("owner/repo") pinned from the composer — runs default their GitHub tools to it. */
  githubRepo?: string;
  /** Kept in the sidebar's Pinned section. */
  pinned?: boolean;
  /** Incognito thread: lives only in this tab — never persisted, never synced, no auto-memory. */
  incognito?: boolean;
  /** Write tools the user chose "Always allow in this chat" for — later runs skip the confirmation card. */
  mcpApproved?: McpToolApproval[];
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
};

/** One MCP tool approved for the rest of a chat. */
export type McpToolApproval = { serverId: string; toolName: string };

export type MemoryFact = {
  id: string;
  text: string;
  /** Loose grouping like "prefs", "health", "work", "people"; "" = none. */
  category: string;
  createdAt: number;
};

export type TrackerKind = "number" | "check";

/** A user-defined thing to track: water, spending, weight, habits, mood… */
export type Tracker = {
  id: string;
  name: string;
  /** Unit label like "glass", "₽", "km"; "" for unitless or check trackers. */
  unit: string;
  kind: TrackerKind;
  /** Daily goal; null = no goal. */
  goal: number | null;
  /** Index into the shared warm palette. */
  color: number;
  createdAt: number;
};

export type TrackerEntry = {
  id: string;
  trackerId: string;
  value: number;
  note?: string;
  at: number;
};

export type PersonalTask = {
  id: string;
  text: string;
  done: boolean;
  /** Due timestamp; null = no due date. */
  due: number | null;
  createdAt: number;
  completedAt?: number;
};

/** The personal assistant hub: memories, trackers, tasks — stored locally. */
export type LifeState = {
  memories: MemoryFact[];
  trackers: Tracker[];
  entries: TrackerEntry[];
  tasks: PersonalTask[];
  /** When true, every chat turn can read and update the hub. */
  shareWithAgent: boolean;
  /** Master memory switch: when false Gera neither saves new facts nor sees saved ones. Trackers and tasks are unaffected. */
  memoryEnabled: boolean;
};

export type AutomationCadence = "interval" | "daily" | "weekly";

/** Where an automation's scheduled fires happen. */
export type AutomationRunOn = "browser" | "server";

/** A scheduled prompt that runs in the background while the app is open. */
export type Automation = {
  id: string;
  name: string;
  prompt: string;
  cadence: AutomationCadence;
  /** Minutes between runs when cadence = "interval". */
  intervalMinutes: number;
  /** Local "HH:MM" fire time for daily/weekly cadences. */
  time: string;
  /** 0 (Sunday) - 6 (Saturday) for the weekly cadence. */
  weekday: number;
  /** Saved agent persona to run with; null = plain Gera. */
  agentId: string | null;
  /** null = every connected MCP server; otherwise allowed server/catalog ids — Cursor-style per-automation tool scoping. */
  mcpServerIds: string[] | null;
  /** null = every enabled skill; otherwise allowed skill ids — per-automation instruction packs. */
  skillIds: string[] | null;
  /** Incoming webhook trigger token (`wh_…`); null = off. POST /hooks/<token> on the backend fires this automation with the payload in the prompt. */
  webhookToken: string | null;
  /** Run as multi-wave deep research with a cited report. */
  deepResearch: boolean;
  enabled: boolean;
  /** Fire a schedule missed while the tab was closed once on next launch. */
  catchUp: boolean;
  /** "browser" fires while the tab is open; "server" fires in the cloud via cron. */
  runOn: AutomationRunOn;
  /** Minutes behind UTC (Date.getTimezoneOffset) captured on save — lets cloud runs fire daily/weekly at the user's local time. */
  tzOffsetMinutes: number;
  /** Thread that collects every run of this automation. */
  conversationId: string;
  lastRunAt?: number;
  nextRunAt: number;
  createdAt: number;
};

export type BuiltinToolId =
  | "web_search"
  | "fetch_url"
  | "selfsurf"
  | "generate_image"
  | "generate_video"
  | "generate_audio";

/** One document in an agent's knowledge base — plain text, retrieved per turn. */
export type KnowledgeDoc = {
  id: string;
  name: string;
  /** Full content for small files; a capped local preview when the full text lives in the cloud. */
  text: string;
  /** R2 object key when the full text is stored in the account's cloud space. */
  r2Key?: string;
  /** Character count of the cloud copy — honest size display and change detection. */
  fullChars?: number;
  addedAt: number;
};

/** Run kinds a skill can ride into: plain chat, Deep Research, Julius panels. */
export type SkillSurface = "chat" | "research" | "julius";

/**
 * A reusable instruction pack (Cursor-style skill): written once, it rides
 * into every run whose surface it targets — chat turns, Deep Research
 * pipelines, and Julius panels. Profiles can narrow the set via `skillIds`.
 */
export type Skill = {
  id: string;
  name: string;
  /** One-line "when to apply" hint shown to the model with the instructions. */
  description: string;
  /** The instructions themselves (markdown). */
  content: string;
  /**
   * Optional folder for grouping skills with one-click per-surface bulk
   * toggles. "" = explicitly ungrouped; an absent key marks a pre-folder blob
   * that may adopt its catalog folder once (matched by template name).
   */
  folder?: string;
  /** Master toggle — a disabled skill never reaches any run. */
  enabled: boolean;
  /** Which run kinds this skill applies to. */
  surfaces: Record<SkillSurface, boolean>;
  /**
   * MCP connectors this skill arms: when the skill rides a chat run, these
   * servers' tools are switched on regardless of the auto-router's guess.
   * Explicit profile/automation narrowing still wins — pins only override
   * the heuristic. Absent/empty = the skill brings no tools of its own.
   */
  mcpServerIds?: string[];
  createdAt: number;
};

/** A saved teammate: persona instructions plus an allowed tool pool. */
export type AgentProfile = {
  id: string;
  name: string;
  tagline: string;
  systemPrompt: string;
  /** Empty string = use whatever model is picked in the composer. */
  modelId: string;
  /** null = every enabled builtin tool; otherwise the allowed subset. */
  builtins: BuiltinToolId[] | null;
  /** null = every connected MCP server; otherwise allowed server/catalog ids. */
  mcpServerIds: string[] | null;
  /** null = every enabled skill; otherwise the allowed skill ids. */
  skillIds: string[] | null;
  /** Knowledge files: the most relevant excerpts are injected every turn. */
  knowledge: KnowledgeDoc[];
  createdAt: number;
};

/**
 * Auth strategy for an MCP server. "auto" (default) tries a pasted key, then
 * custom headers, then a stored browser sign-in, then open access.
 */
export type McpAuthMode = "auto" | "none" | "bearer" | "headers" | "oauth";

export type McpServerConfig = {
  id: string;
  name: string;
  url: string;
  headersJson: string;
  token?: string;
  /** Explicit auth choice for custom servers; catalog entries manage their own. */
  authMode?: McpAuthMode;
  catalogId?: string;
  enabled: boolean;
  status: "idle" | "connecting" | "connected" | "error";
  error?: string;
  /** Human-readable proof of the verified connection: workspace + admin for native connectors, server name for MCP. */
  identity?: string;
  /** Epoch ms of the last successful handshake + tool listing. */
  verifiedAt?: number;
  /** Non-secret proof that this account shard holds auth for the connector. */
  credentialStored?: boolean;
  tools: McpToolInfo[];
  disabledTools: string[];
  /** Prompts / resources the last health check listed (composer `/` and `@` menus). */
  promptCount?: number;
  resourceCount?: number;
  /**
   * OAuth Advanced: pinned scopes for the authorize request (RFC 6749 §3.3,
   * space-separated). Empty = the server's own hints decide. Metadata only.
   */
  oauthScopes?: string;
  /**
   * OAuth Advanced: authorization-server metadata document (RFC 8414 / OIDC)
   * used instead of the well-known walk. Public HTTPS only. Metadata only.
   */
  authServerMetadataUrl?: string;
  /**
   * A run hit `insufficient_scope` on this server: the next sign-in must ask
   * for wider access. Reported by the server-side check; cleared by a sign-in.
   */
  stepUp?: McpStepUp;
};

/** Pending OAuth step-up: what the server demanded and why. */
export type McpStepUp = {
  scopes: string[];
  code: string;
};

/** Spec tool annotations as the server declared them (hints, never guarantees). */
export type McpToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  title?: string;
  annotations?: McpToolAnnotations;
  /** MCP Apps: renders its own UI — never offered to the model, shown as a badge only. */
  uiOnly?: boolean;
};

/** One field of an MCP elicitation form (flattened from requestedSchema on the server). */
export type ElicitationField = {
  name: string;
  type: "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  required: boolean;
  enum?: string[];
  enumLabels?: string[];
  format?: "email" | "uri" | "date" | "date-time";
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: string | number | boolean;
};

/** What a confirmation card shows about the call it guards (redacted preview, never the raw arguments). */
export type RunPauseConfirmation = {
  toolName: string;
  risk: "write" | "destructive";
  argumentsPreview: string;
};

/**
 * An open question a live run paused on — an MCP elicitation form or a
 * write-tool confirmation; answered through /runs/answer.
 */
export type RunPauseRequest = {
  id: string;
  kind: "elicitation" | "confirmation";
  serverId: string;
  serverName: string;
  /** Elicitation: the server's question. Confirmation: what the tool does. */
  message: string;
  fields: ElicitationField[];
  createdAt: number;
  /** Epoch ms after which the server cancels on the user's behalf. */
  expiresAt: number;
  /** Present on confirmation cards only. */
  confirm?: RunPauseConfirmation;
};

/** Completion chime scope: never, only out-of-view finishes, or every finish. */
export type NotifySoundPref = "off" | "background" | "always";

/**
 * How generic MCP tools reach the model. "native" registers one function per
 * tool; "deferred" exposes mcp_search_tools / mcp_call_tool and loads schemas
 * on demand; "auto" defers once the visible tools or their schemas grow large.
 */
export type McpToolLoadingMode = "auto" | "native" | "deferred";

export type AgentSettings = {
  /** Active creation tab in the composer. */
  mode: CreateMode;
  /** Chat model selection id. */
  modelId: string;
  imageModelId: string;
  videoModelId: string;
  audioModelId: string;
  imageSize: ImageSize;
  /** Images generated per image-mode prompt (1-4); an explicit count typed in the prompt overrides it. */
  imageCount: number;
  videoAspect: VideoAspect;
  /** Text-to-speech voice; "" = provider default. */
  audioVoice: string;
  /** Custom instructions appended to the base system prompt for every thread. */
  systemPrompt: string;
  /** When true, a fast router model picks relevant tools per prompt. */
  autoTools: boolean;
  builtinTools: Record<BuiltinToolId, boolean>;
  mcpServers: McpServerConfig[];
  /** MCP tool loading for server runs — synced in the profile so cloud runs honor it too. */
  mcpToolLoading: McpToolLoadingMode;
  /**
   * Write and destructive MCP tools pause chat runs for a confirmation card;
   * unattended automations decline them honestly. Synced in the profile.
   */
  confirmWriteTools: boolean;
  /** Saved agent personas the user can chat with. */
  agents: AgentProfile[];
  /** Reusable instruction packs injected into matching runs (chat / research / Julius). */
  skills: Skill[];
  /** Scheduled prompts that run in the background while the app is open. */
  automations: Automation[];
  /** Julius panel configuration: candidates, decision mode, council models. */
  julius: JuliusSettings;
  /** Deep research budget preset — how much searching/reading one run may spend. */
  researchDepth: ResearchDepth;
  /** Chime when a reply finishes: off / when the thread is out of view / always. */
  notifySound: NotifySoundPref;
  /** Browser notification when a run finishes while the tab is hidden. */
  notifyDesktop: boolean;
  /** Desktop composer: Enter sends. When off, Enter is a newline and Ctrl/⌘+Enter sends. */
  enterSends: boolean;
  /** Home hero: project & screen shortcut chips above the greeting. */
  homeShortcuts: boolean;
  /** Hero composer: one-tap profile monograms at its top right. */
  composerProfiles: boolean;
};

export type OpenAiChatMessage =
  | {
      role: "system" | "user" | "assistant" | "tool";
      content: string | OpenAiContentPart[] | null;
      tool_calls?: OpenAiToolCall[];
      tool_call_id?: string;
    };

export type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type OpenAiTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};
