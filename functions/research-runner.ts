// Server-side deep research — a faithful port of the browser pipeline
// (web/src/lib/deep-research.ts): plan queries, search in waves, reflect,
// read the best pages in full, browse live pages with SelfSurf, read GitHub
// repos through the user's connector, then stream a cited report.
//
// Honesty invariants preserved: reflection failures never masquerade as a
// deliberate stop, page texts are matched back to their exact URLs, retitles
// keep [n] pills accurate, and the report's servedBy chip is set whenever a
// gateway fallback wrote the text.

import {
  CHAT_FALLBACKS,
  FAST_MODEL,
  fallbackServedBy,
  runEngineTurn,
  streamGatewayCompletion,
  withRetries,
  TOOLKIT_URL,
  type EngineMessage,
} from "./agent-engine";
import {
  isMcpMetaToolName,
  MCP_CALL_TOOL_NAME,
  MCP_SEARCH_TOOL_NAME,
  type McpToolset,
} from "./mcp-toolset";
import {
  callGitHubNativeTool,
  fetchGitHubRepoMeta,
  fetchRepoCiSnapshot,
  githubRunRepoRefs,
  parseRepoPick,
  type GitHubRepoMeta,
} from "./native-github";
import { performSurf, type SurfJar } from "./selfsurf";
import type { ResearchDepth, ResearchState, ResearchStep, ResearchStepKind, WireMessage } from "./run-protocol";

export class RunStoppedError extends Error {
  constructor() {
    super("Stopped.");
    this.name = "RunStoppedError";
  }
}

export type ResearchProfile = {
  maxWaves: number;
  maxQueriesTotal: number;
  maxReadsTotal: number;
  readsPerWave: number;
  resultsPerQuery: number;
  pageChars: number;
  dossierCharBudget: number;
  maxBrowseTotal: number;
  browsePerWave: number;
  minWavesBeforeDone: number;
  plannerRange: string;
  plannerMax: number;
  reflectQueries: number;
};

export const RESEARCH_PROFILES: Record<ResearchDepth, ResearchProfile> = {
  eco: {
    maxWaves: 2,
    maxQueriesTotal: 8,
    maxReadsTotal: 6,
    readsPerWave: 3,
    resultsPerQuery: 4,
    pageChars: 6000,
    dossierCharBudget: 60000,
    maxBrowseTotal: 3,
    browsePerWave: 1,
    minWavesBeforeDone: 1,
    plannerRange: "3-5",
    plannerMax: 5,
    reflectQueries: 3,
  },
  balanced: {
    maxWaves: 5,
    maxQueriesTotal: 24,
    maxReadsTotal: 18,
    readsPerWave: 6,
    resultsPerQuery: 6,
    pageChars: 9000,
    dossierCharBudget: 150000,
    maxBrowseTotal: 6,
    browsePerWave: 2,
    minWavesBeforeDone: 2,
    plannerRange: "4-8",
    plannerMax: 8,
    reflectQueries: 4,
  },
  max: {
    maxWaves: 8,
    maxQueriesTotal: 40,
    maxReadsTotal: 30,
    readsPerWave: 8,
    resultsPerQuery: 8,
    pageChars: 12000,
    dossierCharBudget: 240000,
    maxBrowseTotal: 10,
    browsePerWave: 3,
    minWavesBeforeDone: 3,
    plannerRange: "6-10",
    plannerMax: 10,
    reflectQueries: 5,
  },
};

const PROMPT_URLS_LIMIT = 3;

const plannerPrompt = (profile: ResearchProfile) => `You split a research question into targeted web search queries.

Reply with ONLY compact JSON, no markdown: {"queries":["...","..."]}

Rules:
- ${profile.plannerRange} queries, each self-contained and specific.
- Mix angles: official data/docs, news, statistics, comparisons, expert criticism.
- Include at least one query hunting primary data (official statistics, reports, filings, papers) and at least one hunting criticism or counterarguments.
- Include at least one query hunting insider texture: practitioner forums, Reddit, Hacker News, specialist blogs, interviews, conference talks, issue trackers, changelogs, postmortems — the details participants mention and press coverage misses.
- Match the question's language for local/regional topics; use English for global or technical topics; for regional topics add one English query for the international view.
- Add the current year to time-sensitive queries.`;

const reflectPrompt = (profile: ResearchProfile, repoMode: boolean) => `You steer an ongoing web research loop. Given the research question, queries already used, your own notes from earlier waves (when any), and the numbered sources found so far, decide the next actions.

Reply with ONLY compact JSON, no markdown:
{"notes":"one short sentence on what is still missing","queries":["up to ${profile.reflectQueries} NEW search queries"],"read":[source numbers worth reading in full, up to ${profile.readsPerWave}],"browse":["up to ${profile.browsePerWave} exact URLs to open live in the browser"]${repoMode ? `,"files":["up to ${profile.readsPerWave} repo reads — owner/repo:path/to/file for a source file, owner/repo@sha for a commit diff, owner/repo#123 for a PR diff"]` : ""},"done":true|false}

Rules:
- Set "done": true ONLY when the sources cover the question from several independent angles INCLUDING primary data, and extra searching would add little.
- Never repeat or trivially rephrase earlier queries; drill into gaps, follow leads found in the sources, chase missing numbers and dates.
- Build on your earlier notes: a gap noted before that the sources still do not fill needs a DIFFERENT angle (primary source, other language, on-site search, live browse) or must be accepted as unfindable — never re-run the angle that already came up empty; a gap the sources now fill is closed, move on.
- Prefer primary sources for "read": official statistics, reports, filings, papers, documentation — not aggregator listicles.
- Chase the non-obvious: exact figures, direct quotes from named people, fine print, edge cases, practitioner complaints, contradictions between sources. A dossier of news listicles alone is a failure — pull in primary documents and community/expert threads (forums, Reddit, HN, specialist blogs, interviews).
- "browse" opens pages live via SelfSurf, an HTTP browser with cookies and redirects but NO JavaScript. Use it whenever FRESHNESS matters: if the question needs today's state (prices, versions, releases, schedules, rankings, laws, live stats) and search snippets look dated, open the official page directly instead of trusting a cached snippet. Also use it for exact URLs search cannot reach well: official registries or databases, documents and stats pages mentioned inside sources, or on-site search URLs like https://example.com/search?q=term. Skip app-like pages that need JS; use [] when nothing qualifies.
${repoMode ? `- "files" reads straight from the user's connected GitHub repos: source files (owner/repo:path — EXACT paths from the file-tree source), commit diffs (owner/repo@sha — SHAs from the commits source), PR diffs (owner/repo#123). For questions about code, bugs, or implementation quality, reading the implicated source files is MANDATORY before "done" — never judge code you have not opened. For regressions ("when did X break"), read the suspect commit diffs; when a CI source shows a failing run, use its log to pin the cause.
` : ""}- Actively seek dissenting or critical sources if all current ones agree.
- If done, "queries" and "browse" must be [].`;

