import { toolkitFetch } from "@/lib/toolkit";
import type { ResearchSource } from "@/lib/types";

/**
 * Hidden pre-search for ordinary chat turns: the router's queries run before
 * the model speaks, and the best pages arrive as a numbered evidence block.
 * The user never sees the block — only the resulting citations.
 */
export type Grounding = {
  /** System block with numbered evidence excerpts the model cites as [n]. */
  block: string;
  /** Sources in [n] order — seeded into the turn's citation ledger. */
  sources: ResearchSource[];
};

type ExaHit = {
  title?: string;
  url?: string;
  publishedDate?: string | null;
  highlights?: string[];
  text?: string;
};

const PER_QUERY_RESULTS = 5;
const MAX_SOURCES = 10;
const EXCERPT_CHARS = 1_300;
const TIMEOUT_MS = 12_000;

/**
 * Degrades the raw prompt into a single search query for when the router is
 * unreachable — search stays default-on even without a query plan. Exa takes
 * natural-language queries, so a trimmed prompt works as-is.
 */
export function fallbackQuery(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 160);
}

function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

async function searchOnce(query: string, signal: AbortSignal): Promise<ExaHit[]> {
  const base = { query, type: "auto", numResults: PER_QUERY_RESULTS };
  let response = await toolkitFetch("/v2/exa/search", {
    method: "POST",
    signal,
    body: JSON.stringify({
      ...base,
      contents: { highlights: true, text: { maxCharacters: EXCERPT_CHARS } },
    }),
  });
  if (!response.ok) {
    // Highlights alone still ground the answer if the richer shape is rejected.
    response = await toolkitFetch("/v2/exa/search", {
      method: "POST",
      signal,
      body: JSON.stringify({ ...base, contents: { highlights: true } }),
    });
  }
  if (!response.ok) {
    return [];
  }
  const data = (await response.json()) as { results?: ExaHit[] };
  return data.results ?? [];
}

/**
 * Runs up to 3 queries in parallel and packs deduped top pages into a
 * numbered evidence block. Best effort by design: any failure or the 12s
 * timeout returns null and the turn proceeds exactly as before.
 */
export async function fetchGrounding(
  queries: string[],
  outerSignal?: AbortSignal,
): Promise<Grounding | null> {
  const clean = [...new Set(queries.map((query) => query.trim()).filter((query) => query.length > 1))].slice(
    0,
    3,
  );
  if (clean.length === 0) {
    return null;
  }
  const controller = new AbortController();
  const timer = window.setTimeout(
    () => controller.abort(new DOMException("Grounding timed out.", "TimeoutError")),
    TIMEOUT_MS,
  );
  const onAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) {
      onAbort();
    } else {
      outerSignal.addEventListener("abort", onAbort, { once: true });
    }
  }
  try {
    const settled = await Promise.allSettled(clean.map((query) => searchOnce(query, controller.signal)));
    const buckets = settled.map((entry) => (entry.status === "fulfilled" ? entry.value : []));
    const seen = new Set<string>();
    const sources: ResearchSource[] = [];
    const lines: string[] = [];
    // Interleave: every query contributes its top hits before any query's tail.
    for (let rank = 0; rank < PER_QUERY_RESULTS && sources.length < MAX_SOURCES; rank += 1) {
      for (const bucket of buckets) {
        if (sources.length >= MAX_SOURCES) {
          break;
        }
        const hit = bucket[rank];
        const url = hit?.url?.trim();
        if (!hit || !url || !url.startsWith("http") || seen.has(url)) {
          continue;
        }
        seen.add(url);
        const title = hit.title?.trim() || url;
        sources.push({ url, title });
        const date = hit.publishedDate ? ` (${hit.publishedDate.slice(0, 10)})` : "";
        const excerpt = tidy(hit.text ?? "") || tidy((hit.highlights ?? []).join(" "));
        lines.push(
          `[${sources.length}] ${title}${date} — ${url}${excerpt ? `\n${excerpt.slice(0, EXCERPT_CHARS)}` : ""}`,
        );
      }
    }
    if (sources.length === 0) {
      return null;
    }
    const block = [
      "[Fresh web evidence — private context. The user cannot see this block; never mention it or that a pre-search ran. Just answer well.]",
      `Fetched moments ago (${new Date().toISOString().slice(0, 10)}) for the latest user request:`,
      "",
      lines.join("\n\n"),
      "",
      "Use this like your own search results: ground factual claims in the evidence and cite with the exact [n] markers above (several sources: [1][3]) instead of answering from memory. The numbering is already registered — any web_search / fetch_url calls you make continue from it. Where the evidence is thin, stale, or off-target, search or fetch deeper yourself before answering; silently ignore irrelevant entries.",
    ].join("\n");
    return { block, sources };
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onAbort);
  }
}
