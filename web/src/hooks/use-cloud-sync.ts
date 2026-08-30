// Cloud history sync — one account, one history across devices. Extracted
// verbatim from AgentProvider: the debounced sync loop, the profile clock
// (settings + agents + automations + MCP + hub as one LWW blob), deletion
// tombstones, and the sign-in adoption of live server runs. The provider
// wires it with its refs and gets back `scheduleSync` + `recordTombstone`.
import { toast } from "sonner";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { useAuth } from "@/hooks/use-auth";
import { adoptActiveServerRuns, upsertConversation, type AgentState } from "@/lib/agent-store";
import {
  initProfileMeta,
  loadTombstones,
  parseProfilePayload,
  runChatSync,
  saveProfileMeta,
  saveTombstones,
  serializeProfile,
  type LocalTombstones,
  type ProfileMeta,
} from "@/lib/chat-sync";
import { normalizeStoredSettings, saveActiveId, saveConversations } from "@/lib/history";
import { normalizeLife } from "@/lib/life";

type CloudSyncArgs = {
  state: AgentState;
  setState: Dispatch<SetStateAction<AgentState>>;
  stateRef: { current: AgentState };
  /** Server runs are adopted once per session (boot or first sign-in). */
  adoptedRef: { current: boolean };
  notifyRef: { current: (conversationId: string) => void };
  drainRef: { current: (conversationId: string) => void };
};

