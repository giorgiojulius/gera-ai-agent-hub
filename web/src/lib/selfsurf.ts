// SelfSurf — client side of Gera's autonomous browser. The Worker performs
// the actual HTTP navigation (browsers can't fetch arbitrary sites — CORS);
// this module owns the per-turn session: cookie jar, page history, L/F
// numbering, and the digests the model reads.
//
// Honest scope, repeated in every tool description: HTTP-level browsing —
// links, cookies, redirects, real GET/POST form submissions. No JavaScript
// execution, no CAPTCHA solving, no file uploads.

import { authedFetch } from "@/lib/backend";
import { logDiagnostic } from "@/lib/diagnostics";
import type { SourceLedger } from "@/lib/tools";
import type { OpenAiTool } from "@/lib/types";

type SurfJar = Record<string, Record<string, string>>;

type SurfLink = { text: string; href: string };

type SurfField = {
  name: string;
  type: string;
  value?: string;
  options?: string[];
  required?: boolean;
  placeholder?: string;
};

type SurfForm = {
  action: string;
  method: "GET" | "POST";
  enctype?: string;
  fields: SurfField[];
  submitLabel?: string;
};

export type SurfPagePayload = {
  ok: boolean;
  status: number;
  url: string;
  title: string;
  contentType: string;
  text: string;
  links: SurfLink[];
  forms: SurfForm[];
  jsHeavy: boolean;
  note?: string;
};

type SurfSnapshot = {
  url: string;
  title: string;
  status: number;
  /** Full extracted text (≤60k) — surf_find searches this, digests show less. */
  fullText: string;
  links: SurfLink[];
  forms: SurfForm[];
  digest: string;
};

/** One agent turn's browsing session: cookie jar + visited pages (current = last). */
export type SurfSession = {
  jar: SurfJar;
  pages: SurfSnapshot[];
};

export function createSurfSession(): SurfSession {
  return { jar: {}, pages: [] };
}

export const SURF_TOOL_NAMES: ReadonlySet<string> = new Set([
  "surf_open",
  "surf_follow",
  "surf_submit",
  "surf_back",
  "surf_find",
]);

export const SURF_TOOLS: OpenAiTool[] = [
  {
    type: "function",
    function: {
      name: "surf_open",
      description:
        "SelfSurf, your autonomous browser: open a page. Keeps cookies/session for the whole turn, follows redirects, returns readable text plus numbered links (L1…) and forms (F1…). Use for navigating sites, on-site search, filters, pagination, simple logins. No JavaScript execution — SPA-only pages may show little text.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Page URL (https assumed if scheme missing)" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "surf_follow",
      description:
        'SelfSurf: follow a link from the current page — pass the L-number like "L3", an absolute URL, or a snippet of the link text. Session cookies carry over.',
      parameters: {
        type: "object",
        properties: {
          link: { type: "string", description: 'Link reference: "L3", a URL, or link text' },
        },
        required: ["link"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "surf_submit",
      description:
        'SelfSurf: fill and submit a form from the current page. Pass the F-number and ONLY the fields you want to set: {"form":"F1","fields":{"q":"rtx 5090 price"}}. Hidden fields (CSRF tokens, state) carry over automatically. Works for search boxes, filters, plain logins, newsletter forms. Cannot: file uploads (multipart), CAPTCHAs, JavaScript-only forms.',
      parameters: {
        type: "object",
        properties: {
          form: { type: "string", description: 'Form reference like "F1"' },
          fields: { type: "object", description: "Field name → value to fill in" },
        },
        required: ["form", "fields"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "surf_back",
      description: "SelfSurf: go back one page in this session (served from the session cache, no refetch).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "surf_find",
      description:
        "SelfSurf: search the current page's FULL text (digests are truncated) and get snippets around each match. Use after opening a long page.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to find on the current page" },
        },
        required: ["query"],
      },
    },
  },
];

const MAX_SESSION_PAGES = 30;
const DIGEST_TEXT_CHARS = 5_000;
const DIGEST_LINKS = 30;

/** Executes one SelfSurf tool call against the per-turn session. */
export async function executeSurfTool(
  name: string,
  args: Record<string, unknown>,
  session: SurfSession,
  ledger?: SourceLedger,
): Promise<string> {
  const current = session.pages[session.pages.length - 1];

  if (name === "surf_back") {
    if (session.pages.length < 2) {
      return "History is empty — there is no earlier page in this session.";
    }
    session.pages.pop();
    const previous = session.pages[session.pages.length - 1];
    return `(back — served from session cache; surf_open the URL to refresh)\n\n${previous.digest}`;
  }

  if (name === "surf_find") {
    if (!current) {
      return "No page is open yet — call surf_open first.";
    }
    const query = String(args.query ?? "").trim();
    if (!query) {
      return "Missing query.";
    }
    return findInPage(current, query);
  }

  if (name === "surf_open") {
    let url = String(args.url ?? "").trim();
    if (!url) {
      return "Missing url.";
    }
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }
    return navigate(session, ledger, { action: "open", url, referer: current?.url });
  }

  if (name === "surf_follow") {
    if (!current) {
      return "No page is open yet — call surf_open first.";
    }
    const target = resolveFollow(current, args.link);
    if (!target) {
      return `Could not resolve link "${String(args.link ?? "")}" — use an L-number from the current page, an absolute URL, or exact link text.`;
    }
    return navigate(session, ledger, { action: "open", url: target, referer: current.url });
  }

  if (name === "surf_submit") {
    if (!current) {
      return "No page is open yet — call surf_open first.";
    }
    const formRef = String(args.form ?? "").trim();
    const match = /^f?(\d+)$/i.exec(formRef);
    const form = match ? current.forms[Number(match[1]) - 1] : undefined;
    if (!form) {
      return current.forms.length === 0
        ? "The current page has no forms SelfSurf can submit."
        : `Form "${formRef}" not found — the current page lists F1…F${current.forms.length}.`;
    }
    if (form.enctype?.includes("multipart")) {
      return "That form uploads files (multipart) — SelfSurf cannot submit it. Tell the user this honestly.";
    }
    const provided =
      args.fields && typeof args.fields === "object" && !Array.isArray(args.fields)
        ? (args.fields as Record<string, unknown>)
        : {};
    const merged = mergeFields(form, provided);
    return navigate(session, ledger, {
      action: "submit",
      url: form.action,
      method: form.method,
      fields: merged,
      referer: current.url,
    });
  }

  return `Unknown SelfSurf tool: ${name}`;
}

