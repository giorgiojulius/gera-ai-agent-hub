// Server-side tool layer for interactive agent runs — the full builtin set
// the browser loop had: web_search, fetch_url, the five SelfSurf browser
// tools (open / follow / submit / back / find), and media generation
// (images, video, speech). MCP and native-connector calls dispatch through
// the same armed runtime the cloud automations use.
//
// Server-side toolkit calls MUST send `Authorization: Bearer <key>`.

import { capText, TOOLKIT_URL, type EngineToolDef, type EngineToolOutcome } from "./agent-engine";
import { callCloudMcpTool } from "./mcp-cloud";
import { callNativeConnectorTool, type McpRoute, type McpToolset } from "./mcp-toolset";
import {
  formatSurfPage,
  mergeFormFields,
  performSurf,
  resolveFollowTarget,
  type SurfJar,
  type SurfPage,
} from "./selfsurf";
import type { BuiltinToolId, RunSource } from "./run-protocol";

// Media model constants — mirror web/src/lib/models.ts.
const DEFAULT_IMAGE_MODEL = "openai/gpt-image-2";
const IMAGE_FALLBACKS = ["bytedance/seedream-5.0-lite", "spacexai/grok-imagine-image-2.0"];
const DEFAULT_VIDEO_MODEL = "bytedance/seedance-2.5";
const VIDEO_FALLBACKS = ["alibaba/wan-v2.7-t2v", "google/veo-3.1-fast-generate-001"];
const DEFAULT_AUDIO_MODEL = "spacexai/grok-tts";
const MAX_IMAGE_COUNT = 4;

const DIGEST_TEXT_CHARS = 5_000;
const DIGEST_LINKS = 30;

function clampImageCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(Math.max(Math.round(value), 1), MAX_IMAGE_COUNT);
}

function voicesForModel(modelId: string): string[] {
  if (modelId.startsWith("spacexai/") || modelId.startsWith("xai/")) {
    return ["eve", "ara", "rex", "sal", "leo"];
  }
  if (modelId.startsWith("openai/")) {
    return ["alloy", "nova", "shimmer", "onyx", "echo", "fable"];
  }
  return [];
}

/** Veo accepts only 4/6/8-second runs (probed); everything else here takes 5. */
function videoDurationForModel(modelId: string): number {
  return modelId.startsWith("google/veo") ? 6 : 5;
}

/** Assigns stable citation numbers to sources as tools touch them. */
export type SourceLedger = {
  assign(url: string, title?: string): number;
  list(): RunSource[];
};

export function createSourceLedger(): SourceLedger {
  const order: RunSource[] = [];
  const byUrl = new Map<string, number>();
  return {
    assign(url: string, title?: string): number {
      const clean = url.trim();
      const existing = byUrl.get(clean);
      if (existing !== undefined) {
        const entry = order[existing - 1];
        if (title && (!entry.title || entry.title === clean)) {
          entry.title = title;
        }
        return existing;
      }
      const number = order.length + 1;
      byUrl.set(clean, number);
      order.push({ url: clean, title: title?.trim() ? title : clean });
      return number;
    },
    list(): RunSource[] {
      return order.map((item) => ({ ...item }));
    },
  };
}

// ---------------------------------------------------------------------------
// Builtin tool definitions — mirror the browser loop's set exactly.

const WEB_SEARCH_TOOL: EngineToolDef = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the live web (Exa neural index). Use for current events, facts, docs, and anything that needs citations. Each result carries a citation number like [3] — cite claims with those markers.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        numResults: { type: "number", description: "Number of results, 3-8" },
        recency: {
          type: "string",
          enum: ["day", "week", "month", "year"],
          description: "Only results published within this window — use for news and anything time-sensitive",
        },
      },
      required: ["query"],
    },
  },
};

const FETCH_URL_TOOL: EngineToolDef = {
  type: "function",
  function: {
    name: "fetch_url",
    description:
      "Read the full text of web pages. Each page also lists the links found on it — call fetch_url again on those links to browse deeper, hop by hop (read-only: no logins, no forms).",
    parameters: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "HTTP URLs to fetch" },
      },
      required: ["urls"],
    },
  },
};

