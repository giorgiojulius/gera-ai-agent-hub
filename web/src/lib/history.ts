import { defaultAgents } from "@/lib/agents";
import { normalizeAutomation } from "@/lib/automations";
import { newId } from "@/lib/env";
import { clampImageCount } from "@/lib/image-count";
import { MAX_DOCS_PER_AGENT, MAX_FILE_CHARS } from "@/lib/knowledge";
import { defaultJuliusSettings, JULIUS_MAX_CANDIDATES, JULIUS_MIN_CANDIDATES } from "@/lib/julius";
import { keepUserMcpServers } from "@/lib/mcp-catalog";
import { normalizeSkills } from "@/lib/skills";
import { DEFAULT_CHAT_MODEL, isCreateMode, MODE_MODEL_IDS, modeOfModelId, sanitizeModeModel } from "@/lib/models";
import type {
  AgentProfile,
  AgentSettings,
  Attachment,
  Automation,
  BuiltinToolId,
  ChatMessage,
  Conversation,
  CreateMode,
  ImageSize,
  JuliusSettings,
  KnowledgeDoc,
  McpServerConfig,
  QueuedMessage,
  VideoAspect,
} from "@/lib/types";

const HISTORY_KEY = "gera.conversations.v1";
const SETTINGS_KEY = "gera.settings.v1";
const ACTIVE_KEY = "gera.active.v1";
const QUEUE_KEY = "gera.queue.v1";
const DRAFT_KEY = "gera.draft.v1";
/** One-time flag: switches everyone's chat default to Grok 4.6 xHigh once. */
const MODEL_MIGRATION_KEY = "gera.migrate.grok-default.v1";
/** One-time flag: web access (search + fetch) becomes on for everyone once. */
const SEARCH_MIGRATION_KEY = "gera.migrate.web-search-on.v1";

const DEFAULT_TOOLS: Record<BuiltinToolId, boolean> = {
  web_search: true,
  fetch_url: true,
  selfsurf: true,
  generate_image: true,
  generate_video: false,
  generate_audio: true,
};

