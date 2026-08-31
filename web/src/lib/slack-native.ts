import type { McpToolInfo } from "@/lib/types";

/**
 * Native Slack connector — the Runbear approach, in the browser.
 *
 * Slack's MCP endpoint (mcp.slack.com) sends no CORS headers, but the plain
 * Slack Web API (slack.com/api/*) answers form-encoded POSTs with
 * `Access-Control-Allow-Origin: *` and accepts the token in the request body
 * (verified by live probe). Form-encoded POSTs are CORS "simple requests" —
 * no preflight — so a pasted Bot/User token is all a browser needs.
 */

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

const SLACK_CREDENTIAL_ERROR_CODES = new Set<string>([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
]);

/** Distinguishes a dead Slack credential from retryable network/rate-limit failures. */
export function isSlackCredentialError(error: unknown): boolean {
  return error instanceof SlackApiError && SLACK_CREDENTIAL_ERROR_CODES.has(error.code);
}

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
    throw new Error("Could not reach Slack from the browser. Check your connection.");
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
async function fetchUserNames(token: string): Promise<Map<string, string>> {
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
    fetchUserNames(token),
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
