// SelfSurf — Gera's autonomous text browser engine. Runs inside the Worker
// because browsers cannot fetch arbitrary sites (CORS). One call = one HTTP
// navigation: follow redirects manually, carry a cookie jar, parse the HTML
// with HTMLRewriter into readable text + numbered links + submittable forms.
//
// Honest scope, stated everywhere: this is an HTTP-level browser. It follows
// links, keeps session cookies, and submits real GET/POST urlencoded forms.
// It does NOT execute JavaScript (SPA pages may look empty), cannot solve
// CAPTCHAs, and does not upload files (multipart is refused).
//
// Cookies live in the caller's per-session jar (passed in, updated, passed
// back) — the Worker stores nothing and never logs cookie or field values.

/** domain → cookie name → value. Path/Secure attributes are intentionally ignored. */
export type SurfJar = Record<string, Record<string, string>>;

export type SurfLink = { text: string; href: string };

export type SurfField = {
  name: string;
  type: string;
  value?: string;
  options?: string[];
  required?: boolean;
  placeholder?: string;
};

export type SurfForm = {
  action: string;
  method: "GET" | "POST";
  enctype?: string;
  fields: SurfField[];
  submitLabel?: string;
};

export type SurfPage = {
  ok: boolean;
  status: number;
  url: string;
  title: string;
  contentType: string;
  text: string;
  links: SurfLink[];
  forms: SurfForm[];
  /** Heuristic: almost no text but many scripts — content likely needs JS. */
  jsHeavy: boolean;
  note?: string;
};

export type SurfCommand = {
  action: "open" | "submit";
  url: string;
  method?: "GET" | "POST";
  fields?: Record<string, string>;
  referer?: string;
};

// ---------------------------------------------------------------------------
// HTMLRewriter minimal structural types (workerd global; no types package here)

type RewriterElement = {
  tagName: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  onEndTag(handler: () => void): void;
};

type RewriterTextChunk = { text: string; lastInTextNode: boolean };

type RewriterHandlers = {
  element?(element: RewriterElement): void;
  text?(chunk: RewriterTextChunk): void;
};

declare class HTMLRewriter {
  on(selector: string, handlers: RewriterHandlers): HTMLRewriter;
  transform(response: Response): Response;
}

// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 6;
const HOP_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 1_400_000;
const MAX_TEXT_CHARS = 60_000;
const MAX_LINKS = 60;
const MAX_FORMS = 12;
const MAX_FIELDS_PER_FORM = 30;
const MAX_COOKIE_DOMAINS = 30;
const MAX_COOKIES_PER_DOMAIN = 30;
const MAX_COOKIE_VALUE = 4_096;

const BROWSER_HEADERS: Record<string, string> = {
  // Honest UA: browser-compatible prefix so sites serve normal HTML, plus an
  // identifiable agent token.
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 GeraSelfSurf/1.0",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en,ru;q=0.9",
};

