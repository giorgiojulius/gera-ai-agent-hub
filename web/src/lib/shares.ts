// Chat sharing — frozen read-only snapshots served by the Gera backend.
// Publishing/updating/revoking needs an invited account; viewing a link
// needs nothing at all — that is the point of a share link.
import { FUNCTIONS_URL, authedFetch, parseOrThrow } from "@/lib/backend";
import { reviveMessage } from "@/lib/history";
import { inlineMessageMedia } from "@/lib/media-vault";
import type { Attachment, ChatMessage, Conversation } from "@/lib/types";

export type ShareRecord = {
  id: string;
  chatId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

export type ShareSnapshot = {
  v: 1;
  title: string;
  sharedAt: number;
  messages: ChatMessage[];
};

export type SharedChatData = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  snapshot: ShareSnapshot;
};

export function shareUrl(id: string): string {
  return `${window.location.origin}/s/${id}`;
}

/** Keeps snapshots comfortably under the backend's 1.4 MB payload cap. */
const PAYLOAD_LIMIT = 1_300_000;
/** Total inline media (data: URLs) allowed into one snapshot. */
const MEDIA_BUDGET = 900_000;
/** Single inline item above this is always dropped. */
const MEDIA_ITEM_LIMIT = 350_000;
const TOOL_RESULT_LIMIT = 1200;
const CANDIDATE_LIMIT = 6000;
const REVIEW_LIMIT = 3000;

type MediaBudget = { remaining: number };

/** Remote URLs pass for free; data: URLs are kept only while budget lasts. */
function keepMedia(value: string | undefined, budget: MediaBudget): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.startsWith("idb:")) {
    // Device-local vault ref that failed to inline — meaningless to viewers.
    return undefined;
  }
  if (!value.startsWith("data:")) {
    return value;
  }
  if (value.length > MEDIA_ITEM_LIMIT || value.length > budget.remaining) {
    return undefined;
  }
  budget.remaining -= value.length;
  return value;
}

function slimAttachment(item: Attachment, budget: MediaBudget): Attachment {
  const keep = item.mime.startsWith("image/") ? keepMedia(item.dataUrl, budget) : undefined;
  return { ...item, dataUrl: keep ?? "" };
}

function trimShared(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… [trimmed for sharing]` : text;
}

/** One message, settled (no running spinners) and slimmed for a public link. */
function slimForShare(message: ChatMessage, budget: MediaBudget): ChatMessage {
  const settled = reviveMessage(message);
  return {
    ...settled,
    attachments: settled.attachments?.map((item) => slimAttachment(item, budget)),
    images: settled.images
      ?.map((item) => keepMedia(item, budget))
      .filter((item): item is string => Boolean(item)),
    videos: settled.videos?.filter((item) => !item.startsWith("data:") && !item.startsWith("idb:")),
    audioUrl: keepMedia(settled.audioUrl, budget),
    toolCalls: settled.toolCalls?.map((call) =>
      call.result && call.result.length > TOOL_RESULT_LIMIT
        ? { ...call, result: trimShared(call.result, TOOL_RESULT_LIMIT) }
        : call,
    ),
    julius: settled.julius
      ? {
          ...settled.julius,
          candidates: settled.julius.candidates.map((item) => ({
            ...item,
            content: trimShared(item.content, CANDIDATE_LIMIT),
            toolCalls: undefined,
          })),
          reviews: settled.julius.reviews.map((item) => ({
            ...item,
            content: trimShared(item.content, REVIEW_LIMIT),
            toolCalls: undefined,
          })),
        }
      : undefined,
  };
}

/**
 * Builds the frozen snapshot that gets published. Vault refs are inlined
 * back to data URLs first (public viewers have no access to this device's
 * vault), then media is kept while a budget lasts; if the thread still
 * doesn't fit, a text-only pass runs, and only then sharing fails.
 */
export async function buildShareSnapshot(conversation: Conversation): Promise<ShareSnapshot> {
  const inlined = await Promise.all(conversation.messages.map(inlineMessageMedia));
  const build = (mediaBudget: number): ShareSnapshot => {
    const budget: MediaBudget = { remaining: mediaBudget };
    return {
      v: 1,
      title: conversation.title,
      sharedAt: Date.now(),
      messages: inlined.map((message) => slimForShare(message, budget)),
    };
  };
  const full = build(MEDIA_BUDGET);
  if (JSON.stringify(full).length <= PAYLOAD_LIMIT) {
    return full;
  }
  const textOnly = build(0);
  if (JSON.stringify(textOnly).length <= PAYLOAD_LIMIT) {
    return textOnly;
  }
  throw new Error("chat_too_large");
}

/** Maps backend error codes to copy a person can act on. */
export function shareErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "chat_too_large") {
    return "This thread is too large to share — even without media.";
  }
  if (code === "invite_required") {
    return "Publishing links needs an invited Gera account.";
  }
  if (code === "sign_in_required") {
    return "Sign in to manage share links.";
  }
  if (code === "not_found") {
    return "This link no longer exists.";
  }
  return code || "Something went wrong. Try again.";
}

/** Publishes (or refreshes) the share for this thread — the link is stable. */
export async function createShare(conversation: Conversation): Promise<ShareRecord> {
  const snapshot = await buildShareSnapshot(conversation);
  const response = await authedFetch("/share/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: conversation.id, title: conversation.title, snapshot }),
  });
  return parseOrThrow<ShareRecord>(response, "Could not create the link");
}

export async function listShares(): Promise<ShareRecord[]> {
  const response = await authedFetch("/share/mine");
  const data = await parseOrThrow<{ shares: ShareRecord[] }>(response, "Could not load your links");
  return Array.isArray(data.shares) ? data.shares : [];
}

export async function revokeShare(id: string): Promise<void> {
  const response = await authedFetch("/share/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  await parseOrThrow<{ ok: boolean }>(response, "Could not revoke the link");
}

function isRenderableMessage(item: unknown): item is ChatMessage {
  if (!item || typeof item !== "object") {
    return false;
  }
  const message = item as ChatMessage;
  return (
    typeof message.id === "string" &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string"
  );
}

/** Public read — plain fetch on purpose: viewers may have no account at all. */
export async function fetchSharedChat(id: string): Promise<SharedChatData> {
  const response = await fetch(`${FUNCTIONS_URL}/share?id=${encodeURIComponent(id)}`);
  const data = await parseOrThrow<SharedChatData>(response, "Could not load this chat");
  const messages = Array.isArray(data.snapshot?.messages)
    ? data.snapshot.messages.filter(isRenderableMessage)
    : [];
  if (messages.length === 0) {
    throw new Error("not_found");
  }
  return { ...data, snapshot: { ...data.snapshot, messages } };
}
