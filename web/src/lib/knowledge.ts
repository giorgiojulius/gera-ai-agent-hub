/**
 * Agent knowledge — pure, offline-safe core: text reading, chunking, keyword
 * scoring, and score fusion. Formats beyond plain text (PDF/DOCX/XLSX) are
 * extracted in file-extract.ts; the semantic vector layer lives in
 * knowledge-index.ts and degrades to the keyword path in this file whenever
 * embeddings are unavailable. Docs sync inside the profile blob.
 */

import type { KnowledgeDoc } from "@/lib/types";

/** A file whose text fits here stays local (inside the synced profile blob). */
export const MAX_FILE_CHARS = 120_000;
export const MAX_DOCS_PER_AGENT = 8;
/** Total LOCAL knowledge text across ALL agents — keeps the synced profile blob under its cap. */
export const MAX_TOTAL_KNOWLEDGE_CHARS = 400_000;
/** Per-file ceiling for cloud-stored docs — the full text lives in R2, not in the blob. */
export const MAX_REMOTE_FILE_CHARS = 2_000_000;
/** Local preview kept in the blob for a cloud-stored doc — the offline fallback. */
export const LOCAL_EXCERPT_CHARS = 20_000;
/** Char budget of retrieved excerpts injected into one turn. */
export const RETRIEVAL_BUDGET_CHARS = 9_000;
const CHUNK_CHARS = 1_200;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "yml", "yaml",
  "html", "htm", "css", "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java",
  "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php", "sql", "sh", "bash", "zsh",
  "toml", "ini", "cfg", "conf", "env", "log", "tex", "srt", "vtt",
]);

/** Accept attribute for file inputs that take plain-text files. */
export const TEXT_FILE_ACCEPT = [...TEXT_EXTENSIONS].map((ext) => `.${ext}`).join(",") + ",text/*";

export function isTextLikeFile(file: File): boolean {
  if (file.type.startsWith("text/")) {
    return true;
  }
  if (file.type === "application/json" || file.type === "application/xml") {
    return true;
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(ext);
}

/** Trims text at `cap` with an honest marker; strips NUL bytes. */
export function capKnowledgeText(raw: string, cap: number = MAX_FILE_CHARS): string {
  const clean = raw.replace(/\u0000/g, "");
  if (clean.length <= cap) {
    return clean;
  }
  return `${clean.slice(0, cap)}\n… [file trimmed at ${cap.toLocaleString()} characters]`;
}

/**
 * The short local preview synced in the profile blob for a cloud-stored doc.
 * It is the honest offline fallback when the cloud copy is unreachable.
 */
export function makeLocalExcerpt(full: string): string {
  const clean = full.replace(/\u0000/g, "");
  if (clean.length <= LOCAL_EXCERPT_CHARS) {
    return clean;
  }
  return `${clean.slice(0, LOCAL_EXCERPT_CHARS)}\n… [local preview — full ${formatDocSize(clean.length)} in cloud storage]`;
}

/**
 * Where a freshly extracted file should live: small files that fit the local
 * sync budget stay in the profile blob; everything bigger goes to cloud
 * storage with a local preview.
 */
export function planKnowledgePlacement(
  fullChars: number,
  localBudgetLeft: number,
): "local" | "cloud" {
  return fullChars > MAX_FILE_CHARS || fullChars > localBudgetLeft ? "cloud" : "local";
}

/** Reads a plain-text file, trimming at MAX_FILE_CHARS with an honest marker. */
export async function readFileText(file: File): Promise<string> {
  return capKnowledgeText(await file.text());
}

/** LOCAL text size — what actually occupies the synced profile blob. */
export function knowledgeChars(docs: KnowledgeDoc[]): number {
  return docs.reduce((sum, doc) => sum + doc.text.length, 0);
}

/** True content size — cloud-stored docs count their full cloud copy. */
export function knowledgeFullChars(docs: KnowledgeDoc[]): number {
  return docs.reduce((sum, doc) => sum + (doc.fullChars ?? doc.text.length), 0);
}

export function formatDocSize(chars: number): string {
  if (chars >= 1_000_000) {
    return `${(chars / 1_000_000).toFixed(1)}M chars`;
  }
  if (chars < 1_000) {
    return `${chars} chars`;
  }
  return `${Math.round(chars / 1_000)}k chars`;
}

export type KnowledgeChunk = { doc: string; text: string };

/** Splits a doc into ~CHUNK_CHARS pieces at paragraph/line boundaries. */
function chunkDoc(doc: KnowledgeDoc): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  const paragraphs = doc.text.split(/\n{2,}/);
  let current = "";
  const flush = () => {
    const text = current.trim();
    if (text.length > 0) {
      chunks.push({ doc: doc.name, text });
    }
    current = "";
  };
  for (const para of paragraphs) {
    if (current.length + para.length + 2 > CHUNK_CHARS && current.length > 0) {
      flush();
    }
    if (para.length > CHUNK_CHARS) {
      // Giant paragraph (minified JSON, long CSV) — hard-split it.
      flush();
      for (let index = 0; index < para.length; index += CHUNK_CHARS) {
        chunks.push({ doc: doc.name, text: para.slice(index, index + CHUNK_CHARS) });
      }
      continue;
    }
    current = current.length > 0 ? `${current}\n\n${para}` : para;
  }
  flush();
  return chunks;
}

