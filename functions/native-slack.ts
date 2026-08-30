/**
 * Server-side port of the native Slack connector (web/src/lib/slack-native.ts)
 * for cloud automation runs: the plain Slack Web API (slack.com/api/*) with
 * the synced Bot/User token in the form body — the same tool surface as the
 * browser connector, running in the Worker.
 */

type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

const SLACK_API_BASE = "https://slack.com/api";

/** Raised for Slack `ok:false` responses; `code` is Slack's machine error. */
class SlackApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SlackApiError";
    this.code = code;
  }
}

type SlackJson = { ok: boolean; error?: string; needed?: string } & Record<string, unknown>;

function friendlySlackError(code: string, needed?: string): string {
  switch (code) {
    case "invalid_auth":
    case "not_authed":
    case "token_revoked":
    case "token_expired":
    case "account_inactive":
      return "Slack token is invalid or revoked. Paste a fresh Bot (xoxb-…) or User (xoxp-…) token.";
    case "missing_scope":
      return `Slack token is missing the "${needed ?? "required"}" scope. Add it under OAuth & Permissions in your Slack app, reinstall the app, and paste the new token.`;
    case "not_allowed_token_type":
      return "This Slack method needs a User token (xoxp-…) — Bot tokens cannot use it.";
    case "channel_not_found":
      return "Slack channel not found. Use the channel ID (C…) or an exact #name this token can see.";
    case "not_in_channel":
      return "The Slack bot is not in that channel. Invite it with /invite in Slack, then retry.";
    case "ratelimited":
    case "rate_limited":
      return "Slack rate limit reached. Wait a moment and retry.";
    default:
      return `Slack error: ${code}.`;
  }
}

/**
 * Calls a Slack Web API method with the token in the form body — a CORS
 * simple request that slack.com answers with `Access-Control-Allow-Origin: *`.
 */
async function slackCall(
  token: string,
  method: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<SlackJson> {
  const body = new URLSearchParams({ token });
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      body.set(key, String(value));
    }
  }
  let response: Response;
  try {
    response = await fetch(`${SLACK_API_BASE}/${method}`, { method: "POST", body });
  } catch {
    throw new Error("Could not reach Slack. Try again in a moment.");
  }
  let data: SlackJson;
  try {
    data = (await response.json()) as SlackJson;
  } catch {
    throw new Error(`Slack sent an unexpected response (${response.status}).`);
  }
  if (!data.ok) {
    const code = data.error ?? "unknown_error";
    throw new SlackApiError(code, friendlySlackError(code, data.needed));
  }
  return data;
}

export type SlackIdentity = { team: string; user: string; url: string };

/** auth.test — validates the pasted token and names the workspace. */
export async function verifySlackToken(token: string): Promise<SlackIdentity> {
  const data = await slackCall(token, "auth.test");
  return {
    team: typeof data.team === "string" ? data.team : "",
    user: typeof data.user === "string" ? data.user : "",
    url: typeof data.url === "string" ? data.url : "",
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === "number" ? value : Number.parseInt(str(value), 10);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

function looksLikeChannelId(value: string): boolean {
  return /^[CDG][A-Z0-9]{6,}$/i.test(value);
}

/** Accepts "#general", "general", or a raw C… ID; resolves names via conversations.list. */
async function resolveChannelId(token: string, channel: string): Promise<string> {
  const raw = channel.trim().replace(/^#/, "");
  if (!raw) {
    throw new Error("Provide a Slack channel (#name or C… ID).");
  }
  if (looksLikeChannelId(raw)) {
    return raw;
  }
  const wanted = raw.toLowerCase();
  let cursor = "";
  for (let page = 0; page < 3; page += 1) {
    const data = await slackCall(token, "conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      cursor: cursor || undefined,
    });
    const match = asRecordArray(data.channels).find((item) => str(item.name).toLowerCase() === wanted);
    if (match) {
      return str(match.id);
    }
    const meta = (data.response_metadata ?? {}) as Record<string, unknown>;
    cursor = str(meta.next_cursor);
    if (!cursor) {
      break;
    }
  }
  throw new Error(`Slack channel "#${raw}" was not found. Use its channel ID (C…) instead.`);
}

function formatTs(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) {
    return ts;
  }
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
}

/** Best-effort user-id → display-name map; empty when users:read is missing. */
export async function fetchSlackUserNames(token: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const data = await slackCall(token, "users.list", { limit: 200 });
    for (const member of asRecordArray(data.members)) {
      const id = str(member.id);
      const profile = (member.profile ?? {}) as Record<string, unknown>;
      const name = str(profile.display_name) || str(profile.real_name) || str(member.name);
      if (id && name) {
        names.set(id, name);
      }
    }
  } catch {
    // users:read scope missing — fall back to raw member IDs
  }
  return names;
}

