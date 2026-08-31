// Cloud sync — one account, one workspace across preview, production, and
// devices. Chats sync whole-chat last-write-wins by updatedAt; deletions
// travel as tombstones; a chat that is streaming right now is never pushed
// nor overwritten. Settings, agents, automations, MCP servers, and the hub
// sync as ONE profile blob with the same last-write-wins clock. The
// protocol is want-driven: each response tells the client what the server
// is missing, so there is no local dirty bookkeeping that could drift —
// the next sync always heals.
import { isAuthSessionCurrent } from "@/lib/auth-tokens";
import { AuthSessionChangedError, authedFetch, authedFetchForSession, parseOrThrow } from "@/lib/backend";
import { reviveMessage, slimMessage } from "@/lib/history";
import {
  applyServerOAuthRotations,
  exportOAuthTokens,
  parseServerOAuthRotations,
} from "@/lib/mcp-oauth";
import { inlineMessageMedia, vaultConversationMedia } from "@/lib/media-vault";
import { DEFAULT_CHAT_MODEL } from "@/lib/models";
import { resolveCloudMediaInConversation } from "@/lib/server-run";
import type { AgentSettings, ChatMessage, Conversation, LifeState } from "@/lib/types";

const TOMBSTONES_KEY = "gera.deleted.v1";
const PROFILE_META_KEY = "gera.profile-meta.v1";
/** The whole settings+hub blob must fit this; MCP tool lists are slimmed first. */
const PROFILE_PAYLOAD_LIMIT = 850_000;

/** Chats above this even after media trims stay device-local (never lossy-truncated). */
const CHAT_PAYLOAD_LIMIT = 850_000;
/** Serialized payload bytes pushed per request — stays under the relay cap. */
const PUSH_BYTE_BUDGET = 2_400_000;
const PUSH_COUNT_LIMIT = 12;
/** Round-trips per sync cycle; leftovers continue on the next scheduled sync. */
const MAX_ROUNDS = 8;

/** Local deletions waiting to be acknowledged by the server: id → deletedAt. */
export type LocalTombstones = Record<string, number>;

export function loadTombstones(): LocalTombstones {
  try {
    const raw = window.localStorage.getItem(TOMBSTONES_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const map: LocalTombstones = {};
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === "number" && at > 0) {
        map[id] = at;
      }
    }
    return map;
  } catch {
    return {};
  }
}

export function saveTombstones(map: LocalTombstones): void {
  try {
    window.localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(map));
  } catch {
    // Quota — the tombstones stay in memory and retry on the next save.
  }
}

/** Sync clock for the profile blob: local change time vs last server ack. */
export type ProfileMeta = { updatedAt: number; ackedAt: number };

export function saveProfileMeta(meta: ProfileMeta): void {
  try {
    window.localStorage.setItem(PROFILE_META_KEY, JSON.stringify(meta));
  } catch {
    // Quota — the clock stays in memory for this session.
  }
}

/**
 * Loads the profile clock; the first run initializes it. A device with a
 * clearly configured workspace (hub content, MCP servers, automations, or a
 * custom system prompt) starts dirty so the existing setup uploads right
 * away; an untouched fresh device starts clean and can never overwrite a
 * real profile with defaults.
 */
export function initProfileMeta(settings: AgentSettings, life: LifeState): ProfileMeta {
  try {
    const raw = window.localStorage.getItem(PROFILE_META_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ProfileMeta>;
      if (typeof parsed.updatedAt === "number" && typeof parsed.ackedAt === "number") {
        return { updatedAt: parsed.updatedAt, ackedAt: parsed.ackedAt };
      }
    }
  } catch {
    // fall through to a fresh clock
  }
  const configured =
    life.memories.length + life.trackers.length + life.tasks.length > 0 ||
    settings.mcpServers.length > 0 ||
    settings.automations.length > 0 ||
    settings.skills.length > 0 ||
    settings.systemPrompt.trim().length > 0;
  const meta: ProfileMeta = configured
    ? { updatedAt: Date.now(), ackedAt: 0 }
    : { updatedAt: 0, ackedAt: 0 };
  saveProfileMeta(meta);
  return meta;
}

/**
 * Serializes the profile blob. MCP tool lists (bulky JSON schemas that
 * repopulate on reconnect) are dropped when the full form is too big;
 * null when even the slim form exceeds the cap — such a profile stays
 * device-local rather than being silently truncated.
 */
