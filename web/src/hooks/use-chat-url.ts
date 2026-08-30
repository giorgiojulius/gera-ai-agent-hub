import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { useAgent } from "@/hooks/use-agent";
import { useAuth } from "@/hooks/use-auth";
import { chatPath } from "@/lib/nav";

/**
 * Two-way binding between the address bar and the active chat.
 *
 * Canonical addresses:
 * - `/c/<id>` — every thread with at least one message;
 * - `/` — the blank "new thread" draft AND incognito threads (incognito ids
 *   must never reach the browser history).
 *
 * URL changes (links, back/forward) select the chat; app actions (sidebar
 * click, new chat, deletion) rewrite the URL. A deep link to a chat that is
 * not on this device yet waits for cloud sync before giving up honestly.
 */
export function useChatUrl(): void {
  const { chatId } = useParams<{ chatId?: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { state, selectChat, newChat } = useAgent();
  const conversations = state.conversations;
  const activeId = state.activeId;

  // undefined start: the very first run treats the URL as authoritative,
  // so a deep-linked /c/<id> wins over the locally stored active chat.
  const prevParamRef = useRef<string | undefined>(undefined);
  const prevActiveRef = useRef<string | null>(activeId);

  useEffect(() => {
    const paramChanged = chatId !== prevParamRef.current;
    const activeChanged = activeId !== prevActiveRef.current;
    prevParamRef.current = chatId;
    prevActiveRef.current = activeId;

    const active = conversations.find((item) => item.id === activeId) ?? null;

    // --- URL-driven: a link, back/forward, or an app push landed here.
    if (paramChanged) {
      if (chatId) {
        if (chatId !== activeId && conversations.some((item) => item.id === chatId)) {
          selectChat(chatId);
        }
        // Unknown ids are owned by the not-found effect below.
        return;
      }
      // Navigated to "/": that address means "a fresh thread" — but never
      // disturb an already-blank draft or an incognito thread.
      if (active && active.messages.length > 0 && active.incognito !== true) {
        newChat();
      }
      return;
    }

    // --- App-driven: the active chat changed, or state needs normalizing
    // (boot at "/", the first message landing in a blank draft, deletions).
    if (!active) {
      return;
    }
    const wantsUrl = active.incognito !== true && active.messages.length > 0;
    if (wantsUrl && chatId !== active.id) {
      // Push on real switches; replace when the current address just died
      // (active chat deleted) or on the silent boot/first-message pass.
      const deadParam = chatId !== undefined && !conversations.some((item) => item.id === chatId);
      navigate(chatPath(active.id), { replace: !activeChanged || deadParam });
    } else if (!wantsUrl && chatId !== undefined) {
      // Blank drafts and incognito threads live at the clean root address.
      navigate("/", { replace: !activeChanged });
    }
  }, [chatId, activeId, conversations, selectChat, newChat, navigate]);

  // A deep link to a chat this device doesn't have (yet): give cloud sync a
  // moment to pull it, then bail out honestly. The deadline is fixed per id —
  // unrelated state churn must not keep pushing it out.
  const missing = chatId !== undefined && !conversations.some((item) => item.id === chatId);
  const deadlineRef = useRef<{ id: string; at: number } | null>(null);

  useEffect(() => {
    if (!chatId || !missing) {
      deadlineRef.current = null;
      return;
    }
    if (deadlineRef.current?.id !== chatId) {
      deadlineRef.current = { id: chatId, at: Date.now() + (user ? 8_000 : 2_000) };
    }
    const remaining = Math.max(0, deadlineRef.current.at - Date.now());
    const timer = window.setTimeout(() => {
      toast.error("Chat not found", {
        description: user
          ? "This thread is not in your account history."
          : "Sign in first — the link may point to a chat from your account.",
      });
      navigate("/", { replace: true });
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [chatId, missing, user, navigate]);
}