/** Private/loopback targets are refused on every hop, not just the first. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host === "0.0.0.0" || host === "::1" || host === "[::1]" || host.startsWith("[fd") || host.startsWith("[fe80")) {
    return true;
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return true;
  }
  return false;
}

function failPage(url: string, note: string, status = 0): SurfPage {
  return {
    ok: false,
    status,
    url,
    title: "",
    contentType: "",
    text: "",
    links: [],
    forms: [],
    jsHeavy: false,
    note,
  };
}

// --------------------------- cookie jar ------------------------------------

function storeSetCookie(jar: SurfJar, requestHost: string, header: string): void {
  const [pair, ...attrs] = header.split(";");
  const eq = pair.indexOf("=");
  if (eq <= 0) {
    return;
  }
  const name = pair.slice(0, eq).trim();
  const value = pair
    .slice(eq + 1)
    .trim()
    .replace(/[\r\n]/g, "");
  if (!name || value.length > MAX_COOKIE_VALUE) {
    return;
  }
  let domain = requestHost;
  let expired = value.length === 0;
  for (const attr of attrs) {
    const split = attr.indexOf("=");
    const key = (split === -1 ? attr : attr.slice(0, split)).trim().toLowerCase();
    const raw = split === -1 ? "" : attr.slice(split + 1).trim();
    if (key === "domain" && raw) {
      const candidate = raw.toLowerCase().replace(/^\./, "");
      // A site may only set cookies for its own registrable scope.
      if (requestHost === candidate || requestHost.endsWith(`.${candidate}`)) {
        domain = candidate;
      }
    } else if (key === "max-age" && raw && Number(raw) <= 0) {
      expired = true;
    } else if (key === "expires" && raw) {
      const time = Date.parse(raw);
      if (!Number.isNaN(time) && time < Date.now()) {
        expired = true;
      }
    }
  }
  if (expired) {
    if (jar[domain]) {
      delete jar[domain][name];
    }
    return;
  }
  if (!jar[domain]) {
    if (Object.keys(jar).length >= MAX_COOKIE_DOMAINS) {
      return;
    }
    jar[domain] = {};
  }
  if (!(name in jar[domain]) && Object.keys(jar[domain]).length >= MAX_COOKIES_PER_DOMAIN) {
    return;
  }
  jar[domain][name] = value;
}

function cookieHeaderFor(jar: SurfJar, host: string): string {
  const parts: string[] = [];
  for (const [domain, cookies] of Object.entries(jar)) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      for (const [name, value] of Object.entries(cookies)) {
        parts.push(`${name}=${value}`);
      }
    }
  }
  return parts.join("; ");
}

function collectSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
}

// --------------------------- fetch with redirects ---------------------------

async function readCapped(response: Response): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) {
    return { text: "", truncated: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
      chunks.push(value);
      if (total >= MAX_BODY_BYTES) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  }
  const merged = new Uint8Array(Math.min(total, MAX_BODY_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, Math.min(chunk.byteLength, merged.byteLength - offset));
    merged.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= merged.byteLength) {
      break;
    }
  }
  return { text: new TextDecoder("utf-8").decode(merged), truncated };
}

/**
 * Performs one navigation: manual redirect loop with per-hop SSRF checks and
 * cookie capture. Mutates `jar` in place; the caller sends the updated jar
 * back to the client so the session continues across tool calls.
 */
export async function performSurf(command: SurfCommand, jar: SurfJar): Promise<SurfPage> {
  let target: URL;
  try {
    target = new URL(command.url);
  } catch {
    return failPage(command.url, "Invalid URL.");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return failPage(command.url, "Only http/https URLs can be opened.");
  }

  let method: "GET" | "POST" = command.action === "submit" && command.method === "POST" ? "POST" : "GET";
  let body: string | undefined;
  const fields = command.fields ?? {};
  if (command.action === "submit") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      params.append(key.slice(0, 200), String(value).slice(0, 4_000));
    }
    if (method === "POST") {
      body = params.toString();
    } else {
      target.search = params.toString();
    }
  }

  let referer = command.referer;
  let response: Response | null = null;
  let notes: string[] = [];

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (target.username || target.password) {
      return failPage(target.toString(), "URLs with embedded credentials are not allowed.");
    }
    if (isPrivateHost(target.hostname)) {
      return failPage(target.toString(), "This host is not reachable from SelfSurf (private/internal address).");
    }
    const headers: Record<string, string> = { ...BROWSER_HEADERS };
    const cookie = cookieHeaderFor(jar, target.hostname.toLowerCase());
    if (cookie) {
      headers.Cookie = cookie;
    }
    if (referer) {
      headers.Referer = referer;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    try {
      response = await fetch(target.toString(), {
        method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "unreachable";
      return failPage(target.toString(), `The site did not respond (${reason}).`);
    }

    for (const setCookie of collectSetCookies(response)) {
      storeSetCookie(jar, target.hostname.toLowerCase(), setCookie);
    }

    const status = response.status;
    if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
      const location = response.headers.get("location");
      if (!location) {
        break;
      }
      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        break;
      }
      // Browsers switch POST→GET on 301/302/303; 307/308 keep method+body.
      if (status !== 307 && status !== 308) {
        method = "GET";
        body = undefined;
      }
      referer = target.toString();
      target = next;
      response.body?.cancel().catch(() => undefined);
      if (hop === MAX_REDIRECTS) {
        return failPage(target.toString(), "Too many redirects.");
      }
      continue;
    }
    break;
  }

  if (!response) {
    return failPage(target.toString(), "No response.");
  }

  const finalUrl = target.toString();
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const charsetMatch = /charset=([a-z0-9_-]+)/.exec(contentType);
  if (charsetMatch && charsetMatch[1] !== "utf-8" && charsetMatch[1] !== "utf8") {
    notes.push(`Page charset is ${charsetMatch[1]}; non-ASCII characters may render imperfectly.`);
  }

  const isHtml = contentType.includes("html") || contentType === "";
  const isTextLike =
    isHtml || contentType.includes("json") || contentType.startsWith("text/") || contentType.includes("xml");
  if (!isTextLike) {
    return {
      ok: response.ok,
      status: response.status,
      url: finalUrl,
      title: "",
      contentType,
      text: "",
      links: [],
      forms: [],
      jsHeavy: false,
      note: `Binary content (${contentType || "unknown type"}) — SelfSurf reads text pages only.`,
    };
  }

  const { text: raw, truncated } = await readCapped(response);
  if (truncated) {
    notes.push("Page was very large — read the first ~1.4 MB only.");
  }

  if (!isHtml) {
    return {
      ok: response.ok,
      status: response.status,
      url: finalUrl,
      title: "",
      contentType,
      text: raw.slice(0, MAX_TEXT_CHARS),
      links: [],
      forms: [],
      jsHeavy: false,
      note: notes.join(" ") || undefined,
    };
  }

  const parsed = await parseHtml(raw, finalUrl);
  const jsHeavy = parsed.text.length < 400 && parsed.scriptCount >= 6;
  if (jsHeavy) {
    notes.push(
      "This page renders its content with JavaScript, which SelfSurf cannot execute — try the site's non-JS pages, a search engine, or fetch_url.",
    );
  }

  return {
    ok: response.ok,
    status: response.status,
    url: finalUrl,
    title: parsed.title,
    contentType,
    text: parsed.text,
    links: parsed.links,
    forms: parsed.forms,
    jsHeavy,
    note: notes.length > 0 ? notes.join(" ") : undefined,
  };
}