type SurfCommand = {
  action: "open" | "submit";
  url: string;
  method?: "GET" | "POST";
  fields?: Record<string, string>;
  referer?: string;
};

type SurfRequestResult = { kind: "page"; page: SurfPagePayload } | { kind: "refused"; message: string };

/** POSTs one navigation command to the Worker engine and syncs the session cookie jar. */
async function requestSurf(
  session: SurfSession,
  command: SurfCommand,
  signal: AbortSignal,
): Promise<SurfRequestResult> {
  let response: Response;
  try {
    response = await authedFetch("/surf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...command, jar: session.jar }),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return { kind: "refused", message: "SelfSurf timed out waiting for the site." };
    }
    throw error;
  }
  if (response.status === 401) {
    return { kind: "refused", message: "SelfSurf needs a signed-in session — the user must sign in again." };
  }
  if (response.status === 403) {
    return { kind: "refused", message: "SelfSurf is for invited members only." };
  }
  if (!response.ok) {
    // Real backend failures belong in the error journal; 401/403 are user state.
    logDiagnostic("api", `SelfSurf backend error · HTTP ${response.status}`, `${command.action} ${command.url}`.slice(0, 300));
    return { kind: "refused", message: `SelfSurf backend error (${response.status}).` };
  }
  const data = (await response.json()) as { page?: SurfPagePayload; jar?: SurfJar };
  if (!data.page) {
    return { kind: "refused", message: "SelfSurf backend returned no page." };
  }
  if (data.jar && typeof data.jar === "object") {
    session.jar = data.jar;
  }
  return { kind: "page", page: data.page };
}

/** Outcome of a programmatic (non-tool) SelfSurf page fetch. */
export type SurfFetchOutcome = { ok: true; page: SurfPagePayload } | { ok: false; error: string };

/**
 * Programmatic SelfSurf fetch for research flows: same Worker engine and cookie
 * jar as the surf_* tools, but returns the raw page instead of an L/F digest and
 * leaves the tool session's page history untouched. Same honest limits apply:
 * HTTP-level browsing only — no JavaScript execution.
 */
export async function surfFetchPage(
  session: SurfSession,
  url: string,
  options?: { referer?: string; signal?: AbortSignal },
): Promise<SurfFetchOutcome> {
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const controller = new AbortController();
  const timer = window.setTimeout(
    () => controller.abort(new DOMException("SelfSurf timed out.", "TimeoutError")),
    45_000,
  );
  const onUserAbort = () => controller.abort(options?.signal?.reason);
  if (options?.signal?.aborted) {
    onUserAbort();
  } else {
    options?.signal?.addEventListener("abort", onUserAbort, { once: true });
  }
  try {
    const result = await requestSurf(
      session,
      { action: "open", url: target, referer: options?.referer },
      controller.signal,
    );
    if (result.kind === "refused") {
      return { ok: false, error: result.message };
    }
    if (result.page.status === 0) {
      return { ok: false, error: result.page.note ?? "Navigation failed." };
    }
    return { ok: true, page: result.page };
  } catch (error) {
    if (options?.signal?.aborted) {
      throw error;
    }
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return { ok: false, error: "The site took too long to respond." };
    }
    return { ok: false, error: "Network error while browsing." };
  } finally {
    window.clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onUserAbort);
  }
}

