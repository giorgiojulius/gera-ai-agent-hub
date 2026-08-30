import type { McpToolInfo } from "@/lib/types";

/**
 * Native Intercom connector.
 *
 * Intercom's REST API sends no CORS headers (probed live), so calls go through
 * this project's tiny Cloudflare relay, which forwards an allow-listed set of
 * Intercom REST endpoints and adds CORS. The pasted Access Token travels with
 * each request and is never stored server-side. Intercom's official MCP server
 * is browser-direct but read-only for conversations — this connector adds
 * replying and starting chats.
 */

type IntercomRegion = "us" | "eu";

const FUNCTIONS_URL = (() => {
  const url = import.meta.env.EXPO_PUBLIC_RORK_FUNCTIONS_URL;
  if (typeof url !== "string" || url.length === 0) {
    return "https://gera-ai-agent-hub-backend.rork.app";
  }
  return url.replace(/\/$/, "");
})();

/** Raised for Intercom error responses; `code` is Intercom's machine error. */
class IntercomApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "IntercomApiError";
    this.status = status;
    this.code = code;
  }
}

type IntercomAdmin = { id: string; name: string; email: string; appName: string };

export type IntercomIdentity = { admin: IntercomAdmin; region: IntercomRegion };

const regionCache = new Map<string, IntercomRegion>();
const adminCache = new Map<string, IntercomAdmin>();

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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

function friendlyIntercomError(status: number, code: string, message: string): string {
  if (status === 401 || ["unauthorized", "token_unauthorized", "token_expired", "token_revoked"].includes(code)) {
    return "Intercom Access Token is invalid or revoked. Create one in Developer Hub → your app → Authentication and paste it again.";
  }
  if (status === 403 || code === "forbidden" || code === "api_plan_restricted") {
    return "This Intercom token lacks permission for that action. Check the app's permissions in Developer Hub.";
  }
  if (status === 404 || code === "not_found") {
    return "Not found in Intercom — check the conversation or contact ID.";
  }
  if (status === 429 || code === "rate_limit_exceeded") {
    return "Intercom rate limit reached. Wait a moment and retry.";
  }
  if (code === "missing_token") {
    return "Intercom token is missing. Add it in Connections and press Connect.";
  }
  if (code === "upstream_unreachable") {
    return "Intercom is unreachable right now. Try again in a moment.";
  }
  return message ? `Intercom error: ${message}` : `Intercom error (${status}).`;
}

/** Calls the relay, which forwards to api.intercom.io / api.eu.intercom.io. */
async function relay(
  token: string,
  region: IntercomRegion,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${FUNCTIONS_URL}/intercom${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Intercom-Region": region,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Could not reach the Intercom relay. Check your connection.");
  }
  let data: Record<string, unknown> = {};
  try {
    data = asRecord((await response.json()) as unknown);
  } catch {
    data = {};
  }
  if (!response.ok) {
    const firstError = asRecordArray(data.errors)[0];
    const code = str(firstError?.code) || str(data.error) || "unknown";
    const message = str(firstError?.message);
    throw new IntercomApiError(response.status, code, friendlyIntercomError(response.status, code, message));
  }
  return data;
}