export function useCloudSync(args: CloudSyncArgs): {
  /** Debounced sync trigger — one shared timer, the latest call wins. */
  scheduleSync: (delayMs: number) => void;
  /** Records a chat deletion so it reaches the account's other devices. */
  recordTombstone: (id: string) => void;
} {
  const { state, setState, stateRef, adoptedRef, notifyRef, drainRef } = args;
  const { user } = useAuth();
  const userRef = useRef(user);
  userRef.current = user;
  const tombstonesRef = useRef<LocalTombstones>(loadTombstones());
  /** Profile clock: settings + agents + automations + MCP + hub as one blob. */
  const [initialProfileMeta] = useState<ProfileMeta>(() =>
    initProfileMeta(state.settings, state.life),
  );
  const profileMetaRef = useRef<ProfileMeta>(initialProfileMeta);
  /** Suppresses the change-clock bump while a remote profile is applied. */
  const applyingProfileRef = useRef<boolean>(false);
  const firstProfileRenderRef = useRef<boolean>(true);
  const syncTimerRef = useRef<number | null>(null);
  const syncBusyRef = useRef<boolean>(false);
  const syncAgainRef = useRef<boolean>(false);
  const lastSyncAtRef = useRef<number>(0);
  /** Armed on sign-in — the session's first pull gets a quiet toast. */
  const syncToastArmedRef = useRef<boolean>(false);
  const performSyncRef = useRef<() => void>(() => {});

  /** Debounced trigger — one shared timer, the latest call wins. */
  const scheduleSync = useCallback((delayMs: number) => {
    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
    }
    syncTimerRef.current = window.setTimeout(() => {
      syncTimerRef.current = null;
      performSyncRef.current();
    }, delayMs);
  }, []);

  const performSync = useCallback(async () => {
    if (!userRef.current) {
      return; // Signed out — local-only until the next sign-in.
    }
    if (syncBusyRef.current) {
      syncAgainRef.current = true;
      return;
    }
    syncBusyRef.current = true;
    try {
      const snapshot = stateRef.current;
      const meta = profileMetaRef.current;
      const result = await runChatSync({
        // Incognito threads never leave this tab.
        conversations: snapshot.conversations.filter((item) => item.incognito !== true),
        runningIds: snapshot.runningIds,
        tombstones: { ...tombstonesRef.current },
        profile: {
          updatedAt: meta.updatedAt,
          payload: serializeProfile(snapshot.settings, snapshot.life),
          dirty: meta.updatedAt > meta.ackedAt,
        },
      });
      lastSyncAtRef.current = Date.now();
      if (typeof result.profileAckedAt === "number") {
        meta.ackedAt = Math.max(meta.ackedAt, result.profileAckedAt);
        saveProfileMeta(meta);
      }
      const appliedProfile = result.profileApplied;
      if (appliedProfile) {
        const parsed = parseProfilePayload(appliedProfile.payload);
        if (parsed) {
          const nextSettings = normalizeStoredSettings(parsed.settings);
          const nextLife = normalizeLife(parsed.life);
          applyingProfileRef.current = true;
          setState((prev) => ({ ...prev, settings: nextSettings, life: nextLife }));
          meta.updatedAt = appliedProfile.updatedAt;
          meta.ackedAt = appliedProfile.updatedAt;
          saveProfileMeta(meta);
        }
      }
      if (result.oauthAdopted > 0) {
        // Adopted server-rotated MCP grants changed the sign-in map that rides
        // in the profile blob — push it soon so the server retires the
        // rotation override once every copy carries the fresh pair.
        meta.updatedAt = Date.now();
        saveProfileMeta(meta);
        syncAgainRef.current = true;
      }
      if (result.ackedDeleteIds.length > 0) {
        for (const id of result.ackedDeleteIds) {
          delete tombstonesRef.current[id];
        }
        saveTombstones(tombstonesRef.current);
      }
      if (result.pulled.length > 0 || result.removed.length > 0) {
        setState((prev) => {
          let conversations = prev.conversations;
          for (const chat of result.pulled) {
            if (prev.runningIds.includes(chat.id)) {
              continue; // Never overwrite a thread that is streaming here.
            }
            const local = conversations.find((item) => item.id === chat.id);
            if (local && local.updatedAt >= chat.updatedAt) {
              continue;
            }
            conversations = upsertConversation(conversations, chat);
          }
          const droppedIds: string[] = [];
          for (const entry of result.removed) {
            if (prev.runningIds.includes(entry.id)) {
              continue;
            }
            const current = conversations.find((item) => item.id === entry.id);
            if (!current || current.updatedAt > entry.deletedAt) {
              continue; // Edited here after the other device deleted — keep it.
            }
            droppedIds.push(entry.id);
            conversations = conversations.filter((item) => item.id !== entry.id);
          }
          if (conversations === prev.conversations) {
            return prev;
          }
          const activeId =
            prev.activeId && conversations.some((item) => item.id === prev.activeId)
              ? prev.activeId
              : conversations[0]?.id ?? null;
          const queued = { ...prev.queued };
          for (const id of droppedIds) {
            delete queued[id];
          }
          saveConversations(conversations);
          saveActiveId(activeId);
          return {
            ...prev,
            conversations,
            activeId,
            queued,
            unreadIds: prev.unreadIds.filter((id) => !droppedIds.includes(id)),
          };
        });
      }
      if (syncToastArmedRef.current && (result.pulled.length > 0 || appliedProfile)) {
        const parts: string[] = [];
        if (result.pulled.length > 0) {
          parts.push(`${result.pulled.length} chat${result.pulled.length === 1 ? "" : "s"}`);
        }
        if (appliedProfile) {
          parts.push("settings & hub");
        }
        toast.success("Synced from your account", { description: `Updated: ${parts.join(" · ")}` });
      }
      syncToastArmedRef.current = false;
      if (result.incomplete) {
        scheduleSync(2_500); // Caps were hit — keep draining soon.
      }
    } catch (error) {
      // Quiet by design — sync retries on the next change or tab focus.
      // 401/403 mean signed out / not invited; the AccessGate owns that UX.
      console.warn("gera sync failed:", error instanceof Error ? error.message : error);
    } finally {
      syncBusyRef.current = false;
      if (syncAgainRef.current) {
        syncAgainRef.current = false;
        scheduleSync(1_000);
      }
    }
  }, [scheduleSync, setState, stateRef]);
  performSyncRef.current = () => {
    void performSync();
  };

  const userId = user?.id ?? null;

  // Sign-in (or boot with a stored session): fetch the account history.
  useEffect(() => {
    if (!userId) {
      return;
    }
    syncToastArmedRef.current = true;
    scheduleSync(400);
    // A fresh sign-in (no stored token at boot) still adopts server runs.
    if (!adoptedRef.current) {
      adoptedRef.current = true;
      void adoptActiveServerRuns({
        getState: () => stateRef.current,
        setState,
        onDone: (conversationId, stopped) => {
          if (stopped !== true) {
            notifyRef.current(conversationId);
            window.setTimeout(() => drainRef.current(conversationId), 60);
          }
        },
      }).catch(() => undefined);
    }
  }, [userId, scheduleSync, adoptedRef, drainRef, notifyRef, setState, stateRef]);

  // Every history change syncs after a quiet moment. Streaming keeps
  // resetting the timer, and running threads are excluded from the exchange
  // anyway — the settled thread syncs right after it finishes.
  useEffect(() => {
    if (!userRef.current) {
      return;
    }
    scheduleSync(4_000);
  }, [state.conversations, scheduleSync]);

  // Settings, agents, automations, MCP servers, and the hub sync as one
  // profile blob — any change bumps its clock. Applying a remote profile
  // must NOT bump it, or two devices would ping-pong forever.
  useEffect(() => {
    if (firstProfileRenderRef.current) {
      firstProfileRenderRef.current = false;
      return;
    }
    if (applyingProfileRef.current) {
      applyingProfileRef.current = false;
      return;
    }
    const meta = profileMetaRef.current;
    meta.updatedAt = Date.now();
    saveProfileMeta(meta);
    if (userRef.current) {
      scheduleSync(4_000);
    }
  }, [state.settings, state.life, scheduleSync]);

  // Returning to the tab pulls what other devices did meanwhile.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden && userRef.current && Date.now() - lastSyncAtRef.current > 30_000) {
        scheduleSync(500);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [scheduleSync]);

  // Anything app-wide can nudge a sync — e.g. after triggering a cloud run,
  // so the appended thread shows up without waiting for a tab refocus.
  useEffect(() => {
    const onNudge = () => {
      if (userRef.current) {
        scheduleSync(600);
      }
    };
    window.addEventListener("gera:sync", onNudge);
    return () => window.removeEventListener("gera:sync", onNudge);
  }, [scheduleSync]);

  useEffect(() => {
    return () => {
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
      }
    };
  }, []);

  /** Records a deletion tombstone; the caller schedules the sync push. */
  const recordTombstone = useCallback((id: string) => {
    tombstonesRef.current[id] = Date.now();
    saveTombstones(tombstonesRef.current);
  }, []);

  return { scheduleSync, recordTombstone };
}
