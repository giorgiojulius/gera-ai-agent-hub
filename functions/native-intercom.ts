/**
 * Server-side port of the native Intercom connector (web/src/lib/intercom-native.ts)
 * for cloud automation runs: api.intercom.io / api.eu.intercom.io straight from
 * the Worker — no CORS constraints, so no relay hop. Same tool surface as the
 * browser connector; the region auto-detects US → EU and is cached per token.
 */

type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type IntercomRegion = "us" | "eu";

const INTERCOM_HOSTS: Record<IntercomRegion, string> = {
  us: "https://api.intercom.io",
  eu: "https://api.eu.intercom.io",
};

const INTERCOM_VERSION = "2.11";

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

type IntercomAdmin = { id: string; name: string; email: string; appName: string; appIdCode: string };

export type IntercomIdentity = { admin: IntercomAdmin; region: IntercomRegion };

const regionCache = new Map<string, IntercomRegion>();
const adminCache = new Map<string, IntercomAdmin>();

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Intercom mixes string and integer ids (admin/team/owner assignees) — normalize both. */
function idStr(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
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

/** Calls the Intercom REST API directly on the region's host. */
async function relay(
  token: string,
  region: IntercomRegion,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${INTERCOM_HOSTS[region]}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Intercom-Version": INTERCOM_VERSION,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("Intercom is unreachable right now. Try again in a moment.");
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
        appIdCode: str(app.id_code),
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type IntercomMentionRef = { id: string; name: string };

/**
 * Note body HTML where each literal "@Name" from the composer becomes an
 * Intercom teammate mention link (the anchor shape Intercom uses in note
 * HTML), so tagged teammates are linked right in the note. Longest name wins
 * at a shared prefix and a trailing letter guard keeps "@Ann" out of
 * "@Annabelle". Pure — the workspace id_code is a parameter for tests.
 */
export function buildIntercomNoteBody(text: string, mentions: IntercomMentionRef[], appIdCode = "_"): string {
  const html = toHtmlBody(text);
  const idByLabel = new Map<string, string>();
  for (const mention of mentions) {
    const name = mention.name.trim();
    const id = mention.id.trim();
    if (name.length > 0 && id.length > 0) {
      idByLabel.set(escapeHtml(`@${name}`), id);
    }
  }
  if (idByLabel.size === 0) {
    return html;
  }
  const alternation = [...idByLabel.keys()]
    .sort((a, b) => b.length - a.length)
    .map((label) => escapeRegExp(label))
    .join("|");
  const app = encodeURIComponent(appIdCode.trim() || "_");
  return html.replace(new RegExp(`(?:${alternation})(?![\\p{L}\\p{N}_])`, "gu"), (match) => {
    const id = idByLabel.get(match);
    return id
      ? `<a href="https://app.intercom.com/a/apps/${app}/admins/${encodeURIComponent(id)}" class="mention">${match}</a>`
      : match;
  });
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

export type IntercomAttachmentData = {
  name: string;
  /** Signed Intercom CDN link — public but expiring; refreshed on every refetch. */
  url: string;
  contentType: string;
  /** Bytes; 0 = unknown. */
  size: number;
};

/**
 * Parses the `attachments` array Intercom puts on conversation sources and
 * parts. A pasted screenshot with no text is a real customer turn — dropping
 * bodyless parts silently hid those messages from the desk and the model.
 */
export function readAttachments(record: Record<string, unknown>): IntercomAttachmentData[] {
  const out: IntercomAttachmentData[] = [];
  for (const raw of asRecordArray(record.attachments)) {
    const url = str(raw.url).trim();
    if (!/^https?:\/\//i.test(url)) {
      continue;
    }
    out.push({
      name: str(raw.name).trim() || "attachment",
      url,
      contentType: str(raw.content_type).trim().toLowerCase(),
      size:
        typeof raw.filesize === "number" && Number.isFinite(raw.filesize) && raw.filesize > 0
          ? Math.trunc(raw.filesize)
          : 0,
    });
    if (out.length >= 10) {
      break;
    }
  }
  return out;
}

/** "1.2 MB" / "340 KB"; "" when the size is unknown. */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "";
  }
  if (bytes < 1024) {
    return `${Math.trunc(bytes)} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb >= 10 ? Math.round(kb) : Math.round(kb * 10) / 10} KB`;
  }
  const mb = kb / 1024;
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/**
 * "[attached: screenshot.png (image/png, 1.2 MB); crash.log]" — how LLM-facing
 * transcripts mention files. Names, types and sizes only — never the expiring
 * CDN URLs: the model must know the file exists (and say it cannot open it)
 * instead of hallucinating its content.
 */
export function attachmentLabel(attachments: IntercomAttachmentData[]): string {
  if (attachments.length === 0) {
    return "";
  }
  const items = attachments.map((attachment) => {
    const meta = [attachment.contentType, formatAttachmentSize(attachment.size)]
      .filter((piece) => piece.length > 0)
      .join(", ");
    return meta ? `${attachment.name} (${meta})` : attachment.name;
  });
  return `[attached: ${items.join("; ")}]`;
}

/** "text [attached: …]" — body and attachment mention joined; "" when both empty. */
export function joinTextAndAttachments(text: string, attachments: IntercomAttachmentData[]): string {
  return [text, attachmentLabel(attachments)].filter((piece) => piece.length > 0).join(" ");
}

/** Short list-row preview: "Attachment: screenshot.png" / "Attachments: a.png +2". */
export function attachmentPreviewText(attachments: IntercomAttachmentData[]): string {
  const first = attachments[0];
  if (!first) {
    return "";
  }
  return attachments.length > 1
    ? `Attachments: ${first.name} +${attachments.length - 1}`
    : `Attachment: ${first.name}`;
}

function describeConversation(item: Record<string, unknown>): string {
  const source = asRecord(item.source);
  const author = asRecord(source.author);
  const subject = stripHtml(str(source.subject));
  const body = snippet(str(source.body));
  const who = str(author.name) || str(author.email) || str(author.type) || "unknown";
  const when = formatUnix(item.updated_at) || formatUnix(item.created_at);
  const state = str(item.state) || "open";
  const headline = subject || body || attachmentPreviewText(readAttachments(source)) || "(no text)";
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
  const opener = joinTextAndAttachments(stripHtml(str(source.body)), readAttachments(source));
  if (opener) {
    const who = str(sourceAuthor.name) || str(sourceAuthor.email) || str(sourceAuthor.type) || "user";
    lines.push(`[${formatUnix(data.created_at)}] ${who}: ${opener}`);
  }
  const partsRecord = asRecord(data.conversation_parts);
  const parts = asRecordArray(partsRecord.conversation_parts).filter(
    (part) => stripHtml(str(part.body)).length > 0 || readAttachments(part).length > 0,
  );
  const visible = parts.slice(-40);
  for (const part of visible) {
    const author = asRecord(part.author);
    const who = str(author.name) || str(author.email) || str(author.type) || "user";
    const kind = str(part.part_type);
    const note = kind === "note" ? " (internal note)" : "";
    lines.push(
      `[${formatUnix(part.created_at)}] ${who}${note}: ${joinTextAndAttachments(stripHtml(str(part.body)), readAttachments(part))}`,
    );
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

// --- Structured inbox API ----------------------------------------------------
// Used by project screen desks (a human UI), not by LLM tools — same relay,
// same region/admin caches, but typed rows instead of prompt-friendly strings.

export type IntercomInboxItem = {
  id: string;
  state: string;
  author: string;
  email: string;
  snippet: string;
  createdAt: number;
  updatedAt: number;
  /** Biggest spend-looking contact attribute — the desk's priority signal. */
  spend: number | null;
  /** 1 = pays like the top of the list … 3 = pays anything; null = no known spend. */
  tier: IntercomSpendTier | null;
};

// --- Spend priority ------------------------------------------------------------
// The desk ranks conversations by money: the more the customer pays, the higher
// the thread. Spend comes from spend-ish contact attributes (EN + RU keys) —
// no guessing beyond that, non-payers simply fall back to recency order.

const SPEND_KEY_PATTERN =
  /spend|mrr|arr|ltv|revenue|price|payment|paid|billing|budget|тариф|трат|оплат|плат[ёе]ж|выручк|доход|бюджет/i;
/** Ids, dates, debts and statuses are not spend even when the key sounds money-ish. */
const SPEND_KEY_SKIP =
  /(^|[_\s-])id$|_id\b|identifier|url|link|date|_at$|currency|валют|status|статус|debt|balance|долг|баланс|задолж/i;
/** Short currency prefix + digits + short unit suffix; letters glued to digits (ids) fail. */
const MONEY_TEXT_PATTERN =
  /^[^\dа-яёa-z]{0,4}\d[\d\s.,]{0,15}(?:[\s/]*[а-яёa-z]{0,6}\.?|[^\dа-яёa-z]{0,4})?$/i;

/** Best-effort money parse: 4990, "$4,990.50", "4 990 ₽", "499 USD" — id-like strings rejected. */
export function moneyValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const raw = value.trim();
  if (!raw || raw.length > 24 || !MONEY_TEXT_PATTERN.test(raw)) {
    return null;
  }
  const digits = raw.replace(/[^\d.,-]/g, "");
  let normalized = digits;
  if (digits.includes(",") && digits.includes(".")) {
    normalized = digits.replace(/,/g, ""); // "4,990.50" — commas are thousands
  } else if (digits.includes(",")) {
    const parts = digits.split(",");
    normalized =
      parts.length === 2 && (parts[1] ?? "").length !== 3
        ? digits.replace(",", ".") // "4990,50" — comma is the decimal point
        : digits.replace(/,/g, "");
  }
  const amount = Number.parseFloat(normalized);
  return Number.isFinite(amount) ? amount : null;
}

/** Largest positive money-looking value among spend-ish attributes (EN + RU keys). */
export function extractSpendValue(attrs: Record<string, unknown>): number | null {
  let best: number | null = null;
  for (const [key, value] of Object.entries(attrs)) {
    if (!SPEND_KEY_PATTERN.test(key) || SPEND_KEY_SKIP.test(key)) {
      continue;
    }
    const amount = moneyValue(value);
    if (amount !== null && amount > 0 && (best === null || amount > best)) {
      best = amount;
    }
  }
  return best;
}

export type IntercomSpendTier = 1 | 2 | 3;

/**
 * Simple signal relative to the top payer of the list: T1 pays like the top
 * (≥⅔ of max), T2 is midfield (≥⅓), T3 pays anything, null pays nothing.
 */
export function spendTier(
  spend: number | null | undefined,
  maxSpend: number,
): IntercomSpendTier | null {
  if (typeof spend !== "number" || spend <= 0 || maxSpend <= 0) {
    return null;
  }
  if (spend >= (maxSpend * 2) / 3) {
    return 1;
  }
  if (spend >= maxSpend / 3) {
    return 2;
  }
  return 3;
}

/** Higher spender first (tier-1 on top); recency breaks ties and orders non-payers. */
export function rankInboxRows<T extends { spend: number | null; updatedAt: number }>(
  rows: T[],
): Array<T & { tier: IntercomSpendTier | null }> {
  const maxSpend = rows.reduce((acc, row) => Math.max(acc, row.spend ?? 0), 0);
  return rows
    .map((row) => ({ ...row, tier: spendTier(row.spend, maxSpend) }))
    .sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0) || b.updatedAt - a.updatedAt);
}

export type IntercomPartData = {
  id: string;
  author: string;
  role: "customer" | "teammate" | "bot";
  note: boolean;
  body: string;
  createdAt: number;
  attachments: IntercomAttachmentData[];
};

export type IntercomThreadData = {
  id: string;
  state: string;
  author: string;
  email: string;
  parts: IntercomPartData[];
};

function toMs(value: unknown): number {
  const seconds = typeof value === "number" ? value : Number.parseInt(str(value), 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function partRole(authorType: string): "customer" | "teammate" | "bot" {
  if (authorType === "admin" || authorType === "team") {
    return "teammate";
  }
  if (authorType === "bot") {
    return "bot";
  }
  return "customer";
}

// The conversation LIST payload only carries the FIRST message (source) — for
// bot-started chats that's the greeting, not the customer. Real previews and
// the human behind the thread live in the detail payload, so rows are derived
// from per-conversation detail fetches, cached by updated_at across polls.

export type InboxRowCore = {
  id: string;
  state: string;
  contactId: string;
  customerName: string;
  customerEmail: string;
  snippet: string;
  createdAt: number;
  updatedAt: number;
};

const INBOX_ROW_CACHE_MAX = 400;
const inboxRowCache = new Map<string, { updatedAt: number; row: InboxRowCore }>();
const CONTACT_TTL_MS = 30 * 60 * 1000;
const CONTACT_CACHE_MAX = 800;
const contactLiteCache = new Map<
  string,
  { at: number; name: string; email: string; spend: number | null }
>();

/** Drops the oldest entries once a cache grows past its cap. */
function capCache(cache: Map<string, unknown>, max: number): void {
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    cache.delete(oldest);
  }
}

function cacheScope(token: string): string {
  return token.slice(-12);
}

/** Runs an async mapper over items with a small concurrency cap, keeping order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Pure: inbox row (customer identity + last-message preview) from one conversation payload. */
export function deriveInboxRow(detail: Record<string, unknown>): InboxRowCore {
  const source = asRecord(detail.source);
  const sourceAuthor = asRecord(source.author);
  const parts = asRecordArray(asRecord(detail.conversation_parts).conversation_parts).filter(
    (part) => stripHtml(str(part.body)).length > 0 || readAttachments(part).length > 0,
  );
  let customerName = "";
  let customerEmail = "";
  const sourceAuthorType = str(sourceAuthor.type);
  if (sourceAuthorType === "user" || sourceAuthorType === "lead") {
    customerName = str(sourceAuthor.name);
    customerEmail = str(sourceAuthor.email);
  }
  if (!customerName && !customerEmail) {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const author = asRecord(parts[index]?.author);
      const type = str(author.type);
      if (type === "user" || type === "lead") {
        customerName = str(author.name);
        customerEmail = str(author.email);
        break;
      }
    }
  }
  const lastPart = parts[parts.length - 1];
  const previewAuthor = asRecord(lastPart ? lastPart.author : sourceAuthor);
  const previewAuthorType = str(previewAuthor.type);
  const previewName = str(previewAuthor.name).split(/\s+/)[0] ?? "";
  const isNote = lastPart ? str(lastPart.part_type) === "note" : false;
  let prefix = "";
  if (previewAuthorType === "admin" || previewAuthorType === "team") {
    prefix = `${previewName || "Teammate"}${isNote ? " (note)" : ""}: `;
  } else if (previewAuthorType === "bot") {
    prefix = `${previewName || "Bot"}: `;
  }
  const text =
    snippet(str(lastPart ? lastPart.body : source.body), 130) ||
    attachmentPreviewText(readAttachments(lastPart ?? source));
  const subject = stripHtml(str(source.subject));
  return {
    id: idStr(detail.id),
    state: str(detail.state) || "open",
    contactId: idStr(asRecordArray(asRecord(detail.contacts).contacts)[0]?.id),
    customerName,
    customerEmail,
    snippet: text ? `${prefix}${text}` : subject || "(no text)",
    createdAt: toMs(detail.created_at),
    updatedAt: toMs(detail.updated_at) || toMs(detail.created_at),
  };
}

/** One contacts/search round-trip fills names AND spend for the rows' contacts. */
async function resolveContactFacts(
  token: string,
  region: IntercomRegion,
  rows: InboxRowCore[],
): Promise<void> {
  const scope = cacheScope(token);
  const now = Date.now();
  const missing = [
    ...new Set(rows.filter((row) => row.contactId).map((row) => row.contactId)),
  ].filter((id) => {
    const hit = contactLiteCache.get(`${scope}:${id}`);
    return !hit || now - hit.at > CONTACT_TTL_MS;
  });
  if (missing.length === 0) {
    return;
  }
  try {
    const data = await relay(token, region, "POST", "/contacts/search", {
      query: { field: "id", operator: "IN", value: missing.slice(0, 50) },
      pagination: { per_page: 50 },
    });
    const found = new Set<string>();
    for (const contact of asRecordArray(data.data)) {
      const id = idStr(contact.id);
      found.add(id);
      contactLiteCache.set(`${scope}:${id}`, {
        at: now,
        name: str(contact.name),
        email: str(contact.email),
        spend: extractSpendValue(asRecord(contact.custom_attributes)),
      });
    }
    for (const id of missing) {
      if (!found.has(id)) {
        contactLiteCache.set(`${scope}:${id}`, { at: now, name: "", email: "", spend: null });
      }
    }
    capCache(contactLiteCache, CONTACT_CACHE_MAX);
  } catch {
    // Names stay empty this round — rows fall back to the contact email or "Customer".
  }
}

export type IntercomInboxState = "open" | "closed" | "snoozed" | "all";

/**
 * Latest conversations as typed rows for an inbox list, top spenders first.
 * Defaults to OPEN conversations — Intercom's own inbox does the same, and in
 * bot-heavy workspaces (one auto-closed conversation per session) an
 * unfiltered list reads like a per-message feed instead of real dialogs.
 */
export async function fetchIntercomInboxData(
  token: string,
  limit = 30,
  state: IntercomInboxState = "open",
): Promise<IntercomInboxItem[]> {
  const { region } = await ensureContext(token);
  const perPage = clampNumber(limit, 30, 1, 50);
  const data =
    state === "all"
      ? await relay(token, region, "GET", `/conversations?per_page=${perPage}`)
      : await relay(token, region, "POST", "/conversations/search", {
          query: { field: "state", operator: "=", value: state },
          pagination: { per_page: perPage },
        });
  const scope = cacheScope(token);
  const rows = await mapLimit(asRecordArray(data.conversations), 6, async (item) => {
    const id = idStr(item.id);
    const updatedAt = toMs(item.updated_at) || toMs(item.created_at);
    const cacheKey = `${scope}:${id}`;
    const cached = inboxRowCache.get(cacheKey);
    if (cached && cached.updatedAt === updatedAt) {
      return cached.row;
    }
    try {
      const detail = await relay(
        token,
        region,
        "GET",
        `/conversations/${encodeURIComponent(id)}?display_as=plaintext`,
      );
      const row = deriveInboxRow(detail);
      inboxRowCache.set(cacheKey, { updatedAt, row });
      capCache(inboxRowCache, INBOX_ROW_CACHE_MAX);
      return row;
    } catch {
      // Detail fetch failed (rate limit, deleted, …) — degrade to the list payload.
      return deriveInboxRow(item);
    }
  });
  await resolveContactFacts(token, region, rows);
  // rankInboxRows: money first, recency second — search order is neither anyway.
  return rankInboxRows(
    rows.map((row) => {
      const contact = contactLiteCache.get(`${scope}:${row.contactId}`);
      return {
        id: row.id,
        state: row.state,
        author: row.customerName || contact?.name || row.customerEmail || contact?.email || "Customer",
        email: row.customerEmail || contact?.email || "",
        snippet: row.snippet,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        spend: contact?.spend ?? null,
      };
    }),
  );
}

/**
 * Pure: typed thread parts (opener + conversation parts) from one conversation
 * payload. Attachment-only messages stay in — with body "" and the files listed.
 */
export function deriveThreadParts(detail: Record<string, unknown>, fallbackId = ""): IntercomPartData[] {
  const source = asRecord(detail.source);
  const author = asRecord(source.author);
  const parts: IntercomPartData[] = [];
  const opener = stripHtml(str(source.body));
  const openerAttachments = readAttachments(source);
  if (opener || openerAttachments.length > 0) {
    parts.push({
      id: `src-${idStr(detail.id) || fallbackId}`,
      author: str(author.name) || str(author.email) || "Customer",
      role: partRole(str(author.type)),
      note: false,
      body: opener,
      createdAt: toMs(detail.created_at),
      attachments: openerAttachments,
    });
  }
  const partsRecord = asRecord(detail.conversation_parts);
  for (const part of asRecordArray(partsRecord.conversation_parts)) {
    const body = stripHtml(str(part.body));
    const attachments = readAttachments(part);
    if (!body && attachments.length === 0) {
      continue;
    }
    const partAuthor = asRecord(part.author);
    parts.push({
      id: idStr(part.id) || `p-${parts.length}`,
      author: str(partAuthor.name) || str(partAuthor.email) || str(partAuthor.type) || "user",
      role: partRole(str(partAuthor.type)),
      note: str(part.part_type) === "note",
      body,
      createdAt: toMs(part.created_at),
      attachments,
    });
  }
  return parts;
}

/** One conversation's transcript as typed parts for a thread pane. */
export async function fetchIntercomThreadData(
  token: string,
  conversationId: string,
): Promise<IntercomThreadData> {
  const id = conversationId.trim();
  if (!id) {
    throw new Error("Missing conversation id.");
  }
  const { region } = await ensureContext(token);
  const data = await relay(token, region, "GET", `/conversations/${encodeURIComponent(id)}?display_as=plaintext`);
  const source = asRecord(data.source);
  const author = asRecord(source.author);
  const parts = deriveThreadParts(data, id);
  return {
    id: str(data.id) || id,
    state: str(data.state) || "open",
    author: str(author.name) || str(author.email) || "Customer",
    email: str(author.email),
    parts: parts.slice(-80),
  };
}

/** Posts a customer reply or an internal note; returns the acting admin. */
export async function postIntercomReplyData(
  token: string,
  conversationId: string,
  body: string,
  asNote: boolean,
  mentions: IntercomMentionRef[] = [],
): Promise<{ admin: string }> {
  const id = conversationId.trim();
  const text = body.trim();
  if (!id || !text) {
    throw new Error("Missing conversation id or reply text.");
  }
  const { admin, region } = await ensureContext(token);
  await relay(token, region, "POST", `/conversations/${encodeURIComponent(id)}/reply`, {
    message_type: asNote ? "note" : "comment",
    type: "admin",
    admin_id: admin.id,
    body: asNote && mentions.length > 0 ? buildIntercomNoteBody(text, mentions, admin.appIdCode) : toHtmlBody(text),
  });
  return { admin: admin.name };
}

/** Closes or snoozes a conversation as the connected admin (conversation parts API). */
export async function manageIntercomConversationData(
  token: string,
  conversationId: string,
  action: "close" | "snooze",
  snoozedUntilSec?: number,
): Promise<{ admin: string; state: string }> {
  const id = conversationId.trim();
  if (!id) {
    throw new Error("Missing conversation id.");
  }
  const { admin, region } = await ensureContext(token);
  const body =
    action === "close"
      ? { message_type: "close", type: "admin", admin_id: admin.id }
      : {
          message_type: "snoozed_until",
          admin_id: admin.id,
          snoozed_until: snoozedUntilSec ?? Math.floor(Date.now() / 1000) + 24 * 3600,
        };
  const data = await relay(token, region, "POST", `/conversations/${encodeURIComponent(id)}/parts`, body);
  return { admin: admin.name, state: str(data.state) || (action === "close" ? "closed" : "snoozed") };
}

// --- Teammate reply stats (desk performance) ---------------------------------

export type IntercomReplyPair = {
  /** Intercom part id — stable across polls; the dedup key for the stats log. */
  id: string;
  adminId: string;
  adminName: string;
  /** The customer message this reply answered ("" for proactive replies). */
  customerText: string;
  replyText: string;
  /** How long the customer waited for this reply; 0 = proactive/unknown. */
  responseMs: number;
  at: number;
};

/**
 * Extracts HUMAN teammate replies (part_type "comment", author type "admin")
 * from one conversation payload, each paired with the customer message it
 * answered. Bots and internal notes are skipped — people get graded, not Fin.
 */
export function deriveReplyPairs(detail: Record<string, unknown>): IntercomReplyPair[] {
  const out: IntercomReplyPair[] = [];
  const source = asRecord(detail.source);
  const sourceAuthor = asRecord(source.author);
  const sourceType = str(sourceAuthor.type);
  let lastCustomerText = "";
  let lastCustomerAt = 0;
  const opener = joinTextAndAttachments(stripHtml(str(source.body)), readAttachments(source));
  if (opener && sourceType !== "admin" && sourceType !== "bot") {
    lastCustomerText = opener;
    lastCustomerAt = toMs(detail.created_at);
  }
  const partsRecord = asRecord(detail.conversation_parts);
  for (const part of asRecordArray(partsRecord.conversation_parts)) {
    const body = stripHtml(str(part.body));
    const attachments = readAttachments(part);
    if (!body && attachments.length === 0) {
      continue;
    }
    const author = asRecord(part.author);
    const authorType = str(author.type);
    const at = toMs(part.created_at);
    if (authorType === "user" || authorType === "lead" || authorType === "contact") {
      // A screenshot with no words is still a customer turn — the reply that
      // answers it must inherit the wait time and see the attachment mention.
      lastCustomerText = joinTextAndAttachments(body, attachments);
      lastCustomerAt = at;
      continue;
    }
    if (authorType !== "admin" || str(part.part_type) !== "comment" || !body) {
      continue; // Bots, notes, assignments and attachment-only comments are not graded replies.
    }
    const partId = idStr(part.id);
    if (!partId) {
      continue;
    }
    out.push({
      id: partId,
      adminId: idStr(author.id),
      adminName: str(author.name) || str(author.email) || "Teammate",
      customerText: lastCustomerText,
      replyText: body,
      responseMs: lastCustomerAt > 0 && at > lastCustomerAt ? at - lastCustomerAt : 0,
      at,
    });
    // Follow-up teammate messages must not re-claim the same customer message.
    lastCustomerText = "";
    lastCustomerAt = 0;
  }
  return out;
}

export type IntercomHarvestedReply = IntercomReplyPair & { conversationId: string };

/**
 * Full conversation transcript for the grading prompt, oldest first. HUMAN
 * teammate comments carry a stable [partId] marker so the grader can judge
 * each reply against everything said around it; customer messages, bot
 * replies and internal notes stay visible as unmarked context.
 */
export function deriveConversationTranscript(detail: Record<string, unknown>): string {
  const lines: string[] = [];
  const push = (line: string): void => {
    lines.push(line.replace(/\s+/g, " ").trim().slice(0, 400));
  };
  const source = asRecord(detail.source);
  const sourceAuthor = asRecord(source.author);
  const opener = joinTextAndAttachments(stripHtml(str(source.body)), readAttachments(source));
  if (opener) {
    const openerName = str(sourceAuthor.name);
    const openerType = str(sourceAuthor.type);
    if (openerType === "admin") {
      push(`${openerName || "Teammate"} (teammate, opener): ${opener}`);
    } else if (openerType === "bot") {
      push(`Bot${openerName ? ` (${openerName})` : ""}: ${opener}`);
    } else {
      push(`Customer${openerName ? ` (${openerName})` : ""}: ${opener}`);
    }
  }
  const partsRecord = asRecord(detail.conversation_parts);
  for (const part of asRecordArray(partsRecord.conversation_parts)) {
    // Attachment-only turns ride in as "[attached: …]" — the grader must know
    // the customer sent a screenshot even when they typed nothing.
    const body = joinTextAndAttachments(stripHtml(str(part.body)), readAttachments(part));
    if (!body) {
      continue;
    }
    const author = asRecord(part.author);
    const authorType = str(author.type);
    const name = str(author.name);
    const partType = str(part.part_type);
    if (authorType === "user" || authorType === "lead" || authorType === "contact") {
      push(`Customer${name ? ` (${name})` : ""}: ${body}`);
      continue;
    }
    if (authorType === "bot") {
      push(`Bot${name ? ` (${name})` : ""}: ${body}`);
      continue;
    }
    if (authorType !== "admin") {
      continue;
    }
    if (partType === "note") {
      push(`Internal note (${name || "teammate"}): ${body}`);
      continue;
    }
    if (partType !== "comment") {
      continue;
    }
    const partId = idStr(part.id);
    push(`${partId ? `[${partId}] ` : ""}${name || "Teammate"} (teammate): ${body}`);
  }
  // Keep a deep transcript while bounding one conversation's model footprint.
  // Newest context wins only when a very long support thread exceeds the cap.
  const kept = lines.slice(-100);
  while (kept.length > 1 && kept.join("\n").length > 12_000) {
    kept.shift();
  }
  return kept.join("\n");
}

export type IntercomHarvest = {
  replies: IntercomHarvestedReply[];
  /** One full transcript per conversation — the grading context store. */
  transcripts: Array<{ conversationId: string; transcript: string }>;
  /** Conversations returned by Intercom before detail reads. */
  scannedConversations: number;
  /** Conversations whose detail could be read and contained a reply in range. */
  analyzedConversations: number;
  /** True when more matching conversations existed beyond the bounded scan. */
  limitReached: boolean;
};

export type IntercomHarvestOptions = {
  /** Inclusive reply timestamps in epoch milliseconds; 0 means unbounded. */
  from?: number;
  to?: number;
  /** Hard cap on conversation detail calls, 1–300. */
  maxConversations?: number;
};

/** Reads Intercom's cursor without trusting the rest of the paging payload. */
export function intercomNextCursor(data: Record<string, unknown>): string {
  return str(asRecord(asRecord(data.pages).next).starting_after);
}

/**
 * Teammate replies + full transcripts across a bounded, paginated Intercom
 * search. Search narrows by conversation activity; reply timestamps enforce
 * the exact range after each full transcript is fetched.
 */
export async function harvestIntercomReplyPairs(
  token: string,
  options: IntercomHarvestOptions = {},
): Promise<IntercomHarvest> {
  const { region } = await ensureContext(token);
  const from = Number.isFinite(options.from) ? Math.max(0, Math.trunc(options.from ?? 0)) : 0;
  const to = Number.isFinite(options.to) ? Math.max(0, Math.trunc(options.to ?? 0)) : 0;
  const maxConversations = clampNumber(options.maxConversations, 150, 1, 300);
  const conversations: Array<Record<string, unknown>> = [];
  let startingAfter = "";
  let hasMore = false;

  while (conversations.length < maxConversations) {
    const remaining = maxConversations - conversations.length;
    const filters: Array<Record<string, unknown>> = [];
    if (from > 0) {
      filters.push({ field: "updated_at", operator: ">", value: Math.max(0, Math.floor(from / 1000) - 1) });
    }
    if (to > 0) {
      filters.push({ field: "updated_at", operator: "<", value: Math.ceil(to / 1000) + 1 });
    }
    const query =
      filters.length === 0
        ? { field: "updated_at", operator: ">", value: 0 }
        : filters.length === 1
          ? filters[0]
          : { operator: "AND", value: filters };
    const data = await relay(token, region, "POST", "/conversations/search", {
      query,
      pagination: {
        per_page: Math.min(150, remaining),
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      },
      sort: { field: "updated_at", order: "descending" },
    });
    const page = asRecordArray(data.conversations);
    conversations.push(...page.slice(0, remaining));
    const next = intercomNextCursor(data);
    hasMore = Boolean(next);
    if (!next || page.length === 0 || conversations.length >= maxConversations) {
      break;
    }
    startingAfter = next;
  }

  const nested = await mapLimit(conversations, 8, async (item) => {
    const id = idStr(item.id);
    if (!id) {
      return null;
    }
    try {
      const detail = await relay(
        token,
        region,
        "GET",
        `/conversations/${encodeURIComponent(id)}?display_as=plaintext`,
      );
      const replies = deriveReplyPairs(detail)
        .filter((pair) => (from === 0 || pair.at >= from) && (to === 0 || pair.at <= to))
        .map((pair) => ({ ...pair, conversationId: id }));
      if (replies.length === 0) {
        return null;
      }
      return {
        conversationId: id,
        replies,
        transcript: deriveConversationTranscript(detail),
      };
    } catch {
      return null; // One bad conversation must not sink the harvest.
    }
  });
  const harvest: IntercomHarvest = {
    replies: [],
    transcripts: [],
    scannedConversations: conversations.length,
    analyzedConversations: 0,
    limitReached: conversations.length >= maxConversations && hasMore,
  };
  for (const entry of nested) {
    if (!entry) {
      continue;
    }
    harvest.analyzedConversations += 1;
    harvest.replies.push(...entry.replies);
    if (entry.transcript) {
      harvest.transcripts.push({ conversationId: entry.conversationId, transcript: entry.transcript });
    }
  }
  return harvest;
}

export type IntercomAdminLite = { id: string; name: string; email: string };

/** Workspace teammates (id/name/email) — links Intercom admins to Gera members. */
export async function listIntercomAdmins(token: string): Promise<IntercomAdminLite[]> {
  const { region } = await ensureContext(token);
  const directory = await workspaceDirectory(token, region);
  return [...directory.admins.entries()].map(([id, name]) => ({
    id,
    name,
    email: directory.adminEmails.get(id) ?? "",
  }));
}

// --- Conversation details (desk right panel) ---------------------------------

export type IntercomAttrData = { key: string; value: string };

export type IntercomEventData = { name: string; at: number };

export type IntercomContactProfile = {
  id: string;
  name: string;
  email: string;
  phone: string;
  type: string;
  userId: string;
  owner: string;
  location: string;
  browser: string;
  browserVersion: string;
  os: string;
  language: string;
  signedUpAt: number;
  lastSeenAt: number;
  createdAt: number;
  companies: string[];
  attributes: IntercomAttrData[];
  /** Plan / spend / scalar custom attributes of the attached companies. */
  companyAttrs: IntercomAttrData[];
};

export type IntercomDetailsData = {
  id: string;
  state: string;
  priority: boolean;
  createdAt: number;
  updatedAt: number;
  waitingSince: number;
  snoozedUntil: number;
  channel: string;
  subject: string;
  assignee: string;
  teamInbox: string;
  tags: string[];
  attributes: IntercomAttrData[];
  /** Recent Data-API events — the closest REST signal to "Recent page views". */
  events: IntercomEventData[];
  /** Deep link into Intercom's inbox (empty when the workspace id is unknown). */
  intercomUrl: string;
  contact: IntercomContactProfile | null;
};

const DIRECTORY_TTL_MS = 10 * 60 * 1000;
const directoryCache = new Map<
  string,
  {
    at: number;
    admins: Map<string, string>;
    teams: Map<string, string>;
    adminEmails: Map<string, string>;
  }
>();

/** Admin + team name lookups, cached ~10 min per token; failures leave honest #id labels. */
async function workspaceDirectory(
  token: string,
  region: IntercomRegion,
): Promise<{
  admins: Map<string, string>;
  teams: Map<string, string>;
  adminEmails: Map<string, string>;
}> {
  const key = cacheScope(token);
  const cached = directoryCache.get(key);
  if (cached && Date.now() - cached.at < DIRECTORY_TTL_MS) {
    return cached;
  }
  const admins = new Map<string, string>();
  const teams = new Map<string, string>();
  const adminEmails = new Map<string, string>();
  try {
    const data = await relay(token, region, "GET", "/admins");
    for (const admin of asRecordArray(data.admins)) {
      admins.set(idStr(admin.id), str(admin.name) || str(admin.email));
      adminEmails.set(idStr(admin.id), str(admin.email));
    }
  } catch {
    // Panel falls back to "Admin #id" labels.
  }
  try {
    const data = await relay(token, region, "GET", "/teams");
    for (const team of asRecordArray(data.teams)) {
      teams.set(idStr(team.id), str(team.name));
    }
  } catch {
    // Same fallback for teams.
  }
  const entry = { at: Date.now(), admins, teams, adminEmails };
  directoryCache.set(key, entry);
  capCache(directoryCache, 40);
  return entry;
}

/** Scalar custom attributes as displayable rows; objects and empties are skipped. */
export function scalarAttrs(value: unknown): IntercomAttrData[] {
  const out: IntercomAttrData[] = [];
  for (const [key, raw] of Object.entries(asRecord(value))) {
    if (raw === null || raw === undefined || typeof raw === "object") {
      continue;
    }
    const text = typeof raw === "boolean" ? (raw ? "true" : "false") : String(raw).trim();
    if (!text) {
      continue;
    }
    out.push({ key: key.replace(/_/g, " "), value: text.slice(0, 300) });
  }
  return out.slice(0, 60);
}

function channelLabel(source: Record<string, unknown>): string {
  const type = str(source.type);
  if (type === "email") {
    return "Email";
  }
  if (type === "phone_switch") {
    return "Phone";
  }
  if (["facebook", "instagram", "twitter", "whatsapp"].includes(type)) {
    return type.charAt(0).toUpperCase() + type.slice(1);
  }
  const delivered = str(source.delivered_as);
  if (delivered === "admin_initiated") {
    return "Outbound chat";
  }
  if (delivered === "automated") {
    return "Automated chat";
  }
  return "Chat";
}

/** Pure: conversation-level details (assignee, team, tags, channel) minus the contact. */
export function deriveConversationMeta(
  conv: Record<string, unknown>,
  admins: Map<string, string>,
  teams: Map<string, string>,
): Omit<IntercomDetailsData, "contact" | "events" | "intercomUrl"> {
  const source = asRecord(conv.source);
  const adminId = idStr(conv.admin_assignee_id);
  const teamId = idStr(conv.team_assignee_id);
  return {
    id: idStr(conv.id),
    state: str(conv.state) || "open",
    priority: str(conv.priority) === "priority",
    createdAt: toMs(conv.created_at),
    updatedAt: toMs(conv.updated_at) || toMs(conv.created_at),
    waitingSince: toMs(conv.waiting_since),
    snoozedUntil: toMs(conv.snoozed_until),
    channel: channelLabel(source),
    subject: stripHtml(str(source.subject)),
    assignee: adminId ? admins.get(adminId) ?? `Admin #${adminId}` : "",
    teamInbox: teamId ? teams.get(teamId) ?? `Team #${teamId}` : "",
    tags: asRecordArray(asRecord(conv.tags).tags)
      .map((tag) => str(tag.name))
      .filter(Boolean)
      .slice(0, 20),
    attributes: scalarAttrs(conv.custom_attributes),
  };
}

/** Pure: the contact profile rows (standard fields + all scalar custom attributes). */
export function deriveContactProfile(
  raw: Record<string, unknown>,
  companies: string[],
  admins: Map<string, string>,
): IntercomContactProfile {
  const location = asRecord(raw.location);
  const ownerId = idStr(raw.owner_id);
  const city = str(location.city);
  const regionName = str(location.region);
  const country = str(location.country);
  return {
    id: idStr(raw.id),
    name: str(raw.name),
    email: str(raw.email),
    phone: str(raw.phone),
    type: str(raw.role) || "user",
    userId: str(raw.external_id),
    owner: ownerId ? admins.get(ownerId) ?? `Admin #${ownerId}` : "",
    location: [city || regionName, country].filter(Boolean).join(" · "),
    browser: str(raw.browser),
    browserVersion: str(raw.browser_version),
    os: str(raw.os),
    language: str(raw.browser_language),
    signedUpAt: toMs(raw.signed_up_at),
    lastSeenAt: toMs(raw.last_seen_at),
    createdAt: toMs(raw.created_at),
    companies,
    attributes: scalarAttrs(raw.custom_attributes),
    companyAttrs: [],
  };
}

/** Pure: Data Events API payload → display rows (newest first, cap 12). */
export function deriveEventRows(data: Record<string, unknown>): IntercomEventData[] {
  const out: IntercomEventData[] = [];
  for (const event of asRecordArray(data.events)) {
    const name = str(event.event_name).replace(/[-_]+/g, " ").trim();
    if (!name) {
      continue;
    }
    out.push({ name, at: toMs(event.created_at) });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 12);
}

/** Pure: attached companies → display names + billing-relevant attribute rows. */
export function deriveCompanyRows(
  companies: Array<Record<string, unknown>>,
): { names: string[]; rows: IntercomAttrData[] } {
  const names: string[] = [];
  const rows: IntercomAttrData[] = [];
  for (const company of companies.slice(0, 3)) {
    const name = str(company.name);
    if (name) {
      names.push(name);
    }
    const plan = str(asRecord(company.plan).name);
    if (plan) {
      rows.push({ key: name ? `${name} plan` : "Company plan", value: plan });
    }
    const spend = company.monthly_spend;
    if (typeof spend === "number" && Number.isFinite(spend) && spend !== 0) {
      rows.push({ key: name ? `${name} monthly spend` : "Monthly spend", value: String(spend) });
    }
    rows.push(...scalarAttrs(company.custom_attributes));
  }
  return { names: names.slice(0, 8), rows: rows.slice(0, 40) };
}

/**
 * Everything the desk's right panel shows for one conversation, straight from
 * Intercom: assignee/team, tags, the full contact profile, attached-company
 * billing attributes, and recent Data-API events. Recent page views and the
 * Stripe payments widget are inbox-only apps NOT exposed by Intercom's REST
 * API — the payload carries an `intercomUrl` deep link so humans can open the
 * real thing, and subscription facts come from contact/company attributes.
 */
export async function fetchIntercomConversationDetails(
  token: string,
  conversationId: string,
): Promise<IntercomDetailsData> {
  const id = conversationId.trim();
  if (!id) {
    throw new Error("Missing conversation id.");
  }
  const { admin, region } = await ensureContext(token);
  const conv = await relay(token, region, "GET", `/conversations/${encodeURIComponent(id)}?display_as=plaintext`);
  const directory = await workspaceDirectory(token, region);
  const contactId = idStr(asRecordArray(asRecord(conv.contacts).contacts)[0]?.id);
  let contactRaw: Record<string, unknown> | null = null;
  if (contactId) {
    try {
      contactRaw = await relay(token, region, "GET", `/contacts/${encodeURIComponent(contactId)}`);
    } catch {
      contactRaw = null; // A missing contact must not sink the whole panel.
    }
  }
  let companies: { names: string[]; rows: IntercomAttrData[] } = { names: [], rows: [] };
  if (contactRaw) {
    const listed = asRecord(contactRaw.companies);
    const count = typeof listed.total_count === "number" ? listed.total_count : 0;
    if (count > 0) {
      try {
        const data = await relay(token, region, "GET", `/contacts/${encodeURIComponent(contactId)}/companies`);
        companies = deriveCompanyRows(asRecordArray(data.data));
      } catch {
        companies = { names: [], rows: [] };
      }
    }
  }
  let events: IntercomEventData[] = [];
  if (contactId) {
    try {
      const data = await relay(
        token,
        region,
        "GET",
        `/events?type=user&intercom_user_id=${encodeURIComponent(contactId)}&per_page=20`,
      );
      events = deriveEventRows(data);
    } catch {
      events = []; // Leads and event-less workspaces honestly have none.
    }
  }
  const meta = deriveConversationMeta(conv, directory.admins, directory.teams);
  const contact = contactRaw ? deriveContactProfile(contactRaw, companies.names, directory.admins) : null;
  if (contact) {
    contact.companyAttrs = companies.rows;
  }
  return {
    ...meta,
    id: meta.id || id,
    events,
    intercomUrl: admin.appIdCode
      ? `https://app.intercom.com/a/inbox/${encodeURIComponent(admin.appIdCode)}/inbox/conversation/${encodeURIComponent(meta.id || id)}`
      : "",
    contact,
  };
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