// --------------------------- HTML parsing ----------------------------------

type ParsedHtml = {
  title: string;
  text: string;
  links: SurfLink[];
  forms: SurfForm[];
  scriptCount: number;
};

const SKIP_TAGS = ["script", "style", "noscript", "template", "svg", "iframe"];
const BLOCK_TAGS = [
  "p",
  "br",
  "div",
  "li",
  "tr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "ul",
  "ol",
  "table",
  "blockquote",
  "pre",
  "form",
  "hr",
  "td",
];

async function parseHtml(html: string, pageUrl: string): Promise<ParsedHtml> {
  let title = "";
  let base: string | null = null;
  let skipDepth = 0;
  let scriptCount = 0;
  let textLength = 0;
  const textParts: string[] = [];
  const rawLinks: Array<{ href: string; text: string }> = [];
  let currentLink: { href: string; text: string } | null = null;
  const forms: Array<{
    action: string;
    method: "GET" | "POST";
    enctype?: string;
    fields: SurfField[];
    submitLabel: string;
  }> = [];
  let currentForm: (typeof forms)[number] | null = null;
  let currentSelect: SurfField | null = null;
  let currentOptionPending = false;
  let captureSubmitFor: (typeof forms)[number] | null = null;

  const rewriter = new HTMLRewriter();

  rewriter.on("title", {
    text(chunk) {
      if (title.length < 300) {
        title += chunk.text;
      }
    },
  });

  rewriter.on("base", {
    element(el) {
      const href = el.getAttribute("href");
      if (href && !base) {
        base = href;
      }
    },
  });

  for (const tag of SKIP_TAGS) {
    rewriter.on(tag, {
      element(el) {
        if (tag === "script") {
          scriptCount += 1;
        }
        skipDepth += 1;
        try {
          el.onEndTag(() => {
            skipDepth = Math.max(0, skipDepth - 1);
          });
        } catch {
          // self-closing / implicit end — undo the increment
          skipDepth = Math.max(0, skipDepth - 1);
        }
      },
    });
  }

  for (const tag of BLOCK_TAGS) {
    rewriter.on(tag, {
      element() {
        if (textLength < MAX_TEXT_CHARS) {
          textParts.push("\n");
        }
      },
    });
  }

  rewriter.on("body", {
    text(chunk) {
      if (skipDepth === 0 && textLength < MAX_TEXT_CHARS && chunk.text.length > 0) {
        textParts.push(chunk.text);
        textLength += chunk.text.length;
      }
    },
  });

  rewriter.on("a", {
    element(el) {
      const href = el.getAttribute("href");
      currentLink = null;
      if (!href || rawLinks.length >= MAX_LINKS * 2) {
        return;
      }
      const clean = href.trim();
      if (!clean || clean.startsWith("javascript:") || clean.startsWith("#") || clean.startsWith("mailto:")) {
        return;
      }
      const entry = { href: clean, text: "" };
      rawLinks.push(entry);
      currentLink = entry;
      try {
        el.onEndTag(() => {
          currentLink = null;
        });
      } catch {
        currentLink = null;
      }
    },
    text(chunk) {
      if (currentLink && currentLink.text.length < 120) {
        currentLink.text += chunk.text;
      }
    },
  });

  rewriter.on("form", {
    element(el) {
      currentForm = null;
      if (forms.length >= MAX_FORMS) {
        return;
      }
      const method = (el.getAttribute("method") ?? "GET").trim().toUpperCase() === "POST" ? "POST" : "GET";
      const form = {
        action: (el.getAttribute("action") ?? "").trim(),
        method: method as "GET" | "POST",
        enctype: el.getAttribute("enctype")?.trim() || undefined,
        fields: [] as SurfField[],
        submitLabel: "",
      };
      forms.push(form);
      currentForm = form;
      try {
        el.onEndTag(() => {
          currentForm = null;
        });
      } catch {
        currentForm = null;
      }
    },
  });

  rewriter.on("input", {
    element(el) {
      const form = currentForm;
      if (!form || form.fields.length >= MAX_FIELDS_PER_FORM) {
        return;
      }
      const type = (el.getAttribute("type") ?? "text").trim().toLowerCase();
      const name = (el.getAttribute("name") ?? "").trim();
      const value = el.getAttribute("value") ?? undefined;
      if (type === "submit" || type === "image") {
        if (!form.submitLabel && value) {
          form.submitLabel = value.slice(0, 60);
        }
        return;
      }
      if (type === "button" || type === "reset" || !name) {
        return;
      }
      if (type === "radio" || type === "checkbox") {
        const existing = form.fields.find((field) => field.name === name && field.type === type);
        if (existing) {
          if (value && (existing.options?.length ?? 0) < 20) {
            existing.options = [...(existing.options ?? []), value.slice(0, 80)];
          }
          return;
        }
        form.fields.push({
          name,
          type,
          options: value ? [value.slice(0, 80)] : undefined,
          required: el.hasAttribute("required") || undefined,
        });
        return;
      }
      form.fields.push({
        name,
        type,
        value: value !== undefined ? value.slice(0, 500) : undefined,
        required: el.hasAttribute("required") || undefined,
        placeholder: el.getAttribute("placeholder")?.slice(0, 80) || undefined,
      });
    },
  });

  rewriter.on("select", {
    element(el) {
      currentSelect = null;
      const form = currentForm;
      if (!form || form.fields.length >= MAX_FIELDS_PER_FORM) {
        return;
      }
      const name = (el.getAttribute("name") ?? "").trim();
      if (!name) {
        return;
      }
      const field: SurfField = {
        name,
        type: "select",
        options: [],
        required: el.hasAttribute("required") || undefined,
      };
      form.fields.push(field);
      currentSelect = field;
      try {
        el.onEndTag(() => {
          currentSelect = null;
        });
      } catch {
        currentSelect = null;
      }
    },
  });

  rewriter.on("option", {
    element(el) {
      currentOptionPending = false;
      const select = currentSelect;
      if (!select || (select.options?.length ?? 0) >= 20) {
        return;
      }
      const value = el.getAttribute("value");
      if (value !== null && value.trim().length > 0) {
        select.options = [...(select.options ?? []), value.trim().slice(0, 80)];
      } else {
        // value comes from the option's text
        select.options = [...(select.options ?? []), ""];
        currentOptionPending = true;
      }
    },
    text(chunk) {
      const select = currentSelect;
      if (!currentOptionPending || !select || !select.options || select.options.length === 0) {
        return;
      }
      const index = select.options.length - 1;
      if (select.options[index].length < 40) {
        select.options[index] = (select.options[index] + chunk.text).trim().slice(0, 40);
      }
    },
  });

  rewriter.on("textarea", {
    element(el) {
      const form = currentForm;
      if (!form || form.fields.length >= MAX_FIELDS_PER_FORM) {
        return;
      }
      const name = (el.getAttribute("name") ?? "").trim();
      if (!name) {
        return;
      }
      form.fields.push({
        name,
        type: "textarea",
        required: el.hasAttribute("required") || undefined,
        placeholder: el.getAttribute("placeholder")?.slice(0, 80) || undefined,
      });
    },
  });

  rewriter.on("button", {
    element(el) {
      const form = currentForm;
      captureSubmitFor = null;
      if (!form) {
        return;
      }
      const type = (el.getAttribute("type") ?? "submit").trim().toLowerCase();
      if (type !== "submit" || form.submitLabel) {
        return;
      }
      captureSubmitFor = form;
      try {
        el.onEndTag(() => {
          captureSubmitFor = null;
        });
      } catch {
        captureSubmitFor = null;
      }
    },
    text(chunk) {
      if (captureSubmitFor && captureSubmitFor.submitLabel.length < 60) {
        captureSubmitFor.submitLabel = (captureSubmitFor.submitLabel + chunk.text).trim().slice(0, 60);
      }
    },
  });

  // Drain the transformed stream so every handler runs.
  await rewriter.transform(new Response(html)).arrayBuffer();

  let baseUrl = pageUrl;
  if (base) {
    try {
      baseUrl = new URL(base, pageUrl).toString();
    } catch {
      baseUrl = pageUrl;
    }
  }

  const seen = new Set<string>();
  const links: SurfLink[] = [];
  for (const raw of rawLinks) {
    if (links.length >= MAX_LINKS) {
      break;
    }
    let resolved: URL;
    try {
      resolved = new URL(raw.href, baseUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      continue;
    }
    const url = resolved.toString();
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    links.push({ text: raw.text.replace(/\s+/g, " ").trim().slice(0, 100), href: url });
  }

  const resolvedForms: SurfForm[] = [];
  for (const form of forms) {
    let action: string;
    try {
      action = new URL(form.action || baseUrl, baseUrl).toString();
    } catch {
      continue;
    }
    if (!action.startsWith("http")) {
      continue;
    }
    resolvedForms.push({
      action,
      method: form.method,
      enctype: form.enctype,
      fields: form.fields,
      submitLabel: form.submitLabel || undefined,
    });
  }

  let text = textParts
    .join("")
    .replace(/[ \t\r]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length === 0 && html.length > 0) {
    // Fragment/malformed HTML without <body> — strip tags as a fallback.
    text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TEXT_CHARS);
  }

  return {
    title: title.replace(/\s+/g, " ").trim().slice(0, 200),
    text: text.slice(0, MAX_TEXT_CHARS),
    links,
    forms: resolvedForms,
    scriptCount,
  };
}