async function sendMessage(token: string, input: Record<string, unknown>): Promise<string> {
  const channelId = await resolveChannelId(token, str(input.channel));
  const text = str(input.text).trim();
  if (!text) {
    throw new Error("Message text is empty.");
  }
  const params = {
    channel: channelId,
    text,
    thread_ts: str(input.thread_ts) || undefined,
  };
  try {
    const data = await slackCall(token, "chat.postMessage", params);
    return `Message sent to <#${channelId}> (ts ${str(data.ts)}).`;
  } catch (error) {
    if (error instanceof SlackApiError && error.code === "not_in_channel") {
      try {
        await slackCall(token, "conversations.join", { channel: channelId });
      } catch {
        throw error;
      }
      const data = await slackCall(token, "chat.postMessage", params);
      return `Joined the channel and sent the message (ts ${str(data.ts)}).`;
    }
    throw error;
  }
}

async function listChannels(token: string, input: Record<string, unknown>): Promise<string> {
  const limit = clampNumber(input.limit, 50, 1, 200);
  const data = await slackCall(token, "conversations.list", {
    types: "public_channel,private_channel",
    exclude_archived: true,
    limit,
  });
  const channels = asRecordArray(data.channels);
  if (channels.length === 0) {
    return "No channels are visible to this token.";
  }
  return channels
    .map((item) => {
      const name = str(item.name) || str(item.id);
      const members = typeof item.num_members === "number" ? ` · ${item.num_members} members` : "";
      const topicRecord = (item.topic ?? {}) as Record<string, unknown>;
      const topic = str(topicRecord.value);
      return `#${name} (${str(item.id)})${members}${topic ? ` — ${topic}` : ""}`;
    })
    .join("\n");
}

async function readMessages(token: string, input: Record<string, unknown>): Promise<string> {
  const channelId = await resolveChannelId(token, str(input.channel));
  const limit = clampNumber(input.limit, 20, 1, 100);
  const [data, names] = await Promise.all([
    slackCall(token, "conversations.history", { channel: channelId, limit }),
    fetchSlackUserNames(token),
  ]);
  const messages = asRecordArray(data.messages);
  if (messages.length === 0) {
    return "No messages in this channel yet.";
  }
  const lines = messages.map((message) => {
    const authorId = str(message.user) || str(message.bot_id) || "unknown";
    const author = names.get(authorId) ?? authorId;
    const replyCount = typeof message.reply_count === "number" ? message.reply_count : 0;
    const thread = replyCount > 0 ? ` [thread: ${replyCount} replies, ts ${str(message.ts)}]` : "";
    return `[${formatTs(str(message.ts))}] @${author}: ${str(message.text) || "(attachment/blocks)"}${thread}`;
  });
  return `Latest ${lines.length} messages (newest first):\n${lines.join("\n")}`;
}

async function listUsers(token: string, input: Record<string, unknown>): Promise<string> {
  const limit = clampNumber(input.limit, 50, 1, 200);
  const data = await slackCall(token, "users.list", { limit });
  const members = asRecordArray(data.members).filter((member) => member.deleted !== true);
  if (members.length === 0) {
    return "No members are visible to this token.";
  }
  return members
    .map((member) => {
      const profile = (member.profile ?? {}) as Record<string, unknown>;
      const display = str(profile.display_name) || str(member.name);
      const real = str(profile.real_name);
      const bot = member.is_bot === true ? " · bot" : "";
      return `@${display} (${str(member.id)})${real ? ` — ${real}` : ""}${bot}`;
    })
    .join("\n");
}

