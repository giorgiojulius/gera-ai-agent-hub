import type { JuliusState, ResearchSource } from "@/lib/types";

/**
 * Rewrites bracketed citation markers using a local→shared number map.
 * Fenced blocks and inline code are left untouched; numbers without a
 * mapping stay as written (they render as plain text downstream, never a
 * wrong link). Grouped markers like [3, 12] are split into [3][12] first.
 */
export function remapCitations(text: string, remap: Map<number, number>): string {
  if (remap.size === 0 || !text.includes("[")) {
    return text;
  }
  const mapNum = (raw: string): string | null => {
    const mapped = remap.get(Number(raw));
    return mapped === undefined ? null : String(mapped);
  };
  const rewrite = (piece: string): string =>
    piece
      .replace(/\[(\d{1,3}(?:\s*,\s*\d{1,3})+)\]/g, (_match, group: string) =>
        group
          .split(",")
          .map((num) => `[${num.trim()}]`)
          .join(""),
      )
      .replace(/\[(\d{1,3})\]\((https?:\/\/[^)\s]+)\)/g, (match, num: string, url: string) => {
        const mapped = mapNum(num);
        return mapped === null ? match : `[${mapped}](${url})`;
      })
      .replace(/\[(\d{1,3})\](?!\()/g, (match, num: string) => {
        const mapped = mapNum(num);
        return mapped === null ? match : `[${mapped}]`;
      });
  return text
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((fencePart, fenceIndex) => {
      if (fenceIndex % 2 === 1) {
        return fencePart;
      }
      return fencePart
        .split(/(`[^`\n]*`)/)
        .map((piece, pieceIndex) => (pieceIndex % 2 === 1 ? piece : rewrite(piece)))
        .join("");
    })
    .join("");
}

/**
 * Research mode: every candidate cited its own private 1..N source numbering.
 * Folds them into ONE shared deduped list (state.sources) and rewrites each
 * report's markers to the shared numbers — the chairman can then merge text
 * freely, and a single source array resolves every [n] pill in the final
 * message and in manual picks.
 */
export function unifyResearchSources(state: JuliusState): void {
  const numberByUrl = new Map<string, number>();
  const shared: ResearchSource[] = [];
  for (const candidate of state.candidates) {
    const locals = candidate.research?.sources ?? [];
    if (locals.length === 0) {
      continue;
    }
    const remap = new Map<number, number>();
    locals.forEach((source, index) => {
      let assigned = numberByUrl.get(source.url);
      if (assigned === undefined) {
        assigned = shared.length + 1;
        numberByUrl.set(source.url, assigned);
        shared.push({ url: source.url, title: source.title });
      }
      remap.set(index + 1, assigned);
    });
    if (candidate.content) {
      candidate.content = remapCitations(candidate.content, remap);
    }
  }
  if (shared.length > 0) {
    state.sources = shared;
  }
}