// --------------------------- shared helpers --------------------------------

/** Resolves a follow target: "L3" / 3 / absolute URL / link-text match. */
export function resolveFollowTarget(page: SurfPage, ref: unknown): string | null {
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

/**
 * Merges the model's field values over the form's parsed defaults. Hidden
 * fields (CSRF tokens, state) always carry over — that is what makes real
 * form submissions work.
 */
export function mergeFormFields(form: SurfForm, provided: Record<string, unknown>): Record<string, string> {
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
    if (typeof key === "string" && key.length > 0 && value !== null && value !== undefined) {
      merged[key] = String(value);
    }
  }
  return merged;
}

function describeField(field: SurfField): string {
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
  if (field.type === "hidden") {
    return `${field.name} (hidden, kept automatically)`;
  }
  return `${field.name} (${bits.join(", ")})`;
}

/**
 * Formats a surfed page into the tool-result digest the model reads:
 * status line, readable text, numbered links (L1…) and forms (F1…).
 */
export function formatSurfPage(
  page: SurfPage,
  cite: number | null,
  limits: { text?: number; links?: number } = {},
): string {
  const textLimit = limits.text ?? 4_500;
  const linkLimit = limits.links ?? 25;
  const lines: string[] = [];
  const marker = cite !== null ? `[${cite}] ` : "";
  if (!page.ok && page.status === 0) {
    return `${marker}FAILED: ${page.note ?? "Navigation failed."} (${page.url})`;
  }
  lines.push(`${marker}HTTP ${page.status}${page.title ? ` · ${page.title}` : ""}`);
  lines.push(`URL: ${page.url}`);
  if (page.note) {
    lines.push(`NOTE: ${page.note}`);
  }
  if (page.text.length > 0) {
    const truncated = page.text.length > textLimit;
    lines.push("", truncated ? `PAGE TEXT (first ${textLimit} of ${page.text.length} chars):` : "PAGE TEXT:");
    lines.push(page.text.slice(0, textLimit));
    if (truncated) {
      lines.push("… [truncated — surf_find searches the full text]");
    }
  } else {
    lines.push("", "(no readable text on this page)");
  }
  if (page.links.length > 0) {
    lines.push("", `LINKS (follow with surf_follow "L<n>"):`);
    page.links.slice(0, linkLimit).forEach((link, index) => {
      lines.push(`L${index + 1}. ${link.text || "(no text)"} — ${link.href}`);
    });
    if (page.links.length > linkLimit) {
      lines.push(`… ${page.links.length - linkLimit} more links not shown`);
    }
  }
  if (page.forms.length > 0) {
    lines.push("", `FORMS (submit with surf_submit "F<n>" + fields):`);
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
