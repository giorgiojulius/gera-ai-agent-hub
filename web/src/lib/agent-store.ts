import { toast } from "sonner";

import { serializeConversation } from "@/lib/chat-sync";
import { mergeCodeChangeStates } from "@/lib/code-changes";
import { githubRepoRefs, injectGitHubRunAuth, pinnedRepoPromptBlock, resolveGitHubAuth } from "@/lib/github-native";
import {
  ackServerRun,
  attachServerRun,
  listActiveServerRuns,
  resolveCloudMediaRefs,
  startServerRun,
  steerServerRun,
  stopServerRun,
  toWireAttachment,
  toWireMessages,
  type ActiveServerRun,
  type ServerRunConfig,
  type ServerRunDone,
  type ServerRunEvent,
  type ServerRunKind,
  type ServerSteerItem,
} from "@/lib/server-run";
import { newId } from "@/lib/env";
import { errorFromUnknown } from "@/lib/errors";
import { normalizeExecutionOutcome } from "@/lib/execution-outcome";
import { filterMcpServersByIds } from "@/lib/automations";
import {
  loadActiveId,
  loadComposerDraft,
  loadConversations,
  loadQueuedFollowUps,
  loadSettings,
  saveActiveId,
  saveConversations,
  saveSettings,
  titleFromPrompt,
} from "@/lib/history";
import { RESUME_NOTE, planBootAutoResume } from "@/lib/resume";
import { logDiagnostic } from "@/lib/diagnostics";
import { fallbackQuery, fetchGrounding, type Grounding } from "@/lib/grounding";
import { allowedLifeOps, applyLifeOps, buildPersonalContext, extractActionOps, hasMemory, loadLife } from "@/lib/life";
import { retrieveKnowledgeSmart } from "@/lib/knowledge-index";
import { catalogEntryToServer, findCatalogEntry, missingCatalogEntries } from "@/lib/mcp-catalog";
import { resolveMessagesForApi, vaultDataUrl } from "@/lib/media-vault";
import { buildSkillsBlock, filterSkillsByIds, skillPinnedServerIds, skillsForSurface } from "@/lib/skills";
import { applySkillOps, buildSkillsEditorContext, extractSkillOps } from "@/lib/skill-ops";
import { drainSteering, registerSteerableRun, stripSteerFlags, unregisterSteerableRun, watchSteering } from "@/lib/steering";
import { McpAuthError, connectMcpServer, newMcpServer } from "@/lib/mcp";
import { hasOAuthRefreshToken, hasOAuthToken, runOAuthSignIn } from "@/lib/mcp-oauth";
import {
  IMAGE_EDIT_MODEL,
  modelIdForMode,
  modelShortName,
  parseModelSelection,
  resolveVideoModelForImage,
  sanitizeChatModel,
  videoImageSwitchNote,
  videoModelTakesLocalFiles,
} from "@/lib/models";
import { extractImageUrl } from "@/lib/image-url";
import { resizeImageForUpload, shrinkMessagesForApi, type UploadImage } from "@/lib/resize-image";
import { planTools, routerContextDigest } from "@/lib/router";
import { reportModelUsage, turnUsageEvents } from "@/lib/telemetry";
import { generateChatTitle } from "@/lib/title";
import { beginUsageCapture, endUsageCapture, reportUsage } from "@/lib/usage";
import { clampImageCount, MAX_IMAGE_COUNT, parseImageCount } from "@/lib/image-count";
import { generateAudio, generateImageBatch, generateVideo, type VideoImageInput } from "@/lib/tools";
import type {
  AgentProfile,
  AgentSettings,
  Attachment,
  BuiltinToolId,
  ChatMessage,
  Conversation,
  CreateMode,
  ExecutionOutcome,
  JuliusState,
  LifeState,
  McpServerConfig,
  QueuedMessage,
  Skill,
  SkillSurface,
} from "@/lib/types";

export type AgentState = {
  conversations: Conversation[];
  activeId: string | null;
  settings: AgentSettings;
  /** Personal assistant hub: memories, trackers, tasks — persisted locally. */
  life: LifeState;
  input: string;
  attachments: Attachment[];
  /** Conversation ids with an in-flight run — threads stream in parallel like cloud agents. */
  runningIds: string[];
  /** Threads that finished while the user was looking at another thread. */
  unreadIds: string[];
  /** Follow-ups waiting per thread — dispatched FIFO when the run settles. */
  queued: Record<string, QueuedMessage[]>;
  /** When true, the next chat prompt runs the multi-wave research loop. */
  deepResearch: boolean;
  /** When true, the next chat prompt runs a Julius panel of parallel models. */
  julius: boolean;
  sidebarOpen: boolean;
};

/**
 * Skill write-back: applies ```action skill ops once when a chat turn
 * settles. Outcomes are surfaced honestly — a toast per created/updated
 * skill plus the reason for every rejection; never silent.
 */
function settleSkillOps(
  content: string,
  currentSkills: Skill[],
  connectors: McpServerConfig[],
  setState: (updater: (prev: AgentState) => AgentState) => void,
): void {
  const ops = extractSkillOps(content);
  if (ops.length === 0) {
    return;
  }
  // Preview against the turn's snapshot for honest toasts; the actual write
  // applies to the freshest state inside the updater (pure, StrictMode-safe).
  const preview = applySkillOps(currentSkills, ops, { connectors });
  setState((prev) => ({
    ...prev,
    settings: {
      ...prev.settings,
      skills: applySkillOps(prev.settings.skills, ops, { connectors }).skills,
    },
  }));
  for (const outcome of preview.outcomes) {
    if (outcome.kind === "rejected") {
      toast.error(`Skill not saved: ${outcome.name}`, { description: outcome.reason });
    } else {
      toast.success(
        outcome.kind === "created" ? `Skill created: ${outcome.name}` : `Skill updated: ${outcome.name}`,
        {
          // An op note (e.g. unknown connectors ignored) outranks the generic line.
          description:
            outcome.note ?? "It rides into runs from the next message. Manage it on the Skills page.",
        },
      );
    }
  }
}

export function initialAgentState(): AgentState {
  const loaded = loadConversations();
  const savedActive = loadActiveId();
  const activeId = loaded.some((item) => item.id === savedActive)
    ? savedActive
    : loaded[0]?.id ?? null;
  // Seamless publish recovery: a fresh reply that a reload cut mid-stream is
  // re-marked pending before the first render (the "interrupted" chip never
  // flashes) and boot recovery silently picks it back up.
  const { conversations } = planBootAutoResume(loaded, activeId);
  return {
    conversations,
    activeId,
    settings: loadSettings(),
    life: loadLife(),
    // Publish-safe: the draft and the follow-up queue survive reloads.
    input: loadComposerDraft(),
    attachments: [],
    runningIds: [],
    unreadIds: [],
    queued: loadQueuedFollowUps(),
    deepResearch: false,
    julius: false,
    sidebarOpen: false,
  };
}

function persist(conversations: Conversation[], activeId: string | null): void {
  saveConversations(conversations);
  saveActiveId(activeId);
}

export function activeConversation(state: AgentState): Conversation | null {
  return state.conversations.find((item) => item.id === state.activeId) ?? null;
}