async function searchMessages(token: string, input: Record<string, unknown>): Promise<string> {
  const query = str(input.query).trim();
  if (!query) {
    throw new Error("Provide a search query.");
  }
  const count = clampNumber(input.count, 10, 1, 50);
  const data = await slackCall(token, "search.messages", { query, count });
  const messagesRecord = (data.messages ?? {}) as Record<string, unknown>;
  const matches = asRecordArray(messagesRecord.matches);
  if (matches.length === 0) {
    return `No Slack messages match "${query}".`;
  }
  return matches
    .map((match) => {
      const channelRecord = (match.channel ?? {}) as Record<string, unknown>;
      const channel = str(channelRecord.name) || "?";
      const author = str(match.username) || str(match.user) || "unknown";
      return `[#${channel}] @${author}: ${str(match.text)}`;
    })
    .join("\n");
}

async function whoami(token: string): Promise<string> {
  const identity = await verifySlackToken(token);
  return `Signed in to ${identity.team} (${identity.url}) as ${identity.user}.`;
}

/** Tool surface exposed to the agent; names are stable and become mcp_slack_* functions. */
export const SLACK_NATIVE_TOOLS: McpToolInfo[] = [
  {
    name: "send_message",
    description:
      "Send a message to a Slack channel or thread. Channel accepts a #name or C… ID. Needs the chat:write scope; the bot auto-joins public channels when allowed.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel #name or ID (C…)" },
        text: { type: "string", description: "Message text (Slack mrkdwn)" },
        thread_ts: { type: "string", description: "Optional parent message ts to reply in a thread" },
      },
      required: ["channel", "text"],
    },
  },
  {
    name: "read_messages",
    description:
      "Read the latest messages from a Slack channel (newest first). Channel accepts a #name or C… ID. Needs channels:history (private channels: groups:history).",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel #name or ID (C…)" },
        limit: { type: "number", description: "How many messages (default 20, max 100)" },
      },
      required: ["channel"],
    },
  },
  {
    name: "list_channels",
    description:
      "List Slack channels this token can see (public and private) with IDs, member counts, and topics. Needs channels:read.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max channels to return (default 50)" },
      },
    },
  },
  {
    name: "list_users",
    description: "List workspace members with handles, IDs, and real names. Needs users:read.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max users to return (default 50)" },
      },
    },
  },
  {
    name: "search_messages",
    description:
      "Full-text search across workspace messages. Requires a User token (xoxp-…) with search:read — Bot tokens cannot search. Supports in:#channel and from:@user filters.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "whoami",
    description: "Show which Slack workspace and identity this token is signed in as.",
    inputSchema: { type: "object", properties: {} },
  },
];

// --- Inbound Slack bot (Events API) ------------------------------------------
// A project agent becomes a mentionable Slack bot: Slack POSTs app_mention
// events to the Worker, the project shard verifies the app's signing secret
// and runs the agent, and the reply lands back in the same Slack thread.

/** One verified app_mention worth running. */
export type SlackMentionEvent = {
  eventId: string;
  channel: string;
  /** Thread root: thread_ts inside a thread, else the mention's own ts. */
  threadTs: string;
  eventTs: string;
  userId: string;
  text: string;
};

export type SlackEventDecision =
  | { kind: "challenge"; challenge: string }
  | { kind: "mention"; mention: SlackMentionEvent }
  | { kind: "ignore"; reason: string };

/** Pure classifier for an Events API payload — unit-tested. */
export function classifySlackEvent(payload: unknown): SlackEventDecision {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { kind: "ignore", reason: "not_an_object" };
  }
  const record = payload as Record<string, unknown>;
  if (record.type === "url_verification") {
    const challenge = str(record.challenge);
    return challenge ? { kind: "challenge", challenge } : { kind: "ignore", reason: "empty_challenge" };
  }
  if (record.type !== "event_callback") {
    return { kind: "ignore", reason: `type:${str(record.type) || "unknown"}` };
  }
  const event = (record.event && typeof record.event === "object" && !Array.isArray(record.event)
    ? record.event
    : {}) as Record<string, unknown>;
  if (str(event.type) !== "app_mention") {
    return { kind: "ignore", reason: `event:${str(event.type) || "unknown"}` };
  }
  // Bot-authored or edited/system messages never trigger a run — no loops.
  if (str(event.bot_id) || str(event.subtype)) {
    return { kind: "ignore", reason: "bot_or_subtype" };
  }
  const channel = str(event.channel);
  const ts = str(event.ts);
  if (!channel || !ts) {
    return { kind: "ignore", reason: "missing_channel_or_ts" };
  }
  return {
    kind: "mention",
    mention: {
      eventId: str(record.event_id) || `${channel}:${ts}`,
      channel,
      threadTs: str(event.thread_ts) || ts,
      eventTs: ts,
      userId: str(event.user) || "unknown",
      text: str(event.text),
    },
  };
}