export function serializeProfile(settings: AgentSettings, life: LifeState): string | null {
  // MCP sign-ins ride along so the account's cloud automations can use every
  // connected server; the blob is per-account server state, never shared.
  const mcpOAuth = exportOAuthTokens();
  const full = JSON.stringify({ settings, life, mcpOAuth });
  if (full.length <= PROFILE_PAYLOAD_LIMIT) {
    return full;
  }
  const slim = JSON.stringify({
    settings: {
      ...settings,
      mcpServers: settings.mcpServers.map((server) => ({ ...server, tools: [] })),
    },
    life,
    mcpOAuth,
  });
  return slim.length <= PROFILE_PAYLOAD_LIMIT ? slim : null;
}

/** Splits a synced profile blob; each half is validated by its own normalizer. */
export function parseProfilePayload(payload: string): { settings: unknown; life: unknown; mcpOAuth: unknown } | null {
  try {
    const parsed = JSON.parse(payload) as { settings?: unknown; life?: unknown; mcpOAuth?: unknown } | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return { settings: parsed.settings, life: parsed.life, mcpOAuth: parsed.mcpOAuth };
  } catch {
    return null;
  }
}

type RemoteChat = { id: string; title: string; updatedAt: number; payload: string };

type SyncResponse = {
  pull?: RemoteChat[];
  want?: string[];
  tombstones?: Array<{ id: string; deletedAt: number }>;
  skipped?: string[];
  /** Threads owned by a live server run this cycle — the protocol re-wants them later. */
  locked?: string[];
  more?: boolean;
  profile?: { updatedAt?: number; payload?: string };
  profileWant?: boolean;
  profileAck?: number;
  profileSkipped?: boolean;
  /** MCP grants rotated by server runs — this browser adopts matching chains. */
  oauthRotations?: unknown;
};

export type ChatSyncResult = {
  /** Server-newer chats to merge in (already revived, safe to render). */
  pulled: Conversation[];
  /** Chats deleted elsewhere — remove locally unless edited even later. */
  removed: Array<{ id: string; deletedAt: number }>;
  pushedCount: number;
  /** Local tombstones the server acknowledged — safe to drop. */
  ackedDeleteIds: string[];
  /** Server-newer profile blob (settings + hub) to apply locally. */
  profileApplied?: { updatedAt: number; payload: string };
  /** The profile clock value the server acknowledged storing. */
  profileAckedAt?: number;
  /** Server-rotated MCP sign-ins adopted into this browser during the sync. */
  oauthAdopted: number;
  /** True when caps were hit — schedule a follow-up sync soon. */
  incomplete: boolean;
};