export function createConversation(modelId: string, agentId?: string): Conversation {
  const now = Date.now();
  return {
    id: newId(),
    title: "New thread",
    modelId,
    agentId,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Narrows global settings to an agent's persona and allowed tool pool. */
function agentScopedSettings(settings: AgentSettings, agent: AgentProfile): AgentSettings {
  const persona = [
    `You are "${agent.name}"${agent.tagline.trim() ? ` — ${agent.tagline.trim()}` : ""}.`,
    agent.systemPrompt.trim(),
    settings.systemPrompt.trim(),
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
  const allow = agent.builtins;
  return {
    ...settings,
    systemPrompt: persona,
    builtinTools: allow
      ? {
          web_search: settings.builtinTools.web_search && allow.includes("web_search"),
          fetch_url: settings.builtinTools.fetch_url && allow.includes("fetch_url"),
          selfsurf: settings.builtinTools.selfsurf && allow.includes("selfsurf"),
          generate_image: settings.builtinTools.generate_image && allow.includes("generate_image"),
          generate_video: settings.builtinTools.generate_video && allow.includes("generate_video"),
          generate_audio: settings.builtinTools.generate_audio && allow.includes("generate_audio"),
        }
      : settings.builtinTools,
    mcpServers: filterMcpServersByIds(settings.mcpServers, agent.mcpServerIds),
  };
}

export function upsertConversation(list: Conversation[], next: Conversation): Conversation[] {
  const exists = list.some((item) => item.id === next.id);
  const updated = exists ? list.map((item) => (item.id === next.id ? next : item)) : [next, ...list];
  return updated.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Runs a prompt into a specific thread without touching the composer or focus. */
export type SendOverrides = {
  prompt: string;
  /** Target thread id; the thread is created on the fly when missing. */
  conversationId: string;
  /** Title used when the thread does not exist yet. */
  title?: string;
  agentId?: string | null;
  deepResearch?: boolean;
  /** Run as a Julius panel: parallel candidates + decision. */
  julius?: boolean;
  /** Marks the thread as fed by a scheduled automation. */
  automationId?: string;
  /** Per-automation MCP allow-list; an array narrows servers for this run (Cursor-style). */
  mcpServerIds?: string[] | null;
  /** Per-automation skills allow-list; an array narrows instruction packs for this run. */
  skillIds?: string[] | null;
  /** Creation mode for this run; background runs default to chat. */
  mode?: CreateMode;
  /** Replaces the thread history before appending — powers edit-and-resend. */
  replaceMessages?: ChatMessage[];
  /** Attachments carried over with an edited prompt. */
  attachments?: Attachment[];
};

/**
 * Rides along when steering lands in the instant between the answer finishing
 * and the run settling: the shown reply stays put and one extra round APPENDS
 * a continuation addressing the guidance — never a rewrite.
 */
const STEER_WRAP_NOTE =
  "[steering] The user message above arrived just as your previous reply finished. That reply stays on screen exactly as written, and what you write now is appended below it as a continuation of the same answer. The guidance supplements the request you just answered — it is not a new topic: address it directly, building on what you already wrote without repeating it. If the guidance changes something you already wrote, state the correction plainly instead of pretending the earlier text said otherwise.";

/**
 * Live-turn ownership per conversation. A successor turn (interrupt, "stop &
 * send", a quick re-send after Stop) seeds while the aborted predecessor is
 * still unwinding asynchronously — the predecessor's cleanup must not stomp
 * the new run: closing the successor's steering inbox would kill its steering
 * ("This run can't take mid-run steering") and clearing its running flag
 * would hide the Stop button for a run that is very much alive.
 */
const turnOwners = new Map<string, symbol>();

type SetAgentState = (updater: (prev: AgentState) => AgentState) => void;

/** Inserts consumed steering messages above the streaming bubble (deduped by id). */
function insertSteeredIntoThread(
  setState: SetAgentState,
  conversationId: string,
  assistantId: string,
  items: ServerSteerItem[],
): void {
  if (items.length === 0) {
    return;
  }
  const threadMessages: ChatMessage[] = items.map((item) => ({
    id: item.id,
    role: "user" as const,
    content: item.text,
    attachments:
      item.attachments.length > 0
        ? item.attachments.map((file) => ({
            id: newId(),
            name: file.name,
            mime: file.mime,
            dataUrl: file.dataUrl,
            ...(file.text ? { text: file.text } : {}),
          }))
        : undefined,
    createdAt: Date.now(),
  }));
  setState((prev) => {
    const current = prev.conversations.find((entry) => entry.id === conversationId);
    if (!current) {
      return prev;
    }
    const index = current.messages.findIndex((message) => message.id === assistantId);
    if (index < 0) {
      return prev;
    }
    const fresh = threadMessages.filter(
      (message) => !current.messages.some((existing) => existing.id === message.id),
    );
    const consumedIds = new Set(items.map((item) => item.id));
    if (fresh.length === 0) {
      return {
        ...prev,
        queued: {
          ...prev.queued,
          [conversationId]: (prev.queued[conversationId] ?? []).filter((entry) => !consumedIds.has(entry.id)),
        },
      };
    }
    const messages = [
      ...current.messages.slice(0, index),
      ...fresh,
      ...current.messages.slice(index),
    ];
    const conversations = upsertConversation(prev.conversations, {
      ...current,
      messages,
      updatedAt: Date.now(),
    });
    persist(conversations, prev.activeId);
    return {
      ...prev,
      conversations,
      queued: {
        ...prev.queued,
        [conversationId]: (prev.queued[conversationId] ?? []).filter((entry) => !consumedIds.has(entry.id)),
      },
    };
  });
}

/** Maps one live run event onto the streaming assistant bubble. */
function applyRunEvent(
  event: ServerRunEvent,
  patchAssistant: (patch: Partial<ChatMessage>) => void,
  insertSteered: (items: ServerSteerItem[]) => void,
): void {
  switch (event.t) {
    case "snapshot": {
      const snap = event.snapshot;
      if (snap.steered && snap.steered.length > 0) {
        insertSteered(snap.steered);
      }
      patchAssistant({
        ...(snap.content ? { content: snap.content } : {}),
        ...(snap.toolCalls && snap.toolCalls.length > 0 ? { toolCalls: snap.toolCalls } : {}),
        ...(snap.codeChanges ? { codeChanges: snap.codeChanges } : {}),
        ...(snap.sources && snap.sources.length > 0 ? { sources: snap.sources } : {}),
        ...(snap.research ? { research: snap.research } : {}),
        ...(snap.julius ? { julius: snap.julius } : {}),
      });
      return;
    }
    case "text":
      patchAssistant({ content: event.content });
      return;
    case "tools":
      patchAssistant({ toolCalls: event.toolCalls });
      return;
    case "code":
      patchAssistant({ codeChanges: event.codeChanges });
      return;
    case "sources":
      patchAssistant({ sources: event.sources });
      return;
    case "research":
      patchAssistant({
        research: event.research,
        ...(event.research.sources.length > 0 ? { sources: event.research.sources } : {}),
      });
      return;
    case "julius":
      patchAssistant({
        julius: event.julius,
        ...(event.sources && event.sources.length > 0 ? { sources: event.sources } : {}),
      });
      return;
    case "steered":
      insertSteered(event.items);
      return;
    default:
      return;
  }
}

/** Resolves cloud media refs, vaults them, and replays server usage locally. */
async function settleDone(done: ServerRunDone): Promise<Partial<ChatMessage>> {
  // Token usage happened on the server — replay it into this turn's capture
  // so pricing and arena telemetry keep working.
  for (const event of done.usageEvents) {
    reportUsage(event.modelId, event.usage, event.service ? "service" : undefined);
  }
  const message = done.message;
  let images: string[] | undefined;
  let videos: string[] | undefined;
  let audioUrl: string | undefined;
  if (message.images && message.images.length > 0) {
    const { resolved } = await resolveCloudMediaRefs(message.images);
    images = await Promise.all(resolved.map(vaultDataUrl));
  }
  if (message.videos && message.videos.length > 0) {
    const { resolved } = await resolveCloudMediaRefs(message.videos);
    videos = await Promise.all(resolved.map(vaultDataUrl));
  }
  if (message.audioUrl) {
    const { resolved } = await resolveCloudMediaRefs([message.audioUrl]);
    audioUrl = resolved[0] ? await vaultDataUrl(resolved[0]) : undefined;
  }
  return {
    content: message.content,
    toolCalls: message.toolCalls && message.toolCalls.length > 0 ? message.toolCalls : undefined,
    codeChanges: message.codeChanges,
    execution: normalizeExecutionOutcome(message.execution),
    sources: message.sources && message.sources.length > 0 ? message.sources : undefined,
    ...(message.servedBy ? { servedBy: message.servedBy } : {}),
    ...(message.research ? { research: message.research } : {}),
    ...(message.julius ? { julius: message.julius } : {}),
    ...(images && images.length > 0 ? { images } : {}),
    ...(videos && videos.length > 0 ? { videos } : {}),
    ...(audioUrl ? { audioUrl } : {}),
    interrupted: message.interrupted ? true : undefined,
  };
}

/** Aligns the local LWW clock with the server's post-run write — sync sees equality. */
function reconcileServerClock(setState: SetAgentState, conversationId: string, chatUpdatedAt: number): void {
  if (chatUpdatedAt <= 0) {
    return;
  }
  setState((prev) => {
    const current = prev.conversations.find((item) => item.id === conversationId);
    if (!current || current.updatedAt >= chatUpdatedAt) {
      return prev;
    }
    const conversations = upsertConversation(prev.conversations, { ...current, updatedAt: chatUpdatedAt });
    persist(conversations, prev.activeId);
    return { ...prev, conversations };
  });
}

/**
 * Bridges the local steering inbox to the live server run: every offered
 * message is forwarded immediately; the server soft-cuts its in-flight
 * stream and weaves the guidance in. A refused/failed forward honestly
 * falls back to the ordinary queue.
 *
 * `started` gates the forwards: guidance typed while the run is still being
 * registered on the server waits for the start acknowledgment instead of
 * bouncing off as "not running" and degrading into a separate follow-up turn.
 */
function createSteerBridge(
  conversationId: string,
  setState: SetAgentState,
  started?: Promise<void>,
): () => void {
  const forward = async (): Promise<void> => {
    if (started) {
      await started;
    }
    for (const item of drainSteering(conversationId)) {
      try {
        const resolved = await shrinkMessagesForApi(
          await resolveMessagesForApi([
            {
              id: item.id,
              role: "user" as const,
              content: item.text,
              attachments: item.attachments.length > 0 ? item.attachments : undefined,
              createdAt: item.createdAt,
            },
          ]),
        );
        const outcome = await steerServerRun(conversationId, {
          id: item.id,
          text: resolved[0]?.content ?? item.text,
          attachments: (resolved[0]?.attachments ?? []).map(toWireAttachment),
        });
        if (!outcome.accepted) {
          throw new Error(outcome.reason ?? "not accepted");
        }
      } catch {
        setState((prev) => ({
          ...prev,
          queued: {
            ...prev.queued,
            [conversationId]: (prev.queued[conversationId] ?? []).map((entry) =>
              entry.id === item.id ? { ...entry, steer: undefined } : entry,
            ),
          },
        }));
        toast.info("Steering did not reach the live run", {
          description: "Queued — it sends the moment the run finishes.",
        });
      }
    }
  };
  const unwatch = watchSteering(conversationId, () => {
    void forward();
  });
  void forward();
  return unwatch;
}

type ServerTurnParams = {
  kind: ServerRunKind;
  seeded: Conversation;
  assistantId: string;
  selectionId: string;
  config: ServerRunConfig;
  /** Chat runs bridge local steering offers to the server inbox. */
  steerBridge: boolean;
  /** Resume keeps the partial assistant message inside the server seed. */
  keepAssistantInSeed?: boolean;
  signal: AbortSignal;
  setState: SetAgentState;
  patchAssistant: (patch: Partial<ChatMessage>) => void;
};

/**
 * Runs one turn ON THE SERVER: seeds the chat, starts the run in the
 * account's backend node, attaches this tab to the live stream, and resolves
 * with the terminal payload. There is no browser fallback — if the backend
 * is unreachable the caller surfaces an honest error instead.
 */
async function runServerTurn(params: ServerTurnParams): Promise<ServerRunDone> {
  const { seeded, assistantId } = params;
  let chatSeed: { payload: string; updatedAt: number } | undefined;
  if (seeded.incognito !== true) {
    const seedSource: Conversation = params.keepAssistantInSeed
      ? seeded
      : { ...seeded, messages: seeded.messages.filter((message) => message.id !== assistantId) };
    const payload = await serializeConversation(seedSource);
    if (payload) {
      chatSeed = { payload, updatedAt: seeded.updatedAt };
    } else {
      console.warn("gera run: thread too large to seed — history stays on this device only.");
    }
  }
  const insertSteered = (items: ServerSteerItem[]) =>
    insertSteeredIntoThread(params.setState, seeded.id, assistantId, items);
  // Early steering offers wait for this acknowledgment; a failed start releases
  // them too, so they fall back to the ordinary queue honestly.
  let ackStart: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    ackStart = resolve;
  });
  const stopBridge = params.steerBridge
    ? createSteerBridge(seeded.id, params.setState, started)
    : undefined;
  try {
    if (params.signal.aborted) {
      // Stopped while the turn was still being prepared (attachment shrink,
      // knowledge retrieval, seeding) — never start it: a run started after
      // the user's Stop would grind to completion in the cloud and the
      // discarded reply would arrive anyway via sync.
      throw new DOMException("Stopped.", "AbortError");
    }
    await startServerRun({
      runId: newId(),
      conversationId: seeded.id,
      assistantMessageId: assistantId,
      kind: params.kind,
      title: seeded.title,
      modelId: params.selectionId,
      agentId: seeded.agentId,
      automationId: seeded.automationId,
      chatSeed,
      config: params.config,
    });
    ackStart();
    if (params.signal.aborted) {
      // Stop landed while the start request was in flight — the run is live
      // on the server now; kill it there instead of just detaching the tab.
      void stopServerRun(seeded.id).catch(() => undefined);
      throw new DOMException("Stopped.", "AbortError");
    }
    return await attachServerRun({
      conversationId: seeded.id,
      signal: params.signal,
      onEvent: (event) => applyRunEvent(event, params.patchAssistant, insertSteered),
    });
  } finally {
    ackStart();
    stopBridge?.();
  }
}

export async function sendPrompt(params: {
  state: AgentState;
  setState: (updater: (prev: AgentState) => AgentState) => void;
  signal: AbortSignal;
  /** When set, the run targets this thread in the background: chat mode only,
   * composer input untouched, focus never stolen. Used by automations. */
  overrides?: SendOverrides;
  /** Fires once the target conversation id is known, before streaming starts. */
  onRun?: (conversationId: string) => void;
  /** Fires after the run settles; `stoppedManually` holds the follow-up queue. */
  onDone?: (conversationId: string, stoppedManually?: boolean, execution?: ExecutionOutcome) => void;
}): Promise<void> {
  const settings = params.state.settings;
  const overrides = params.overrides;
  const background = Boolean(overrides);
  const mode = overrides ? overrides.mode ?? "chat" : settings.mode;
  const prompt = (overrides?.prompt ?? params.state.input).trim();
  const rawAttachments = overrides
    ? overrides.attachments ?? []
    : mode === "audio"
      ? []
      : params.state.attachments;
  // Image mode edits the attached images; video mode animates the first one.
  // Text-like files only make sense in chat.
  const attachments =
    mode === "chat"
      ? rawAttachments
      : rawAttachments
          .filter((item) => item.mime.startsWith("image/"))
          .slice(0, mode === "video" ? 1 : 6);
  if (!prompt && attachments.length === 0) {
    return;
  }
  // Deep research runs on the question text alone — attachments never enter
  // the pipeline, and workspace context (skills, knowledge) must not become
  // the subject. An attachments-only send in research mode would start a run
  // with an empty question that ends up "researching the skills"; refuse
  // honestly before seeding the thread.
  const wantsResearchRun = overrides ? overrides.deepResearch === true : params.state.deepResearch;
  if (!prompt && mode === "chat" && wantsResearchRun) {
    if (!background) {
      toast.error("Deep research needs a question", {
        description: "Type what to research — attachments alone can't drive a research run.",
      });
    }
    return;
  }

  const overrideAgent = overrides?.agentId
    ? settings.agents.find((item) => item.id === overrides.agentId)
    : undefined;
  const selectionId = overrides
    ? (mode === "chat" && overrideAgent?.modelId ? sanitizeChatModel(overrideAgent.modelId) : undefined) ||
      modelIdForMode(settings, mode)
    : modelIdForMode(settings, mode);
  const selection = parseModelSelection(selectionId);
  const modelId = selection.catalogId;

  let conversation: Conversation | null = overrides
    ? params.state.conversations.find((item) => item.id === overrides.conversationId) ?? null
    : activeConversation(params.state);
  if (!conversation) {
    conversation = createConversation(modelId, overrides?.agentId ?? undefined);
    if (overrides) {
      conversation = { ...conversation, id: overrides.conversationId };
    }
  }

  const userMessage: ChatMessage = {
    id: newId(),
    role: "user",
    content: prompt,
    attachments: attachments.length > 0 ? attachments : undefined,
    createdAt: Date.now(),
  };

  const assistantId = newId();
  const assistantMessage: ChatMessage = {
    id: assistantId,
    role: "assistant",
    content: "",
    // Persisted while the run streams: a reload that kills the run leaves the
    // flag behind, and the next load flips it into an honest "interrupted"
    // marker with a Continue/Retry offer.
    pending: true,
    createdAt: Date.now(),
  };

  const isFirstMessage = conversation.messages.length === 0;
  const title = isFirstMessage
    ? overrides?.title?.trim() || titleFromPrompt(prompt || "Attachment")
    : conversation.title;
  const seeded: Conversation = {
    ...conversation,
    title,
    modelId,
    agentId: overrides ? overrides.agentId ?? undefined : conversation.agentId,
    automationId: overrides?.automationId ?? conversation.automationId,
    messages: [...(overrides?.replaceMessages ?? conversation.messages), userMessage, assistantMessage],
    updatedAt: Date.now(),
  };

  params.onRun?.(seeded.id);
  params.setState((prev) => {
    const conversations = upsertConversation(prev.conversations, seeded);
    // Background runs never steal focus or clear what the user is typing.
    const activeId = background ? prev.activeId : seeded.id;
    persist(conversations, activeId);
    return {
      ...prev,
      conversations,
      activeId,
      input: background ? prev.input : "",
      attachments: background ? prev.attachments : [],
      runningIds: prev.runningIds.includes(seeded.id) ? prev.runningIds : [...prev.runningIds, seeded.id],
      unreadIds: prev.unreadIds.filter((id) => id !== seeded.id),
    };
  });

  // This turn owns the thread's run slot from this moment. An aborted
  // predecessor still unwinding must not clean up over the successor — see
  // the owner checks in the finally block.
  const turnToken = Symbol("turn");
  turnOwners.set(seeded.id, turnToken);

  if (isFirstMessage && !overrides?.title?.trim() && prompt.length > 0) {
    // Pretty thread names: the cheapest catalog model condenses the first
    // prompt in the background. Applied only while the raw-prompt title is
    // still in place — a manual rename that lands first always wins.
    void generateChatTitle(prompt).then((generated) => {
      if (!generated || generated === title) {
        return;
      }
      params.setState((prev) => {
        const current = prev.conversations.find((item) => item.id === seeded.id);
        if (!current || current.title !== title) {
          return prev;
        }
        const conversations = upsertConversation(prev.conversations, {
          ...current,
          title: generated,
          updatedAt: Date.now(),
        });
        persist(conversations, prev.activeId);
        return { ...prev, conversations };
      });
    });
  }

  /** Last text written into the streaming bubble — the catch below must never overwrite it. */
  let shownContent = "";
  const patchAssistant = (partial: Partial<ChatMessage>) => {
    if (typeof partial.content === "string") {
      shownContent = partial.content;
    }
    params.setState((prev) => {
      const current = prev.conversations.find((item) => item.id === seeded.id);
      if (!current) {
        return prev;
      }
      const messages = current.messages.map((message) =>
        message.id === assistantId ? { ...message, ...partial } : message,
      );
      const next = { ...current, messages, updatedAt: Date.now() };
      const conversations = upsertConversation(prev.conversations, next);
      // Keep the user's focused thread as the saved active id — a background
      // run must never steal focus (a top cloud-agent UX complaint).
      persist(conversations, prev.activeId);
      return { ...prev, conversations };
    });
  };

  // Meter every LLM call of this turn (chat, router, research, Julius).
  const usageCapture = beginUsageCapture();
  let turnFailed = false;
  /** Set when the server confirms a manual stop — the follow-up queue holds. */
  let manualStop = false;
  let executionOutcome: ExecutionOutcome | undefined;
  // Image/video runs may honestly reroute to a capable model — telemetry
  // reports the model that actually ran.
  let effectiveModelId = modelId;

  const wantResearch = overrides ? overrides.deepResearch === true : params.state.deepResearch;
  const wantJulius = overrides ? overrides.julius === true : params.state.julius;

  // Real steering: the inbox opens the moment a plain chat run seeds — before
  // knowledge retrieval and context assembly — so guidance typed while the run
  // is still planning is accepted and the ⚡ affordance shows at once.
  // Research, Julius, and media runs never register: offers honestly fail and
  // the message waits in the ordinary queue. The finally below always cleans up.
  if (mode === "chat" && !wantResearch && !wantJulius) {
    registerSteerableRun(seeded.id);
  }

  try {
    if (mode === "image") {
      let inputs: UploadImage[] = [];
      if (attachments.length > 0) {
        // Split the ~3 MB raw budget across every input image (Vercel body cap).
        const budget = Math.floor(3_000_000 / attachments.length);
        inputs = [];
        for (const attachment of attachments) {
          inputs.push(await resizeImageForUpload(attachment.dataUrl, budget));
        }
      }
      // An explicit count typed in the prompt ("4 варианта", "x3") wins over
      // the composer's count chip; anything above the cap is disclosed.
      const requested = parseImageCount(prompt) ?? settings.imageCount;
      const count = clampImageCount(requested);
      const notes: string[] = [];
      if (requested > MAX_IMAGE_COUNT) {
        notes.push(`Capped at ${MAX_IMAGE_COUNT} images per prompt.`);
      }
      let batch: { images: string[]; failed: number };
      try {
        batch = await generateImageBatch(prompt, settings.imageSize, modelId, inputs, count);
      } catch (error) {
        // The catalog doesn't publish which image models accept input images —
        // when the pick rejects them, retry once with the docs-confirmed editor.
        if (inputs.length === 0 || modelId === IMAGE_EDIT_MODEL) {
          throw error;
        }
        effectiveModelId = IMAGE_EDIT_MODEL;
        batch = await generateImageBatch(prompt, settings.imageSize, IMAGE_EDIT_MODEL, inputs, count);
        notes.push(
          `Edited with ${modelShortName(IMAGE_EDIT_MODEL)} — ${modelShortName(modelId)} rejected the attached image.`,
        );
      }
      if (batch.failed > 0) {
        notes.push(
          `${batch.failed} of ${count} runs failed — showing the ${batch.images.length} that worked.`,
        );
      }
      const note = notes.join(" ");
      // Straight into the vault — state and storage hold tiny refs, never base64.
      patchAssistant({
        images: await Promise.all(batch.images.map(vaultDataUrl)),
        ...(note ? { content: note } : {}),
      });
      return;
    }
    if (mode === "video") {
      let note = "";
      let inputImage: VideoImageInput | undefined;
      let videoModelId = modelId;
      let videoPrompt = prompt;
      // Seedance takes images only as public links and Wan none at all — the
      // composer hides the paperclip for those picks, and leftover attachments
      // from other tabs are ignored rather than silently rerouted.
      const fileAttachment = videoModelTakesLocalFiles(modelId) ? attachments[0] : undefined;
      // A pasted public link is the second way in — the provider fetches it
      // server-side, so URL-only models like Seedance take it directly.
      const linked = !fileAttachment ? extractImageUrl(prompt) : null;
      if (fileAttachment) {
        inputImage = await resizeImageForUpload(fileAttachment.dataUrl);
      } else if (linked) {
        inputImage = { url: linked.url };
        videoPrompt = linked.text || "Bring this image to life with natural, subtle motion.";
      }
      if (inputImage) {
        const routed = resolveVideoModelForImage(modelId, linked ? "url" : "base64");
        videoModelId = routed.modelId;
        effectiveModelId = routed.modelId;
        if (routed.switched) {
          note = videoImageSwitchNote(modelId, routed.modelId);
        }
      }
      const video = await generateVideo(videoPrompt, settings.videoAspect, videoModelId, inputImage);
      patchAssistant({ videos: [await vaultDataUrl(video)], ...(note ? { content: note } : {}) });
      return;
    }
    if (mode === "audio") {
      const audio = await generateAudio(prompt, {
        modelId,
        voice: settings.audioVoice || undefined,
      });
      patchAssistant({ audioUrl: await vaultDataUrl(audio) });
      return;
    }

    const agent = settings.agents.find((item) => item.id === seeded.agentId);
    let scoped = agent ? agentScopedSettings(settings, agent) : settings;
    // Automation runs narrow MCP further (Cursor-style per-automation tools):
    // the automation's allow-list intersects with the agent's own scoping.
    if (overrides && Array.isArray(overrides.mcpServerIds)) {
      scoped = { ...scoped, mcpServers: filterMcpServersByIds(scoped.mcpServers, overrides.mcpServerIds) };
    }

    // Agent knowledge: inject the excerpts most relevant to this prompt
    // (hybrid keyword + semantic retrieval; degrades to keyword offline).
    const knowledge =
      agent && agent.knowledge.length > 0 ? await retrieveKnowledgeSmart(agent.knowledge, prompt) : "";

    // Skills: reusable instruction packs — the enabled ones matching this
    // run's surface (chat / research / Julius), narrowed by the profile's
    // allow-list, ride into the system prompt of every run kind alike.
    const skillSurface: SkillSurface = wantJulius ? "julius" : wantResearch ? "research" : "chat";
    // Automation runs narrow skills further (like MCP): the automation's
    // allow-list intersects with the profile's own scoping.
    const runSkills = filterSkillsByIds(
      skillsForSurface(settings.skills, skillSurface, agent),
      overrides && Array.isArray(overrides.skillIds) ? overrides.skillIds : null,
    );
    // Chat runs take MCP tools, so the block may promise bound connectors;
    // research/Julius runs get no pool — no promises they can't keep.
    const skillsBlock = buildSkillsBlock(
      runSkills,
      wantResearch || wantJulius ? undefined : scoped.mcpServers,
    );

    // Personal assistant hub: the model sees a live snapshot every turn and
    // writes back via ```action fences, applied once when the turn settles.
    // Incognito threads get neither the snapshot nor write-back — nothing sticks.
    const isIncognito = seeded.incognito === true;
    const personal =
      !isIncognito && params.state.life.shareWithAgent ? buildPersonalContext(params.state.life) : "";
    // The user's GitHub connector (sign-in token or PAT), when enabled. Deep
    // research reads repos named in the prompt through it — private code never
    // comes from web search — and a thread-pinned repo depends on it too.
    const githubServer = scoped.mcpServers.find(
      (server) => server.enabled && (server.catalogId ?? server.id) === "github",
    );
    // The GitHub credential lives only in this browser (a device-flow sign-in
    // sits in localStorage; the profile sync that mirrors it server-side is
    // best-effort). Resolve it once and hand it to the server run itself —
    // research takes it directly, chat runs carry it inside the connector
    // entry — otherwise the cloud run silently drops GitHub tools while the
    // composer's repo picker keeps working.
    let githubAuth: string | undefined;
    if (githubServer) {
      try {
        githubAuth = await resolveGitHubAuth(githubServer);
      } catch {
        githubAuth = undefined; // signed out — the repo block stays honest
      }
    }
    // Repo pinned from the composer: every run kind sees the pin in its system
    // prompt; the block stays honest when the connector is off for this run
    // or the sign-in is gone.
    const pinnedRepo = seeded.githubRepo?.trim() ?? "";
    const repoBlock = pinnedRepo
      ? pinnedRepoPromptBlock(pinnedRepo, Boolean(githubServer && githubAuth))
      : "";
    const hubSystemPrompt = [scoped.systemPrompt, skillsBlock, knowledge, personal, repoBlock]
      .filter((part) => part.length > 0)
      .join("\n\n");
    const applyHubOps = (content: string) => {
      if (isIncognito) {
        return; // Off the record — no memories, no tracker writes.
      }
      const ops = allowedLifeOps(params.state.life, extractActionOps(content));
      if (ops.length === 0) {
        return;
      }
      params.setState((prev) =>
        prev.life.shareWithAgent ? { ...prev, life: applyLifeOps(prev.life, ops) } : prev,
      );
      // Auto-memory should be felt, not silent — a quiet toast per new fact.
      if (params.state.life.shareWithAgent) {
        const fresh = ops.filter(
          (op): op is Extract<typeof ops[number], { op: "memory.save" }> =>
            op.op === "memory.save" && !hasMemory(params.state.life, op.text),
        );
        if (fresh.length > 0) {
          toast.success(fresh.length === 1 ? "Remembered" : `Remembered ${fresh.length} facts`, {
            description: fresh[0].text.slice(0, 140),
          });
        }
      }
    };

    /**
     * Julius hub writes must never wait for a verdict. When the final text
     * carries the ```action fence, it applies as usual; otherwise (manual pick
     * pending, run stopped, or the synthesis dropped the fence) the ops are
     * recovered from the candidates — winner first, then settled ones — and the
     * source index is recorded so a later manual pick never double-writes.
     */
    const settleJuliusHubOps = (result: { julius: JuliusState; content: string }): JuliusState => {
      if (result.content.trim().length > 0 && extractActionOps(result.content).length > 0) {
        applyHubOps(result.content);
        return result.julius;
      }
      if (isIncognito) {
        return result.julius;
      }
      const indexed = result.julius.candidates.map((candidate, index) => ({ candidate, index }));
      const winnerIndex = result.julius.winner;
      const ordered = [
        ...indexed.filter(({ index }) => index === winnerIndex),
        ...indexed.filter(({ index, candidate }) => index !== winnerIndex && candidate.status === "done"),
        ...indexed.filter(({ index, candidate }) => index !== winnerIndex && candidate.status !== "done"),
      ];
      const source = ordered.find(
        ({ candidate }) =>
          candidate.content.trim().length > 0 && extractActionOps(candidate.content).length > 0,
      );
      if (!source) {
        return result.julius;
      }
      applyHubOps(source.candidate.content);
      return { ...result.julius, hubOpsApplied: [source.index] };
    };

    // Vaulted image attachments become real bytes only for this API turn —
    // the inlined copies are transient and die when the turn settles.
    // Oversized images (old threads, other devices) are shrunk to fit the
    // gateway's request-body cap, or the model would never see them at all.
    const turnHistory = await shrinkMessagesForApi(await resolveMessagesForApi(seeded.messages));

    // Research and Julius execute entirely on the server — the run survives
    // this tab closing; the GitHub credential is resolved here because only
    // the browser holds the sign-in token store.
    if (wantResearch || wantJulius) {
      const kind: ServerRunKind = wantJulius ? "julius" : "research";
      const wireHistory = wantJulius
        ? toWireMessages(turnHistory.filter((message) => message.id !== assistantId))
        : toWireMessages(
            turnHistory.filter(
              (message) => message.id !== assistantId && message.id !== userMessage.id,
            ),
          );
      const done = await runServerTurn({
        kind,
        seeded,
        assistantId,
        selectionId,
        config: {
          systemPrompt: hubSystemPrompt || undefined,
          history: wireHistory,
          prompt,
          builtins: scoped.builtinTools,
          // Every Julius mode carries the scoped GitHub connector. Plain
          // candidates use it directly; Research × Julius candidates use the
          // deterministic preload below, but its council Verifier still needs
          // the same credential to check repository claims independently.
          mcpServers:
            wantJulius && githubServer ? injectGitHubRunAuth([githubServer], githubAuth) : [],
          githubRepo: pinnedRepo || undefined,
          ...(wantResearch
            ? {
                research: {
                  depth: settings.researchDepth,
                  citations: "numeric",
                  githubAuth,
                  githubDisabledTools: githubServer?.disabledTools,
                },
              }
            : {}),
          ...(wantJulius
            ? { julius: { settings: settings.julius, research: wantResearch || undefined } }
            : {}),
          ...(isIncognito ? { ephemeral: true } : {}),
        },
        steerBridge: false,
        signal: params.signal,
        setState: params.setState,
        patchAssistant,
      });
      manualStop = done.status === "stopped";
      executionOutcome = normalizeExecutionOutcome(done.message.execution);
      const patch = await settleDone(done);
      if (wantJulius && patch.julius) {
        if (patch.julius.status === "error") {
          patchAssistant({ julius: patch.julius });
          throw new Error(done.message.content || done.error || "Julius panel failed.");
        }
        const settledJulius = settleJuliusHubOps({ julius: patch.julius, content: patch.content ?? "" });
        patchAssistant({
          ...patch,
          julius: settledJulius,
          ...(settledJulius.sources && settledJulius.sources.length > 0
            ? { sources: settledJulius.sources }
            : {}),
        });
      } else {
        patchAssistant(patch);
        applyHubOps(done.message.content);
      }
      reconcileServerClock(params.setState, seeded.id, done.chatUpdatedAt);
      if (done.status === "error") {
        turnFailed = true;
        toast.error("The run failed on the server", {
          description: done.error ?? "Unknown error — the collected draft is shown as-is.",
        });
      }
      return;
    }

    // Skills editor: interactive chat turns can create and edit skills via
    // ```action ops. Background automation runs and incognito threads can't —
    // automations execute unattended, and incognito leaves nothing behind.
    const skillsEditor =
      !background && !isIncognito
        ? buildSkillsEditorContext(settings.skills, settings.mcpServers)
        : "";

    let armedBuiltins = scoped.builtinTools;
    let armedServers = scoped.mcpServers;
    let grounding: Grounding | null = null;

    // One fast router call serves two jobs: tool arming (autoTools) and the
    // invisible pre-search that grounds ordinary answers in live evidence.
    if (scoped.autoTools || scoped.builtinTools.web_search) {
      const plan = await planTools({
        prompt,
        // Follow-ups ("а подробнее?") are meaningless without the thread — the
        // router needs the recent exchange to write self-contained queries.
        context: routerContextDigest(
          turnHistory.filter((message) => message.id !== assistantId && message.id !== userMessage.id),
        ),
        attachmentCount: attachments.length,
        settings: scoped,
        signal: params.signal,
      });
      if (plan) {
        if (scoped.autoTools) {
          const chosen = new Set<string>(plan.builtins);
          // Internet access (search, fetch, SelfSurf browsing) is always armed
          // by default; the router only gates media generation and MCP servers.
          // Master toggles still apply.
          armedBuiltins = {
            web_search: scoped.builtinTools.web_search,
            fetch_url: scoped.builtinTools.fetch_url,
            selfsurf: scoped.builtinTools.selfsurf,
            generate_image: scoped.builtinTools.generate_image && chosen.has("generate_image"),
            generate_video: scoped.builtinTools.generate_video && chosen.has("generate_video"),
            generate_audio: scoped.builtinTools.generate_audio && chosen.has("generate_audio"),
          };
          // Skill-pinned connectors arm regardless of the router's guess — a
          // skill riding this run explicitly depends on them. Pins override
          // only the heuristic: agent/automation narrowing already shaped
          // scoped.mcpServers, so excluded servers never resurrect here.
          const pinnedIds = [
            ...skillPinnedServerIds(runSkills),
            // A thread pin OR an explicit owner/repo is deterministic intent,
            // so GitHub arms regardless of the heuristic router's guess.
            ...((pinnedRepo || githubRepoRefs(prompt, 1).length > 0) && githubServer ? [githubServer.id] : []),
          ];
          armedServers = scoped.mcpServers.filter(
            (server) => plan.mcpServerIds.includes(server.id) || pinnedIds.includes(server.id),
          );
          // The plan chips stay honest: connectors armed by a skill (and able
          // to serve tools) show up next to the router's own picks.
          const pinLabels = armedServers
            .filter(
              (server) =>
                !plan.mcpServerIds.includes(server.id) &&
                server.enabled &&
                server.status === "connected",
            )
            .map((server) => server.name);
          if (plan.labels.length > 0 || pinLabels.length > 0) {
            patchAssistant({ toolPlan: [...plan.labels, ...pinLabels] });
          }
        }
        // Quiet grounding: run the router's queries up front so even a turn
        // where the model never calls tools still answers from fresh, cited
        // evidence. Best effort — failures never block the reply.
        if (plan.queries.length > 0 && scoped.builtinTools.web_search) {
          grounding = await fetchGrounding(plan.queries, params.signal);
          if (grounding) {
            // Attach sources immediately so [n] pills resolve while streaming.
            patchAssistant({ sources: grounding.sources });
          }
        }
      } else if (scoped.builtinTools.web_search) {
        // Router down or timed out — search is default-on, so it still fires
        // with the prompt itself as the query instead of silently skipping.
        grounding = await fetchGrounding([fallbackQuery(prompt)], params.signal);
        if (grounding) {
          patchAssistant({ sources: grounding.sources });
        }
      }
    }

    // The whole agent loop — tools, MCP, media generation, steering — runs
    // on the server; this tab only renders the live stream.
    const done = await runServerTurn({
      kind: "chat",
      seeded,
      assistantId,
      selectionId,
      config: {
        systemPrompt:
          [hubSystemPrompt, skillsEditor].filter((part) => part.length > 0).join("\n\n") || undefined,
        history: toWireMessages(turnHistory.filter((message) => message.id !== assistantId)),
        prompt,
        builtins: armedBuiltins,
        mcpServers: injectGitHubRunAuth(armedServers, githubAuth),
        githubRepo: pinnedRepo || undefined,
        grounding: grounding ?? undefined,
        steeringWrapNote: STEER_WRAP_NOTE,
        ...(isIncognito ? { ephemeral: true } : {}),
      },
      steerBridge: true,
      signal: params.signal,
      setState: params.setState,
      patchAssistant,
    });
    manualStop = done.status === "stopped";
    executionOutcome = normalizeExecutionOutcome(done.message.execution);
    patchAssistant(await settleDone(done));
    reconcileServerClock(params.setState, seeded.id, done.chatUpdatedAt);
    if (done.status === "error") {
      turnFailed = true;
      toast.error("The run failed on the server", {
        description: done.error ?? "Unknown error — the collected draft is shown as-is.",
      });
    } else {
      applyHubOps(done.message.content);
      if (skillsEditor) {
        settleSkillOps(
          done.message.content,
          params.state.settings.skills,
          settings.mcpServers,
          params.setState,
        );
      }
    }
  } catch (error) {
    logDiagnostic("chat", error);
    // A manual Stop is a user choice, not a model failure.
    const aborted = error instanceof DOMException && error.name === "AbortError";
    if (!aborted) {
      turnFailed = true;
    }
    if (shownContent.trim().length === 0) {
      // Nothing streamed yet — the empty bubble carries the honest reason.
      patchAssistant({ content: errorFromUnknown(error) });
    } else if (!aborted) {
      // NEVER overwrite a streamed draft with an error (or "Stopped.") — the
      // text stays exactly as shown, marked continuable; the reason is a toast.
      patchAssistant({ interrupted: true });
      toast.error("The run failed", { description: errorFromUnknown(error) });
    }
    // Aborted with a draft: the tab detached or a newer turn took over — the
    // shown text stays; if the run still lives on the server, sync reconciles.
  } finally {
    // A successor turn (interrupt, "stop & send", a quick re-send) may already
    // own this thread while this aborted turn is still unwinding — its
    // steering inbox, ⚡ flags and running spinner belong to IT. Cleaning them
    // up from here used to kill the new run's steering and hide its Stop
    // button; the owner check keeps hands off.
    const ownsTurn = turnOwners.get(seeded.id) === turnToken;
    if (ownsTurn) {
      turnOwners.delete(seeded.id);
      // Close the steering inbox, then drop EVERY leftover ⚡ flag — with no
      // live run in this thread nothing may pose as steering. This includes
      // items the server accepted but never consumed (guidance that landed in
      // the instant the loop was already finishing); they stay queued and
      // dispatch as ordinary follow-ups.
      unregisterSteerableRun(seeded.id);
      params.setState((prev) => {
        const stripped = stripSteerFlags(prev.queued[seeded.id] ?? []);
        return stripped ? { ...prev, queued: { ...prev.queued, [seeded.id]: stripped } } : prev;
      });
    }
    const usage = endUsageCapture(usageCapture);
    // The pending marker dies with the run — only a reload mid-run leaves it
    // behind for the next load to detect.
    patchAssistant({ pending: undefined, ...(usage ? { usage } : {}) });
    // Automatic arena telemetry — model, mode, outcome, token counts. Never
    // message content; incognito turns leave no trace anywhere, including here.
    if (seeded.incognito !== true) {
      reportModelUsage(
        turnUsageEvents({ usage, mode, fallbackModelId: effectiveModelId, ok: !turnFailed }),
      );
    }
    if (ownsTurn) {
      params.setState((prev) => ({
        ...prev,
        runningIds: prev.runningIds.filter((id) => id !== seeded.id),
        unreadIds:
          prev.activeId !== seeded.id &&
          prev.conversations.some((item) => item.id === seeded.id) &&
          !prev.unreadIds.includes(seeded.id)
            ? [...prev.unreadIds, seeded.id]
            : prev.unreadIds,
      }));
    }
    params.onDone?.(seeded.id, manualStop, executionOutcome);
  }
}

/**
 * Continues an assistant reply that a page reload (an app update mid-run, a
 * crash) cut mid-stream. The surviving partial text stays in place and the
 * continuation streams into the same bubble. Steering, tools, knowledge, and
 * hub write-back work like a normal chat turn; only the auto-router
 * pre-search is skipped. Julius panels recover through their own pick UI and
 * are not resumable here.
 */
export async function resumePrompt(params: {
  state: AgentState;
  setState: (updater: (prev: AgentState) => AgentState) => void;
  signal: AbortSignal;
  conversationId: string;
  messageId: string;
  onRun?: (conversationId: string) => void;
  onDone?: (conversationId: string, stoppedManually?: boolean, execution?: ExecutionOutcome) => void;
}): Promise<void> {
  const state = params.state;
  const conversation = state.conversations.find((item) => item.id === params.conversationId);
  const message = conversation?.messages.find((item) => item.id === params.messageId);
  if (
    !conversation ||
    !message ||
    message.role !== "assistant" ||
    // Accepts the boot plan's silent pre-mark (pending) as well as a manual
    // Continue on an interrupted chip.
    (message.interrupted !== true && message.pending !== true) ||
    message.julius !== undefined ||
    state.runningIds.includes(conversation.id)
  ) {
    return;
  }
  const partial = message.content.trimEnd();
  if (!partial) {
    return; // nothing to continue — the UI offers Retry for empty turns
  }
  const conversationId = conversation.id;
  const assistantId = message.id;
  const baseToolCalls = message.toolCalls ?? [];
  const baseSources = message.sources ?? [];
  const settings = state.settings;
  const agent = settings.agents.find((item) => item.id === conversation.agentId);
  const scoped = agent ? agentScopedSettings(settings, agent) : settings;
  const lastUser = [...conversation.messages].reverse().find((item) => item.role === "user");
  const selectionId = agent?.modelId || settings.modelId || conversation.modelId;

  params.onRun?.(conversationId);
  // The interrupted flag clears right away (pending returns while streaming);
  // a failed resume restores it so Continue can be tried again.
  params.setState((prev) => {
    const current = prev.conversations.find((item) => item.id === conversationId);
    if (!current) {
      return prev;
    }
    const messages = current.messages.map((item) =>
      item.id === assistantId ? { ...item, interrupted: undefined, pending: true } : item,
    );
    const conversations = upsertConversation(prev.conversations, {
      ...current,
      messages,
      updatedAt: Date.now(),
    });
    persist(conversations, prev.activeId);
    return {
      ...prev,
      conversations,
      runningIds: prev.runningIds.includes(conversationId)
        ? prev.runningIds
        : [...prev.runningIds, conversationId],
      unreadIds: prev.unreadIds.filter((id) => id !== conversationId),
    };
  });

  const patchAssistant = (patch: Partial<ChatMessage>) => {
    params.setState((prev) => {
      const current = prev.conversations.find((item) => item.id === conversationId);
      if (!current) {
        return prev;
      }
      const messages = current.messages.map((item) =>
        item.id === assistantId ? { ...item, ...patch } : item,
      );
      const next = { ...current, messages, updatedAt: Date.now() };
      const conversations = upsertConversation(prev.conversations, next);
      persist(conversations, prev.activeId);
      return { ...prev, conversations };
    });
  };

  const usageCapture = beginUsageCapture();
  let turnFailed = false;
  let manualStop = false;
  let executionOutcome: ExecutionOutcome | undefined;

  // This resume owns the thread's run slot; see sendPrompt's owner note.
  const turnToken = Symbol("turn");
  turnOwners.set(conversationId, turnToken);
  // A resume is steerable like any plain chat turn.
  registerSteerableRun(conversationId);

  try {
    const isIncognito = conversation.incognito === true;
    const knowledge =
      agent && agent.knowledge.length > 0
        ? await retrieveKnowledgeSmart(agent.knowledge, lastUser?.content ?? "")
        : "";
    const personal =
      !isIncognito && state.life.shareWithAgent ? buildPersonalContext(state.life) : "";
    // Resumed turns are plain chat runs — chat-surface skills ride along so a
    // continuation follows the same rules the original turn ran under. The
    // resume passes every scoped server, so bound connectors are armed too.
    const skillsBlock = buildSkillsBlock(
      skillsForSurface(settings.skills, "chat", agent),
      scoped.mcpServers,
    );
    // A continuation is interactive chat — the skills editor rides like in the
    // original turn (the interrupted run's settle never applied its ops).
    const skillsEditor = !isIncognito
      ? buildSkillsEditorContext(settings.skills, settings.mcpServers)
      : "";
    // The thread's pinned repo rides continuations too — the resume passes
    // every scoped server, so the GitHub connector is armed when enabled.
    // Same credential hand-off as sendPrompt: the sign-in token lives only in
    // this browser, so the continuation carries it into the server run.
    const resumeGithubServer = scoped.mcpServers.find(
      (server) => server.enabled && (server.catalogId ?? server.id) === "github",
    );
    let resumeGithubAuth: string | undefined;
    if (resumeGithubServer) {
      try {
        resumeGithubAuth = await resolveGitHubAuth(resumeGithubServer);
      } catch {
        resumeGithubAuth = undefined; // signed out — the block stays honest
      }
    }
    const resumeRepo = conversation.githubRepo?.trim() ?? "";
    const resumeRepoBlock = resumeRepo
      ? pinnedRepoPromptBlock(resumeRepo, Boolean(resumeGithubServer && resumeGithubAuth))
      : "";
    const hubSystemPrompt = [scoped.systemPrompt, skillsBlock, knowledge, personal, skillsEditor, resumeRepoBlock]
      .filter((part) => part.length > 0)
      .join("\n\n");

    const cutIndex = conversation.messages.findIndex((item) => item.id === assistantId);
    const resolved = await resolveMessagesForApi(conversation.messages.slice(0, cutIndex + 1));
    const history: ChatMessage[] = [
      ...resolved,
      { id: newId(), role: "user", content: RESUME_NOTE, createdAt: Date.now() },
    ];

    // The continuation runs on the server — the resumed bubble is stitched
    // there (overlap-deduped) and every attached tab sees identical text.
    const done = await runServerTurn({
      kind: "chat",
      seeded: { ...conversation, messages: conversation.messages.slice(0, cutIndex + 1) },
      assistantId,
      selectionId,
      config: {
        systemPrompt: hubSystemPrompt || undefined,
        history: toWireMessages(history),
        prompt: lastUser?.content ?? "",
        builtins: scoped.builtinTools,
        mcpServers: injectGitHubRunAuth(scoped.mcpServers, resumeGithubAuth),
        githubRepo: resumeRepo || undefined,
        steeringWrapNote: STEER_WRAP_NOTE,
        resume: { messageId: assistantId, partial },
        ...(isIncognito ? { ephemeral: true } : {}),
      },
      steerBridge: true,
      keepAssistantInSeed: true,
      signal: params.signal,
      setState: params.setState,
      patchAssistant,
    });
    manualStop = done.status === "stopped";
    executionOutcome = normalizeExecutionOutcome(done.message.execution);
    const patch = await settleDone(done);
    const images = [...(message.images ?? []), ...(patch.images ?? [])];
    const videos = [...(message.videos ?? []), ...(patch.videos ?? [])];
    // Old citation numbers stay valid — new sources only append.
    const knownUrls = new Set(baseSources.map((item) => item.url));
    const sources = [...baseSources, ...(patch.sources ?? []).filter((item) => !knownUrls.has(item.url))];
    const toolCalls = [...baseToolCalls, ...(patch.toolCalls ?? [])];
    const codeChanges = mergeCodeChangeStates(message.codeChanges, patch.codeChanges);
    patchAssistant({
      ...patch,
      images: images.length > 0 ? images : undefined,
      videos: videos.length > 0 ? videos : undefined,
      audioUrl: patch.audioUrl ?? message.audioUrl,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      codeChanges,
      sources: sources.length > 0 ? sources : undefined,
    });
    reconcileServerClock(params.setState, conversationId, done.chatUpdatedAt);
    if (done.status === "error") {
      turnFailed = true;
      toast.error("Could not continue the reply", {
        description: done.error ?? "Unknown error — the collected draft is shown as-is.",
      });
    } else if (!isIncognito) {
      // Hub write-back from the continuation, same rules as a normal turn.
      const ops = allowedLifeOps(state.life, extractActionOps(done.message.content));
      if (ops.length > 0) {
        params.setState((prev) =>
          prev.life.shareWithAgent ? { ...prev, life: applyLifeOps(prev.life, ops) } : prev,
        );
      }
      if (skillsEditor) {
        settleSkillOps(done.message.content, state.settings.skills, settings.mcpServers, params.setState);
      }
    }
  } catch (error) {
    logDiagnostic("chat", error);
    if (error instanceof DOMException && error.name === "AbortError") {
      // The tab detached — the run continues on the server; whatever already
      // streamed stays in the bubble and sync reconciles the final text.
    } else {
      turnFailed = true;
      // Content stays as streamed; the interrupted marker returns so Continue
      // can be tried again, and the toast carries the reason.
      patchAssistant({ interrupted: true });
      toast.error("Could not continue the reply", { description: errorFromUnknown(error) });
    }
  } finally {
    // Same owner contract as sendPrompt: a successor turn may already hold
    // this thread — only the owner closes the inbox and clears the spinner.
    const ownsTurn = turnOwners.get(conversationId) === turnToken;
    if (ownsTurn) {
      turnOwners.delete(conversationId);
      unregisterSteerableRun(conversationId);
      params.setState((prev) => {
        const stripped = stripSteerFlags(prev.queued[conversationId] ?? []);
        return stripped
          ? { ...prev, queued: { ...prev.queued, [conversationId]: stripped } }
          : prev;
      });
    }
    const usage = endUsageCapture(usageCapture);
    patchAssistant({ pending: undefined, ...(usage ? { usage } : {}) });
    if (conversation.incognito !== true) {
      reportModelUsage(
        turnUsageEvents({
          usage,
          mode: "chat",
          fallbackModelId: parseModelSelection(selectionId).catalogId,
          ok: !turnFailed,
        }),
      );
    }
    if (ownsTurn) {
      params.setState((prev) => ({
        ...prev,
        runningIds: prev.runningIds.filter((id) => id !== conversationId),
        unreadIds:
          prev.activeId !== conversationId &&
          prev.conversations.some((item) => item.id === conversationId) &&
          !prev.unreadIds.includes(conversationId)
            ? [...prev.unreadIds, conversationId]
            : prev.unreadIds,
      }));
    }
    params.onDone?.(conversationId, manualStop, executionOutcome);
  }
}

// ---------------------------------------------------------------------------
// Server-run adoption: a (re)opened tab picks up runs that live on the backend.

/** Patch helper bound to one conversation/message pair. */
function makePatcher(
  setState: SetAgentState,
  conversationId: string,
  messageId: string,
): (patch: Partial<ChatMessage>) => void {
  return (patch) => {
    setState((prev) => {
      const current = prev.conversations.find((item) => item.id === conversationId);
      if (!current) {
        return prev;
      }
      const messages = current.messages.map((item) =>
        item.id === messageId ? { ...item, ...patch } : item,
      );
      const conversations = upsertConversation(prev.conversations, {
        ...current,
        messages,
        updatedAt: Date.now(),
      });
      persist(conversations, prev.activeId);
      return { ...prev, conversations };
    });
  };
}

type AdoptParams = {
  getState: () => AgentState;
  setState: SetAgentState;
  /** Fires when an adopted run settles; `stoppedManually` holds the queue. */
  onDone?: (conversationId: string, stoppedManually?: boolean, execution?: ExecutionOutcome) => void;
};

/**
 * Attaches this tab to a run that is executing on the server right now:
 * ensures the thread and its streaming bubble exist locally, re-registers
 * steering for chat runs, replays the snapshot, and follows live events
 * until the run settles. Hub write-backs are NOT applied here — only the
 * initiating tab does that, so several attached devices never double-write.
 */
function adoptRunningServerRun(run: ActiveServerRun, params: AdoptParams): void {
  const conversationId = run.conversationId;
  const assistantId = run.assistantMessageId || newId();
  params.setState((prev) => {
    let conversation = prev.conversations.find((item) => item.id === conversationId);
    let conversations = prev.conversations;
    if (!conversation) {
      // The thread lives on the server (sync is locked mid-run) — show a live
      // placeholder now; the full history arrives via sync once the run ends.
      conversation = {
        id: conversationId,
        title: run.title || "Chat",
        modelId: prev.settings.modelId,
        messages: [],
        createdAt: run.startedAt,
        updatedAt: Date.now(),
      };
    }
    const hasBubble = conversation.messages.some((item) => item.id === assistantId);
    const messages = hasBubble
      ? conversation.messages.map((item) =>
          item.id === assistantId ? { ...item, pending: true, interrupted: undefined } : item,
        )
      : [
          ...conversation.messages,
          {
            id: assistantId,
            role: "assistant" as const,
            content: run.snapshot?.content ?? "",
            pending: true,
            createdAt: run.startedAt,
          },
        ];
    conversations = upsertConversation(conversations, {
      ...conversation,
      messages,
      updatedAt: conversation.updatedAt,
    });
    persist(conversations, prev.activeId);
    return {
      ...prev,
      conversations,
      runningIds: prev.runningIds.includes(conversationId)
        ? prev.runningIds
        : [...prev.runningIds, conversationId],
    };
  });
  // The adopted run owns the thread's run slot; see sendPrompt's owner note.
  const turnToken = Symbol("turn");
  turnOwners.set(conversationId, turnToken);
  if (run.kind === "chat") {
    registerSteerableRun(conversationId);
  }
  const patchAssistant = makePatcher(params.setState, conversationId, assistantId);
  const insertSteered = (items: ServerSteerItem[]) =>
    insertSteeredIntoThread(params.setState, conversationId, assistantId, items);
  if (run.snapshot) {
    applyRunEvent({ t: "snapshot", seq: 0, snapshot: run.snapshot }, patchAssistant, insertSteered);
  }
  const stopBridge = run.kind === "chat" ? createSteerBridge(conversationId, params.setState) : undefined;
  const usageCapture = beginUsageCapture();
  let manualStop = false;
  let executionOutcome: ExecutionOutcome | undefined;
  void (async () => {
    try {
      const done = await attachServerRun({
        conversationId,
        onEvent: (event) => applyRunEvent(event, patchAssistant, insertSteered),
      });
      manualStop = done.status === "stopped";
      executionOutcome = normalizeExecutionOutcome(done.message.execution);
      patchAssistant(await settleDone(done));
      reconcileServerClock(params.setState, conversationId, done.chatUpdatedAt);
      void ackServerRun(run.runId);
      if (done.status === "error") {
        toast.error("The run failed on the server", {
          description: done.error ?? "The collected draft is shown as-is.",
        });
      }
    } catch (error) {
      logDiagnostic("chat", error);
      patchAssistant({ interrupted: true });
    } finally {
      stopBridge?.();
      // Owner contract (see sendPrompt): an interrupt may have replaced this
      // adopted run with a fresh turn — leave the successor's state alone.
      const ownsTurn = turnOwners.get(conversationId) === turnToken;
      if (ownsTurn) {
        turnOwners.delete(conversationId);
        unregisterSteerableRun(conversationId);
        params.setState((prev) => {
          const stripped = stripSteerFlags(prev.queued[conversationId] ?? []);
          return stripped
            ? { ...prev, queued: { ...prev.queued, [conversationId]: stripped } }
            : prev;
        });
      }
      const usage = endUsageCapture(usageCapture);
      patchAssistant({ pending: undefined, ...(usage ? { usage } : {}) });
      if (ownsTurn) {
        params.setState((prev) => ({
          ...prev,
          runningIds: prev.runningIds.filter((id) => id !== conversationId),
          unreadIds:
            prev.activeId !== conversationId &&
            prev.conversations.some((item) => item.id === conversationId) &&
            !prev.unreadIds.includes(conversationId)
              ? [...prev.unreadIds, conversationId]
              : prev.unreadIds,
        }));
      }
      params.onDone?.(conversationId, manualStop, executionOutcome);
    }
  })();
}

/** Applies a finished (unacked) run's result to the local thread, if it is still waiting. */
async function applyFinishedServerRun(run: ActiveServerRun, params: AdoptParams): Promise<boolean> {
  const done = run.result;
  if (!done) {
    return false;
  }
  const state = params.getState();
  const conversation = state.conversations.find((item) => item.id === run.conversationId);
  if (!conversation) {
    // The server wrote the history — normal sync delivers the whole thread.
    return done.chatUpdatedAt > 0;
  }
  const messageId = done.message.id || run.assistantMessageId;
  const message = conversation.messages.find((item) => item.id === messageId);
  if (!message) {
    return done.chatUpdatedAt > 0;
  }
  if (message.pending !== true && message.interrupted !== true && message.content.trim().length > 0) {
    return true; // already settled locally
  }
  const patch = await settleDone(done);
  makePatcher(params.setState, run.conversationId, messageId)({ ...patch, pending: undefined });
  reconcileServerClock(params.setState, run.conversationId, done.chatUpdatedAt);
  return true;
}

/**
 * Boot/sign-in pass: adopts runs still executing on the server (live attach)
 * and applies results that finished while no tab was open. Returns the
 * touched conversation ids so boot recovery never double-continues them.
 */
export async function adoptActiveServerRuns(
  params: AdoptParams,
): Promise<{ running: string[]; applied: string[] }> {
  const runs = await listActiveServerRuns();
  const running: string[] = [];
  const applied: string[] = [];
  for (const run of runs) {
    if (run.status === "running") {
      if (params.getState().runningIds.includes(run.conversationId)) {
        continue; // this tab already streams it
      }
      running.push(run.conversationId);
      adoptRunningServerRun(run, params);
      continue;
    }
    if (run.result) {
      try {
        const ok = await applyFinishedServerRun(run, params);
        if (ok) {
          applied.push(run.conversationId);
          void ackServerRun(run.runId);
        }
      } catch (error) {
        logDiagnostic("chat", error);
      }
    }
  }
  return { running, applied };
}

export async function reconnectMcp(
  server: McpServerConfig,
  setSettings: (updater: (prev: AgentSettings) => AgentSettings) => void,
): Promise<void> {
  setSettings((prev) => {
    const exists = prev.mcpServers.some((item) => item.id === server.id);
    const list = exists ? prev.mcpServers : [...prev.mcpServers, server];
    return {
      ...prev,
      mcpServers: list.map((item) =>
        item.id === server.id ? { ...item, ...server, status: "connecting", error: undefined } : item,
      ),
    };
  });
  try {
    const connection = await connectMcpServer(server);
    setSettings((prev) => ({
      ...prev,
      mcpServers: prev.mcpServers.map((item) =>
        item.id === server.id
          ? {
              ...item,
              status: "connected",
              tools: connection.tools,
              identity: connection.identity,
              verifiedAt: Date.now(),
              error: undefined,
              name: item.name || server.name,
            }
          : item,
      ),
    }));
    toast.success(`${server.name} verified`, {
      description: `${connection.tools.length} tools listed${connection.identity ? ` · ${connection.identity}` : ""}`,
    });
  } catch (error) {
    const message = errorFromUnknown(error);
    setSettings((prev) => ({
      ...prev,
      mcpServers: prev.mcpServers.map((item) =>
        item.id === server.id
          ? {
              ...item,
              status: "error",
              error: message,
              identity: undefined,
              verifiedAt: undefined,
            }
          : item,
      ),
    }));
    toast.error(`${server.name} did not connect`, { description: message });
  }
}

/** Re-verify a persisted green status after this age, and always once auth disappears. */
const MCP_REVERIFY_AFTER_MS = 10 * 60_000;
const mcpLastHealthyAt = new Map<string, number>();
const mcpRevalidationInFlight = new Set<string>();

/**
 * Shared auth, relay, network, rate-limit, and provider-outage failures do not
 * revoke a connector credential. They must stay retryable instead of becoming
 * a synced, permanent disconnect for every MCP after a sleeping tab resumes.
 */
export function isRecoverableMcpHealthError(error: unknown): boolean {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return /(?:gera (?:relay|account)|sign in to gera|external connectors|could not reach|unreachable|network|failed to fetch|load failed|time(?:d)? out|aborted|retry|rate limit|temporar|server returned 5\d\d|unexpected response)/i.test(
    message,
  );
}

/** Returns the exact local credential gap that makes a green card impossible. */
export function mcpCredentialProblem(server: McpServerConfig): string | null {
  const entry = findCatalogEntry(server.catalogId ?? server.id);
  const catalogId = server.catalogId ?? server.id;
  const hasKey = Boolean(server.token?.trim());
  const hasHeaders = Boolean(server.headersJson?.trim());
  const hasOAuth =
    hasOAuthToken(server.id, server.url) ||
    (catalogId !== server.id && hasOAuthToken(catalogId, server.url));

  if (entry?.native === "github") {
    return hasKey || hasOAuth ? null : "GitHub sign-in is missing — sign in again or paste a PAT.";
  }
  if (entry?.native === "slack" || entry?.native === "intercom") {
    return hasKey ? null : `${entry.name} needs a fresh API token.`;
  }
  if (server.authMode === "oauth" || entry?.auth === "oauth") {
    return hasOAuth ? null : "Sign-in is missing or expired — authorize this server again.";
  }
  if (server.authMode === "bearer") {
    return hasKey ? null : "Bearer token is missing.";
  }
  if (entry?.auth === "token" && entry.tokenOptional !== true) {
    return hasKey || hasHeaders ? null : `${entry.name} needs an API key.`;
  }
  return null;
}

/**
 * Re-validates persisted connection state after boot and after a synced profile
 * arrives. Missing auth bypasses the freshness window, so a remote green flag
 * can never mask an absent local grant. Stale cards visibly enter Checking and
 * end in either a fresh verified green state or an honest error state.
 */
export function revalidateMcpServers(
  servers: McpServerConfig[],
  setSettings: (updater: (prev: AgentSettings) => AgentSettings) => void,
  forceIds: ReadonlySet<string> = new Set<string>(),
): void {
  const candidates: McpServerConfig[] = [];
  const problems = new Map<string, string>();
  const recoverableIds = new Set<string>();
  const now = Date.now();
  for (const server of servers) {
    if (!server.enabled) {
      continue;
    }
    const catalogId = server.catalogId ?? server.id;
    const hasRefreshableOAuth =
      (hasOAuthToken(server.id, server.url) && hasOAuthRefreshToken(server.id)) ||
      (catalogId !== server.id &&
        hasOAuthToken(catalogId, server.url) &&
        hasOAuthRefreshToken(catalogId));
    const isRecoverableError =
      server.status === "error" &&
      (isRecoverableMcpHealthError(server.error) || hasRefreshableOAuth);
    if (server.status !== "connected" && !isRecoverableError) {
      continue;
    }
    const problem = mcpCredentialProblem(server);
    if (problem) {
      problems.set(server.id, problem);
      continue;
    }
    const lastHealthyAt = Math.max(
      server.verifiedAt ?? 0,
      mcpLastHealthyAt.get(server.id) ?? 0,
    );
    if (
      isRecoverableError ||
      forceIds.has(server.id) ||
      lastHealthyAt === 0 ||
      now - lastHealthyAt >= MCP_REVERIFY_AFTER_MS
    ) {
      candidates.push(server);
      if (isRecoverableError) {
        recoverableIds.add(server.id);
      }
    }
  }
  if (problems.size > 0 || recoverableIds.size > 0) {
    setSettings((prev) => ({
      ...prev,
      mcpServers: prev.mcpServers.map((server) => {
        const problem = problems.get(server.id);
        if (problem) {
          return {
            ...server,
            status: "error" as const,
            error: problem,
            identity: undefined,
            verifiedAt: undefined,
          };
        }
        // Repair profiles poisoned by an old shared-relay outage. A background
        // check never moves a healthy connector through persisted "connecting".
        return recoverableIds.has(server.id)
          ? { ...server, status: "connected" as const, error: undefined }
          : server;
      }),
    }));
  }
  for (const server of candidates) {
    if (mcpRevalidationInFlight.has(server.id)) {
      continue;
    }
    mcpRevalidationInFlight.add(server.id);
    void revalidateQuietly(server, setSettings).finally(() => {
      mcpRevalidationInFlight.delete(server.id);
    });
  }
}

function sameMcpTools(left: McpServerConfig["tools"], right: McpServerConfig["tools"]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function revalidateQuietly(
  server: McpServerConfig,
  setSettings: (updater: (prev: AgentSettings) => AgentSettings) => void,
): Promise<void> {
  try {
    const connection = await connectMcpServer(server);
    mcpLastHealthyAt.set(server.id, Date.now());
    setSettings((prev) => {
      let changed = false;
      const mcpServers = prev.mcpServers.map((item) => {
        if (item.id !== server.id) {
          return item;
        }
        if (
          item.status === "connected" &&
          item.error === undefined &&
          item.identity === connection.identity &&
          sameMcpTools(item.tools, connection.tools)
        ) {
          return item;
        }
        changed = true;
        return {
          ...item,
          status: "connected" as const,
          tools: connection.tools,
          identity: connection.identity,
          verifiedAt: Date.now(),
          error: undefined,
        };
      });
      return changed ? { ...prev, mcpServers } : prev;
    });
  } catch (error) {
    // A failed Gera refresh, relay outage, sleeping network, provider 5xx, or
    // rate limit says nothing about the saved provider credential. Keep the
    // connector armed and retry on a later health tick.
    if (!(error instanceof McpAuthError) && isRecoverableMcpHealthError(error)) {
      return;
    }
    const message = errorFromUnknown(error);
    setSettings((prev) => ({
      ...prev,
      mcpServers: prev.mcpServers.map((item) =>
        item.id === server.id
          ? { ...item, status: "error", error: message, identity: undefined, verifiedAt: undefined }
          : item,
      ),
    }));
    if (error instanceof McpAuthError) {
      toast.error(`${server.name} disconnected`, { description: message });
    }
  }
}

/**
 * Attempt guard per server: pressing Sign in again supersedes the previous
 * popup flow, whose late failure (its window finally reported closed) must
 * never clobber the newer attempt's card state.
 */
const oauthAttempts = new Map<string, symbol>();

/**
 * OAuth connect: registers the server as connecting, runs the popup sign-in
 * flow, then performs a normal connect with the stored token.
 */
export async function oauthConnectMcp(
  server: McpServerConfig,
  popup: Window | null,
  setSettings: (updater: (prev: AgentSettings) => AgentSettings) => void,
): Promise<void> {
  const attempt = Symbol("mcp-oauth-attempt");
  oauthAttempts.set(server.id, attempt);
  setSettings((prev) => {
    const exists = prev.mcpServers.some((item) => item.id === server.id);
    const list = exists ? prev.mcpServers : [...prev.mcpServers, server];
    return {
      ...prev,
      mcpServers: list.map((item) =>
        item.id === server.id ? { ...item, status: "connecting" as const, error: undefined } : item,
      ),
    };
  });
  try {
    await runOAuthSignIn({ id: server.id, url: server.url, name: server.name }, popup);
  } catch (error) {
    if (oauthAttempts.get(server.id) !== attempt) {
      return;
    }
    const message = errorFromUnknown(error);
    setSettings((prev) => ({
      ...prev,
      mcpServers: prev.mcpServers.map((item) =>
        item.id === server.id
          ? { ...item, status: "error" as const, error: message }
          : item,
      ),
    }));
    toast.error(`${server.name} sign-in failed`, { description: message });
    return;
  }
  if (oauthAttempts.get(server.id) !== attempt) {
    return;
  }
  await reconnectMcp(server, setSettings);
}

export function addBlankMcpServer(settings: AgentSettings): AgentSettings {
  return { ...settings, mcpServers: [...settings.mcpServers, newMcpServer()] };
}

export function addCatalogMcp(settings: AgentSettings, catalogId: string): AgentSettings {
  const entry = findCatalogEntry(catalogId);
  if (!entry) {
    return settings;
  }
  if (settings.mcpServers.some((item) => item.catalogId === entry.id || item.id === entry.id)) {
    return settings;
  }
  return { ...settings, mcpServers: [...settings.mcpServers, catalogEntryToServer(entry)] };
}

export function addMissingCatalogMcps(settings: AgentSettings): AgentSettings {
  const missing = missingCatalogEntries(settings.mcpServers).map(catalogEntryToServer);
  if (missing.length === 0) {
    return settings;
  }
  return { ...settings, mcpServers: [...settings.mcpServers, ...missing] };
}

export { newMcpServer };
export type { BuiltinToolId };
