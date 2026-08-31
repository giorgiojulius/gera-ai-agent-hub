import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { AgentContext, type AgentContextValue, type AgentDraftInput } from "@/hooks/agent-context";
import { useCloudSync } from "@/hooks/use-cloud-sync";
import { useMcpActions } from "@/hooks/use-mcp-actions";
import {
  activeConversation,
  adoptActiveServerRuns,
  createConversation,
  initialAgentState,
  resumePrompt,
  sendPrompt,
  upsertConversation,
  type AgentState,
} from "@/lib/agent-store";
import { fileToAttachment } from "@/lib/attachments";
import { getAccessToken } from "@/lib/auth-tokens";
import { errorFromUnknown } from "@/lib/errors";
import { shouldSignalExecution } from "@/lib/execution-outcome";
import { hasActiveCloudRun, stopServerRun } from "@/lib/server-run";
import { computeNextRunAt, type AutomationDraftInput } from "@/lib/automations";
import { newId } from "@/lib/env";
import { saveComposerDraft, saveConversations, saveQueuedFollowUps, saveSettings } from "@/lib/history";
import { RESUME_FRESH_MS } from "@/lib/resume";
import { deleteKnowledgeText } from "@/lib/knowledge-store";
import { migrateConversationsToVault, pruneMediaVault } from "@/lib/media-vault";
import { appNavigate, chatPath } from "@/lib/nav";
import { allowedLifeOps, applyLifeOps, extractActionOps, hasMemory, saveLife } from "@/lib/life";
import { moveQueuedItem, offerSteering, retractSteering, syncSteeringOrder } from "@/lib/steering";
import { playCompletionChime, shouldPlaySound, showRunFinishedNotification } from "@/lib/notify";
import {
  fetchGatewayModels,
  findModel,
  modeForModelType,
  modeOfModelId,
  modelIdForMode,
  withStaticModels,
} from "@/lib/models";
import type { AgentSettings, CreateMode, ExecutionOutcome, LifeState, QueuedMessage, RepoPreviewJob } from "@/lib/types";

export { useAgent } from "@/hooks/agent-context";
export type { AgentDraftInput } from "@/hooks/agent-context";

/** A server-confirmed stop must visibly settle the UI within this window even when the terminal event is lost. */
const STOP_SETTLE_GRACE_MS = 6_000;

/** Chat sync carries lifecycle evidence, never private build logs or preview capabilities. */
function persistableRepoPreview(job: RepoPreviewJob): RepoPreviewJob {
  const stored: RepoPreviewJob = { ...job };
  delete stored.logs;
  delete stored.previewUrl;
  delete stored.actionsUrl;
  delete stored.setupPullRequestUrl;
  return stored;
}