const SURF_TOOLS: EngineToolDef[] = [
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

const SURF_TOOL_NAMES = new Set(["surf_open", "surf_follow", "surf_submit", "surf_back", "surf_find"]);

const GENERATE_IMAGE_TOOL: EngineToolDef = {
  type: "function",
  function: {
    name: "generate_image",
    description:
      "Generate one or more images from a detailed visual prompt. Returns data URLs the UI will display. When the user asks for several images or variations, set count instead of calling this tool repeatedly.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed image description" },
        size: {
          type: "string",
          enum: ["1024x1024", "1536x1024", "1024x1536"],
          description: "Optional size",
        },
        count: {
          type: "number",
          minimum: 1,
          maximum: MAX_IMAGE_COUNT,
          description: `How many variations to generate in parallel (1-${MAX_IMAGE_COUNT}). Use only when the user explicitly asks for several.`,
        },
      },
      required: ["prompt"],
    },
  },
};

const GENERATE_VIDEO_TOOL: EngineToolDef = {
  type: "function",
  function: {
    name: "generate_video",
    description: "Generate a short video from a prompt. This can take up to a few minutes.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed video description" },
        aspectRatio: { type: "string", enum: ["16:9", "9:16", "1:1"] },
      },
      required: ["prompt"],
    },
  },
};

const GENERATE_AUDIO_TOOL: EngineToolDef = {
  type: "function",
  function: {
    name: "generate_audio",
    description: "Speak text aloud with text-to-speech. Returns audio the UI will play.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The exact text to read aloud" },
      },
      required: ["prompt"],
    },
  },
};

/** Builtin tool defs for one run — mirrors the client's builtinOpenAiTools. */
export function builtinToolDefs(enabled: Record<BuiltinToolId, boolean>): EngineToolDef[] {
  const tools: EngineToolDef[] = [];
  if (enabled.web_search) {
    tools.push(WEB_SEARCH_TOOL);
  }
  if (enabled.fetch_url) {
    tools.push(FETCH_URL_TOOL);
  }
  if (enabled.selfsurf) {
    tools.push(...SURF_TOOLS);
  }
  if (enabled.generate_image) {
    tools.push(GENERATE_IMAGE_TOOL);
  }
  if (enabled.generate_video) {
    tools.push(GENERATE_VIDEO_TOOL);
  }
  if (enabled.generate_audio) {
    tools.push(GENERATE_AUDIO_TOOL);
  }
  return tools;
}

// ---------------------------------------------------------------------------
// SelfSurf session (server-side): cookie jar + visited pages with digests.

export type ServerSurfSession = {
  jar: SurfJar;
  pages: Array<{ page: SurfPage; digest: string }>;
};

export function createServerSurfSession(): ServerSurfSession {
  return { jar: {}, pages: [] };
}

const MAX_SESSION_PAGES = 30;

function recordSurfPage(session: ServerSurfSession, ledger: SourceLedger, page: SurfPage): string {
  let cite: number | null = null;
  if (page.status > 0 && page.url.startsWith("http")) {
    cite = ledger.assign(page.url, page.title || page.url);
  }
  const digest = formatSurfPage(page, cite, { text: DIGEST_TEXT_CHARS, links: DIGEST_LINKS });
  if (page.status > 0) {
    session.pages.push({ page, digest });
    if (session.pages.length > MAX_SESSION_PAGES) {
      session.pages.shift();
    }
  }
  return digest;
}

/** surf_find: snippets around matches in the current page's FULL text. */
function findInPage(page: SurfPage, query: string): string {
  const haystack = page.text;
  const lower = haystack.toLowerCase();
  const needle = query.toLowerCase();
  const snippets: string[] = [];
  let from = 0;
  while (snippets.length < 6) {
    const index = lower.indexOf(needle, from);
    if (index === -1) {
      break;
    }
    const start = Math.max(0, index - 160);
    const end = Math.min(haystack.length, index + needle.length + 160);
    snippets.push(`…${haystack.slice(start, end).replace(/\s+/g, " ").trim()}…`);
    from = index + needle.length;
  }
  if (snippets.length === 0) {
    return `No matches for "${query}" in the current page's text (${haystack.length} chars searched).`;
  }
  return `Matches for "${query}" on ${page.url}:\n\n${snippets.join("\n\n")}`;
}