/** GET /me — validates the token and auto-detects the workspace region (US → EU). */
export async function verifyIntercomToken(token: string): Promise<IntercomIdentity> {
  const regions: IntercomRegion[] = [];
  const cached = regionCache.get(token);
  if (cached) {
    regions.push(cached);
  }
  for (const region of ["us", "eu"] as const) {
    if (!regions.includes(region)) {
      regions.push(region);
    }
  }
  let lastAuthError: Error | null = null;
  for (const region of regions) {
    try {
      const data = await relay(token, region, "GET", "/me");
      const app = asRecord(data.app);
      const admin: IntercomAdmin = {
        id: str(data.id),
        name: str(data.name) || "Intercom admin",
        email: str(data.email),
        appName: str(app.name) || "Intercom workspace",
      };
      if (!admin.id) {
        throw new Error("Intercom did not return an admin identity for this token.");
      }
      regionCache.set(token, region);
      adminCache.set(token, admin);
      return { admin, region };
    } catch (error) {
      if (error instanceof IntercomApiError && error.status === 401) {
        lastAuthError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastAuthError ?? new Error("Intercom token is invalid.");
}

async function ensureContext(token: string): Promise<IntercomIdentity> {
  const region = regionCache.get(token);
  const admin = adminCache.get(token);
  if (region && admin) {
    return { admin, region };
  }
  return verifyIntercomToken(token);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plain text → simple Intercom HTML body (paragraphs + line breaks). */
function toHtmlBody(text: string): string {
  const escaped = escapeHtml(text.trim());
  return `<p>${escaped.replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatUnix(value: unknown): string {
  const seconds = typeof value === "number" ? value : Number.parseInt(str(value), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function snippet(text: string, max = 140): string {
  const clean = stripHtml(text).replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function describeConversation(item: Record<string, unknown>): string {
  const source = asRecord(item.source);
  const author = asRecord(source.author);
  const subject = stripHtml(str(source.subject));
  const body = snippet(str(source.body));
  const who = str(author.name) || str(author.email) || str(author.type) || "unknown";
  const when = formatUnix(item.updated_at) || formatUnix(item.created_at);
  const state = str(item.state) || "open";
  const headline = subject || body || "(no text)";
  return `#${str(item.id)} [${state}] ${when} — from ${who}: ${headline}`;
}

async function listConversations(token: string, input: Record<string, unknown>): Promise<string> {
  const { region } = await ensureContext(token);
  const limit = clampNumber(input.limit, 15, 1, 50);
  const data = await relay(token, region, "GET", `/conversations?per_page=${limit}`);
  const conversations = asRecordArray(data.conversations);
  if (conversations.length === 0) {
    return "No conversations in this workspace yet.";
  }
  return `Latest ${conversations.length} conversations (newest first):\n${conversations
    .map(describeConversation)
    .join("\n")}`;
}

async function readConversation(token: string, input: Record<string, unknown>): Promise<string> {
  const { region } = await ensureContext(token);
  const id = str(input.conversation_id).trim();
  if (!id) {
    throw new Error("Provide a conversation_id (find it via list_conversations or search).");
  }
  const data = await relay(token, region, "GET", `/conversations/${encodeURIComponent(id)}?display_as=plaintext`);
  const source = asRecord(data.source);
  const sourceAuthor = asRecord(source.author);
  const lines: string[] = [];
  const opener = stripHtml(str(source.body));
  if (opener) {
    const who = str(sourceAuthor.name) || str(sourceAuthor.email) || str(sourceAuthor.type) || "user";
    lines.push(`[${formatUnix(data.created_at)}] ${who}: ${opener}`);
  }
  const partsRecord = asRecord(data.conversation_parts);
  const parts = asRecordArray(partsRecord.conversation_parts).filter((part) => stripHtml(str(part.body)).length > 0);
  const visible = parts.slice(-40);
  for (const part of visible) {
    const author = asRecord(part.author);
    const who = str(author.name) || str(author.email) || str(author.type) || "user";
    const kind = str(part.part_type);
    const note = kind === "note" ? " (internal note)" : "";
    lines.push(`[${formatUnix(part.created_at)}] ${who}${note}: ${stripHtml(str(part.body))}`);
  }
  if (lines.length === 0) {
    return `Conversation #${id} has no readable messages.`;
  }
  const skipped = parts.length - visible.length;
  const header = `Conversation #${id} (${str(data.state) || "open"})${skipped > 0 ? ` — showing last ${visible.length} of ${parts.length} parts` : ""}:`;
  return `${header}\n${lines.join("\n")}`;
}

async function replyToConversation(token: string, input: Record<string, unknown>): Promise<string> {
  const { admin, region } = await ensureContext(token);
  const id = str(input.conversation_id).trim();
  const body = str(input.body).trim();
  if (!id) {
    throw new Error("Provide a conversation_id to reply to.");
  }
  if (!body) {
    throw new Error("Reply text is empty.");
  }
  const asNote = input.as_note === true;
  await relay(token, region, "POST", `/conversations/${encodeURIComponent(id)}/reply`, {
    message_type: asNote ? "note" : "comment",
    type: "admin",
    admin_id: admin.id,
    body: toHtmlBody(body),
  });
  return asNote
    ? `Internal note added to conversation #${id}.`
    : `Reply posted to conversation #${id} as ${admin.name}.`;
}

async function resolveContact(
  token: string,
  region: IntercomRegion,
  to: string,
): Promise<{ id: string; role: string; label: string }> {
  const target = to.trim();
  if (!target) {
    throw new Error("Provide the recipient: a contact email or contact ID.");
  }
  if (target.includes("@")) {
    const data = await relay(token, region, "POST", "/contacts/search", {
      query: { field: "email", operator: "=", value: target.toLowerCase() },
      pagination: { per_page: 1 },
    });
    const contact = asRecordArray(data.data)[0];
    if (!contact) {
      throw new Error(`No Intercom contact found with email ${target}.`);
    }
    return {
      id: str(contact.id),
      role: str(contact.role) || "user",
      label: str(contact.name) || target,
    };
  }
  const contact = await relay(token, region, "GET", `/contacts/${encodeURIComponent(target)}`);
  return {
    id: str(contact.id),
    role: str(contact.role) || "user",
    label: str(contact.name) || str(contact.email) || target,
  };
}

async function sendNewMessage(token: string, input: Record<string, unknown>): Promise<string> {
  const { admin, region } = await ensureContext(token);
  const body = str(input.body).trim();
  if (!body) {
    throw new Error("Message text is empty.");
  }
  const contact = await resolveContact(token, region, str(input.to));
  const data = await relay(token, region, "POST", "/messages", {
    message_type: "inapp",
    body: toHtmlBody(body),
    from: { type: "admin", id: admin.id },
    to: { type: contact.role === "lead" ? "lead" : "user", id: contact.id },
  });
  const conversationId = str(data.conversation_id);
  return `New chat sent to ${contact.label}${conversationId ? ` (conversation #${conversationId})` : ""}.`;
}

async function searchContacts(token: string, input: Record<string, unknown>): Promise<string> {
  const { region } = await ensureContext(token);
  const query = str(input.query).trim();
  if (!query) {
    throw new Error("Provide a search query (name or email).");
  }
  const field = query.includes("@") ? "email" : "name";
  const operator = query.includes("@") ? "=" : "~";
  const data = await relay(token, region, "POST", "/contacts/search", {
    query: { field, operator, value: query.includes("@") ? query.toLowerCase() : query },
    pagination: { per_page: 10 },
  });
  const contacts = asRecordArray(data.data);
  if (contacts.length === 0) {
    return `No Intercom contacts match "${query}".`;
  }
  return contacts
    .map((contact) => {
      const name = str(contact.name) || "(no name)";
      const email = str(contact.email);
      const role = str(contact.role) || "user";
      const seen = formatUnix(contact.last_seen_at);
      return `${name} (${str(contact.id)}) — ${email || "no email"} · ${role}${seen ? ` · last seen ${seen}` : ""}`;
    })
    .join("\n");
}

async function searchConversations(token: string, input: Record<string, unknown>): Promise<string> {
  const { region } = await ensureContext(token);
  const query = str(input.query).trim();
  if (!query) {
    throw new Error("Provide text to search for.");
  }
  const data = await relay(token, region, "POST", "/conversations/search", {
    query: { field: "source.body", operator: "~", value: query },
    pagination: { per_page: 10 },
  });
  const conversations = asRecordArray(data.conversations);
  if (conversations.length === 0) {
    return `No Intercom conversations match "${query}".`;
  }
  return conversations.map(describeConversation).join("\n");
}

async function whoami(token: string): Promise<string> {
  const { admin, region } = await ensureContext(token);
  return `Signed in to ${admin.appName} as ${admin.name}${admin.email ? ` (${admin.email})` : ""} — ${region.toUpperCase()} region.`;
}

/** Tool surface exposed to the agent; names become mcp_intercom_* functions. */
export const INTERCOM_NATIVE_TOOLS: McpToolInfo[] = [
  {
    name: "reply_to_conversation",
    description:
      "Reply in an Intercom conversation as the connected admin. Set as_note=true to add an internal note visible only to teammates instead of messaging the customer.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "Conversation ID (find via list or search)" },
        body: { type: "string", description: "Reply text (plain text; line breaks preserved)" },
        as_note: { type: "boolean", description: "true = internal note instead of a customer-visible reply" },
      },
      required: ["conversation_id", "body"],
    },
  },
  {
    name: "send_new_message",
    description:
      "Start a new Intercom chat with a contact (in-app message from the connected admin). Recipient is a contact email or contact ID.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Contact email or contact ID" },
        body: { type: "string", description: "Message text" },
      },
      required: ["to", "body"],
    },
  },
  {
    name: "list_conversations",
    description: "List the latest Intercom conversations (newest first) with IDs, state, author, and a snippet.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many conversations (default 15, max 50)" },
      },
    },
  },
  {
    name: "read_conversation",
    description: "Read a full Intercom conversation transcript by ID, including customer messages, admin replies, and internal notes.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "Conversation ID" },
      },
      required: ["conversation_id"],
    },
  },
  {
    name: "search_conversations",
    description: "Full-text search Intercom conversations by message text.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for" },
      },
      required: ["query"],
    },
  },
  {
    name: "search_contacts",
    description: "Find Intercom contacts by email (exact) or name (contains). Returns IDs usable with send_new_message.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Email or name" },
      },
      required: ["query"],
    },
  },
  {
    name: "whoami",
    description: "Show which Intercom workspace, admin identity, and region this token is signed in as.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** Dispatches an agent tool call to the Intercom relay. */
export async function callIntercomNativeTool(token: string, name: string, args: unknown): Promise<string> {
  const input = asRecord(args);
  switch (name) {
    case "reply_to_conversation":
      return replyToConversation(token, input);
    case "send_new_message":
      return sendNewMessage(token, input);
    case "list_conversations":
      return listConversations(token, input);
    case "read_conversation":
      return readConversation(token, input);
    case "search_conversations":
      return searchConversations(token, input);
    case "search_contacts":
      return searchContacts(token, input);
    case "whoami":
      return whoami(token);
    default:
      throw new Error(`Unknown Intercom tool "${name}".`);
  }
}