const synthesisPrompt = (citeNumeric: boolean) => `You are Gera in deep research mode. You are given a research dossier of numbered sources — web pages (search notes plus full page texts) and, when the question names a repository, file trees, source files, commit diffs, CI runs, and failure logs pulled from the user's connected GitHub. Write a deep, insight-dense report that answers the user's question. Today's date: ${new Date().toISOString().slice(0, 10)} (UTC) — weigh source freshness accordingly. A source marked "Fetched live" was opened today by the live browser — treat it as today's state.

A <research_log> may follow the dossier: the queries the loop ran, its own notes on what was still missing after each wave, and the pages or tools that failed. Use it to write "Limitations" factually — what was searched for and not found, which pages could not be opened — and to tell "no public data found" apart from "never looked for". The log is not a source: never cite it, and never present a failed fetch as evidence.

Sources whose URL starts with mcp:// are outputs of the user's connected MCP tools (server · tool) — primary data from their own systems, fetched during this run; cite them like any other source and name the server in prose when the fact comes from there.

Citations — dense, Perplexity-style:
${citeNumeric
    ? `- Cite with bare numeric markers using the dossier source numbers, placed right after the claim they support: "revenue grew 34% in 2025 [7]". Stack markers when sources corroborate: [3][12].
- Nearly EVERY factual sentence must carry at least one [n] marker — an unmarked paragraph is a defect. Never paste raw URLs into the body; the markers render as clickable pills.`
    : `- Cite inline with markdown links [short source name](url) right after each claim; use only URLs from the dossier. Nearly every factual sentence must carry a link — an uncited paragraph is a defect.`}

Depth — what separates this from a dry summary:
- Keep every precision the sources give: exact figures, dates, names, versions, prices, percentages. Never round away detail the dossier contains.
- Work in 2-5 short verbatim quotes from named people or documents, with attribution (translate into the report's language, keep the meaning exact).
- Include a "Details & nuances" section (title it in the report's language) collecting the non-obvious: fine print, exceptions, edge cases, practitioner caveats from forums and communities, little-known numbers, recent changes, who wins and who loses.
- Where sources disagree, show the disagreement head-on and say which side the evidence favors and why.
- Prefer concrete mechanisms over generalities: HOW it works, WHO exactly did what, WHEN, and what it cost.
- When repository sources are in the dossier (file trees, source files, commit diffs, CI runs and logs), ground every code-level claim in the actual file contents: name exact files and functions, quote the offending lines, and cite those sources like any other. Never say the code was unavailable when repo sources are present.
- Calibrate every cost/time/effort estimate to today's AI-era workflows. Since 2023, AI coding agents and generation tools collapsed software and content build costs by orders of magnitude — when a source quotes pre-AI agency rates or timelines ("$100K and 6 months for an app"), date-stamp it, label it a legacy baseline, and put the realistic AI-assisted figure beside it. Never present stale numbers as current market reality; costs that genuinely did not collapse (salaries, compliance, marketing, hardware, infra at scale) stay as sourced.

Artifacts — visual, built ONLY from real dossier data (never invent numbers):
- \`\`\`chart fence with JSON like {"type":"bar","title":"...","xKey":"...","series":[{"key":"..."}],"data":[{...}]} (types: line, bar, area, pie, donut, radar, scatter). Add a chart whenever the dossier holds 3+ comparable numbers — trends, shares, comparisons, rankings. Aim for at least one chart per report when the data allows.
- Markdown tables for structured comparisons: options, players, plans, timelines with figures.
- \`\`\`mermaid fence (flowchart, timeline, sequenceDiagram) when a process, chronology, or relationship map clarifies the story.
- \`\`\`map fence with JSON like {"markers":[{"lat":55.75,"lng":37.62,"label":"..."}]} for places, routes, and geographic comparisons.
- If numbers are too sparse for a chart, use a table — never fabricate data points.

Structure:
- Write in the same language as the user's question.
- Start with a short executive summary (2-4 sentences), then sections with ## headings, then the details-and-nuances section.
- Point out where data is stale or evidence is weak; if a claim rests on a single source, say so.
- Before "Sources", add a short "Limitations" note in the report's language: what remains uncertain and which data could not be found.
- End with a "Sources" section ${citeNumeric ? `listing every CITED source as "- [n] [Title](url)" in number order (only sources you actually cited)` : "listing the cited links"}, then 1-2 suggested follow-up questions.
- Length must match the evidence — a rich dossier deserves a long report; never pad a thin one.`;

/**
 * Mounts the workspace context (profile instructions, skill packs, saved
 * knowledge) under the synthesis prompt with an honest frame: it shapes HOW
 * the report is researched and written — it is never WHAT to research. The
 * old "User instructions (always follow these)" label made models treat
 * skill packs as the subject and write reports about them when the question
 * was thin. Kept in sync with the browser twin in web/src/lib/deep-research.ts.
 */
export function synthesisSystem(base: string, workspaceGuidance?: string): string {
  const guidance = workspaceGuidance?.trim();
  if (!guidance) {
    return base;
  }
  return `${base}\n\nWorkspace guidance — the user's saved profile instructions, skill packs, and knowledge. It shapes HOW you research and write (tone, language, rigor, format). It is NOT the research subject: never research, summarize, or cite the guidance itself, and when it conflicts with the user's question, the question wins.\n\n${guidance}`;
}

export type RegistrySource = {
  index: number;
  url: string;
  title: string;
  published?: string;
  highlights: string[];
  text?: string;
  /** ISO date when SelfSurf fetched the text live — the writer weighs it as today's state. */
  liveAt?: string;
};