export function AgentProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AgentState>(() => initialAgentState());
  /** One controller per conversation — threads run in parallel and stop independently. */
  const abortMapRef = useRef<Map<string, AbortController>>(new Map());
  /** Threads where an explicit "stop & send" awaits its dispatch on settle. */
  const interruptPendingRef = useRef<Set<string>>(new Set());
  /** Completion signals (chime + desktop notification); a ref so every settle path can call it. */
  const notifyRef = useRef<(conversationId: string, execution?: ExecutionOutcome) => void>(() => {});
  /** Server runs are adopted once per session (boot or first sign-in). */
  const adoptedRef = useRef<boolean>(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  /** Drain runs through a ref to break the cycle: drain → sendPrompt → onDone → drain. */
  const drainRef = useRef<(conversationId: string) => void>(() => {});

  // --- Cloud history sync: one account, one history across devices (see
  // use-cloud-sync.ts — debounced loop, profile clock, tombstones, adoption). ---
  const { scheduleSync, recordTombstone } = useCloudSync({
    state,
    setState,
    stateRef,
    adoptedRef,
    notifyRef,
    drainRef,
  });

  // One-time boot pass: legacy inline media (persisted by older versions as
  // giant base64 strings) moves into the disk-backed vault, then blobs no
  // thread references anymore (deleted chats, stale composer attachments)
  // are pruned. Swapping by object identity guarantees a thread that changed
  // meanwhile (e.g. started streaming) is never clobbered — it simply
  // migrates on the next boot.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const replacements = await migrateConversationsToVault(stateRef.current.conversations);
      if (cancelled) {
        return;
      }
      if (replacements.size > 0) {
        setState((prev) => {
          let changed = false;
          const conversations = prev.conversations.map((item) => {
            const migrated = replacements.get(item);
            if (migrated) {
              changed = true;
              return migrated;
            }
            return item;
          });
          if (!changed) {
            return prev;
          }
          saveConversations(conversations);
          return { ...prev, conversations };
        });
      }
      // The merged view keeps freshly migrated refs even before React has
      // applied the state update above.
      const merged = stateRef.current.conversations.map((item) => replacements.get(item) ?? item);
      const keepRefs = [
        ...stateRef.current.attachments.map((item) => item.dataUrl),
        // Queued follow-ups persist across reloads — their vaulted images must too.
        ...Object.values(stateRef.current.queued)
          .flat()
          .flatMap((item) => item.attachments.map((file) => file.dataUrl)),
      ];
      void pruneMediaVault(merged, keepRefs);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const modelsQuery = useQuery({
    queryKey: ["gera-models"],
    queryFn: fetchGatewayModels,
    staleTime: 1000 * 60 * 30,
  });

  const models = useMemo(() => withStaticModels(modelsQuery.data ?? []), [modelsQuery.data]);

  useEffect(() => {
    saveSettings(state.settings);
  }, [state.settings]);

  useEffect(() => {
    saveLife(state.life);
  }, [state.life]);

  // Publish-safe: queued follow-ups and the composer draft survive reloads
  // (an app update mid-session loses nothing typed or queued).
  useEffect(() => {
    saveQueuedFollowUps(state.queued);
  }, [state.queued]);

  useEffect(() => {
    saveComposerDraft(state.input);
  }, [state.input]);

  useEffect(() => {
    const running = state.runningIds.length;
    const unread = state.unreadIds.length;
    document.title =
      unread > 0 ? `(${unread} done) Gera AI` : running > 0 ? `(${running} running) Gera AI` : "Gera AI";
  }, [state.runningIds, state.unreadIds]);

  const setSettings = useCallback((updater: (prev: AgentSettings) => AgentSettings) => {
    setState((prev) => ({ ...prev, settings: updater(prev.settings) }));
  }, []);

  // MCP connector actions + the boot revalidation pass (see use-mcp-actions.ts).
  const {
    updateMcp,
    addMcp,
    addCatalogMcpServer,
    connectCatalog,
    addCustomMcp,
    removeMcp,
    connectMcp,
    toggleMcpTool,
  } = useMcpActions({ stateRef, servers: state.settings.mcpServers, setSettings });

  const updateLife = useCallback((updater: (prev: LifeState) => LifeState) => {
    setState((prev) => ({ ...prev, life: updater(prev.life) }));
  }, []);

  const newChat = useCallback((options?: { incognito?: boolean }) => {
    const incognito = options?.incognito === true;
    setState((prev) => {
      // Reuse an existing blank draft of the same kind instead of stacking
      // "New thread" rows — repeated clicks land on the same empty chat.
      const blank = prev.conversations.find(
        (item) =>
          item.messages.length === 0 &&
          !item.automationId &&
          !item.agentId &&
          (item.incognito === true) === incognito &&
          !prev.runningIds.includes(item.id),
      );
      if (blank) {
        return { ...prev, activeId: blank.id, input: "", attachments: [] };
      }
      const base = createConversation(prev.settings.modelId);
      const conversation = incognito ? { ...base, incognito: true as const } : base;
      const conversations = [conversation, ...prev.conversations];
      saveConversations(conversations);
      return { ...prev, conversations, activeId: conversation.id, input: "", attachments: [] };
    });
  }, []);

  const newChatWithAgent = useCallback((agentId: string) => {
    const agent = stateRef.current.settings.agents.find((item) => item.id === agentId);
    const modelId = agent?.modelId || stateRef.current.settings.modelId;
    setState((prev) => {
      const blank = prev.conversations.find(
        (item) =>
          item.messages.length === 0 &&
          !item.automationId &&
          item.agentId === agentId &&
          item.incognito !== true &&
          !prev.runningIds.includes(item.id),
      );
      const conversation = blank ?? createConversation(modelId, agentId);
      const conversations = blank ? prev.conversations : [conversation, ...prev.conversations];
      if (!blank) {
        saveConversations(conversations);
      }
      return {
        ...prev,
        conversations,
        activeId: conversation.id,
        input: "",
        attachments: [],
        settings: {
          ...prev.settings,
          mode: "chat" as const,
          ...(agent?.modelId ? { modelId: agent.modelId } : {}),
        },
      };
    });
  }, []);

  const setChatAgent = useCallback((agentId: string | null) => {
    setState((prev) => {
      const current = prev.conversations.find((item) => item.id === prev.activeId);
      if (!current) {
        return prev;
      }
      const conversations = prev.conversations.map((item) =>
        item.id === current.id ? { ...item, agentId: agentId ?? undefined } : item,
      );
      saveConversations(conversations);
      return { ...prev, conversations };
    });
  }, []);

  /** Pin/unpin a GitHub repo on the active thread — its runs default GitHub tools to it. */
  const setChatRepo = useCallback((repo: string | null) => {
    setState((prev) => {
      const trimmed = repo?.trim() ?? "";
      const current = prev.conversations.find((item) => item.id === prev.activeId);
      if (!current) {
        if (!trimmed) {
          return prev;
        }
        // Launchpad with no draft yet — pinning creates the draft, like typing would.
        const conversation = { ...createConversation(prev.settings.modelId), githubRepo: trimmed };
        const conversations = [conversation, ...prev.conversations];
        saveConversations(conversations);
        return { ...prev, conversations, activeId: conversation.id };
      }
      if ((current.githubRepo ?? "") === trimmed) {
        return prev;
      }
      const conversations = prev.conversations.map((item) =>
        item.id === current.id
          ? { ...item, githubRepo: trimmed || undefined, updatedAt: Date.now() }
          : item,
      );
      saveConversations(conversations);
      return { ...prev, conversations };
    });
  }, []);

  const recordRepoPreview = useCallback((job: RepoPreviewJob, conversationId?: string) => {
    const now = Date.now();
    const storedJob = persistableRepoPreview(job);
    setState((prev) => {
      const existing = conversationId
        ? prev.conversations.find((item) => item.id === conversationId)
        : prev.conversations.find((item) => item.id === prev.activeId);
      if (existing?.incognito === true) {
        return prev;
      }
      const current = existing ?? {
        ...createConversation(prev.settings.modelId),
        githubRepo: job.repository,
      };
      const shortName = job.repository.split("/").pop() ?? job.repository;
      const messages = [
        ...current.messages,
        {
          id: newId(),
          role: "user" as const,
          content: `Launch ${job.repository} as a web preview.`,
          createdAt: now,
        },
        {
          id: newId(),
          role: "assistant" as const,
          content: "",
          repoPreview: storedJob,
          createdAt: now,
        },
      ];
      const conversation = {
        ...current,
        title: current.title === "New thread" ? `Preview · ${shortName}` : current.title,
        githubRepo: job.repository,
        messages,
        updatedAt: now,
      };
      const conversations = upsertConversation(prev.conversations, conversation);
      saveConversations(conversations);
      return { ...prev, conversations, activeId: prev.activeId ?? conversation.id };
    });
    scheduleSync(800);
  }, [scheduleSync]);

  const updateRepoPreview = useCallback((job: RepoPreviewJob) => {
    const storedJob = persistableRepoPreview(job);
    let changed = false;
    setState((prev) => {
      const conversations = prev.conversations.map((conversation) => {
        let conversationChanged = false;
        const messages = conversation.messages.map((message) => {
          if (message.repoPreview?.id !== job.id) return message;
          const current = persistableRepoPreview(message.repoPreview);
          if (JSON.stringify(current) === JSON.stringify(storedJob)) return message;
          changed = true;
          conversationChanged = true;
          return { ...message, repoPreview: storedJob };
        });
        return conversationChanged ? { ...conversation, messages, updatedAt: Date.now() } : conversation;
      });
      if (!changed) return prev;
      saveConversations(conversations);
      return { ...prev, conversations };
    });
    scheduleSync(800);
  }, [scheduleSync]);

  const createAgent = useCallback((input: AgentDraftInput): string => {
    const id = newId();
    setSettings((prev) => ({
      ...prev,
      agents: [{ ...input, id, createdAt: Date.now() }, ...prev.agents],
    }));
    return id;
  }, [setSettings]);

  const updateAgent = useCallback((id: string, patch: Partial<AgentDraftInput>) => {
    setSettings((prev) => ({
      ...prev,
      agents: prev.agents.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));
  }, [setSettings]);

  const deleteAgent = useCallback((id: string) => {
    setState((prev) => {
      const removed = prev.settings.agents.find((item) => item.id === id);
      // Best-effort cloud cleanup; deletes are idempotent, so a StrictMode
      // double-invoke of this updater is harmless.
      for (const doc of removed?.knowledge ?? []) {
        if (doc.r2Key) {
          void deleteKnowledgeText(doc.r2Key);
        }
      }
      const conversations = prev.conversations.map((item) =>
        item.agentId === id ? { ...item, agentId: undefined } : item,
      );
      saveConversations(conversations);
      return {
        ...prev,
        conversations,
        settings: { ...prev.settings, agents: prev.settings.agents.filter((item) => item.id !== id) },
      };
    });
  }, []);

  const createAutomation = useCallback((input: AutomationDraftInput): string => {
    const id = newId();
    const now = Date.now();
    setSettings((prev) => ({
      ...prev,
      automations: [
        { ...input, id, conversationId: newId(), nextRunAt: computeNextRunAt(input, now), createdAt: now },
        ...prev.automations,
      ],
    }));
    return id;
  }, [setSettings]);

  const updateAutomation = useCallback((id: string, patch: Partial<AutomationDraftInput>) => {
    setSettings((prev) => ({
      ...prev,
      automations: prev.automations.map((item) => {
        if (item.id !== id) {
          return item;
        }
        const next = { ...item, ...patch };
        return { ...next, nextRunAt: computeNextRunAt(next, Date.now()) };
      }),
    }));
  }, [setSettings]);

  const deleteAutomation = useCallback((id: string) => {
    setSettings((prev) => ({ ...prev, automations: prev.automations.filter((item) => item.id !== id) }));
  }, [setSettings]);

  const selectChat = useCallback((id: string) => {
    // Switching threads never kills a running one — it keeps working in the background.
    setState((prev) => ({
      ...prev,
      activeId: id,
      sidebarOpen: false,
      unreadIds: prev.unreadIds.filter((item) => item !== id),
    }));
  }, []);

  // Completion signals per settings: the chime plays for settled runs
  // (scope: off / out-of-view / always), the desktop notification fires only
  // while the tab is hidden. Manual stops and takeovers never signal.
  notifyRef.current = (conversationId: string, execution?: ExecutionOutcome) => {
    if (!shouldSignalExecution(execution)) {
      return;
    }
    const snapshot = stateRef.current;
    const inBackground = document.hidden || snapshot.activeId !== conversationId;
    if (shouldPlaySound(snapshot.settings.notifySound, inBackground)) {
      playCompletionChime();
    }
    if (snapshot.settings.notifyDesktop && document.hidden) {
      const thread = snapshot.conversations.find((item) => item.id === conversationId);
      showRunFinishedNotification({
        title: thread?.title || "Gera AI",
        body: "The reply is ready — click to open the thread.",
        tag: conversationId,
        onOpen: () => {
          selectChat(conversationId);
          appNavigate(chatPath(conversationId));
        },
      });
    }
  };

  const deleteChat = useCallback((id: string) => {
    if (hasActiveCloudRun(id)) {
      // Stop the server run first, or it would resurrect the deleted thread.
      void stopServerRun(id).catch(() => undefined);
    }
    abortMapRef.current.get(id)?.abort();
    abortMapRef.current.delete(id);
    // The deletion must reach other devices — record a sync tombstone.
    // Incognito threads never reached the cloud, so no tombstone for them.
    const target = stateRef.current.conversations.find((item) => item.id === id);
    if (target?.incognito !== true) {
      recordTombstone(id);
      scheduleSync(800);
    }
    setState((prev) => {
      const conversations = prev.conversations.filter((item) => item.id !== id);
      const activeId = prev.activeId === id ? conversations[0]?.id ?? null : prev.activeId;
      const queued = { ...prev.queued };
      delete queued[id];
      saveConversations(conversations);
      return {
        ...prev,
        conversations,
        activeId,
        queued,
        runningIds: prev.runningIds.filter((item) => item !== id),
        unreadIds: prev.unreadIds.filter((item) => item !== id),
      };
    });
  }, [recordTombstone, scheduleSync]);

  const renameChat = useCallback((id: string, title: string) => {
    setState((prev) => {
      const current = prev.conversations.find((item) => item.id === id);
      if (!current) {
        return prev;
      }
      const conversations = upsertConversation(prev.conversations, { ...current, title, updatedAt: Date.now() });
      saveConversations(conversations);
      return { ...prev, conversations };
    });
  }, []);

  const togglePinChat = useCallback((id: string) => {
    setState((prev) => {
      const current = prev.conversations.find((item) => item.id === id);
      if (!current) {
        return prev;
      }
      // updatedAt bump makes the pin win LWW sync and reach other devices.
      const conversations = upsertConversation(prev.conversations, {
        ...current,
        pinned: current.pinned === true ? undefined : true,
        updatedAt: Date.now(),
      });
      saveConversations(conversations);
      return { ...prev, conversations };
    });
    scheduleSync(800);
  }, [scheduleSync]);

  const markUnreadChat = useCallback((id: string) => {
    setState((prev) =>
      prev.unreadIds.includes(id) ? prev : { ...prev, unreadIds: [...prev.unreadIds, id] },
    );
  }, []);

  const setInput = useCallback((value: string) => {
    setState((prev) => ({ ...prev, input: value }));
  }, []);

  const addAttachments = useCallback(async (files: File[], options?: { replace?: boolean }) => {
    const next = await Promise.all(files.map(fileToAttachment));
    setState((prev) => ({
      ...prev,
      attachments: (options?.replace ? next : [...prev.attachments, ...next]).slice(0, 6),
    }));
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setState((prev) => ({ ...prev, attachments: prev.attachments.filter((item) => item.id !== id) }));
  }, []);

  /** Detaches this tab from a thread's run: abort, forget the controller, clear the flag. */
  const detachLocalRun = useCallback((id: string) => {
    abortMapRef.current.get(id)?.abort();
    abortMapRef.current.delete(id);
    setState((prev) => ({ ...prev, runningIds: prev.runningIds.filter((item) => item !== id) }));
  }, []);

  /**
   * Stops a cloud run with a guaranteed visible result. Normally the server
   * confirms, the engine winds down and the terminal event settles the UI
   * within a second or two — but the Stop button must never depend on that
   * event alone. A backend node that lost the run ("not_running" after a
   * deploy), a dropped stream or a lost terminal event used to leave a dead
   * Stop button until a page reload:
   * - the server says nothing is running → this tab detaches immediately;
   * - the stop is confirmed but no terminal event lands within the grace
   *   window → the tab detaches honestly (the draft stays as shown; sync or
   *   the next boot reconciles the authoritative final);
   * - a successor turn that took over the thread meanwhile is never touched.
   */
  const stopCloudRun = useCallback(
    (id: string, errorTitle: string) => {
      const controllerAtPress = abortMapRef.current.get(id);
      const settle = () => {
        if (abortMapRef.current.get(id) !== controllerAtPress) {
          return; // a newer turn owns this thread now — hands off
        }
        if (!stateRef.current.runningIds.includes(id)) {
          return; // the terminal event landed — nothing to force
        }
        const hadInterrupt = interruptPendingRef.current.has(id);
        interruptPendingRef.current.delete(id);
        detachLocalRun(id);
        if (hadInterrupt) {
          // "Stop & send" must still dispatch its message — the aborted
          // unwind path holds the queue by design.
          window.setTimeout(() => drainRef.current(id), 90);
        }
      };
      void stopServerRun(id)
        .then((result) => {
          if (result.ok === false) {
            settle();
            return;
          }
          window.setTimeout(settle, STOP_SETTLE_GRACE_MS);
        })
        .catch((error) => {
          interruptPendingRef.current.delete(id);
          toast.error(errorTitle, { description: errorFromUnknown(error) });
        });
    },
    [detachLocalRun],
  );

  const stop = useCallback(() => {
    const id = stateRef.current.activeId;
    if (!id) {
      return;
    }
    if (hasActiveCloudRun(id)) {
      // The run lives on the server — stop it there. The terminal event
      // normally clears the running flag; stopCloudRun guarantees the UI
      // settles even when that event never arrives.
      stopCloudRun(id, "Could not stop the run");
      return;
    }
    if (stateRef.current.runningIds.includes(id)) {
      // Not attached yet — the run may still be STARTING on the server (the
      // prep + start-request window before the stream opens). A local abort
      // alone would let it grind to completion in the cloud and the reply
      // would arrive anyway; fire a best-effort server stop too. Harmless
      // when nothing reached the server.
      void stopServerRun(id).catch(() => undefined);
    }
    detachLocalRun(id);
  }, [detachLocalRun, stopCloudRun]);

  const toggleDeepResearch = useCallback(() => {
    setState((prev) => ({ ...prev, deepResearch: !prev.deepResearch }));
  }, []);

  // Combines freely with deep research: the council then audits the report.
  const toggleJulius = useCallback(() => {
    setState((prev) => ({ ...prev, julius: !prev.julius }));
  }, []);

  /** Applies a candidate pick to a Julius panel message; user can override the council. */
  const chooseJuliusWinner = useCallback((messageId: string, candidateIndex: number) => {
    let remembered: string[] = [];
    setState((prev) => {
      const conversation = prev.conversations.find((item) => item.id === prev.activeId);
      if (!conversation) {
        return prev;
      }
      let changed = false;
      let pickedContent = "";
      let opsAlreadyApplied = true;
      const messages = conversation.messages.map((message) => {
        if (message.id !== messageId || !message.julius) {
          return message;
        }
        const julius = message.julius;
        if (julius.status === "candidates" || julius.status === "debate") {
          return message; // run still in flight — the runner owns this state
        }
        const candidate = julius.candidates[candidateIndex];
        if (!candidate || candidate.status === "running" || !candidate.content.trim()) {
          return message;
        }
        changed = true;
        pickedContent = candidate.content;
        opsAlreadyApplied = (julius.hubOpsApplied ?? []).includes(candidateIndex);
        return {
          ...message,
          content: candidate.content,
          // The chip must describe the text now shown: the picked candidate's
          // own fallback (if any), not the synthesis call's.
          servedBy: candidate.servedBy,
          // Research mode: the shared source list makes the picked report's
          // [n] citation pills resolve in the message body.
          ...(julius.sources && julius.sources.length > 0 ? { sources: julius.sources } : {}),
          julius: {
            ...julius,
            winner: candidateIndex,
            decidedBy: "user" as const,
            status: "done" as const,
            finishedAt: julius.finishedAt ?? Date.now(),
            hubOpsApplied: opsAlreadyApplied
              ? julius.hubOpsApplied
              : [...(julius.hubOpsApplied ?? []), candidateIndex],
          },
        };
      });
      if (!changed) {
        return prev;
      }
      const conversations = upsertConversation(prev.conversations, {
        ...conversation,
        messages,
        updatedAt: Date.now(),
      });
      saveConversations(conversations);
      // The picked answer's hub writes (facts, logs, tasks) land now — unless
      // this exact candidate already wrote when the panel settled, the thread
      // is incognito, or hub sharing is off.
      let life = prev.life;
      if (!opsAlreadyApplied && conversation.incognito !== true && prev.life.shareWithAgent) {
        const ops = allowedLifeOps(prev.life, extractActionOps(pickedContent));
        if (ops.length > 0) {
          life = applyLifeOps(prev.life, ops);
          remembered = ops.flatMap((op) =>
            op.op === "memory.save" && !hasMemory(prev.life, op.text) ? [op.text] : [],
          );
        }
      }
      return { ...prev, conversations, life };
    });
    // Auto-memory should be felt — announce after the state update lands.
    window.setTimeout(() => {
      if (remembered.length > 0) {
        toast.success(remembered.length === 1 ? "Remembered" : `Remembered ${remembered.length} facts`, {
          description: remembered[0].slice(0, 140),
        });
      }
    }, 0);
  }, []);

  /** Clears the run's controller and, unless it was stopped, fires the next queued follow-up. */
  const finishRun = useCallback(
    (
      conversationId: string,
      controller: AbortController,
      stoppedManually?: boolean,
      execution?: ExecutionOutcome,
    ) => {
      if (abortMapRef.current.get(conversationId) === controller) {
        abortMapRef.current.delete(conversationId);
      }
      // A manual stop holds the queue — local abort or server-confirmed stop —
      // except an explicit "stop & send", which dispatches its message now.
      const interrupted = interruptPendingRef.current.delete(conversationId);
      if (!controller.signal.aborted && stoppedManually !== true) {
        notifyRef.current(conversationId, execution);
      }
      if (!controller.signal.aborted && (stoppedManually !== true || interrupted)) {
        window.setTimeout(() => drainRef.current(conversationId), 60);
      }
    },
    [],
  );

  /** Sends the first queued follow-up of a thread once nothing is running there. */
  const dispatchQueued = useCallback((conversationId: string) => {
    const snapshot = stateRef.current;
    const item = (snapshot.queued[conversationId] ?? [])[0];
    if (!item) {
      return;
    }
    if (snapshot.runningIds.includes(conversationId)) {
      return; // A newer run took over — it drains the queue when it settles.
    }
    const conversation = snapshot.conversations.find((entry) => entry.id === conversationId);
    if (!conversation) {
      setState((prev) => {
        const queued = { ...prev.queued };
        delete queued[conversationId];
        return { ...prev, queued };
      });
      return;
    }
    setState((prev) => ({
      ...prev,
      queued: {
        ...prev.queued,
        [conversationId]: (prev.queued[conversationId] ?? []).filter((entry) => entry.id !== item.id),
      },
    }));
    const controller = new AbortController();
    void sendPrompt({
      state: snapshot,
      setState,
      signal: controller.signal,
      overrides: {
        prompt: item.text,
        conversationId,
        title: conversation.title,
        agentId: conversation.agentId ?? null,
        deepResearch: item.deepResearch,
        julius: item.julius,
        mode: item.mode,
        attachments: item.attachments,
      },
      onRun: (id) => {
        abortMapRef.current.get(id)?.abort();
        abortMapRef.current.set(id, controller);
      },
      onDone: (id, stopped, execution) => {
        finishRun(id, controller, stopped, execution);
        if (
          controller.signal.aborted ||
          stateRef.current.activeId === id ||
          !shouldSignalExecution(execution)
        ) {
          return;
        }
        const thread = stateRef.current.conversations.find((entry) => entry.id === id);
        if (thread) {
          toast.success("Finished in the background", {
            description: thread.title,
            action: {
              label: "Open",
              onClick: () => {
                selectChat(id);
                appNavigate(chatPath(id));
              },
            },
          });
        }
      },
    });
  }, [finishRun, selectChat]);
  drainRef.current = dispatchQueued;

  /**
   * Captures the composer as a follow-up for the active thread — the three
   * delivery channels of a live run:
   * - default: FIFO queue, dispatched as a fresh turn after the run settles;
   * - steer: handed to the in-flight agent loop, lands at its next step
   *   boundary — the run keeps going, nothing is interrupted. Runs that can't
   *   absorb guidance mid-flight (research, Julius, media) queue honestly
   *   instead and say so;
   * - interrupt: aborts the live run (whatever streamed stays) and sends this
   *   message immediately as a new turn. Never the default — explicit gesture.
   */
  const queueMessage = useCallback((options?: { steer?: boolean; interrupt?: boolean }) => {
    const snapshot = stateRef.current;
    const conversationId = snapshot.activeId;
    if (!conversationId) {
      return;
    }
    const isChat = snapshot.settings.mode === "chat";
    const text = snapshot.input.trim();
    const attachments = isChat ? snapshot.attachments : [];
    if (!text && attachments.length === 0) {
      return;
    }
    const running = snapshot.runningIds.includes(conversationId);
    const item: QueuedMessage = {
      id: newId(),
      text,
      attachments,
      mode: snapshot.settings.mode,
      deepResearch: isChat && snapshot.deepResearch,
      julius: isChat && snapshot.julius,
      createdAt: Date.now(),
    };
    // Interrupt — the third channel ("stop & send"): stop the live run,
    // keep whatever already streamed, fire this message right away.
    if (options?.interrupt === true) {
      if (hasActiveCloudRun(conversationId)) {
        // Server run: stop it there; the marker below lets the settle handler
        // dispatch this message immediately (a plain stop holds the queue).
        interruptPendingRef.current.add(conversationId);
        stopCloudRun(conversationId, "Could not interrupt the run");
        setState((prev) => ({
          ...prev,
          input: "",
          attachments: [],
          queued: {
            ...prev.queued,
            [conversationId]: [item, ...(prev.queued[conversationId] ?? [])],
          },
        }));
        return;
      }
      abortMapRef.current.get(conversationId)?.abort();
      abortMapRef.current.delete(conversationId);
      setState((prev) => ({
        ...prev,
        input: "",
        attachments: [],
        runningIds: prev.runningIds.filter((entry) => entry !== conversationId),
        queued: {
          ...prev.queued,
          [conversationId]: [item, ...(prev.queued[conversationId] ?? [])],
        },
      }));
      window.setTimeout(() => drainRef.current(conversationId), 60);
      return;
    }
    // Real steering: no abort — the live loop picks the message up at its
    // next step boundary and the model adjusts course mid-run.
    const steered =
      options?.steer === true && running && isChat && offerSteering(conversationId, item);
    if (options?.steer === true && running && !steered) {
      toast.info("This run can't take mid-run steering", {
        description: "Queued — it sends the moment the run finishes.",
      });
    }
    const queuedItem: QueuedMessage = steered ? { ...item, steer: true } : item;
    setState((prev) => ({
      ...prev,
      input: "",
      attachments: [],
      queued: {
        ...prev.queued,
        [conversationId]: steered
          ? [queuedItem, ...(prev.queued[conversationId] ?? [])]
          : [...(prev.queued[conversationId] ?? []), queuedItem],
      },
    }));
    // A run that settled between keystroke and here — fire the queue now.
    if (!running) {
      window.setTimeout(() => drainRef.current(conversationId), 60);
    }
  }, [stopCloudRun]);

  const removeQueued = useCallback((id: string) => {
    const conversationId = stateRef.current.activeId;
    if (!conversationId) {
      return;
    }
    // If the live run hasn't consumed it yet, take it back from the inbox too.
    retractSteering(conversationId, id);
    setState((prev) => ({
      ...prev,
      queued: {
        ...prev.queued,
        [conversationId]: (prev.queued[conversationId] ?? []).filter((entry) => entry.id !== id),
      },
    }));
  }, []);

  /**
   * Drag-and-drop reorder of the follow-up queue (Cursor 2.4 style): the
   * dragged item takes the target's position, and dispatch order follows —
   * the head of the list is what fires next. When reordered items already
   * ride a live steerable run, the steering inbox is re-ranked too so
   * mid-run injection order always matches the visible chips.
   */
  const reorderQueued = useCallback((fromId: string, toId: string) => {
    const conversationId = stateRef.current.activeId;
    if (!conversationId) {
      return;
    }
    setState((prev) => {
      const next = moveQueuedItem(prev.queued[conversationId] ?? [], fromId, toId);
      if (!next) {
        return prev;
      }
      // Idempotent for a given order — a dev-mode double-invoked updater lands
      // on the same inbox ranking, so this side effect is safe here.
      syncSteeringOrder(
        conversationId,
        next.map((item) => item.id),
      );
      return { ...prev, queued: { ...prev.queued, [conversationId]: next } };
    });
  }, []);

  /**
   * Fires a queued follow-up now. With a live steerable run it becomes real
   * steering — injected mid-run, nothing interrupted. Only when the run can't
   * take guidance (research, Julius, media) does "now" honestly mean
   * interrupting it, and the button says so.
   */
  const sendQueuedNow = useCallback((id: string) => {
    const snapshot = stateRef.current;
    const conversationId = snapshot.activeId;
    if (!conversationId) {
      return;
    }
    const item = (snapshot.queued[conversationId] ?? []).find((entry) => entry.id === id);
    if (!item) {
      return;
    }
    const running = snapshot.runningIds.includes(conversationId);
    if (item.steer && running) {
      return; // Already handed to the live run — it lands at the next boundary.
    }
    if (running && item.mode === "chat" && offerSteering(conversationId, item)) {
      setState((prev) => ({
        ...prev,
        queued: {
          ...prev.queued,
          [conversationId]: (prev.queued[conversationId] ?? []).map((entry) =>
            entry.id === id ? { ...entry, steer: true } : entry,
          ),
        },
      }));
      return;
    }
    if (hasActiveCloudRun(conversationId)) {
      // Server run: stop it there; the marker lets the head of the queue
      // dispatch the moment the stopped run settles.
      interruptPendingRef.current.add(conversationId);
      stopCloudRun(conversationId, "Could not interrupt the run");
      setState((prev) => ({
        ...prev,
        queued: {
          ...prev.queued,
          [conversationId]: [
            { ...item, steer: undefined },
            ...(prev.queued[conversationId] ?? []).filter((entry) => entry.id !== id),
          ],
        },
      }));
      return;
    }
    abortMapRef.current.get(conversationId)?.abort();
    abortMapRef.current.delete(conversationId);
    setState((prev) => ({
      ...prev,
      runningIds: prev.runningIds.filter((entry) => entry !== conversationId),
      queued: {
        ...prev.queued,
        [conversationId]: [
          // A leftover steer flag (the run settled or was stopped before
          // consuming it) is stale here — dispatch as an ordinary follow-up.
          { ...item, steer: undefined },
          ...(prev.queued[conversationId] ?? []).filter((entry) => entry.id !== id),
        ],
      },
    }));
    window.setTimeout(() => drainRef.current(conversationId), 60);
  }, []);

  const send = useCallback(() => {
    const controller = new AbortController();
    void sendPrompt({
      state: stateRef.current,
      setState,
      signal: controller.signal,
      onRun: (conversationId) => {
        abortMapRef.current.get(conversationId)?.abort();
        abortMapRef.current.set(conversationId, controller);
      },
      onDone: (conversationId, stopped, execution) => {
        finishRun(conversationId, controller, stopped, execution);
        if (
          controller.signal.aborted ||
          stateRef.current.activeId === conversationId ||
          !shouldSignalExecution(execution)
        ) {
          return;
        }
        const conversation = stateRef.current.conversations.find((item) => item.id === conversationId);
        if (!conversation) {
          return;
        }
        toast.success("Finished in the background", {
          description: conversation.title,
          action: {
            label: "Open",
            onClick: () => {
              selectChat(conversationId);
              appNavigate(chatPath(conversationId));
            },
          },
        });
      },
    });
  }, [finishRun, selectChat]);

  const editMessage = useCallback((messageId: string, newText: string) => {
    const snapshot = stateRef.current;
    const conversation = snapshot.conversations.find((item) => item.id === snapshot.activeId);
    if (!conversation) {
      return;
    }
    const index = conversation.messages.findIndex((item) => item.id === messageId);
    if (index < 0 || conversation.messages[index].role !== "user") {
      return;
    }
    const edited = conversation.messages[index];
    const reply = conversation.messages.slice(index + 1).find((item) => item.role === "assistant");
    // Re-run in the same creation mode the original turn produced.
    const mode: CreateMode =
      reply?.images && reply.images.length > 0
        ? "image"
        : reply?.videos && reply.videos.length > 0
          ? "video"
          : reply?.audioUrl
            ? "audio"
            : "chat";
    const controller = new AbortController();
    void sendPrompt({
      state: snapshot,
      setState,
      signal: controller.signal,
      overrides: {
        prompt: newText,
        conversationId: conversation.id,
        title: conversation.title,
        agentId: conversation.agentId ?? null,
        deepResearch: Boolean(reply?.research),
        julius: Boolean(reply?.julius),
        mode,
        replaceMessages: conversation.messages.slice(0, index),
        attachments: edited.attachments,
      },
      onRun: (conversationId) => {
        abortMapRef.current.get(conversationId)?.abort();
        abortMapRef.current.set(conversationId, controller);
      },
      onDone: (conversationId, stopped, execution) => {
        finishRun(conversationId, controller, stopped, execution);
      },
    });
  }, [finishRun]);

  /** Guards double-fire (StrictMode boot pass, double click) per message. */
  const resumingRef = useRef<Set<string>>(new Set());

  /**
   * Continues a reply that a reload (an app update mid-run) cut. The partial
   * text stays; the continuation streams into the same bubble and the
   * thread's queue drains right after.
   */
  const resumeInterrupted = useCallback((messageId: string) => {
    const snapshot = stateRef.current;
    const conversation = snapshot.conversations.find((item) =>
      item.messages.some((entry) => entry.id === messageId),
    );
    if (
      !conversation ||
      snapshot.runningIds.includes(conversation.id) ||
      resumingRef.current.has(messageId)
    ) {
      return;
    }
    resumingRef.current.add(messageId);
    const controller = new AbortController();
    void resumePrompt({
      state: snapshot,
      setState,
      signal: controller.signal,
      conversationId: conversation.id,
      messageId,
      onRun: (id) => {
        abortMapRef.current.get(id)?.abort();
        abortMapRef.current.set(id, controller);
      },
      onDone: (id, stopped, execution) => {
        resumingRef.current.delete(messageId);
        finishRun(id, controller, stopped, execution);
      },
    });
  }, [finishRun]);

  /** Re-runs a turn that a reload killed before anything arrived. */
  const retryInterrupted = useCallback((messageId: string) => {
    const snapshot = stateRef.current;
    const conversation = snapshot.conversations.find((item) =>
      item.messages.some((entry) => entry.id === messageId),
    );
    if (!conversation || snapshot.runningIds.includes(conversation.id)) {
      return;
    }
    const index = conversation.messages.findIndex((entry) => entry.id === messageId);
    const message = conversation.messages[index];
    if (!message || message.role !== "assistant") {
      return;
    }
    let userIndex = -1;
    for (let i = index - 1; i >= 0; i -= 1) {
      if (conversation.messages[i].role === "user") {
        userIndex = i;
        break;
      }
    }
    if (userIndex < 0) {
      return;
    }
    const userMessage = conversation.messages[userIndex];
    const controller = new AbortController();
    void sendPrompt({
      state: snapshot,
      setState,
      signal: controller.signal,
      overrides: {
        prompt: userMessage.content,
        conversationId: conversation.id,
        title: conversation.title,
        agentId: conversation.agentId ?? null,
        deepResearch: Boolean(message.research),
        julius: Boolean(message.julius),
        // The thread's model remembers what kind of turn this was (image/video/audio/chat).
        mode: modeOfModelId(conversation.modelId) ?? "chat",
        replaceMessages: conversation.messages.slice(0, userIndex),
        attachments: userMessage.attachments,
      },
      onRun: (id) => {
        abortMapRef.current.get(id)?.abort();
        abortMapRef.current.set(id, controller);
      },
      onDone: (id, stopped, execution) => {
        finishRun(id, controller, stopped, execution);
      },
    });
  }, [finishRun]);

  /**
   * One-shot boot recovery — the silent "nothing is lost to a publish" pass.
   * The boot plan (initialAgentState) already re-marked the freshest cut
   * reply as pending, so no chip or toast ever appears: a text partial just
   * keeps streaming into its bubble, an empty cut re-runs its prompt, and
   * restored follow-up queues dispatch themselves on settled fresh threads.
   * Older interruptions keep the in-thread Continue/Retry chip instead of
   * silently spending tokens.
   */
  const bootRecoveryRef = useRef<boolean>(false);
  useEffect(() => {
    if (bootRecoveryRef.current) {
      return;
    }
    bootRecoveryRef.current = true;
    void (async () => {
      // Runs may be executing (or already finished) on the server — adopt
      // them BEFORE local recovery so a reply is never continued twice.
      const adopted = new Set<string>();
      if (getAccessToken()) {
        adoptedRef.current = true;
        try {
          const result = await adoptActiveServerRuns({
            getState: () => stateRef.current,
            setState,
            onDone: (conversationId, stopped, execution) => {
              if (stopped !== true) {
                notifyRef.current(conversationId, execution);
                window.setTimeout(() => drainRef.current(conversationId), 60);
              }
            },
          });
          for (const id of [...result.running, ...result.applied]) {
            adopted.add(id);
          }
        } catch {
          // Backend unreachable — local recovery still offers Continue/Retry.
        }
      }
      const snapshot = stateRef.current;
      const now = Date.now();
      const recovering = new Set<string>();
      for (const conversation of snapshot.conversations) {
        if (snapshot.runningIds.includes(conversation.id) || adopted.has(conversation.id)) {
          continue;
        }
        const last = conversation.messages[conversation.messages.length - 1];
        if (!last || last.role !== "assistant" || last.pending !== true) {
          continue;
        }
        recovering.add(conversation.id);
        if (last.content.trim().length > 0) {
          resumeInterrupted(last.id);
        } else {
          retryInterrupted(last.id);
        }
      }
      for (const [conversationId, items] of Object.entries(snapshot.queued)) {
        if (items.length === 0 || recovering.has(conversationId) || adopted.has(conversationId)) {
          continue; // the recovered run drains its queue when it settles
        }
        const thread = snapshot.conversations.find((item) => item.id === conversationId);
        if (!thread || now - thread.updatedAt >= RESUME_FRESH_MS) {
          continue;
        }
        const tail = thread.messages[thread.messages.length - 1];
        if (tail && tail.role === "assistant" && tail.interrupted) {
          continue; // Continue/Retry first — the user decides the order
        }
        window.setTimeout(() => drainRef.current(conversationId), 400);
      }
    })();
  }, [resumeInterrupted, retryInterrupted]);

  /**
   * Fires one automation run into its own background thread.
   * `reschedule` moves nextRunAt forward (scheduled fire); manual runs keep it.
   */
  const runAutomation = useCallback((id: string, reschedule: boolean) => {
    const snapshot = stateRef.current;
    const automation = snapshot.settings.automations.find((item) => item.id === id);
    if (!automation || !automation.prompt.trim()) {
      return;
    }
    const now = Date.now();
    const overlapped = snapshot.runningIds.includes(automation.conversationId);
    setSettings((prev) => ({
      ...prev,
      automations: prev.automations.map((item) =>
        item.id === id
          ? {
              ...item,
              ...(overlapped ? {} : { lastRunAt: now }),
              ...(reschedule ? { nextRunAt: computeNextRunAt(item, now) } : {}),
            }
          : item,
      ),
    }));
    if (overlapped) {
      return; // Previous run is still streaming into this thread — never overlap.
    }
    const controller = new AbortController();
    void sendPrompt({
      state: snapshot,
      setState,
      signal: controller.signal,
      overrides: {
        prompt: automation.prompt,
        conversationId: automation.conversationId,
        title: automation.name,
        agentId: automation.agentId,
        deepResearch: automation.deepResearch,
        automationId: automation.id,
        mcpServerIds: automation.mcpServerIds,
        skillIds: automation.skillIds,
      },
      onRun: (conversationId) => {
        abortMapRef.current.get(conversationId)?.abort();
        abortMapRef.current.set(conversationId, controller);
      },
      onDone: (conversationId, stopped, execution) => {
        finishRun(conversationId, controller, stopped, execution);
        if (
          controller.signal.aborted ||
          stateRef.current.activeId === conversationId ||
          !shouldSignalExecution(execution)
        ) {
          return;
        }
        toast.success(automation.name, {
          description: "Scheduled run finished",
          action: {
            label: "Open",
            onClick: () => {
              selectChat(conversationId);
              appNavigate(chatPath(conversationId));
            },
          },
        });
      },
    });
  }, [setSettings, selectChat, finishRun]);

  const runAutomationNow = useCallback((id: string) => {
    runAutomation(id, false);
  }, [runAutomation]);

  // Scheduler: fires due automations while the tab is open. A schedule missed
  // while the tab was closed fires once on launch when catch-up is on;
  // otherwise it silently rolls forward to the next slot.
  useEffect(() => {
    const MISS_GRACE_MS = 90_000;
    const tick = () => {
      const now = Date.now();
      for (const automation of stateRef.current.settings.automations) {
        // Cloud automations fire from the backend cron — never from this tab.
        if (automation.runOn === "server" || !automation.enabled || automation.nextRunAt > now) {
          continue;
        }
        if (!automation.catchUp && now - automation.nextRunAt > MISS_GRACE_MS) {
          setSettings((prev) => ({
            ...prev,
            automations: prev.automations.map((item) =>
              item.id === automation.id ? { ...item, nextRunAt: computeNextRunAt(item, now) } : item,
            ),
          }));
          continue;
        }
        runAutomation(automation.id, true);
      }
    };
    const timer = window.setInterval(tick, 30_000);
    const initial = window.setTimeout(tick, 1_500);
    const onVisible = () => {
      if (!document.hidden) {
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(initial);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [runAutomation, setSettings]);

  /** Stores the pick in the matching creation tab and switches to it. */
  const setModelId = useCallback((id: string) => {
    const model = findModel(models, id);
    const mode: CreateMode = model ? modeForModelType(model.type) : modeOfModelId(id) ?? "chat";
    setSettings((prev) => {
      if (mode === "image") {
        return { ...prev, mode, imageModelId: id };
      }
      if (mode === "video") {
        return { ...prev, mode, videoModelId: id };
      }
      if (mode === "audio") {
        return { ...prev, mode, audioModelId: id };
      }
      return { ...prev, mode, modelId: id };
    });
  }, [models, setSettings]);

  const setMode = useCallback((mode: CreateMode) => {
    setSettings((prev) => ({ ...prev, mode }));
  }, [setSettings]);

  const patchSettings = useCallback((patch: Partial<AgentSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, [setSettings]);

  const setSystemPrompt = useCallback((value: string) => {
    setSettings((prev) => ({ ...prev, systemPrompt: value }));
  }, [setSettings]);

  const setAutoTools = useCallback((enabled: boolean) => {
    setSettings((prev) => ({ ...prev, autoTools: enabled }));
  }, [setSettings]);

  const toggleBuiltin = useCallback((id: keyof AgentSettings["builtinTools"]) => {
    setSettings((prev) => ({
      ...prev,
      builtinTools: { ...prev.builtinTools, [id]: !prev.builtinTools[id] },
    }));
  }, [setSettings]);

  const value = useMemo<AgentContextValue>(() => {
    const active = activeConversation(state);
    return {
      state,
      models,
      modelsLoading: modelsQuery.isLoading,
      active,
      activeModel: findModel(models, modelIdForMode(state.settings, state.settings.mode)),
      mode: state.settings.mode,
      setMode,
      patchSettings,
      agents: state.settings.agents,
      activeAgent: active?.agentId
        ? state.settings.agents.find((item) => item.id === active.agentId)
        : undefined,
      newChat,
      newChatWithAgent,
      setChatAgent,
      setChatRepo,
      recordRepoPreview,
      updateRepoPreview,
      createAgent,
      updateAgent,
      deleteAgent,
      automations: state.settings.automations,
      createAutomation,
      updateAutomation,
      deleteAutomation,
      runAutomationNow,
      life: state.life,
      updateLife,
      selectChat,
      deleteChat,
      renameChat,
      togglePinChat,
      markUnreadChat,
      setInput,
      addAttachments,
      removeAttachment,
      send,
      editMessage,
      resumeInterrupted,
      retryInterrupted,
      stop,
      queueMessage,
      removeQueued,
      reorderQueued,
      sendQueuedNow,
      toggleDeepResearch,
      toggleJulius,
      chooseJuliusWinner,
      setModelId,
      setSystemPrompt,
      setAutoTools,
      toggleBuiltin,
      setSidebarOpen: (open: boolean) => setState((prev) => ({ ...prev, sidebarOpen: open })),
      updateMcp,
      addMcp,
      addCatalogMcpServer,
      connectCatalog,
      addCustomMcp,
      removeMcp,
      connectMcp,
      toggleMcpTool,
    };
  }, [
    state,
    models,
    modelsQuery.isLoading,
    newChat,
    newChatWithAgent,
    setChatAgent,
    setChatRepo,
    recordRepoPreview,
    updateRepoPreview,
    createAgent,
    updateAgent,
    deleteAgent,
    createAutomation,
    updateAutomation,
    deleteAutomation,
    runAutomationNow,
    updateLife,
    selectChat,
    deleteChat,
    renameChat,
    togglePinChat,
    markUnreadChat,
    setInput,
    addAttachments,
    removeAttachment,
    send,
    editMessage,
    resumeInterrupted,
    retryInterrupted,
    stop,
    queueMessage,
    removeQueued,
    reorderQueued,
    sendQueuedNow,
    toggleDeepResearch,
    toggleJulius,
    chooseJuliusWinner,
    setModelId,
    setMode,
    patchSettings,
    setSystemPrompt,
    setAutoTools,
    toggleBuiltin,
    updateMcp,
    addMcp,
    addCatalogMcpServer,
    connectCatalog,
    addCustomMcp,
    removeMcp,
    connectMcp,
    toggleMcpTool,
  ]);

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}