const IMAGE_SIZES: ImageSize[] = ["1024x1024", "1536x1024", "1024x1536"];
const VIDEO_ASPECTS: VideoAspect[] = ["16:9", "9:16", "1:1"];

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readJson<T>(key: string, fallback: T): T {
  if (!canUseStorage()) {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): boolean {
  if (!canUseStorage()) {
    return false;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // storage quota exceeded — caller decides how to slim down
  }
}

export function loadConversations(): Conversation[] {
  const items = readJson<Conversation[]>(HISTORY_KEY, []);
  return items
    .filter(
      (item) =>
        typeof item?.id === "string" &&
        Array.isArray(item.messages) &&
        // Blank drafts ("New thread" ghosts) never survive a reload.
        item.messages.length > 0,
    )
    .map((item) => ({ ...item, messages: item.messages.map(reviveMessage) }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Heals runs interrupted by a tab close — no spinner survives a reload.
 * Also reused when building share snapshots so a frozen public page never
 * shows a "running" state.
 */
export function reviveMessage(message: ChatMessage): ChatMessage {
  let next = message;
  if (message.pending) {
    // A run was writing into this message when the tab died (reload after a
    // publish, crash). Media that already landed means the turn essentially
    // delivered; otherwise the flag flips to an honest "interrupted" marker
    // the UI offers to continue.
    const delivered =
      (message.images?.length ?? 0) > 0 ||
      (message.videos?.length ?? 0) > 0 ||
      Boolean(message.audioUrl);
    next = delivered
      ? { ...next, pending: undefined }
      : { ...next, pending: undefined, interrupted: true };
  }
  if (message.research && message.research.status === "running") {
    next = {
      ...next,
      research: {
        ...message.research,
        status: "error",
        steps: message.research.steps.map((step) =>
          step.status === "running" ? { ...step, status: "error" as const } : step,
        ),
        finishedAt: message.research.finishedAt ?? Date.now(),
      },
    };
  }
  const julius = next.julius;
  if (!julius) {
    return next;
  }
  if (julius.status === "waiting") {
    // The research this stage was waiting for died with the tab — drop the placeholder.
    return { ...next, julius: undefined };
  }
  const candidates = julius.candidates.map((item) => {
    const research =
      item.research && item.research.status === "running"
        ? {
            ...item.research,
            status: "error" as const,
            steps: item.research.steps.map((step) =>
              step.status === "running" ? { ...step, status: "error" as const } : step,
            ),
            finishedAt: item.research.finishedAt ?? Date.now(),
          }
        : item.research;
    const healed = research === item.research ? item : { ...item, research };
    return healed.status === "running"
      ? healed.content.trim()
        ? { ...healed, status: "done" as const }
        : { ...healed, status: "error" as const, error: "Interrupted by reload." }
      : healed;
  });
  const reviews = (julius.reviews ?? []).map((item) =>
    item.status === "running" ? { ...item, status: "error" as const } : item,
  );
  const interrupted = julius.status === "candidates" || julius.status === "debate";
  // Single candidate = quality check: nothing to pick, settle as done.
  // A reload mid-synthesis keeps the ruling — the winner is already decided.
  const status = interrupted
    ? candidates.some((item) => item.content.trim())
      ? candidates.length === 1
        ? ("done" as const)
        : ("choice" as const)
      : ("error" as const)
    : julius.status === "synthesis"
      ? ("done" as const)
      : julius.status;
  return {
    ...next,
    julius: {
      ...julius,
      candidates,
      reviews,
      status,
      finishedAt: status !== julius.status ? julius.finishedAt ?? Date.now() : julius.finishedAt,
    },
  };
}

/** Threads (newest first) whose inline media survive a storage-quota squeeze. */
const MEDIA_KEEP_THREADS = 6;

/**
 * Inline base64 payloads and device-local vault refs. Both are dropped when
 * slimming: data URLs for size, `idb:` refs because they only resolve on the
 * device that stored the blob.
 */
function isHeavyMedia(value: string): boolean {
  return value.startsWith("data:") || value.startsWith("idb:");
}

function trimStored(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… [trimmed in storage]` : text;
}

/**
 * Drops bulky inline media and shrinks giant tool results. Used for the
 * localStorage quota fallback and by cloud sync when a chat exceeds the
 * per-chat payload budget.
 */
export function slimMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    attachments: message.attachments?.map((item) => {
      const next = isHeavyMedia(item.dataUrl) ? { ...item, dataUrl: "" } : item;
      return typeof next.text === "string" && next.text.length > 2_000
        ? { ...next, text: trimStored(next.text, 2_000) }
        : next;
    }),
    images: message.images?.filter((item) => !isHeavyMedia(item)),
    videos: message.videos?.filter((item) => !isHeavyMedia(item)),
    audioUrl: message.audioUrl && isHeavyMedia(message.audioUrl) ? undefined : message.audioUrl,
    toolCalls: message.toolCalls?.map((call) =>
      call.result && call.result.length > 2000
        ? { ...call, result: trimStored(call.result, 2000) }
        : call,
    ),
    sources: message.sources && message.sources.length > 24 ? message.sources.slice(0, 24) : message.sources,
    julius: message.julius
      ? {
          ...message.julius,
          candidates: message.julius.candidates.map((item) => ({
            ...item,
            content: trimStored(item.content, 4000),
            toolCalls: undefined,
            research: undefined,
          })),
          reviews: message.julius.reviews.map((item) => ({
            ...item,
            content: trimStored(item.content, 2000),
            toolCalls: undefined,
          })),
        }
      : undefined,
  };
}

/**
 * Trailing debounce for history writes. Streaming used to re-stringify the
 * ENTIRE history on every token (plus a multi-pass quota cascade when
 * localStorage was full) — the dominant allocation churn behind
 * out-of-memory tab crashes. Writes now land at most every 800 ms, and
 * always synchronously when the tab hides or closes.
 */
const SAVE_DEBOUNCE_MS = 800;
let pendingSave: Conversation[] | null = null;
let saveTimer: number | null = null;

export function saveConversations(conversations: Conversation[]): void {
  if (!canUseStorage()) {
    return;
  }
  pendingSave = conversations;
  if (saveTimer !== null) {
    return; // the scheduled write picks up the latest pending list
  }
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    flushConversations();
  }, SAVE_DEBOUNCE_MS);
}

/** Writes whatever is pending right now — fired on tab hide/close. */
export function flushConversations(): void {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (pendingSave === null) {
    return;
  }
  const conversations = pendingSave;
  pendingSave = null;
  writeHistoryNow(conversations);
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("pagehide", flushConversations);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      flushConversations();
    }
  });
}

/**
 * Quota-safe persistence: losing the whole history silently is the worst
 * outcome, so on overflow we first strip heavy media from older threads,
 * then drop the oldest threads until the newest ones fit.
 */
function writeHistoryNow(conversations: Conversation[]): void {
  // Incognito threads and blank drafts stay in memory only.
  const persistable = conversations.filter(
    (item) => item.incognito !== true && item.messages.length > 0,
  );
  if (writeJson(HISTORY_KEY, persistable)) {
    return;
  }
  const slimmed = persistable.map((conversation, index) =>
    index < MEDIA_KEEP_THREADS
      ? conversation
      : { ...conversation, messages: conversation.messages.map(slimMessage) },
  );
  if (writeJson(HISTORY_KEY, slimmed)) {
    console.warn("gera: storage quota reached — trimmed inline media in older threads to keep history.");
    return;
  }
  let trimmed = slimmed;
  while (trimmed.length > 1) {
    trimmed = trimmed.slice(0, Math.max(1, Math.floor(trimmed.length / 2)));
    if (writeJson(HISTORY_KEY, trimmed)) {
      console.warn(`gera: storage quota reached — kept the ${trimmed.length} most recent threads.`);
      return;
    }
  }
  console.warn("gera: history no longer fits in storage; changes stay in memory for this session.");
}

/**
 * Storage-safe copy of the follow-up queue. Raw base64 payloads would blow
 * the quota, so they persist only when their extracted text carries the
 * content; vault refs (`idb:`) are tiny and survive as-is.
 */
export function slimQueuedForStorage(
  queued: Record<string, QueuedMessage[]>,
): Record<string, QueuedMessage[]> {
  const out: Record<string, QueuedMessage[]> = {};
  for (const [key, items] of Object.entries(queued)) {
    if (items.length === 0) {
      continue;
    }
    out[key] = items.map((item) => ({
      ...item,
      attachments: item.attachments.flatMap((file) => {
        if (!file.dataUrl.startsWith("data:")) {
          return [file];
        }
        return typeof file.text === "string" && file.text.trim() ? [{ ...file, dataUrl: "" }] : [];
      }),
    }));
  }
  return out;
}

function normalizeQueuedAttachment(value: unknown): Attachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const file = value as Partial<Attachment>;
  if (typeof file.dataUrl !== "string" || typeof file.name !== "string") {
    return null;
  }
  const text = typeof file.text === "string" ? file.text : undefined;
  if (!file.dataUrl && !(text && text.trim())) {
    return null; // nothing restorable — no bytes, no text
  }
  return {
    id: typeof file.id === "string" && file.id ? file.id : newId(),
    name: file.name || "file",
    mime: typeof file.mime === "string" && file.mime ? file.mime : "application/octet-stream",
    dataUrl: file.dataUrl,
    ...(text !== undefined ? { text } : {}),
  };
}

/**
 * Validates a stored follow-up queue. The `steer` flag never survives — the
 * run it was handed to died with the tab, so restored items are plain queued
 * follow-ups again.
 */
export function normalizeStoredQueue(raw: unknown): Record<string, QueuedMessage[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, QueuedMessage[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !Array.isArray(value)) {
      continue;
    }
    const items = value.flatMap((entry): QueuedMessage[] => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const item = entry as Partial<QueuedMessage>;
      if (typeof item.text !== "string") {
        return [];
      }
      const attachments = Array.isArray(item.attachments)
        ? item.attachments
            .map(normalizeQueuedAttachment)
            .filter((file): file is Attachment => file !== null)
        : [];
      if (!item.text.trim() && attachments.length === 0) {
        return [];
      }
      return [
        {
          id: typeof item.id === "string" && item.id ? item.id : newId(),
          text: item.text,
          attachments,
          mode: isCreateMode(item.mode) ? item.mode : "chat",
          deepResearch: item.deepResearch === true,
          julius: item.julius === true,
          createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
        },
      ];
    });
    if (items.length > 0) {
      out[key] = items;
    }
  }
  return out;
}

export function loadQueuedFollowUps(): Record<string, QueuedMessage[]> {
  return normalizeStoredQueue(readJson<unknown>(QUEUE_KEY, {}));
}

export function saveQueuedFollowUps(queued: Record<string, QueuedMessage[]>): void {
  writeJson(QUEUE_KEY, slimQueuedForStorage(queued));
}

/** Composer draft survives reloads — nothing typed is lost to a publish. */
export function loadComposerDraft(): string {
  if (!canUseStorage()) {
    return "";
  }
  return window.localStorage.getItem(DRAFT_KEY) ?? "";
}

export function saveComposerDraft(value: string): void {
  if (!canUseStorage()) {
    return;
  }
  try {
    if (value) {
      window.localStorage.setItem(DRAFT_KEY, value);
    } else {
      window.localStorage.removeItem(DRAFT_KEY);
    }
  } catch {
    // quota — the draft is a convenience, never worth failing over
  }
}

export function loadActiveId(): string | null {
  if (!canUseStorage()) {
    return null;
  }
  return window.localStorage.getItem(ACTIVE_KEY);
}

export function saveActiveId(id: string | null): void {
  if (!canUseStorage()) {
    return;
  }
  if (id) {
    window.localStorage.setItem(ACTIVE_KEY, id);
  } else {
    window.localStorage.removeItem(ACTIVE_KEY);
  }
}

/**
 * Validates any settings blob — localStorage or cloud-synced — into a safe
 * AgentSettings: unknown models fall back, verified MCP servers stay
 * connected ("connect once and forget" — boot re-verifies them quietly),
 * agents and automations are normalized item by item.
 */
export function normalizeStoredSettings(raw: unknown): AgentSettings {
  const stored = (
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  ) as Partial<AgentSettings>;
  const servers = Array.isArray(stored.mcpServers) ? stored.mcpServers.map(normalizeServer) : [];
  const agents = Array.isArray(stored.agents)
    ? stored.agents.map((item) => normalizeAgent(item as Partial<AgentProfile>))
    : defaultAgents();
  const automations = Array.isArray(stored.automations)
    ? stored.automations.map((item) => normalizeAutomation(item as Partial<Automation>))
    : [];

  // Older versions stored image/video picks in modelId — move them to their tab.
  const legacyId = typeof stored.modelId === "string" ? stored.modelId : "";
  const legacyMode = legacyId ? modeOfModelId(legacyId) : undefined;
  const mode: CreateMode = isCreateMode(stored.mode)
    ? stored.mode
    : legacyMode && legacyMode !== "chat"
      ? legacyMode
      : "chat";

  return {
    mode,
    modelId: sanitizeModeModel("chat", legacyMode === "chat" || !legacyMode ? legacyId : ""),
    imageModelId: sanitizeModeModel(
      "image",
      typeof stored.imageModelId === "string" ? stored.imageModelId : legacyMode === "image" ? legacyId : "",
    ),
    videoModelId: sanitizeModeModel(
      "video",
      typeof stored.videoModelId === "string" ? stored.videoModelId : legacyMode === "video" ? legacyId : "",
    ),
    audioModelId: sanitizeModeModel("audio", typeof stored.audioModelId === "string" ? stored.audioModelId : ""),
    imageSize: IMAGE_SIZES.includes(stored.imageSize as ImageSize) ? (stored.imageSize as ImageSize) : "1024x1024",
    imageCount: clampImageCount(typeof stored.imageCount === "number" ? stored.imageCount : 1),
    videoAspect: VIDEO_ASPECTS.includes(stored.videoAspect as VideoAspect)
      ? (stored.videoAspect as VideoAspect)
      : "16:9",
    audioVoice: typeof stored.audioVoice === "string" ? stored.audioVoice : "",
    systemPrompt: typeof stored.systemPrompt === "string" ? stored.systemPrompt : "",
    autoTools: typeof stored.autoTools === "boolean" ? stored.autoTools : true,
    builtinTools: { ...DEFAULT_TOOLS, ...(stored.builtinTools ?? {}) },
    mcpServers: keepUserMcpServers(servers),
    agents,
    skills: normalizeSkills(stored.skills),
    automations,
    julius: normalizeJulius(stored.julius),
    researchDepth:
      stored.researchDepth === "eco" || stored.researchDepth === "max" ? stored.researchDepth : "balanced",
    notifySound:
      stored.notifySound === "off" || stored.notifySound === "always" ? stored.notifySound : "background",
    notifyDesktop: stored.notifyDesktop === true,
    enterSends: stored.enterSends !== false,
    homeShortcuts: stored.homeShortcuts !== false,
    composerProfiles: stored.composerProfiles !== false,
  };
}

export function loadSettings(): AgentSettings {
  let settings = normalizeStoredSettings(readJson<Partial<AgentSettings>>(SETTINGS_KEY, {}));
  // One-time default switch: Grok 4.6 xHigh becomes the chat default for
  // existing installs too; picks made after the migration stick normally.
  if (canUseStorage() && window.localStorage.getItem(MODEL_MIGRATION_KEY) !== "1") {
    window.localStorage.setItem(MODEL_MIGRATION_KEY, "1");
    settings = { ...settings, modelId: DEFAULT_CHAT_MODEL };
  }
  // One-time default switch: web search (and URL fetch, which reads the found
  // pages) turns on even for installs that had it off; the Settings toggle
  // still works for anyone who flips it back afterwards.
  if (canUseStorage() && window.localStorage.getItem(SEARCH_MIGRATION_KEY) !== "1") {
    window.localStorage.setItem(SEARCH_MIGRATION_KEY, "1");
    settings = {
      ...settings,
      builtinTools: { ...settings.builtinTools, web_search: true, fetch_url: true },
    };
  }
  return settings;
}

/** Sanitizes stored Julius config; removed models fall back to defaults. */
function normalizeJulius(stored: unknown): JuliusSettings {
  const defaults = defaultJuliusSettings();
  if (!stored || typeof stored !== "object") {
    return defaults;
  }
  const raw = stored as Partial<JuliusSettings>;
  const chatIds = MODE_MODEL_IDS.chat;
  const sanitize = (id: unknown, fallback: string): string =>
    typeof id === "string" && chatIds.includes(id) ? id : fallback;
  const candidates = Array.isArray(raw.candidateModelIds)
    ? raw.candidateModelIds
        .filter((id): id is string => typeof id === "string" && chatIds.includes(id))
        .slice(0, JULIUS_MAX_CANDIDATES)
    : [];
  return {
    candidateModelIds: candidates.length >= JULIUS_MIN_CANDIDATES ? candidates : defaults.candidateModelIds,
    decision: raw.decision === "manual" || raw.decision === "council" ? raw.decision : defaults.decision,
    proponentModelId: sanitize(raw.proponentModelId, defaults.proponentModelId),
    criticModelId: sanitize(raw.criticModelId, defaults.criticModelId),
    verifierModelId: sanitize(raw.verifierModelId, defaults.verifierModelId),
    chairmanModelId: sanitize(raw.chairmanModelId, defaults.chairmanModelId),
  };
}

export function saveSettings(settings: AgentSettings): void {
  writeJson(SETTINGS_KEY, settings);
}

const BUILTIN_IDS: BuiltinToolId[] = [
  "web_search",
  "fetch_url",
  "selfsurf",
  "generate_image",
  "generate_video",
  "generate_audio",
];

function normalizeKnowledgeDoc(value: unknown): KnowledgeDoc | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const doc = value as Partial<KnowledgeDoc>;
  if (typeof doc.text !== "string" || doc.text.trim().length === 0) {
    return null;
  }
  return {
    id: typeof doc.id === "string" && doc.id ? doc.id : newId(),
    name: typeof doc.name === "string" && doc.name.trim() ? doc.name : "Document",
    text: doc.text.slice(0, MAX_FILE_CHARS + 100),
    addedAt: typeof doc.addedAt === "number" ? doc.addedAt : Date.now(),
  };
}

function normalizeAgent(agent: Partial<AgentProfile>): AgentProfile {
  return {
    id: typeof agent.id === "string" && agent.id ? agent.id : newId(),
    name: typeof agent.name === "string" && agent.name.trim() ? agent.name : "Agent",
    tagline: typeof agent.tagline === "string" ? agent.tagline : "",
    systemPrompt: typeof agent.systemPrompt === "string" ? agent.systemPrompt : "",
    // Removed catalog models (e.g. retired generations) fall back to the composer pick.
    modelId:
      typeof agent.modelId === "string" && MODE_MODEL_IDS.chat.includes(agent.modelId) ? agent.modelId : "",
    builtins: Array.isArray(agent.builtins)
      ? agent.builtins.filter((id): id is BuiltinToolId => BUILTIN_IDS.includes(id as BuiltinToolId))
      : null,
    mcpServerIds: Array.isArray(agent.mcpServerIds) ? agent.mcpServerIds.map(String) : null,
    skillIds: Array.isArray(agent.skillIds) ? agent.skillIds.map(String) : null,
    knowledge: Array.isArray(agent.knowledge)
      ? agent.knowledge
          .map(normalizeKnowledgeDoc)
          .filter((doc): doc is KnowledgeDoc => doc !== null)
          .slice(0, MAX_DOCS_PER_AGENT)
      : [],
    createdAt: typeof agent.createdAt === "number" ? agent.createdAt : Date.now(),
  };
}

const MCP_AUTH_MODES = new Set(["auto", "none", "bearer", "headers", "oauth"]);

function normalizeServer(server: McpServerConfig): McpServerConfig {
  return {
    ...server,
    authMode:
      typeof server.authMode === "string" && MCP_AUTH_MODES.has(server.authMode)
        ? server.authMode
        : undefined,
    headersJson: typeof server.headersJson === "string" ? server.headersJson : "",
    token: typeof server.token === "string" ? server.token : "",
    catalogId: typeof server.catalogId === "string" ? server.catalogId : undefined,
    // "Connect once and forget": a verified server stays connected across
    // reloads — auth material persists too (tokens in this config, sign-ins
    // in localStorage) and every call re-handshakes lazily. Boot re-verifies
    // in the background and flips truly dead sign-ins to an honest error.
    status: server.status === "connected" ? "connected" : server.status === "error" ? "error" : "idle",
    error: typeof server.error === "string" ? server.error : undefined,
    identity: typeof server.identity === "string" ? server.identity : undefined,
    verifiedAt: typeof server.verifiedAt === "number" ? server.verifiedAt : undefined,
    tools: Array.isArray(server.tools) ? server.tools : [],
    disabledTools: Array.isArray(server.disabledTools) ? server.disabledTools : [],
  };
}

export function titleFromPrompt(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) {
    return "New thread";
  }
  return cleaned.length > 42 ? `${cleaned.slice(0, 42).trim()}…` : cleaned;
}