type SearchHit = {
  url: string;
  title: string;
  published?: string;
  highlights: string[];
};

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 40);
  }
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function urlsInPrompt(prompt: string): string[] {
  const matches = prompt.match(/https?:\/\/[^\s)\]}>"'`]+/gi) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const url = raw.replace(/[.,;:!?]+$/, "");
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
    if (out.length >= PROMPT_URLS_LIMIT) {
      break;
    }
  }
  return out;
}

function normalizeBrowseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/|$)/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return null;
}

function toolkitPost(path: string, body: unknown, authKey: string, timeoutMs = 45_000): Promise<Response> {
  return fetch(`${TOOLKIT_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authKey}`,
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** Non-streaming JSON helper call on the fast model; null on any failure. */
async function jsonCall(params: {
  authKey: string;
  system: string;
  user: string;
  maxTokens: number;
  onUsage?: (modelId: string, usage: unknown, service?: boolean) => void;
}): Promise<Record<string, unknown> | null> {
  try {
    const response = await toolkitPost(
      "/v2/vercel/v1/chat/completions",
      {
        model: FAST_MODEL,
        stream: false,
        temperature: 0,
        max_tokens: params.maxTokens,
        messages: [
          { role: "system", content: params.system },
          { role: "user", content: params.user },
        ],
        providerOptions: { gateway: { models: [...CHAT_FALLBACKS] } },
      },
      params.authKey,
      100_000,
    );
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: Record<string, unknown>;
    };
    if (data.usage) {
      // Planner/helper call — tagged service so it never poses as model adoption.
      params.onUsage?.(FAST_MODEL, data.usage, true);
    }
    const text = data.choices?.[0]?.message?.content ?? "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return null;
    }
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function exaSearch(query: string, numResults: number, authKey: string): Promise<SearchHit[]> {
  const response = await toolkitPost("/v2/exa/search", {
    query,
    type: "auto",
    numResults,
    contents: { highlights: true },
  }, authKey);
  if (!response.ok) {
    throw new Error(`Search failed (${response.status}).`);
  }
  const data = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; publishedDate?: string | null; highlights?: string[] }>;
  };
  return (data.results ?? [])
    .filter((hit): hit is { url: string; title?: string; publishedDate?: string | null; highlights?: string[] } =>
      typeof hit.url === "string" && hit.url.startsWith("http"),
    )
    .map((hit) => ({
      url: hit.url,
      title: hit.title?.trim() || hit.url,
      published: hit.publishedDate ?? undefined,
      highlights: (hit.highlights ?? []).slice(0, 3),
    }));
}

function normalizedUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "").toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Query parameters that only track the click and never change the document. */
const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|_ga)$/i;

/**
 * One registry slot per document. Scheme, `www.`, trailing slashes, parameter
 * order and tracking parameters never mint a second source for the same page —
 * otherwise the reflector spends two reads (and the writer two page texts) on
 * one article. Meaningful queries stay (`?q=term` is a different page) and so
 * does the fragment: repository sources rely on it (`…/repo#readme` next to
 * the overview at `…/repo`). Kept in sync with the browser twin.
 */