const SLACK_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

function timingSafeEqualStr(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i += 1) {
    const ai = i < a.length ? a.charCodeAt(i) : 0;
    const bi = i < b.length ? b.charCodeAt(i) : 0;
    mismatch |= ai ^ bi;
  }
  return mismatch === 0;
}

/**
 * Verifies Slack's `X-Slack-Signature` — `v0=` + HMAC-SHA256 of
 * `v0:<timestamp>:<raw body>` with the app's signing secret. Rejects
 * timestamps outside ±5 minutes to block replays.
 */
export async function verifySlackSignature(
  signingSecret: string,
  timestampHeader: string | null | undefined,
  rawBody: string,
  signatureHeader: string | null | undefined,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!signingSecret || !timestampHeader || !signatureHeader) {
    return false;
  }
  const seconds = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(seconds) || Math.abs(nowMs - seconds * 1000) > SLACK_SIGNATURE_WINDOW_MS) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestampHeader}:${rawBody}`),
  );
  const hex = Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return timingSafeEqualStr(`v0=${hex}`, signatureHeader);
}

/** Removes the bot's own <@U…> mention so the prompt reads naturally. */
export function stripSlackMention(text: string, botUserId: string): string {
  const cleaned = botUserId ? text.split(`<@${botUserId}>`).join(" ") : text;
  return cleaned.replace(/\s+/g, " ").trim();
}

/** auth.test including the bot's own user id (to strip self-mentions). */
export async function fetchSlackBotIdentity(token: string): Promise<SlackIdentity & { userId: string }> {
  const data = await slackCall(token, "auth.test");
  return {
    team: str(data.team),
    user: str(data.user),
    url: str(data.url),
    userId: str(data.user_id),
  };
}

/** Thread transcript via conversations.replies — oldest first, capped. */
export async function fetchSlackThreadTranscript(
  token: string,
  channel: string,
  threadTs: string,
  limit: number,
): Promise<string> {
  const [data, names] = await Promise.all([
    slackCall(token, "conversations.replies", { channel, ts: threadTs, limit }),
    fetchSlackUserNames(token),
  ]);
  const messages = asRecordArray(data.messages).slice(-limit);
  return messages
    .map((message) => {
      const authorId = str(message.user) || str(message.bot_id) || "unknown";
      const author = names.get(authorId) ?? authorId;
      return `[${formatTs(str(message.ts))}] @${author}: ${str(message.text) || "(attachment/blocks)"}`;
    })
    .join("\n");
}

/** chat.postMessage into a thread; auto-joins public channels when allowed. */
export async function postSlackThreadReply(
  token: string,
  channel: string,
  threadTs: string,
  text: string,
): Promise<void> {
  const params = { channel, text, thread_ts: threadTs, unfurl_links: false };
  try {
    await slackCall(token, "chat.postMessage", params);
  } catch (error) {
    if (error instanceof SlackApiError && error.code === "not_in_channel") {
      await slackCall(token, "conversations.join", { channel });
      await slackCall(token, "chat.postMessage", params);
      return;
    }
    throw error;
  }
}

// --- Desk Slack sync (screen desks) ------------------------------------------
// The desk watches the channels its Slack bot is a MEMBER of — inviting the
// bot to a channel in Slack IS the per-project channel selection, which also
// keeps one workspace serving several Gera projects correctly partitioned
// (each project's bot only sees its own channels). Structured returns (not
// display strings) so discussions can be matched to Intercom conversations.

export type SlackChannelLite = { id: string; name: string };

/** Channels the bot token is a member of — the desk's watched set. */
export async function listBotChannels(token: string, limit = 100): Promise<SlackChannelLite[]> {
  const data = await slackCall(token, "users.conversations", {
    types: "public_channel,private_channel",
    exclude_archived: true,
    limit,
  });
  return asRecordArray(data.channels)
    .map((item) => ({ id: str(item.id), name: str(item.name) || str(item.id) }))
    .filter((item) => item.id.length > 0);
}

export type SlackHistoryMessage = {
  ts: string;
  /** Thread root ts when the message is a threaded reply; "" for top-level. */
  threadTs: string;
  authorId: string;
  text: string;
  replyCount: number;
  /** Seconds — the message's own ts, or its latest reply when it roots a thread. */
  lastActivityTs: number;
};

/** Recent channel history (newest first), structured for matching. */
export async function fetchChannelHistoryData(
  token: string,
  channelId: string,
  oldestSeconds: number,
  limit: number,
): Promise<SlackHistoryMessage[]> {
  const data = await slackCall(token, "conversations.history", {
    channel: channelId,
    limit,
    oldest: oldestSeconds > 0 ? String(oldestSeconds) : undefined,
  });
  return asRecordArray(data.messages).map((message) => {
    const ts = str(message.ts);
    const own = Number.parseFloat(ts);
    const latest = Number.parseFloat(str(message.latest_reply));
    return {
      ts,
      threadTs: str(message.thread_ts),
      authorId: str(message.user) || str(message.bot_id) || "unknown",
      text: str(message.text),
      replyCount: typeof message.reply_count === "number" ? message.reply_count : 0,
      lastActivityTs: Number.isFinite(latest) ? latest : Number.isFinite(own) ? own : 0,
    };
  });
}

export type SlackThreadTail = {
  /** Oldest→newest, capped to the last `tailLimit` messages. */
  lines: Array<{ ts: string; authorId: string; text: string }>;
  /** Seconds — ts of the newest fetched message (0 when unreadable). */
  lastTs: number;
  replyCount: number;
};

/** The live tail of one thread — what "wait, then show the outcome" polls. */
export async function fetchSlackThreadTailData(
  token: string,
  channel: string,
  rootTs: string,
  tailLimit: number,
): Promise<SlackThreadTail> {
  const data = await slackCall(token, "conversations.replies", { channel, ts: rootTs, limit: 60 });
  const messages = asRecordArray(data.messages);
  const lines = messages.slice(-tailLimit).map((message) => ({
    ts: str(message.ts),
    authorId: str(message.user) || str(message.bot_id) || "unknown",
    text: str(message.text) || "(attachment/blocks)",
  }));
  const last = Number.parseFloat(str(messages[messages.length - 1]?.ts));
  return {
    lines,
    lastTs: Number.isFinite(last) ? last : 0,
    replyCount: Math.max(0, messages.length - 1),
  };
}

/** Dispatches an agent tool call to the Slack Web API. */
export async function callSlackNativeTool(token: string, name: string, args: unknown): Promise<string> {
  const input = (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  switch (name) {
    case "send_message":
      return sendMessage(token, input);
    case "read_messages":
      return readMessages(token, input);
    case "list_channels":
      return listChannels(token, input);
    case "list_users":
      return listUsers(token, input);
    case "search_messages":
      return searchMessages(token, input);
    case "whoami":
      return whoami(token);
    default:
      throw new Error(`Unknown Slack tool "${name}".`);
  }
}

// --- Create the Slack bot from Gera (app provisioning) -----------------------
// The admin pastes a one-shot app configuration token; Gera mints the Slack
// app via apps.manifest.create (the response carries app_id + credentials
// incl. the signing secret), stores the signing secret FIRST, then wires
// Event Subscriptions with a manifest update — so Slack's URL challenge
// verifies against a secret the shard already holds. Installing into a
// workspace is OAuth v2: the Worker callback trades the code for the bot
// token server-side, so the admin never touches xoxb-… by hand.

/** Bot scopes the agent's Slack tool surface needs — manifest and install link share this list. */
export const SLACK_BOT_SCOPES: readonly string[] = [
  "app_mentions:read",
  "chat:write",
  "channels:join",
  "channels:history",
  "groups:history",
  "channels:read",
  "groups:read",
  "users:read",
];

/** Slack rejects display_information.name longer than 35 characters. */
const SLACK_APP_NAME_LIMIT = 35;

/** How long one generated install link stays valid. */
export const SLACK_INSTALL_STATE_TTL_MS = 30 * 60 * 1000;

/**
 * App manifest for one agent bot. Event subscriptions are included only when
 * `eventsUrl` is set: creation goes without them (the signing secret must be
 * stored before Slack's URL check can pass), a follow-up update adds them.
 */
export function buildSlackAppManifest(options: {
  botName: string;
  redirectUrl: string;
  eventsUrl?: string;
}): Record<string, unknown> {
  const name = (options.botName.trim() || "Gera Agent").slice(0, SLACK_APP_NAME_LIMIT);
  const settings: Record<string, unknown> = {
    org_deploy_enabled: false,
    socket_mode_enabled: false,
    token_rotation_enabled: false,
  };
  if (options.eventsUrl) {
    settings.event_subscriptions = {
      request_url: options.eventsUrl,
      bot_events: ["app_mention"],
    };
  }
  return {
    display_information: {
      name,
      description: "Project agent from Gera — @mention it and it replies in the thread.",
    },
    features: {
      bot_user: { display_name: name, always_online: true },
    },
    oauth_config: {
      redirect_urls: [options.redirectUrl],
      scopes: { bot: [...SLACK_BOT_SCOPES] },
    },
    settings,
  };
}

export type SlackAppCredentials = {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
};

/** Pulls the new app's credentials out of an apps.manifest.create response. */
export function parseSlackAppCreation(data: Record<string, unknown>): SlackAppCredentials | null {
  const appId = str(data.app_id);
  const credentials = (data.credentials && typeof data.credentials === "object" && !Array.isArray(data.credentials)
    ? data.credentials
    : {}) as Record<string, unknown>;
  const clientId = str(credentials.client_id);
  const clientSecret = str(credentials.client_secret);
  const signingSecret = str(credentials.signing_secret);
  if (!appId || !clientId || !clientSecret || !signingSecret) {
    return null;
  }
  return { appId, clientId, clientSecret, signingSecret };
}

/** First few `errors[].message` entries of an invalid_manifest response. */
function manifestErrorDetail(data: SlackJson): string {
  const errors = Array.isArray(data.errors) ? data.errors : [];
  const messages = errors
    .map((item) => (item && typeof item === "object" ? str((item as Record<string, unknown>).message) : ""))
    .filter((message) => message.length > 0)
    .slice(0, 3);
  return messages.length > 0 ? ` — ${messages.join("; ")}` : "";
}

function friendlyConfigError(code: string, data: SlackJson): string {
  switch (code) {
    case "invalid_auth":
    case "not_authed":
    case "token_expired":
    case "token_revoked":
      return "The app configuration token is invalid or expired (they live 12 hours). Generate a fresh one at api.slack.com/apps → Your App Configuration Tokens.";
    case "invalid_manifest":
      return `Slack rejected the app manifest${manifestErrorDetail(data)}.`;
    case "app_not_found":
      return "Slack could not find the app — it may have been deleted at api.slack.com/apps.";
    case "ratelimited":
    case "rate_limited":
      return "Slack rate limit reached. Wait a minute and try again.";
    default:
      return `Slack error: ${code}.`;
  }
}

/** Calls a Slack app-management method with an app configuration token. */
async function slackConfigCall(
  configToken: string,
  method: string,
  params: Record<string, string>,
): Promise<SlackJson> {
  const body = new URLSearchParams({ token: configToken, ...params });
  let response: Response;
  try {
    response = await fetch(`${SLACK_API_BASE}/${method}`, { method: "POST", body });
  } catch {
    throw new Error("Could not reach Slack. Try again in a moment.");
  }
  let data: SlackJson;
  try {
    data = (await response.json()) as SlackJson;
  } catch {
    throw new Error(`Slack sent an unexpected response (${response.status}).`);
  }
  if (!data.ok) {
    const code = data.error ?? "unknown_error";
    throw new SlackApiError(code, friendlyConfigError(code, data));
  }
  return data;
}

/** apps.manifest.create — mints the Slack app; the response carries its credentials. */
export async function createSlackAppFromManifest(
  configToken: string,
  manifest: Record<string, unknown>,
): Promise<SlackAppCredentials> {
  const data = await slackConfigCall(configToken, "apps.manifest.create", {
    manifest: JSON.stringify(manifest),
  });
  const credentials = parseSlackAppCreation(data);
  if (!credentials) {
    throw new Error(
      "Slack created the app but returned no credentials — delete it at api.slack.com/apps and try again.",
    );
  }
  return credentials;
}

/** apps.manifest.update — wires Event Subscriptions once the signing secret is stored. */
export async function updateSlackAppManifest(
  configToken: string,
  appId: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await slackConfigCall(configToken, "apps.manifest.update", {
    app_id: appId,
    manifest: JSON.stringify(manifest),
  });
}

export type SlackInstallResult = { botToken: string; team: string; botUserId: string };

/** oauth.v2.access — trades the OAuth callback code for the workspace's bot token. */
export async function exchangeSlackOAuthCode(options: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<SlackInstallResult> {
  const body = new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    code: options.code,
    redirect_uri: options.redirectUri,
  });
  let response: Response;
  try {
    response = await fetch(`${SLACK_API_BASE}/oauth.v2.access`, { method: "POST", body });
  } catch {
    throw new Error("Could not reach Slack. Try again in a moment.");
  }
  let data: SlackJson;
  try {
    data = (await response.json()) as SlackJson;
  } catch {
    throw new Error(`Slack sent an unexpected response (${response.status}).`);
  }
  if (!data.ok) {
    const code = data.error ?? "unknown_error";
    if (code === "invalid_code" || code === "code_already_used") {
      throw new Error("The install link expired or was already used — click Install in Gera again.");
    }
    if (code === "bad_redirect_uri" || code === "oauth_authorization_url_mismatch") {
      throw new Error("Slack rejected the redirect URL — recreate the app from Gera and try again.");
    }
    throw new Error(`Slack error: ${code}.`);
  }
  const botToken = str(data.access_token);
  if (!botToken.startsWith("xoxb-")) {
    throw new Error("Slack did not return a bot token — reinstall the app.");
  }
  const team = (data.team && typeof data.team === "object" && !Array.isArray(data.team)
    ? data.team
    : {}) as Record<string, unknown>;
  return { botToken, team: str(team.name) || str(team.id), botUserId: str(data.bot_user_id) };
}

// App-manager connection: the admin pastes the REFRESH token (xoxe-1-…) once;
// the shard swaps it for a fresh access token via tooling.tokens.rotate
// whenever one is needed, so creating Slack bots never asks for tokens again.

export type SlackConfigTokenKind = "refresh" | "access";

/** Refresh tokens start with `xoxe-1-`, access tokens with `xoxe.xoxp-`. */
export function classifySlackConfigToken(raw: string): SlackConfigTokenKind | null {
  const token = raw.trim();
  if (token.startsWith("xoxe-1-")) {
    return "refresh";
  }
  if (token.startsWith("xoxe.xoxp-")) {
    return "access";
  }
  return null;
}

export type SlackConfigRotation = {
  accessToken: string;
  refreshToken: string;
  teamId: string;
  userId: string;
  /** Epoch ms when the access token expires; 0 when Slack omitted `exp`. */
  expiresAt: number;
};

/** Pulls the new token pair out of a tooling.tokens.rotate response. */
export function parseSlackConfigRotation(data: Record<string, unknown>): SlackConfigRotation | null {
  const accessToken = str(data.token);
  const refreshToken = str(data.refresh_token);
  if (!accessToken || !refreshToken) {
    return null;
  }
  const exp = typeof data.exp === "number" && Number.isFinite(data.exp) ? data.exp : 0;
  return {
    accessToken,
    refreshToken,
    teamId: str(data.team_id),
    userId: str(data.user_id),
    expiresAt: exp > 0 ? exp * 1000 : 0,
  };
}

/** Rotate this long before the stored access token expires (Slack gives ~12 h). */
export const SLACK_CONFIG_ROTATE_MARGIN_MS = 10 * 60 * 1000;

/** True when the stored access token is still comfortably usable. */
export function isSlackConfigAccessFresh(expiresAt: number, now: number): boolean {
  return expiresAt - now > SLACK_CONFIG_ROTATE_MARGIN_MS;
}

const SLACK_CONFIG_DEAD_CODES = new Set([
  "invalid_refresh_token",
  "token_expired",
  "token_revoked",
  "invalid_auth",
  "not_authed",
]);

/** True when a rotate failure means the stored connection is dead, not transient. */
export function isSlackConfigAuthError(error: unknown): boolean {
  return error instanceof SlackApiError && SLACK_CONFIG_DEAD_CODES.has(error.code);
}

/** tooling.tokens.rotate — swaps the refresh token for a fresh access+refresh pair. */
export async function rotateSlackConfigToken(refreshToken: string): Promise<SlackConfigRotation> {
  const body = new URLSearchParams({ refresh_token: refreshToken });
  let response: Response;
  try {
    response = await fetch(`${SLACK_API_BASE}/tooling.tokens.rotate`, { method: "POST", body });
  } catch {
    throw new Error("Could not reach Slack. Try again in a moment.");
  }
  let data: SlackJson;
  try {
    data = (await response.json()) as SlackJson;
  } catch {
    throw new Error(`Slack sent an unexpected response (${response.status}).`);
  }
  if (!data.ok) {
    const code = data.error ?? "unknown_error";
    if (SLACK_CONFIG_DEAD_CODES.has(code)) {
      throw new SlackApiError(
        code,
        "The saved Slack connection is no longer valid — reconnect with a fresh refresh token from api.slack.com/apps → Your App Configuration Tokens.",
      );
    }
    if (code === "ratelimited" || code === "rate_limited") {
      throw new SlackApiError(code, "Slack rate limit reached. Wait a minute and try again.");
    }
    throw new SlackApiError(code, `Slack error: ${code}.`);
  }
  const rotation = parseSlackConfigRotation(data);
  if (!rotation) {
    throw new Error("Slack did not return a token pair — reconnect from api.slack.com/apps.");
  }
  return rotation;
}

// Install state: `base64url({p,a,e})`.`hex HMAC-SHA256(client_secret)` — the
// Worker relay reads the plain part only to route to the right shard; the
// shard is what verifies the HMAC before touching Slack.

export type SlackInstallState = { projectId: string; agentId: string; exp: number };

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(encoded: string): string | null {
  try {
    const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Reads the unauthenticated payload — routing only; authenticity is the shard's HMAC check. */
export function decodeSlackInstallState(state: string): SlackInstallState | null {
  const json = base64UrlDecode(state.split(".")[0] ?? "");
  if (!json) {
    return null;
  }
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const projectId = str(parsed.p);
    const agentId = str(parsed.a);
    const exp = typeof parsed.e === "number" ? parsed.e : 0;
    return projectId && agentId && exp > 0 ? { projectId, agentId, exp } : null;
  } catch {
    return null;
  }
}

/** Signs an install state with the app's client secret. */
export async function buildSlackInstallState(secret: string, payload: SlackInstallState): Promise<string> {
  const encoded = base64UrlEncode(
    JSON.stringify({ p: payload.projectId, a: payload.agentId, e: payload.exp }),
  );
  return `${encoded}.${await hmacHex(secret, encoded)}`;
}

/** HMAC + expiry check; returns the payload only when both hold. */
export async function verifySlackInstallState(
  secret: string,
  state: string,
  nowMs: number = Date.now(),
): Promise<SlackInstallState | null> {
  const [encoded, signature] = state.split(".");
  if (!secret || !encoded || !signature) {
    return null;
  }
  if (!timingSafeEqualStr(await hmacHex(secret, encoded), signature)) {
    return null;
  }
  const payload = decodeSlackInstallState(state);
  return payload && payload.exp >= nowMs ? payload : null;
}

/** The OAuth v2 link the admin opens to install the bot into a workspace. */
export function slackAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: SLACK_BOT_SCOPES.join(","),
    redirect_uri: redirectUri,
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}