/** All docs chunked, in doc order — the shared unit for keyword and vector scoring. */
export function chunkKnowledge(docs: KnowledgeDoc[]): KnowledgeChunk[] {
  return docs.flatMap(chunkDoc);
}

/** Distinct query terms (≥3 chars, unicode-aware), capped at 24. */
export function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((token) => token.length >= 3),
    ),
  ].slice(0, 24);
}

/**
 * Keyword relevance per chunk: rare terms weigh more (IDF), plus a bonus for
 * containing the whole query phrase. Returns scores aligned with `chunks`.
 */
export function keywordScoreChunks(chunks: KnowledgeChunk[], query: string): number[] {
  const terms = queryTerms(query);
  const lowered = chunks.map((chunk) => chunk.text.toLowerCase());
  if (terms.length === 0) {
    return chunks.map(() => 0);
  }
  // Rare terms weigh more: matching "refund-policy" beats matching "the".
  const docFreq = new Map<string, number>();
  for (const term of terms) {
    let count = 0;
    for (const text of lowered) {
      if (text.includes(term)) {
        count += 1;
      }
    }
    docFreq.set(term, count);
  }
  const phrase = query.trim().toLowerCase();
  return chunks.map((chunk, index) => {
    let score = 0;
    for (const term of terms) {
      if (lowered[index].includes(term)) {
        score += 1 + Math.log(chunks.length / (1 + (docFreq.get(term) ?? 0)));
      }
    }
    if (phrase.length >= 8 && lowered[index].includes(phrase)) {
      score += 3;
    }
    return score;
  });
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

const RRF_K = 60;

/**
 * Reciprocal-rank fusion of the keyword ranking and the vector ranking.
 * Chunks missing a vector (null sim) compete on keyword rank alone; when all
 * sims are null the fused order equals the keyword order. RRF needs no score
 * normalization, which keeps the two signals honest about their own scales.
 */
export function fuseScores(keywordScores: number[], vectorSims: (number | null)[]): number[] {
  const fused = keywordScores.map(() => 0);
  const byKeyword = keywordScores
    .map((score, index) => ({ score, index }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  byKeyword.forEach((entry, rank) => {
    fused[entry.index] += 1 / (RRF_K + rank + 1);
  });
  const byVector = vectorSims
    .map((sim, index) => ({ sim, index }))
    .filter((entry): entry is { sim: number; index: number } => entry.sim !== null)
    .sort((a, b) => b.sim - a.sim);
  byVector.forEach((entry, rank) => {
    fused[entry.index] += 1 / (RRF_K + rank + 1);
  });
  return fused;
}

/** System-prompt header; the retrieval note stays honest about the active mode. */
export function knowledgeHeader(mode: "keyword" | "hybrid"): string {
  const retrieval =
    mode === "hybrid"
      ? "Retrieval is hybrid (keyword + semantic)"
      : "Retrieval is keyword-based";
  return `AGENT KNOWLEDGE — excerpts from files the user attached to this agent. Treat them as the primary source for questions they cover; quote them instead of guessing. ${retrieval}, so ask the user to point at a file if something seems missing.`;
}

/** Honest empty-retrieval message: lists what exists so the model can ask, not guess. */
export function noMatchMessage(docs: KnowledgeDoc[], header: string): string {
  return `${header}\n\nFiles on hand: ${docs.map((doc) => doc.name).join(", ")}. No excerpt matched this message — ask the user which file to look into if their question should be covered.`;
}

/** Packs ranked chunks into the budget; always includes at least one. */
export function packExcerpts(chunks: KnowledgeChunk[], budget: number): string {
  const parts: string[] = [];
  let used = 0;
  for (const chunk of chunks) {
    if (used + chunk.text.length > budget && parts.length > 0) {
      break;
    }
    parts.push(`[file: ${chunk.doc}]\n${chunk.text}`);
    used += chunk.text.length;
  }
  return parts.join("\n\n---\n\n");
}

/**
 * Keyword-only retrieval — the offline-safe fallback. Small knowledge bases
 * are injected whole; larger ones are chunked and scored by rare-term
 * keyword overlap. Returns "" when there is nothing.
 */
export function retrieveKnowledge(
  docs: KnowledgeDoc[],
  query: string,
  budget: number = RETRIEVAL_BUDGET_CHARS,
): string {
  const usable = docs.filter((doc) => doc.text.trim().length > 0);
  if (usable.length === 0) {
    return "";
  }
  const header = knowledgeHeader("keyword");

  const total = knowledgeChars(usable);
  if (total <= budget) {
    const whole = usable
      .map((doc) => `[file: ${doc.name}]\n${doc.text.trim()}`)
      .join("\n\n");
    return `${header}\n\n${whole}`;
  }

  if (queryTerms(query).length === 0) {
    // No usable query terms — fall back to the freshest docs' openings.
    const opening = usable
      .map((doc) => `[file: ${doc.name}]\n${doc.text.slice(0, Math.floor(budget / usable.length))}`)
      .join("\n\n");
    return `${header}\n\n${opening}`;
  }

  const chunks = chunkKnowledge(usable);
  const scores = keywordScoreChunks(chunks, query);
  const picked = chunks
    .map((chunk, index) => ({ chunk, score: scores[index] }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.chunk);
  if (picked.length === 0) {
    return noMatchMessage(usable, header);
  }
  return `${header}\n\n${packExcerpts(picked, budget)}`;
}