export function sourceDedupeKey(url: string): string {
  try {
    const parsed = new URL(url);
    const kept = [...parsed.searchParams.entries()]
      .filter(([key]) => !TRACKING_PARAM.test(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const search = kept.length > 0 ? `?${new URLSearchParams(kept).toString()}` : "";
    return `${parsed.hostname.replace(/^www\./, "").toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}${search}${parsed.hash}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Pairs content-API results back to the requested sources without guessing:
 * exact URL match first, then a normalized match. Positional pairing is
 * trusted ONLY when the response has one entry per requested URL — a shorter
 * or reordered response must never attach another page's text to a source.
 */
export function matchContentPages<T extends { url: string }>(
  requested: Array<{ url: string }>,
  pages: T[],
): Array<T | undefined> {
  const claimed = new Set<number>();
  const out: Array<T | undefined> = requested.map((target) => {
    const exact = pages.findIndex((page, index) => !claimed.has(index) && page.url === target.url);
    if (exact === -1) {
      return undefined;
    }
    claimed.add(exact);
    return pages[exact];
  });
  requested.forEach((target, slot) => {
    if (out[slot]) {
      return;
    }
    const key = normalizedUrlKey(target.url);
    const near = pages.findIndex((page, index) => !claimed.has(index) && normalizedUrlKey(page.url) === key);
    if (near !== -1) {
      claimed.add(near);
      out[slot] = pages[near];
    }
  });
  if (pages.length === requested.length) {
    requested.forEach((_target, slot) => {
      if (!out[slot] && !claimed.has(slot)) {
        claimed.add(slot);
        out[slot] = pages[slot];
      }
    });
  }
  return out;
}

async function exaContents(
  urls: string[],
  authKey: string,
): Promise<Array<{ url: string; title?: string; text?: string }>> {
  const response = await toolkitPost("/v2/exa/contents", { urls, text: true }, authKey);
  if (!response.ok) {
    throw new Error(`Fetch failed (${response.status}).`);
  }
  const data = (await response.json()) as { results?: Array<{ url?: string; title?: string; text?: string }> };
  return (data.results ?? []).map((item) => ({
    url: typeof item.url === "string" ? item.url : "",
    title: item.title,
    text: item.text,
  }));
}

function stringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const text = String(item).trim();
    if (text && !seen.has(text.toLowerCase())) {
      seen.add(text.toLowerCase());
      out.push(text);
    }
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

/** Water-filled dossier assembly — late-wave pages are never crowded out. */
export function buildDossier(registry: Map<string, RegistrySource>, budget: number): string {
  const sources = [...registry.values()];
  const allocation = new Map<number, number>();
  const withText = sources
    .filter((source) => (source.text?.length ?? 0) > 0)
    .sort((a, b) => (a.text?.length ?? 0) - (b.text?.length ?? 0));
  let remaining = Math.max(0, budget);
  let left = withText.length;
  for (const source of withText) {
    const take = Math.min(source.text?.length ?? 0, Math.floor(remaining / left));
    allocation.set(source.index, take);
    remaining -= take;
    left -= 1;
  }
  const parts: string[] = [];
  for (const source of sources) {
    const lines = [`[${source.index}] ${source.title}`, `URL: ${source.url}`];
    if (source.published) {
      lines.push(`Published: ${source.published.slice(0, 10)}`);
    }
    if (source.liveAt) {
      lines.push(`Fetched live: ${source.liveAt}`);
    }
    if (source.highlights.length > 0) {
      lines.push(`Notes: ${source.highlights.join(" ")}`);
    }
    const take = allocation.get(source.index) ?? 0;
    if (source.text && take > 0) {
      lines.push(`Full text:\n${source.text.slice(0, take)}`);
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n---\n\n");
}

export const REFLECT_LIST_BUDGET = 36000;

/** Reflection list: read sources shrink, newest unread finds stay visible. */
export function buildReflectionList(sources: RegistrySource[], budget: number): string {
  const lines = sources.map((source) => {
    const read = (source.text?.length ?? 0) > 0;
    const snippet = source.highlights.join(" ").slice(0, read ? 120 : 200);
    const head = `[${source.index}] ${source.title.slice(0, 140)} — ${source.url}${read ? " (already read)" : ""}`;
    return { index: source.index, read, text: snippet ? `${head}\n${snippet}` : head };
  });
  const total = lines.reduce((sum, line) => sum + line.text.length + 1, 0);
  if (total <= budget) {
    return lines.map((line) => line.text).join("\n");
  }
  const keep = new Set<number>();
  let used = 0;
  for (const line of lines) {
    if (line.read) {
      keep.add(line.index);
      used += line.text.length + 1;
    }
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.read) {
      continue;
    }
    if (used + line.text.length + 1 > budget) {
      break;
    }
    keep.add(line.index);
    used += line.text.length + 1;
  }
  const kept = lines.filter((line) => keep.has(line.index));
  const hidden = lines.length - kept.length;
  const note = hidden > 0 ? `(${hidden} older unread sources hidden — earlier waves already reviewed them)\n` : "";
  return note + kept.map((line) => line.text).join("\n");
}

export const RESEARCH_LOG_BUDGET = 8_000;
const REFLECTION_NOTE_CHARS = 300;

/**
 * The loop's working notes, handed to the writer next to the dossier. A text
 * hand-off keeps the findings and drops the considerations behind them; this
 * keeps them: what the reflector judged still missing after each wave, which
 * pages or tools failed, and every query run — so "Limitations" states what
 * was actually looked for and not found instead of guessing. Sections are
 * ordered by value per character, so a budget cut trims the query list first.
 * Kept in sync with the browser twin.
 */
export function buildResearchLog(input: {
  queries: string[];
  notes: string[];
  steps: ResearchStep[];
  budget?: number;
}): string {
  const budget = input.budget ?? RESEARCH_LOG_BUDGET;
  const clip = (text: string, limit: number): string => text.replace(/\s+/g, " ").trim().slice(0, limit);
  const sections: string[] = [];
  const notes = input.notes.map((note) => clip(note, REFLECTION_NOTE_CHARS + 20)).filter((note) => note.length > 0);
  if (notes.length > 0) {
    sections.push(
      `Reflection notes — what the loop judged still missing after each wave:\n${notes.map((note) => `- ${note}`).join("\n")}`,
    );
  }
  const failures = input.steps
    .filter((step) => step.status === "error" && step.kind !== "synthesize")
    .map((step) => `- ${step.kind}: ${clip(step.label, 100)}${step.detail ? ` — ${clip(step.detail, 140)}` : ""}`);
  if (failures.length > 0) {
    const shown = failures.slice(0, 25);
    const hidden = failures.length - shown.length;
    sections.push(
      `Could not be obtained (not sources — never cite; mention in Limitations when relevant):\n${shown.join("\n")}${hidden > 0 ? `\n- …and ${hidden} more` : ""}`,
    );
  }
  if (input.queries.length > 0) {
    sections.push(
      `Queries run (${input.queries.length}):\n${input.queries.map((query) => `- ${clip(query, 120)}`).join("\n")}`,
    );
  }
  const log = sections.join("\n\n");
  return log.length > budget ? `${log.slice(0, Math.max(0, budget - 1))}…` : log;
}

function historyMessages(history: WireMessage[]): EngineMessage[] {
  return history
    .filter((message) => message.content.trim().length > 0)
    .slice(-6)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, 1500),
    }));
}

export type ResearchRunParams = {
  authKey: string;
  prompt: string;
  history: WireMessage[];
  modelId: string;
  systemPrompt?: string;
  depth?: ResearchDepth;
  /** Ready GitHub Authorization value (client resolves the sign-in/PAT). */
  githubAuth?: string;
  /** Native tools disabled on the selected GitHub connector. */
  githubDisabledTools?: string[];
  /** Thread pin used when the current question does not name another repo. */
  githubRepo?: string;
  citations?: "numeric" | "links";
  fallbacks?: boolean;
  /**
   * The run's deferred MCP toolset: research never lists tool schemas — a
   * bounded scout step searches the connected servers and reads the few
   * tools whose output bears on the question; results become dossier sources.
   */
  mcpToolset?: McpToolset;
  isCancelled?: () => boolean;
  onUpdate: (research: ResearchState) => void;
  onText: (full: string) => void;
  onUsage?: (modelId: string, usage: unknown, service?: boolean) => void;
};

/** Most MCP tool reads one research run may spend on connected servers. */
export const MCP_RESEARCH_CALLS = 6;
/** Wall-clock budget of the connector scout step. */
const MCP_RESEARCH_BUDGET_MS = 90_000;

/** Pseudo-URL that identifies one MCP tool output in the dossier (unique per call). */
export function mcpSourceUrl(serverId: string, toolName: string, ordinal: number): string {
  const base = `mcp://${encodeURIComponent(serverId)}/${encodeURIComponent(toolName)}`;
  return ordinal > 1 ? `${base}#${ordinal}` : base;
}

const mcpScoutPrompt = (toolset: McpToolset, calls: number) => `You scout the user's connected MCP servers for a research question — you find and read data, you do not write the report.

${toolset.promptNote}

Procedure:
1. Call ${MCP_SEARCH_TOOL_NAME} with 1-3 targeted queries derived from the question (topic words, entity names, the kind of data needed).
2. Call ${MCP_CALL_TOOL_NAME} for at most ${calls} tools whose OUTPUT would contain facts directly useful to the question: internal documents, knowledge bases, tickets, metrics, live systems, catalogs. Pass arguments that match the tool's inputSchema.
3. Read-only intent: never call tools that create, update, send, post, or delete anything.
4. If no tool is relevant, stop without calling one.
Finish with ONE short sentence naming what was fetched, or that nothing relevant exists — no analysis, no answer to the question.`;

/**
 * Grok-style deep research on the server: plan queries, search in waves,
 * reflect on findings, read the best pages in full, then stream a cited report.
 */
export async function runServerDeepResearch(
  params: ResearchRunParams,
): Promise<{ content: string; research: ResearchState; servedBy?: string }> {
  const profile = RESEARCH_PROFILES[params.depth ?? "balanced"];
  const state: ResearchState = { status: "running", steps: [], sources: [], startedAt: Date.now() };
  const registry = new Map<string, RegistrySource>();
  /** The same document under variant URLs resolves to one registry slot. */
  const registryByKey = new Map<string, RegistrySource>();
  const usedQueries: string[] = [];
  /** The reflector's own "still missing" notes, wave by wave — handed forward. */
  const reflectionNotes: string[] = [];
  let readsTotal = 0;

  const snapshot = (): ResearchState => ({
    ...state,
    steps: state.steps.map((step) => ({ ...step })),
    sources: [...state.sources],
  });
  const emit = () => params.onUpdate(snapshot());
  const addStep = (kind: ResearchStepKind, label: string, detail?: string): ResearchStep => {
    const step: ResearchStep = { id: crypto.randomUUID(), kind, label, detail, status: "running" };
    state.steps.push(step);
    emit();
    return step;
  };
  const finishStep = (step: ResearchStep, status: "done" | "error", detail?: string) => {
    step.status = status;
    if (detail !== undefined) {
      step.detail = detail;
    }
    emit();
  };
  const ensureAlive = () => {
    if (params.isCancelled?.()) {
      throw new RunStoppedError();
    }
  };
  const findSource = (url: string): RegistrySource | undefined =>
    registry.get(url) ?? registryByKey.get(sourceDedupeKey(url));
  const registerHit = (hit: SearchHit): boolean => {
    if (findSource(hit.url)) {
      return false;
    }
    const source: RegistrySource = {
      index: registry.size + 1,
      url: hit.url,
      title: hit.title,
      published: hit.published,
      highlights: hit.highlights,
    };
    registry.set(hit.url, source);
    registryByKey.set(sourceDedupeKey(hit.url), source);
    state.sources.push({ url: hit.url, title: hit.title });
    return true;
  };
  // A full read upgrades the search-snippet title to the real page title —
  // the visible source pill must follow, or [n] hovers show stale names.
  const retitle = (source: RegistrySource, title: string) => {
    const clean = title.trim();
    if (!clean) {
      return;
    }
    source.title = clean;
    const pill = state.sources.find((item) => item.url === source.url);
    if (pill) {
      pill.title = clean;
    }
  };

  const repos = new Map<string, GitHubRepoMeta>();
  const readRepoPicks = new Set<string>();
  const githubAuth: string | null = params.githubAuth?.trim() ? params.githubAuth.trim() : null;
  const githubDisabled = new Set(params.githubDisabledTools ?? []);
  const canGitHub = (toolName: string): boolean => !githubDisabled.has(toolName);
  const upsertRepoSource = (url: string, title: string, text: string) => {
    if (!findSource(url)) {
      registerHit({ url, title, highlights: [] });
    }
    const source = findSource(url);
    if (source) {
      source.text = text;
      retitle(source, title);
    }
  };

  // SelfSurf: one live-browsing session (cookie jar) for the whole run.
  const jar: SurfJar = {};
  const browsedUrls = new Set<string>();
  let browsesTotal = 0;

  const scoutMcpConnectors = async (toolset: McpToolset): Promise<void> => {
    const metaTools = toolset.toolDefs.filter((def) => isMcpMetaToolName(def.function.name));
    const servers = toolset.servers.filter((server) => server.deferred && !server.unavailable);
    if (metaTools.length === 0 || servers.length === 0) {
      return;
    }
    const serverName = (id: string): string => servers.find((server) => server.id === id)?.name ?? id;
    const scoutStep = addStep("plan", "Checking connected MCP servers", servers.map((server) => server.name).join(", ").slice(0, 110));
    const callOrdinals = new Map<string, number>();
    let reads = 0;
    let calls = 0;
    const parseArgs = (argsJson: string): Record<string, unknown> => {
      try {
        const parsed = JSON.parse(argsJson || "{}") as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    };
    try {
      await runEngineTurn({
        authKey: params.authKey,
        modelId: FAST_MODEL,
        apiMessages: [
          { role: "system", content: mcpScoutPrompt(toolset, MCP_RESEARCH_CALLS) },
          { role: "user", content: `Research question:\n"""${params.prompt.slice(0, 2000)}"""` },
        ],
        tools: metaTools,
        fallbacks: params.fallbacks,
        isStopped: params.isCancelled,
        deadlineAt: Date.now() + MCP_RESEARCH_BUDGET_MS,
        handlers: { onText: () => undefined },
        // Scout calls are helper spend — tagged service so they never pose as model adoption.
        onUsage: (modelId, usage) => params.onUsage?.(modelId, usage, true),
        executeTool: async (name, argsJson) => {
          ensureAlive();
          const args = parseArgs(argsJson);
          if (name === MCP_CALL_TOOL_NAME) {
            if (calls >= MCP_RESEARCH_CALLS) {
              return { text: `Read budget exhausted (${MCP_RESEARCH_CALLS} tool reads per research run). Stop and summarize.`, isError: true };
            }
            calls += 1;
            const serverId = typeof args.serverId === "string" ? args.serverId : "?";
            const toolName = typeof args.toolName === "string" ? args.toolName : "?";
            const step = addStep("read", toolName.slice(0, 90), `MCP · ${serverName(serverId)}`);
            const outcome = await toolset.execute(name, args);
            if (outcome.executed === false) {
              calls -= 1;
              finishStep(step, "done", "Schema loaded — tool not executed; no source added");
              return outcome;
            }
            if (outcome.isError || outcome.text.trim().length === 0) {
              finishStep(step, "error", outcome.isError ? outcome.text.slice(0, 120) : "empty result");
              return outcome;
            }
            const key = `${serverId}\u0000${toolName}`;
            const ordinal = (callOrdinals.get(key) ?? 0) + 1;
            callOrdinals.set(key, ordinal);
            upsertRepoSource(
              mcpSourceUrl(serverId, toolName, ordinal),
              `${serverName(serverId)} · ${toolName}`,
              outcome.text.slice(0, profile.pageChars * 2),
            );
            reads += 1;
            finishStep(step, "done", `MCP · ${serverName(serverId)}`);
            return outcome;
          }
          if (name === MCP_SEARCH_TOOL_NAME) {
            const query = typeof args.query === "string" ? args.query : "";
            const step = addStep("search", `MCP tools: ${query || "(all)"}`.slice(0, 90), "connected servers");
            const outcome = await toolset.execute(name, args);
            finishStep(step, outcome.isError ? "error" : "done", outcome.isError ? outcome.text.slice(0, 120) : undefined);
            return outcome;
          }
          return { text: `Tool "${name}" is not available in the connector scout.`, isError: true };
        },
      });
      finishStep(scoutStep, "done", reads > 0 ? `${reads} tool read${reads === 1 ? "" : "s"} added as sources` : "nothing relevant found");
    } catch (error) {
      if (error instanceof RunStoppedError) {
        throw error;
      }
      finishStep(scoutStep, "error", error instanceof Error ? error.message.slice(0, 120) : "scout failed");
    }
  };

  const browsePages = async (rawUrls: string[]): Promise<void> => {
    for (const raw of rawUrls) {
      if (browsesTotal >= profile.maxBrowseTotal) {
        return;
      }
      const url = normalizeBrowseUrl(raw);
      if (!url || browsedUrls.has(url) || findSource(url)?.text) {
        continue;
      }
      browsedUrls.add(url);
      browsesTotal += 1;
      const step = addStep("browse", url.replace(/^https?:\/\//i, "").slice(0, 90), "SelfSurf");
      let page: Awaited<ReturnType<typeof performSurf>> | null = null;
      try {
        page = await performSurf({ action: "open", url }, jar);
      } catch {
        page = null;
      }
      ensureAlive();
      if (!page || page.status === 0) {
        finishStep(step, "error", page?.note?.slice(0, 80) || "fetch failed");
        continue;
      }
      const text = page.text.trim();
      if (!text) {
        finishStep(step, "error", page.jsHeavy ? "needs JavaScript — SelfSurf is HTTP-only" : "no readable text");
        continue;
      }
      const finalUrl = page.url.startsWith("http") ? page.url : url;
      browsedUrls.add(finalUrl);
      const title = page.title.trim() || finalUrl;
      let source = findSource(finalUrl) ?? findSource(url);
      if (!source) {
        registerHit({ url: finalUrl, title, highlights: [] });
        source = findSource(finalUrl);
      }
      if (source) {
        source.text = text.slice(0, profile.pageChars);
        source.liveAt = isoToday();
        retitle(source, title);
        if (source.highlights.length === 0) {
          source.highlights = [text.slice(0, 180).replace(/\s+/g, " ").trim()];
        }
      }
      step.label = title.slice(0, 90);
      finishStep(step, "done", `SelfSurf · ${domainOf(finalUrl)}`);
    }
  };

  try {
    // Research runs on the question text alone — attachments and workspace
    // context (skills, knowledge) never become the subject. An empty prompt
    // would leave the planner nothing and the report would riff on the skill
    // packs instead; refuse honestly before spending a single credit.
    if (params.prompt.trim().length === 0) {
      throw new Error(
        "Deep research needs a question — this run started with an empty message, so there is nothing to research.",
      );
    }
    const planStep = addStep("plan", "Planning research");
    const today = new Date().toISOString().slice(0, 10);
    const planJson = await withRetries(
      () =>
        jsonCall({
          authKey: params.authKey,
          system: plannerPrompt(profile),
          user: `Today: ${today}\nResearch question:\n"""${params.prompt.slice(0, 2000)}"""`,
          maxTokens: 400,
          onUsage: params.onUsage,
        }),
      { attempts: 2, isCancelled: params.isCancelled, shouldRetryResult: (result) => result === null },
    );
    ensureAlive();
    let queries = stringArray(planJson?.queries, profile.plannerMax);
    if (queries.length === 0) {
      queries = [params.prompt.slice(0, 200)];
    }
    finishStep(planStep, "done", planJson ? `${queries.length} queries` : "planner failed — searching the raw question");

    const promptUrls = urlsInPrompt(params.prompt);
    if (promptUrls.length > 0) {
      await browsePages(promptUrls);
      ensureAlive();
    }

    // Connected MCP servers: a bounded scout step on the fast model searches
    // their catalogs and reads the few tools whose output bears on the
    // question. Every successful read becomes a dossier source (mcp://…), so
    // the writer cites it like any page; failures stay honest in the trail.
    if (params.mcpToolset) {
      await scoutMcpConnectors(params.mcpToolset);
      ensureAlive();
    }

    // An explicit repo in the question wins; otherwise read the thread pin.
    // The pin is structured run data — system-prompt prose alone never reached
    // this deterministic GitHub preload, which made pinned private repos vanish.
    const repoRefs = githubRunRepoRefs(params.prompt, params.githubRepo);
    if (repoRefs.length > 0 && (!githubAuth || !canGitHub("get_repo"))) {
      finishStep(
        addStep("read", repoRefs.map((ref) => `${ref.owner}/${ref.repo}`).join(", "), "GitHub"),
        "error",
        !githubAuth
          ? "GitHub connector is disabled — enable it in Connections so research can read the repo"
          : "GitHub get_repo is disabled for this connector — repository preload was not allowed",
      );
    }
    if (githubAuth && canGitHub("get_repo")) {
      for (const ref of repoRefs) {
        ensureAlive();
        const step = addStep("read", `${ref.owner}/${ref.repo}`, "GitHub · overview, tree, commits, CI");
        try {
          const meta = await fetchGitHubRepoMeta(githubAuth, ref.owner, ref.repo);
          repos.set(meta.fullName.toLowerCase(), meta);
          const [owner, repo] = meta.fullName.split("/");
          const overview = [
            `${meta.fullName}${meta.isPrivate ? " (private)" : ""} — default branch: ${meta.defaultBranch}${meta.language ? ` · ${meta.language}` : ""}${meta.pushedAt ? ` · last push ${meta.pushedAt}` : ""} · ${meta.openIssues} open issues`,
            meta.description,
          ]
            .filter(Boolean)
            .join("\n");
          let tree = canGitHub("get_file_tree") ? "File tree unavailable." : "File tree tool disabled.";
          if (canGitHub("get_file_tree")) {
            try {
              tree = await callGitHubNativeTool(githubAuth, "get_file_tree", { owner, repo, ref: meta.defaultBranch });
            } catch {
              // keep the placeholder — overview and commits are still worth having
            }
          }
          upsertRepoSource(
            meta.htmlUrl,
            `${meta.fullName} — repository overview & file tree`,
            `${overview}\n\n${tree}`.slice(0, profile.pageChars * 2),
          );
          if (canGitHub("get_readme")) {
            try {
              const readme = await callGitHubNativeTool(githubAuth, "get_readme", { owner, repo });
              upsertRepoSource(`${meta.htmlUrl}#readme`, `${meta.fullName} — README`, readme.slice(0, profile.pageChars));
            } catch {
              // no README — skip the source
            }
          }
          if (canGitHub("list_commits")) {
            try {
              const commits = await callGitHubNativeTool(githubAuth, "list_commits", { owner, repo, limit: 30 });
              upsertRepoSource(`${meta.htmlUrl}/commits/${meta.defaultBranch}`, `${meta.fullName} — recent commits`, commits);
            } catch {
              // commits are optional
            }
          }
          if (["list_workflow_runs", "list_run_jobs", "get_job_logs"].every(canGitHub)) {
            try {
              const ci = await fetchRepoCiSnapshot(githubAuth, owner, repo);
            if (ci) {
              upsertRepoSource(
                `${meta.htmlUrl}/actions`,
                `${meta.fullName} — CI: recent workflow runs`,
                ci.runsText.slice(0, profile.pageChars),
              );
              if (ci.failure) {
                upsertRepoSource(ci.failure.url, ci.failure.title, ci.failure.text.slice(0, profile.pageChars));
              }
              }
            } catch {
              // Actions disabled or inaccessible — CI context is optional
            }
          }
          finishStep(step, "done", `GitHub · @${meta.defaultBranch}`);
        } catch (error) {
          if (error instanceof RunStoppedError) {
            throw error;
          }
          finishStep(step, "error", error instanceof Error ? error.message.slice(0, 120) : "unreachable");
        }
      }
      ensureAlive();
    }

    for (let wave = 1; wave <= profile.maxWaves; wave += 1) {
      const remainingBudget = Math.max(0, profile.maxQueriesTotal - usedQueries.length);
      const lowered = new Set(usedQueries.map((query) => query.toLowerCase()));
      const waveQueries = queries.filter((query) => !lowered.has(query.toLowerCase())).slice(0, remainingBudget);
      if (waveQueries.length === 0) {
        break;
      }
      const searchSteps = waveQueries.map((query) => addStep("search", query.slice(0, 90)));
      usedQueries.push(...waveQueries);
      const settled = await Promise.allSettled(
        waveQueries.map((query) => exaSearch(query, profile.resultsPerQuery, params.authKey)),
      );
      ensureAlive();
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") {
          let added = 0;
          for (const hit of result.value) {
            if (registerHit(hit)) {
              added += 1;
            }
          }
          finishStep(searchSteps[index], "done", added > 0 ? `+${added} sources` : "no new sources");
        } else {
          finishStep(searchSteps[index], "error", "search failed");
        }
      });

      const canQueryMore = wave < profile.maxWaves && usedQueries.length < profile.maxQueriesTotal;
      const canReadMore = readsTotal < profile.maxReadsTotal;
      queries = [];
      if (registry.size === 0 || (!canQueryMore && !canReadMore)) {
        continue;
      }

      const reflectStep = addStep("plan", "Reviewing findings");
      const reflectJson = await withRetries(
        () =>
          jsonCall({
            authKey: params.authKey,
            system: reflectPrompt(profile, githubAuth !== null && repos.size > 0),
            user: [
              `Research question:\n"""${params.prompt.slice(0, 1500)}"""`,
              `Queries already used:\n${usedQueries.map((query) => `- ${query}`).join("\n")}`,
              ...(reflectionNotes.length > 0
                ? [`Your notes from earlier waves:\n${reflectionNotes.map((note) => `- ${note}`).join("\n")}`]
                : []),
              `Sources so far:\n${buildReflectionList([...registry.values()], REFLECT_LIST_BUDGET)}`,
            ].join("\n\n"),
            maxTokens: 900,
            onUsage: params.onUsage,
          }),
        { attempts: 2, isCancelled: params.isCancelled, shouldRetryResult: (result) => result === null },
      );
      ensureAlive();
      if (!reflectJson) {
        // An unparseable or failed reflection must not masquerade as a
        // deliberate stop — say so and write the report from what is collected.
        finishStep(reflectStep, "error", "reflection failed twice — writing the report from sources collected so far");
        break;
      }
      const notes = typeof reflectJson.notes === "string" ? reflectJson.notes.trim() : "";
      finishStep(reflectStep, "done", notes ? notes.slice(0, 110) : undefined);
      if (notes) {
        reflectionNotes.push(`Wave ${wave}: ${notes.slice(0, REFLECTION_NOTE_CHARS)}`);
      }

      const isDone = reflectJson?.done === true && wave >= profile.minWavesBeforeDone;
      if (canQueryMore && !isDone) {
        queries = stringArray(reflectJson?.queries, profile.reflectQueries);
      }

      if (canReadMore && Array.isArray(reflectJson?.read)) {
        const byIndex = new Map<number, RegistrySource>();
        for (const source of registry.values()) {
          byIndex.set(source.index, source);
        }
        const targets: RegistrySource[] = [];
        for (const raw of reflectJson.read) {
          const source = byIndex.get(Number(String(raw).match(/\d+/)?.[0] ?? Number.NaN));
          if (source && !source.text && !targets.some((item) => item.url === source.url)) {
            targets.push(source);
          }
          if (targets.length >= Math.min(profile.readsPerWave, profile.maxReadsTotal - readsTotal)) {
            break;
          }
        }
        if (targets.length > 0) {
          const readSteps = targets.map((source) => addStep("read", source.title.slice(0, 90), domainOf(source.url)));
          let pages: Array<{ url: string; title?: string; text?: string }> = [];
          try {
            pages = await exaContents(targets.map((source) => source.url), params.authKey);
          } catch {
            pages = [];
          }
          ensureAlive();
          const matched = matchContentPages(targets, pages);
          for (let index = 0; index < targets.length; index += 1) {
            const source = targets[index];
            const page = matched[index];
            const cached = page?.text?.trim() ?? "";
            if (cached) {
              source.text = cached.slice(0, profile.pageChars);
              if (page?.title) {
                retitle(source, page.title);
              }
              readsTotal += 1;
              finishStep(readSteps[index], "done");
              continue;
            }
            // Exa has no text for this page — SelfSurf reads it live instead.
            let live: Awaited<ReturnType<typeof performSurf>> | null = null;
            try {
              live = await performSurf({ action: "open", url: source.url }, jar);
            } catch {
              live = null;
            }
            ensureAlive();
            const liveText = live && live.status > 0 ? live.text.trim() : "";
            if (liveText) {
              source.text = liveText.slice(0, profile.pageChars);
              source.liveAt = isoToday();
              retitle(source, live?.title ?? "");
              readsTotal += 1;
              finishStep(readSteps[index], "done", `${domainOf(source.url)} · via SelfSurf`);
            } else {
              finishStep(readSteps[index], "error", "no text");
            }
          }
          ensureAlive();
        }
      }

      // Reflector-picked repository reads — files, commit diffs, PR diffs.
      if (githubAuth && repos.size > 0 && Array.isArray(reflectJson?.files) && readsTotal < profile.maxReadsTotal) {
        const picks = stringArray(reflectJson.files, Math.min(profile.readsPerWave, profile.maxReadsTotal - readsTotal));
        for (const pick of picks) {
          const target = parseRepoPick(pick, repos);
          if (!target) {
            continue;
          }
          const repoKey = target.meta.fullName.toLowerCase();
          const pickKey =
            target.kind === "file"
              ? `f:${repoKey}:${target.path}`
              : target.kind === "commit"
                ? `c:${repoKey}:${target.ref.toLowerCase()}`
                : `p:${repoKey}:${target.number}`;
          if (readRepoPicks.has(pickKey)) {
            continue;
          }
          readRepoPicks.add(pickKey);
          const label =
            target.kind === "file"
              ? target.path
              : target.kind === "commit"
                ? `commit ${target.ref.slice(0, 10)}`
                : `PR #${target.number} diff`;
          const step = addStep("read", label.slice(0, 90), `GitHub · ${target.meta.fullName}`);
          const toolName =
            target.kind === "file" ? "get_contents" : target.kind === "commit" ? "get_commit" : "get_pull_files";
          if (!canGitHub(toolName)) {
            finishStep(step, "error", `${toolName} is disabled for this connector`);
            continue;
          }
          try {
            const [owner, repo] = target.meta.fullName.split("/");
            let url: string;
            let title: string;
            let text: string;
            if (target.kind === "file") {
              text = await callGitHubNativeTool(githubAuth, "get_contents", {
                owner,
                repo,
                path: target.path,
                ref: target.meta.defaultBranch,
              });
              url = `${target.meta.htmlUrl}/blob/${target.meta.defaultBranch}/${target.path}`;
              title = `${target.meta.fullName}: ${target.path}`;
            } else if (target.kind === "commit") {
              text = await callGitHubNativeTool(githubAuth, "get_commit", { owner, repo, ref: target.ref });
              url = `${target.meta.htmlUrl}/commit/${target.ref}`;
              title = `${target.meta.fullName}: commit ${target.ref.slice(0, 10)} diff`;
            } else {
              text = await callGitHubNativeTool(githubAuth, "get_pull_files", { owner, repo, number: target.number });
              url = `${target.meta.htmlUrl}/pull/${target.number}/files`;
              title = `${target.meta.fullName}: PR #${target.number} diff`;
            }
            upsertRepoSource(url, title, text);
            readsTotal += 1;
            finishStep(step, "done");
          } catch (error) {
            if (error instanceof RunStoppedError) {
              throw error;
            }
            finishStep(step, "error", error instanceof Error ? error.message.slice(0, 80) : "read failed");
          }
        }
        ensureAlive();
      }

      if (!isDone && browsesTotal < profile.maxBrowseTotal) {
        const browseTargets = stringArray(reflectJson?.browse, profile.browsePerWave);
        if (browseTargets.length > 0) {
          await browsePages(browseTargets);
          ensureAlive();
        }
      }

      if (isDone || queries.length === 0) {
        break;
      }
    }

    ensureAlive();
    const writeStep = addStep("synthesize", "Writing report", `${state.sources.length} sources`);
    const dossier = buildDossier(registry, profile.dossierCharBudget);
    const log = buildResearchLog({ queries: usedQueries, notes: reflectionNotes, steps: state.steps });
    const system = synthesisSystem(
      synthesisPrompt((params.citations ?? "numeric") === "numeric"),
      params.systemPrompt,
    );
    const messages: EngineMessage[] = [
      { role: "system", content: system },
      ...historyMessages(params.history),
      {
        role: "user",
        content: `${params.prompt}\n\n<research_dossier>\n${dossier || "No sources found — say so honestly and answer from general knowledge, flagging uncertainty."}\n</research_dossier>${log ? `\n\n<research_log>\n${log}\n</research_log>` : ""}`,
      },
    ];
    // The dossier is already collected — a network blip while writing the
    // report must not throw away the whole research run, so retry the write.
    const completion = await withRetries(
      () =>
        streamGatewayCompletion({
          authKey: params.authKey,
          modelId: params.modelId,
          messages,
          tools: [],
          fallbacks: params.fallbacks,
          handlers: { onText: params.onText },
          onUsage: params.onUsage,
        }),
      { attempts: 3, isCancelled: params.isCancelled, shouldRetryResult: (result) => !result.content.trim() },
    );
    finishStep(writeStep, "done");
    state.status = "done";
    state.finishedAt = Date.now();
    emit();
    return {
      content: completion.content,
      research: snapshot(),
      // Honest chip: set when a gateway fallback wrote the report text.
      servedBy: fallbackServedBy(params.modelId, completion.servedModelId),
    };
  } catch (error) {
    for (const step of state.steps) {
      if (step.status === "running") {
        step.status = "error";
      }
    }
    state.status = "error";
    state.finishedAt = Date.now();
    emit();
    throw error;
  }
}