async function executeSurfTool(
  name: string,
  args: Record<string, unknown>,
  session: ServerSurfSession,
  ledger: SourceLedger,
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
    return findInPage(current.page, query);
  }

  if (name === "surf_open") {
    let url = String(args.url ?? "").trim();
    if (!url) {
      return "Missing url.";
    }
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }
    const page = await performSurf({ action: "open", url, referer: current?.page.url }, session.jar);
    return recordSurfPage(session, ledger, page);
  }

  if (name === "surf_follow") {
    if (!current) {
      return "No page is open yet — call surf_open first.";
    }
    const target = resolveFollowTarget(current.page, args.link);
    if (!target) {
      return `Could not resolve link "${String(args.link ?? "")}" — use an L-number from the current page, an absolute URL, or exact link text.`;
    }
    const page = await performSurf({ action: "open", url: target, referer: current.page.url }, session.jar);
    return recordSurfPage(session, ledger, page);
  }

  // surf_submit
  if (!current) {
    return "No page is open yet — call surf_open first.";
  }
  const formRef = String(args.form ?? "").trim();
  const match = /^f?(\d+)$/i.exec(formRef);
  const form = match ? current.page.forms[Number(match[1]) - 1] : undefined;
  if (!form) {
    return current.page.forms.length === 0
      ? "The current page has no forms SelfSurf can submit."
      : `Form "${formRef}" not found — the current page lists F1…F${current.page.forms.length}.`;
  }
  if (form.enctype?.includes("multipart")) {
    return "That form uploads files (multipart) — SelfSurf cannot submit it. Tell the user this honestly.";
  }
  const provided =
    args.fields && typeof args.fields === "object" && !Array.isArray(args.fields)
      ? (args.fields as Record<string, unknown>)
      : {};
  const merged = mergeFormFields(form, provided);
  const page = await performSurf(
    { action: "submit", url: form.action, method: form.method, fields: merged, referer: current.page.url },
    session.jar,
  );
  return recordSurfPage(session, ledger, page);
}

// ---------------------------------------------------------------------------
// Web search / page reading (rich variants matching the browser loop).