async function navigate(
  session: SurfSession,
  ledger: SourceLedger | undefined,
  command: SurfCommand,
): Promise<string> {
  const result = await requestSurf(session, command, AbortSignal.timeout(60_000));
  if (result.kind === "refused") {
    return result.message;
  }
  const page = result.page;

  if (page.status === 0) {
    return `FAILED: ${page.note ?? "Navigation failed."} (${page.url})`;
  }

  const cite = ledger && page.url.startsWith("http") ? ledger.assign(page.url, page.title || page.url) : null;
  const digest = buildDigest(page, cite);
  session.pages.push({
    url: page.url,
    title: page.title,
    status: page.status,
    fullText: page.text,
    links: page.links,
    forms: page.forms,
    digest,
  });
  if (session.pages.length > MAX_SESSION_PAGES) {
    session.pages.shift();
  }
  return digest;
}

function describeField(field: SurfField): string {
  if (field.type === "hidden") {
    return `${field.name} (hidden, kept automatically)`;
  }
  const bits: string[] = [field.type];
  if (field.required) {
    bits.push("required");
  }
  if (field.placeholder) {
    bits.push(`placeholder "${field.placeholder}"`);
  }
  if (field.options && field.options.length > 0) {
    bits.push(`options: ${field.options.slice(0, 12).join(" | ")}`);
  }
  return `${field.name} (${bits.join(", ")})`;
}

function buildDigest(page: SurfPagePayload, cite: number | null): string {
  const lines: string[] = [];
  const marker = cite !== null ? `[${cite}] ` : "";
  lines.push(`${marker}HTTP ${page.status}${page.title ? ` · ${page.title}` : ""}`);
  lines.push(`URL: ${page.url}`);
  if (page.note) {
    lines.push(`NOTE: ${page.note}`);
  }
  if (page.text.length > 0) {
    const truncated = page.text.length > DIGEST_TEXT_CHARS;
    lines.push(
      "",
      truncated ? `PAGE TEXT (first ${DIGEST_TEXT_CHARS} of ${page.text.length} chars):` : "PAGE TEXT:",
    );
    lines.push(page.text.slice(0, DIGEST_TEXT_CHARS));
    if (truncated) {
      lines.push("… [truncated — surf_find searches the full text]");
    }
  } else {
    lines.push("", "(no readable text on this page)");
  }
  if (page.links.length > 0) {
    lines.push("", 'LINKS (follow with surf_follow "L<n>"):');
    page.links.slice(0, DIGEST_LINKS).forEach((link, index) => {
      lines.push(`L${index + 1}. ${link.text || "(no text)"} — ${link.href}`);
    });
    if (page.links.length > DIGEST_LINKS) {
      lines.push(`… ${page.links.length - DIGEST_LINKS} more links not shown`);
    }
  }
  if (page.forms.length > 0) {
    lines.push("", 'FORMS (submit with surf_submit "F<n>" + fields):');
    page.forms.forEach((form, index) => {
      const label = form.submitLabel ? ` — submit "${form.submitLabel}"` : "";
      lines.push(`F${index + 1}. ${form.method} ${form.action}${label}`);
      if (form.fields.length > 0) {
        lines.push(`    fields: ${form.fields.map(describeField).join("; ")}`);
      }
      if (form.enctype?.includes("multipart")) {
        lines.push("    (multipart/file-upload form — SelfSurf cannot submit this one)");
      }
    });
  }
  return lines.join("\n");
}

function resolveFollow(page: SurfSnapshot, ref: unknown): string | null {
  const raw = String(ref ?? "").trim();
  if (!raw) {
    return null;
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  const numeric = /^l?(\d+)$/i.exec(raw);
  if (numeric) {
    const index = Number(numeric[1]) - 1;
    return page.links[index]?.href ?? null;
  }
  const lower = raw.toLowerCase();
  const byText = page.links.find((link) => link.text.toLowerCase().includes(lower));
  return byText?.href ?? null;
}

/** Model values overlay parsed defaults; hidden fields always carry over. */
function mergeFields(form: SurfForm, provided: Record<string, unknown>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const field of form.fields) {
    if (field.type === "hidden" && field.value !== undefined) {
      merged[field.name] = field.value;
    } else if (
      field.value !== undefined &&
      field.value.length > 0 &&
      field.type !== "checkbox" &&
      field.type !== "radio"
    ) {
      merged[field.name] = field.value;
    }
  }
  for (const [key, value] of Object.entries(provided)) {
    if (key.length > 0 && value !== null && value !== undefined) {
      merged[key] = String(value);
    }
  }
  return merged;
}

function findInPage(page: SurfSnapshot, query: string): string {
  const haystack = page.fullText;
  const needle = query.toLowerCase();
  const lower = haystack.toLowerCase();
  const snippets: string[] = [];
  let from = 0;
  while (snippets.length < 5) {
    const at = lower.indexOf(needle, from);
    if (at === -1) {
      break;
    }
    const start = Math.max(0, at - 260);
    const end = Math.min(haystack.length, at + needle.length + 260);
    snippets.push(`…${haystack.slice(start, end).replace(/\s+/g, " ").trim()}…`);
    from = at + needle.length;
  }
  if (snippets.length === 0) {
    return `"${query}" was not found in the current page's text (${haystack.length} chars searched).`;
  }
  return `Found ${snippets.length} match(es) for "${query}" on ${page.url}:\n\n${snippets.join("\n\n---\n\n")}`;
}