function isChatMessage(item: unknown): item is ChatMessage {
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

/** Distrust the wire: rebuild the conversation from validated pieces only. */
export function parseRemoteChat(item: RemoteChat): Conversation | null {
  try {
    const raw = JSON.parse(item.payload) as Partial<Conversation> | null;
    if (!raw || typeof raw !== "object" || raw.id !== item.id) {
      return null;
    }
    const messages = Array.isArray(raw.messages)
      ? raw.messages.filter(isChatMessage).map(reviveMessage)
      : [];
    if (messages.length === 0) {
      return null;
    }
    return {
      id: item.id,
      title:
        (typeof raw.title === "string" && raw.title.trim() ? raw.title : item.title) || "Chat",
      modelId: typeof raw.modelId === "string" && raw.modelId ? raw.modelId : DEFAULT_CHAT_MODEL,
      agentId: typeof raw.agentId === "string" && raw.agentId ? raw.agentId : undefined,
      automationId:
        typeof raw.automationId === "string" && raw.automationId ? raw.automationId : undefined,
      githubRepo:
        typeof raw.githubRepo === "string" && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(raw.githubRepo)
          ? raw.githubRepo
          : undefined,
      pinned: raw.pinned === true ? true : undefined,
      messages,
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : item.updatedAt,
      // The server row's timestamp is the LWW truth for this copy.
      updatedAt: item.updatedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Full chat when it fits, media-trimmed when it doesn't, null when even the
 * trimmed form is too big — such a chat stays device-local rather than being
 * silently truncated. Vault refs are inlined back to data URLs first so other
 * devices receive real media; the inline copies are transient and die with
 * the request.
 */
export async function serializeConversation(conversation: Conversation): Promise<string | null> {
  const messages = await Promise.all(
    conversation.messages.map(async (message) => inlineMessageMedia(reviveMessage(message))),
  );
  const settled: Conversation = { ...conversation, messages };
  const full = JSON.stringify(settled);
  if (full.length <= CHAT_PAYLOAD_LIMIT) {
    return full;
  }
  const slim = JSON.stringify({ ...settled, messages: settled.messages.map(slimMessage) });
  return slim.length <= CHAT_PAYLOAD_LIMIT ? slim : null;
}

/**
 * One sync cycle: reconcile local state with the account's cloud history.
 * Runs several capped round-trips; chats in `runningIds` are left untouched
 * in both directions.
 */
export async function runChatSync(input: {
  conversations: Conversation[];
  runningIds: string[];
  tombstones: LocalTombstones;
  /** The profile blob to reconcile; `dirty` = local changes not yet acked. */
  profile?: { updatedAt: number; payload: string | null; dirty: boolean };
  /** Pins every round/retry to the account that produced this payload. */
  authSessionNonce?: string;
}): Promise<ChatSyncResult> {
  const ensureCurrentSession = (): void => {
    if (input.authSessionNonce && !isAuthSessionCurrent(input.authSessionNonce)) {
      throw new AuthSessionChangedError();
    }
  };
  ensureCurrentSession();
  const running = new Set<string>(input.runningIds);
  const localById = new Map<string, Conversation>(input.conversations.map((item) => [item.id, item]));

  const pulled = new Map<string, Conversation>();
  const removed = new Map<string, number>();
  const acked = new Set<string>();
  const pendingPush = new Set<string>();
  /** Ids the server refused (too large / deleted / capped) — never re-queue. */
  const refused = new Set<string>();
  let pushedCount = 0;
  let moreLeft = false;

  let deletesToSend = Object.entries(input.tombstones).map(([id, deletedAt]) => ({ id, deletedAt }));

  const profileInput = input.profile;
  let profileSettled = !profileInput;
  let sendProfilePayload = Boolean(profileInput?.dirty && profileInput.payload !== null);
  let profileApplied: { updatedAt: number; payload: string } | undefined;
  let profileAckedAt: number | undefined;
  let oauthAdopted = 0;
  if (profileInput && profileInput.dirty && profileInput.payload === null) {
    console.warn("gera sync: settings profile is too large to sync — it stays on this device for now.");
  }

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    ensureCurrentSession();
    // What this device has — overlaid with what it already accepted this cycle.
    const haveMap = new Map<string, number>();
    for (const item of input.conversations) {
      if (item.messages.length === 0 || removed.has(item.id)) {
        continue;
      }
      haveMap.set(item.id, item.updatedAt);
    }
    for (const [id, chat] of pulled) {
      if (!removed.has(id)) {
        haveMap.set(id, Math.max(haveMap.get(id) ?? 0, chat.updatedAt));
      }
    }

    const push: Array<{ id: string; title: string; updatedAt: number; payload: string }> = [];
    let pushBytes = 0;
    for (const id of [...pendingPush]) {
      if (push.length >= PUSH_COUNT_LIMIT || pushBytes >= PUSH_BYTE_BUDGET) {
        break;
      }
      const chat = localById.get(id);
      if (!chat || running.has(id) || chat.messages.length === 0) {
        pendingPush.delete(id);
        continue;
      }
      const payload = await serializeConversation(chat);
      if (!payload) {
        pendingPush.delete(id);
        refused.add(id);
        console.warn(`gera sync: "${chat.title}" is too large to sync — it stays on this device only.`);
        continue;
      }
      if (payload.length + pushBytes > PUSH_BYTE_BUDGET && push.length > 0) {
        break;
      }
      push.push({ id, title: chat.title, updatedAt: chat.updatedAt, payload });
      pushBytes += payload.length;
    }

    const profileBody =
      profileInput && !profileSettled
        ? {
            updatedAt: profileInput.updatedAt,
            ...(sendProfilePayload && profileInput.payload !== null
              ? { payload: profileInput.payload }
              : {}),
          }
        : undefined;

    const response = await (input.authSessionNonce
      ? authedFetchForSession("/chats/sync", input.authSessionNonce, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            have: [...haveMap.entries()].map(([id, updatedAt]) => ({ id, updatedAt })),
            push,
            delete: deletesToSend,
            ...(profileBody ? { profile: profileBody } : {}),
          }),
        })
      : authedFetch("/chats/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        have: [...haveMap.entries()].map(([id, updatedAt]) => ({ id, updatedAt })),
        push,
        delete: deletesToSend,
        ...(profileBody ? { profile: profileBody } : {}),
      }),
    }));
    const data = await parseOrThrow<SyncResponse>(response, "Sync failed");
    ensureCurrentSession();

    // The server applied (or consciously overruled) everything we sent.
    for (const item of deletesToSend) {
      acked.add(item.id);
    }
    deletesToSend = [];
    for (const item of push) {
      pendingPush.delete(item.id);
      pushedCount += 1;
    }
    for (const id of data.skipped ?? []) {
      if (typeof id === "string") {
        pendingPush.delete(id);
        refused.add(id);
      }
    }

    for (const item of data.pull ?? []) {
      if (!item || typeof item.id !== "string" || typeof item.payload !== "string") {
        continue;
      }
      if (running.has(item.id) || typeof item.updatedAt !== "number") {
        continue;
      }
      const chat = parseRemoteChat(item);
      if (chat) {
        // Cloud-run media refs resolve to real bytes first; then inline media
        // from other devices moves straight into the vault — pulled chats
        // never park base64 strings in React state.
        const withCloudMedia = await resolveCloudMediaInConversation(chat);
        const vaulted = await vaultConversationMedia(withCloudMedia);
        pulled.set(vaulted.id, vaulted);
        removed.delete(vaulted.id);
      }
    }

    for (const item of data.tombstones ?? []) {
      if (!item || typeof item.id !== "string" || typeof item.deletedAt !== "number") {
        continue;
      }
      if (running.has(item.id)) {
        continue;
      }
      const localAt = pulled.get(item.id)?.updatedAt ?? localById.get(item.id)?.updatedAt ?? 0;
      if (item.deletedAt >= localAt) {
        removed.set(item.id, item.deletedAt);
        pulled.delete(item.id);
      }
    }

    for (const id of data.want ?? []) {
      if (
        typeof id === "string" &&
        !running.has(id) &&
        !refused.has(id) &&
        !removed.has(id) &&
        localById.has(id)
      ) {
        pendingPush.add(id);
      }
    }

    if (data.oauthRotations !== undefined) {
      ensureCurrentSession();
      // Server runs redeem (and thereby rotate) MCP refresh tokens while this
      // browser sleeps — adopt the fresh pairs so the local sign-in survives
      // instead of dying on its next refresh attempt.
      oauthAdopted += applyServerOAuthRotations(parseServerOAuthRotations(data.oauthRotations));
    }

    if (profileInput && !profileSettled) {
      if (typeof data.profileAck === "number") {
        profileAckedAt = data.profileAck;
        profileSettled = true;
      } else if (data.profileSkipped === true) {
        // Too large for the server — stop retrying until the next local change.
        profileAckedAt = profileInput.updatedAt;
        profileSettled = true;
        console.warn("gera sync: settings profile is too large to sync — it stays on this device for now.");
      } else if (
        data.profile &&
        typeof data.profile.updatedAt === "number" &&
        typeof data.profile.payload === "string"
      ) {
        profileApplied = { updatedAt: data.profile.updatedAt, payload: data.profile.payload };
        profileSettled = true;
      } else if (data.profileWant === true && profileInput.payload !== null) {
        sendProfilePayload = true; // the next round carries the blob
      } else {
        profileSettled = true; // clocks equal — nothing to exchange
      }
    }

    moreLeft = data.more === true;
    if (!moreLeft && pendingPush.size === 0 && profileSettled) {
      break;
    }
  }

  return {
    pulled: [...pulled.values()],
    removed: [...removed.entries()].map(([id, deletedAt]) => ({ id, deletedAt })),
    pushedCount,
    ackedDeleteIds: [...acked],
    profileApplied,
    profileAckedAt,
    oauthAdopted,
    incomplete: moreLeft || pendingPush.size > 0 || !profileSettled,
  };
}