function toolkitPost(
  path: string,
  body: unknown,
  authKey: string,
  extraHeaders?: Record<string, string>,
  timeoutMs = 45_000,
): Promise<Response> {
  return fetch(`${TOOLKIT_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authKey}`,
      "idempotency-key": crypto.randomUUID(),
      ...(extraHeaders ?? {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

const RECENCY_WINDOW_MS: Record<string, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
};

async function runWebSearch(
  query: string,
  numResults: number,
  recency: string | undefined,
  authKey: string,
  ledger: SourceLedger,
): Promise<string> {
  if (!query.trim()) {
    return "Missing search query.";
  }
  const windowMs = recency ? RECENCY_WINDOW_MS[recency] : undefined;
  const base = {
    query,
    type: "auto",
    numResults: Math.min(Math.max(numResults || 5, 3), 8),
    ...(windowMs ? { startPublishedDate: new Date(Date.now() - windowMs).toISOString() } : {}),
  };
  // Page text alongside highlights grounds answers far better than bare
  // snippets; fall back to highlights-only if the richer shape is rejected.
  let response = await toolkitPost(
    "/v2/exa/search",
    { ...base, contents: { highlights: true, text: { maxCharacters: 1_200 } } },
    authKey,
  );
  if (!response.ok) {
    response = await toolkitPost("/v2/exa/search", { ...base, contents: { highlights: true } }, authKey);
  }
  if (!response.ok) {
    return `Search failed (${response.status}).`;
  }
  const data = (await response.json()) as {
    results?: Array<{
      title?: string;
      url: string;
      publishedDate?: string | null;
      highlights?: string[];
      text?: string;
    }>;
  };
  const results = data.results ?? [];
  if (results.length === 0) {
    return windowMs
      ? `No results published in the last ${recency}. Retry without "recency" to include older material.`
      : "No search results.";
  }
  return results
    .map((hit) => {
      const marker = `[${ledger.assign(hit.url, hit.title)}]`;
      const date = hit.publishedDate ? ` (${hit.publishedDate.slice(0, 10)})` : "";
      const highlights = (hit.highlights ?? []).slice(0, 2).join(" ");
      const body = (hit.text ?? "").replace(/\s+/g, " ").trim().slice(0, 1_000);
      return `${marker} ${hit.title ?? "(untitled)"}${date}\n${hit.url}\n${highlights}${body ? `\n${body}` : ""}`.trim();
    })
    .join("\n\n");
}

async function runFetchUrls(urls: string[], authKey: string, ledger: SourceLedger): Promise<string> {
  const clean = urls.map((url) => url.trim()).filter((url) => url.startsWith("http")).slice(0, 4);
  if (clean.length === 0) {
    return "No valid URLs.";
  }
  // extras.links powers multi-hop browsing; retry the plain shape if the
  // proxy or upstream rejects the field so page reading never breaks.
  let response = await toolkitPost("/v2/exa/contents", { urls: clean, text: true, extras: { links: 10 } }, authKey);
  if (!response.ok) {
    response = await toolkitPost("/v2/exa/contents", { urls: clean, text: true }, authKey);
  }
  if (!response.ok) {
    return `Fetch failed (${response.status}).`;
  }
  const data = (await response.json()) as {
    results?: Array<{ url?: string; title?: string; text?: string; extras?: { links?: string[] } }>;
  };
  const results = data.results ?? [];
  if (results.length === 0) {
    return "Could not fetch those pages.";
  }
  return results
    .map((item) => {
      const marker = item.url ? `[${ledger.assign(item.url, item.title)}] ` : "";
      const body = (item.text ?? "").slice(0, 4_000);
      const links = (item.extras?.links ?? [])
        .filter((link) => typeof link === "string" && link.startsWith("http"))
        .slice(0, 10);
      const linksBlock =
        links.length > 0
          ? `\n\nLinks on this page (fetch_url them to browse deeper):\n${links.join("\n")}`
          : "";
      return `${marker}# ${item.title ?? item.url ?? "Page"}\n${item.url ?? ""}\n${body}${linksBlock}`;
    })
    .join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Media generation — server ports of the browser tool layer.

export async function generateImageServer(prompt: string, size: string, authKey: string): Promise<string> {
  if (!prompt.trim()) {
    throw new Error("Describe the image first.");
  }
  const response = await toolkitPost(
    "/v2/vercel/v3/ai/image-model",
    {
      model: DEFAULT_IMAGE_MODEL,
      prompt,
      n: 1,
      size,
      providerOptions: { gateway: { models: [...IMAGE_FALLBACKS] } },
    },
    authKey,
    {
      "ai-gateway-protocol-version": "0.0.1",
      "ai-image-model-specification-version": "4",
      "ai-model-id": DEFAULT_IMAGE_MODEL,
    },
    180_000,
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Image generation failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const data = (await response.json()) as { images?: string[] };
  const raw = data.images?.[0];
  if (!raw) {
    throw new Error("No image returned.");
  }
  return raw.startsWith("data:") ? raw : `data:image/png;base64,${raw}`;
}

async function generateImageBatchServer(
  prompt: string,
  size: string,
  count: number,
  authKey: string,
): Promise<{ images: string[]; failed: number }> {
  const total = clampImageCount(count);
  if (total === 1) {
    return { images: [await generateImageServer(prompt, size, authKey)], failed: 0 };
  }
  const settled = await Promise.allSettled(
    Array.from({ length: total }, () => generateImageServer(prompt, size, authKey)),
  );
  const images = settled
    .filter((item): item is PromiseFulfilledResult<string> => item.status === "fulfilled")
    .map((item) => item.value);
  if (images.length === 0) {
    const first = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    throw first && first.reason instanceof Error
      ? first.reason
      : new Error(String(first?.reason ?? "Image generation failed."));
  }
  return { images, failed: total - images.length };
}

export async function generateVideoServer(prompt: string, aspectRatio: string, authKey: string): Promise<string> {
  if (!prompt.trim()) {
    throw new Error("Describe the video first.");
  }
  const response = await toolkitPost(
    "/v2/vercel/v3/ai/video-model",
    {
      model: DEFAULT_VIDEO_MODEL,
      prompt,
      n: 1,
      aspectRatio,
      duration: videoDurationForModel(DEFAULT_VIDEO_MODEL),
      providerOptions: { gateway: { models: [...VIDEO_FALLBACKS] } },
    },
    authKey,
    {
      "ai-gateway-protocol-version": "0.0.1",
      "ai-video-model-specification-version": "4",
      "ai-model-id": DEFAULT_VIDEO_MODEL,
      accept: "text/event-stream",
    },
    480_000,
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Video generation failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const body = await response.text();
  const events = body
    .split(/\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0 && line !== "[DONE]");

  let errorMessage: string | null = null;
  let videoUrl: string | null = null;
  for (const event of events) {
    try {
      const parsed = JSON.parse(event) as {
        type?: string;
        message?: string;
        videos?: Array<{ type?: string; url?: string; data?: string; mediaType?: string }>;
      };
      if (parsed.type === "error") {
        errorMessage = parsed.message ?? "Video generation failed.";
        continue;
      }
      const videos = parsed.videos ?? [];
      if (videos.length === 0) {
        continue;
      }
      const first = videos[0];
      if (first.type === "url" && first.url) {
        videoUrl = first.url;
      } else if (first.data) {
        videoUrl = `data:${first.mediaType ?? "video/mp4"};base64,${first.data}`;
      } else if (first.url) {
        videoUrl = first.url;
      }
    } catch {
      // skip malformed events
    }
  }
  if (videoUrl) {
    return videoUrl;
  }
  throw new Error(errorMessage ?? "No video returned.");
}

export async function generateAudioServer(prompt: string, authKey: string): Promise<string> {
  if (!prompt.trim()) {
    throw new Error("Add the text to speak first.");
  }
  const voice = voicesForModel(DEFAULT_AUDIO_MODEL)[0] ?? "";
  const response = await toolkitPost(
    "/v2/vercel/v4/ai/speech-model",
    {
      text: prompt,
      ...(voice ? { voice } : {}),
      outputFormat: "mp3",
    },
    authKey,
    {
      "ai-gateway-protocol-version": "0.0.1",
      "ai-model-id": DEFAULT_AUDIO_MODEL,
    },
    120_000,
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Audio generation failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const data = (await response.json()) as { audio?: unknown; mediaType?: string };
  let base64: string | undefined;
  if (typeof data.audio === "string") {
    base64 = data.audio;
  } else if (data.audio && typeof data.audio === "object") {
    const nested = data.audio as { base64?: string; data?: string; url?: string };
    if (typeof nested.url === "string" && nested.url.length > 0) {
      return nested.url;
    }
    base64 = nested.base64 ?? nested.data;
  }
  if (!base64) {
    throw new Error("No audio returned.");
  }
  return base64.startsWith("data:") ? base64 : `data:${data.mediaType ?? "audio/mpeg"};base64,${base64}`;
}

// ---------------------------------------------------------------------------
// Tool executor for one run.

export type ServerToolContext = {
  authKey: string;
  ledger: SourceLedger;
  surf: ServerSurfSession;
  /** Armed MCP + native-connector routes; null when none are configured. */
  mcpRoutes: Map<string, McpRoute> | null;
  /** The run's resolved toolset — owns inline routes AND the deferred meta functions. */
  mcpToolset?: McpToolset | null;
};

/** Executes one tool call inside a server run — never throws for tool errors. */
export async function executeServerTool(
  name: string,
  argsJson: string,
  ctx: ServerToolContext,
): Promise<EngineToolOutcome> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }

  if (ctx.mcpToolset?.owns(name)) {
    const outcome = await ctx.mcpToolset.execute(name, args);
    return { text: capText(outcome.text, 60_000), ...(outcome.isError ? { isError: true } : {}) };
  }

  const route = ctx.mcpRoutes?.get(name);
  if (route) {
    try {
      const output =
        route.type === "native"
          ? await callNativeConnectorTool(route, args)
          : await callCloudMcpTool(route.session, route.toolName, args);
      return { text: output.trim().length > 0 ? capText(output, 60_000) : "(empty result)" };
    } catch (error) {
      return {
        text: `MCP tool failed (${route.serverName}): ${error instanceof Error ? error.message : "unknown error"}`,
        isError: true,
      };
    }
  }

  if (SURF_TOOL_NAMES.has(name)) {
    return { text: await executeSurfTool(name, args, ctx.surf, ctx.ledger) };
  }

  if (name === "web_search") {
    return {
      text: await runWebSearch(
        String(args.query ?? ""),
        Number(args.numResults ?? 5),
        typeof args.recency === "string" ? args.recency : undefined,
        ctx.authKey,
        ctx.ledger,
      ),
    };
  }
  if (name === "fetch_url") {
    const urls = Array.isArray(args.urls) ? args.urls.map(String) : [];
    return { text: await runFetchUrls(urls, ctx.authKey, ctx.ledger) };
  }
  if (name === "generate_image") {
    const count = clampImageCount(Number(args.count ?? 1));
    const batch = await generateImageBatchServer(
      String(args.prompt ?? ""),
      typeof args.size === "string" ? args.size : "1024x1024",
      count,
      ctx.authKey,
    );
    const text = [
      batch.images.length === 1 ? "Image generated." : `Generated ${batch.images.length} images.`,
      batch.failed > 0 ? `${batch.failed} of ${count} attempts failed.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return { text, images: batch.images };
  }
  if (name === "generate_video") {
    const video = await generateVideoServer(
      String(args.prompt ?? ""),
      typeof args.aspectRatio === "string" ? args.aspectRatio : "16:9",
      ctx.authKey,
    );
    return { text: "Video generated.", videos: [video] };
  }
  if (name === "generate_audio") {
    const audio = await generateAudioServer(String(args.prompt ?? ""), ctx.authKey);
    return { text: "Audio generated.", audios: [audio] };
  }
  throw new Error(`Unknown tool: ${name}`);
}
