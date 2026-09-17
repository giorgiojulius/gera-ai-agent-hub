// Council v2 — Jev (TypeSafe AI's decision model on the AI Gateway) as the
// editorial board of a Julius panel. Jev generates no text: it answers typed
// questions about one shared state and returns calibrated probabilities. The
// board asks it, with the Verifier's fact-check as evidence, (1) which
// candidate is the backbone of the final answer, (2) how trustworthy every
// candidate is, and (3) for every block of every candidate whether it goes
// into the final answer as is (KEEP), with the Verifier's correction (FIX),
// or not at all (DROP — wrong / redundant). The chairman then only writes.
//
// Platform-neutral (fetch + JSON); web unit tests import it directly.

import { capText, GatewayRequestError, isTransientGatewayError, TOOLKIT_URL, withRetries } from "./agent-engine";
import type { JuliusBoard, JuliusBoardBlock, JuliusBoardDecision, JuliusBoardQuality } from "./run-protocol";

export const JEV_MODEL_ID = "typesafe-ai/jev";
/** AI SDK v4 evaluation endpoint of the gateway, behind the toolkit proxy. */
export const JEV_EVALUATION_PATH = "/v2/vercel/v4/ai/evaluation-model";
export const JEV_TIMEOUT_MS = 60_000;
export const JEV_ATTEMPTS = 3;
/** Blocks per candidate the board rules on; smaller blocks are merged to fit. */
export const MAX_BLOCKS_PER_CANDIDATE = 24;
const MIN_BLOCK_CHARS = 80;
const EXCERPT_CHARS = 160;
const REQUEST_CHARS = 4_000;
const VERIFIER_CHARS = 6_000;
const DEFAULT_CANDIDATE_CHARS = 12_000;

export const QUALITY_LEVELS = ["unreliable", "usable with caveats", "solid", "excellent"] as const;
const QUALITY_CRITERIA: string[] = [
  "Unreliable — wrong on the substance, misses the request, or rests on claims the Verifier found false.",
  "Usable with caveats — partly right; needs the Verifier's corrections before it can be trusted.",
  "Solid — correct and complete enough to trust as it stands.",
  "Excellent — correct, complete, well-grounded and directly useful to the user.",
];
export const BLOCK_DECISIONS: JuliusBoardDecision[] = ["keep", "fix", "drop_wrong", "drop_redundant"];
const BLOCK_CRITERIA: Record<JuliusBoardDecision, string> = {
  keep: "Correct, relevant to the request, and not already covered by a kept part of the backbone — it belongs in the final answer as written.",
  fix: "Worth keeping, but a claim in it needs the Verifier's correction (a wrong or stale number, date, name, version) or an unfounded statement needs tightening.",
  drop_wrong:
    "Contradicted by the Verifier's report or by verified material, unfounded, harmful, or off the request — it must not appear in the final answer.",
  drop_redundant:
    "Correct, but it duplicates material already present in the backbone (or earlier in this same answer) and adds nothing beyond it.",
};

const BOARD_TASK =
  "An editorial board is turning candidate answers to one user request into a single final answer. A neutral Verifier fact-checked the candidates; its report is the evidence — weigh it heavily, discount style. Judge only what serves the user who asked the request.";
const BLOCK_TASK =
  "An editorial board is assembling the final answer to one user request from candidate answers. The backbone candidate is the base of the final answer; other candidates contribute only what adds to it. Rule on each block of the candidate below: keep as written, keep with the Verifier's fix, drop as wrong, or drop as redundant with the backbone.";

// ---------------------------------------------------------------------------
// Jev wire.

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "boolean"; instructions: string; criteria?: { true?: string; false?: string } };

export type JevAnswer =
  | { type: "choice"; choice: string; probabilities?: Record<string, number> }
  | { type: "score"; score: number; probabilities?: Record<string, number> }
  | { type: "boolean"; probability: number };

export type JevEvaluation = {
  answers: Record<string, JevAnswer>;
  inputTokens: number;
  elapsedMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProbabilities(raw: unknown): Record<string, number> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseAnswer(raw: unknown, question: JevQuestion, id: string): JevAnswer {
  if (!isRecord(raw) || raw.type !== question.type) {
    throw new Error(`Jev returned no ${question.type} answer for "${id}"`);
  }
  if (question.type === "choice") {
    if (typeof raw.choice !== "string" || !(raw.choice in question.criteria)) {
      throw new Error(`Jev picked an unknown option for "${id}"`);
    }
    return { type: "choice", choice: raw.choice, probabilities: parseProbabilities(raw.probabilities) };
  }
  if (question.type === "score") {
    if (typeof raw.score !== "number" || !Number.isFinite(raw.score)) {
      throw new Error(`Jev returned no score for "${id}"`);
    }
    return { type: "score", score: raw.score, probabilities: parseProbabilities(raw.probabilities) };
  }
  if (typeof raw.probability !== "number" || !Number.isFinite(raw.probability)) {
    throw new Error(`Jev returned no probability for "${id}"`);
  }
  return { type: "boolean", probability: raw.probability };
}

/** Parses a gateway evaluation response against the questions that were asked. */
export function parseJevEvaluation(
  payload: unknown,
  questions: Record<string, JevQuestion>,
  elapsedMs: number,
): JevEvaluation {
  const answersRaw = isRecord(payload) && isRecord(payload.answers) ? payload.answers : null;
  if (!answersRaw) {
    throw new Error("Jev returned no answers");
  }
  const answers: Record<string, JevAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    answers[id] = parseAnswer(answersRaw[id], question, id);
  }
  const usage = isRecord(payload) && isRecord(payload.usage) ? payload.usage : {};
  const inputTokens = typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;
  return { answers, inputTokens, elapsedMs };
}

export type JevCallParams = {
  authKey: string;
  state: unknown;
  questions: Record<string, JevQuestion>;
  fetchImpl?: typeof fetch;
  isCancelled?: () => boolean;
};

/**
 * One Jev evaluation through the toolkit proxy. Transient gateway failures
 * (408/425/429/5xx, resets) are retried; auth/schema errors are not. Malformed
 * answers throw plainly — the board then refuses honestly instead of guessing.
 */
export async function evaluateWithJev(params: JevCallParams): Promise<JevEvaluation> {
  const fetchImpl = params.fetchImpl ?? fetch;
  return withRetries(
    async () => {
      const startedAt = Date.now();
      const response = await fetchImpl(`${TOOLKIT_URL}${JEV_EVALUATION_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.authKey}`,
          "ai-gateway-protocol-version": "0.0.1",
          "ai-evaluation-model-specification-version": "4",
          "ai-model-id": JEV_MODEL_ID,
        },
        body: JSON.stringify({ state: params.state, questions: params.questions }),
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new GatewayRequestError(response.status, await response.text().catch(() => ""));
      }
      const payload: unknown = await response.json();
      return parseJevEvaluation(payload, params.questions, Date.now() - startedAt);
    },
    { attempts: JEV_ATTEMPTS, isCancelled: params.isCancelled, shouldRetryError: isTransientGatewayError },
  );
}

// ---------------------------------------------------------------------------
// Blocks.

export type BoardBlock = { id: string; candidate: number; text: string };

export function candidateLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Whitespace-collapsed opening of a block for the panel and the plan. */
export function excerptOf(text: string, limit = EXCERPT_CHARS): string {
  const flat = collapse(text);
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

const HEADING_LINE = /^\s{0,3}#{1,6}\s/;

function isHeadingOnly(paragraph: string): boolean {
  return paragraph.split("\n").every((line) => HEADING_LINE.test(line));
}

/**
 * Splits an answer into the blocks Jev rules on: fenced code stays atomic,
 * paragraphs / lists / tables split on blank lines, a heading introduces the
 * block after it, fragments under MIN_BLOCK_CHARS ride with a neighbour, and
 * the smallest adjacent pairs merge until the count fits `maxBlocks`. Ids are
 * `<letter><n>` in reading order — the same ids the editor sees as markers.
 */
export function splitBlocks(
  text: string,
  letter: string,
  maxBlocks = MAX_BLOCKS_PER_CANDIDATE,
): Array<{ id: string; text: string }> {
  const pieces: string[] = [];
  text.split(/(```[\s\S]*?(?:```|$))/).forEach((part, index) => {
    if (index % 2 === 1) {
      if (part.trim()) {
        pieces.push(part.trim());
      }
      return;
    }
    for (const paragraph of part.split(/\n[ \t]*\n+/)) {
      const trimmed = paragraph.trim();
      if (trimmed) {
        pieces.push(trimmed);
      }
    }
  });
  const headed: string[] = [];
  let pendingHeading: string | null = null;
  for (const piece of pieces) {
    if (isHeadingOnly(piece)) {
      pendingHeading = pendingHeading ? `${pendingHeading}\n\n${piece}` : piece;
      continue;
    }
    headed.push(pendingHeading ? `${pendingHeading}\n\n${piece}` : piece);
    pendingHeading = null;
  }
  if (pendingHeading) {
    headed.push(pendingHeading);
  }
  // A fenced code block is a whole unit however short; prose fragments ride with a neighbour.
  const isFragment = (piece: string): boolean => piece.length < MIN_BLOCK_CHARS && !piece.startsWith("```");
  const sized: string[] = [];
  for (const piece of headed) {
    const last = sized.length - 1;
    if (last >= 0 && isFragment(sized[last])) {
      sized[last] = `${sized[last]}\n\n${piece}`;
    } else {
      sized.push(piece);
    }
  }
  if (sized.length > 1 && isFragment(sized[sized.length - 1])) {
    const tail = sized.pop() ?? "";
    sized[sized.length - 1] = `${sized[sized.length - 1]}\n\n${tail}`;
  }
  while (sized.length > Math.max(1, maxBlocks)) {
    let best = 0;
    let bestSize = Number.POSITIVE_INFINITY;
    for (let index = 0; index + 1 < sized.length; index += 1) {
      const size = sized[index].length + sized[index + 1].length;
      if (size < bestSize) {
        bestSize = size;
        best = index;
      }
    }
    sized.splice(best, 2, `${sized[best]}\n\n${sized[best + 1]}`);
  }
  return sized.map((block, index) => ({ id: `${letter}${index + 1}`, text: block }));
}

/** A candidate's text with every block introduced by its ⟦id⟧ marker (what the editor reads). */
export function markBlocks(blocks: Array<{ id: string; text: string }>): string {
  return blocks.map((block) => `⟦${block.id}⟧\n${block.text}`).join("\n\n");
}

// ---------------------------------------------------------------------------
// The board.

export type BoardCandidate = {
  /** Index in the panel's candidate list (letters derive from it). */
  index: number;
  modelId: string;
  content: string;
  status: "running" | "done" | "error";
};

export type JevBoardOutcome = {
  board: JuliusBoard;
  /** Index of the backbone (the single candidate when there is only one). */
  winner: number;
  /** Every ruled block in reading order, grouped by candidate. */
  blocks: BoardBlock[];
};

export type JevBoardParams = {
  authKey: string;
  prompt: string;
  candidates: BoardCandidate[];
  /** The Verifier's report; null when it failed (the board is told so). */
  verifierReport: string | null;
  /** Cap applied to every candidate text before splitting (the editor sees the same cap). */
  candidateChars?: number;
  maxBlocksPerCandidate?: number;
  fetchImpl?: typeof fetch;
  isCancelled?: () => boolean;
  /** Called after the backbone round with the partial board (blocks still pending). */
  onProgress?: (board: JuliusBoard) => void;
  onUsage?: (modelId: string, usage: unknown, service?: boolean) => void;
};

function chosenProbability(answer: Extract<JevAnswer, { type: "choice" }>): number | undefined {
  return answer.probabilities?.[answer.choice];
}

function qualityOf(index: number, answer: Extract<JevAnswer, { type: "score" }>): JuliusBoardQuality {
  const clamped = Math.min(QUALITY_LEVELS.length - 1, Math.max(0, answer.score));
  let levelIndex = Math.round(clamped);
  let confidence = 1;
  if (answer.probabilities) {
    let best = -1;
    for (const [key, probability] of Object.entries(answer.probabilities)) {
      const level = Number(key);
      if (Number.isInteger(level) && level >= 0 && level < QUALITY_LEVELS.length && probability > best) {
        best = probability;
        levelIndex = level;
      }
    }
    if (best >= 0) {
      confidence = best;
    }
  }
  return { candidate: index, score: clamped, level: QUALITY_LEVELS[levelIndex], confidence };
}

function decisionProbabilities(
  probabilities: Record<string, number> | undefined,
): Record<JuliusBoardDecision, number> | undefined {
  if (!probabilities) {
    return undefined;
  }
  const out = {} as Record<JuliusBoardDecision, number>;
  for (const decision of BLOCK_DECISIONS) {
    out[decision] = probabilities[decision] ?? 0;
  }
  return out;
}

function reportOrNote(report: string | null): string {
  return report && report.trim() ? capText(report, VERIFIER_CHARS) : "(the Verifier's report is unavailable — judge on internal consistency and the request alone)";
}

/**
 * Runs Jev's board: one call picks the backbone and grades every candidate,
 * then one call per candidate rules on its blocks (the non-backbone calls see
 * the backbone's text so redundancy is judged against it). Throws when Jev is
 * unreachable or answers off-schema — the panel then refuses honestly.
 */
export async function runJevBoard(params: JevBoardParams): Promise<JevBoardOutcome> {
  const startedAt = Date.now();
  const candidateChars = params.candidateChars ?? DEFAULT_CANDIDATE_CHARS;
  const maxBlocks = params.maxBlocksPerCandidate ?? MAX_BLOCKS_PER_CANDIDATE;
  const candidates = params.candidates.filter((candidate) => candidate.content.trim().length > 0);
  if (candidates.length === 0) {
    throw new Error("no candidate produced text");
  }
  const request = capText(params.prompt, REQUEST_CHARS);
  const verifier = reportOrNote(params.verifierReport);
  const texts = new Map<number, string>(
    candidates.map((candidate) => [candidate.index, capText(candidate.content, candidateChars)]),
  );
  const blocks: BoardBlock[] = [];
  for (const candidate of candidates) {
    for (const block of splitBlocks(texts.get(candidate.index) ?? "", candidateLetter(candidate.index), maxBlocks)) {
      blocks.push({ id: block.id, candidate: candidate.index, text: block.text });
    }
  }
  let inputTokens = 0;
  const account = (evaluation: JevEvaluation): void => {
    inputTokens += evaluation.inputTokens;
    params.onUsage?.(JEV_MODEL_ID, { input_tokens: evaluation.inputTokens, output_tokens: 0 }, true);
  };

  // Round 1 — backbone + quality over every candidate.
  const roundOne: Record<string, JevQuestion> = {};
  if (candidates.length > 1) {
    const criteria: Record<string, string> = {};
    for (const candidate of candidates) {
      criteria[candidateLetter(candidate.index)] = `Candidate ${candidateLetter(candidate.index)} (${candidate.modelId})`;
    }
    roundOne.backbone = {
      type: "choice",
      instructions:
        "Which candidate should be the backbone of the final answer — the most correct, complete and useful answer to the request, with the Verifier's findings weighed heavily?",
      criteria,
    };
  }
  for (const candidate of candidates) {
    roundOne[`quality_${candidateLetter(candidate.index)}`] = {
      type: "score",
      instructions: `How trustworthy is candidate ${candidateLetter(candidate.index)}'s answer to the request, given the Verifier's report?`,
      criteria: QUALITY_CRITERIA,
    };
  }
  const first = await evaluateWithJev({
    authKey: params.authKey,
    state: {
      task: BOARD_TASK,
      request,
      verifier_report: verifier,
      candidates: candidates.map((candidate) => ({
        letter: candidateLetter(candidate.index),
        model: candidate.modelId,
        ...(candidate.status === "error" ? { note: "incomplete — generation was interrupted" } : {}),
        text: texts.get(candidate.index) ?? "",
      })),
    },
    questions: roundOne,
    fetchImpl: params.fetchImpl,
    isCancelled: params.isCancelled,
  });
  account(first);

  let winner = candidates[0].index;
  let backbone: JuliusBoard["backbone"];
  if (candidates.length > 1) {
    const answer = first.answers.backbone;
    if (answer.type !== "choice") {
      throw new Error("Jev returned no backbone choice");
    }
    winner = answer.choice.charCodeAt(0) - 65;
    const probabilities = candidates.map((candidate) => answer.probabilities?.[candidateLetter(candidate.index)] ?? 0);
    backbone = { winner, probabilities, confidence: chosenProbability(answer) ?? 1 };
  }
  const quality: JuliusBoardQuality[] = candidates.map((candidate) => {
    const answer = first.answers[`quality_${candidateLetter(candidate.index)}`];
    if (answer.type !== "score") {
      throw new Error(`Jev returned no quality score for ${candidateLetter(candidate.index)}`);
    }
    return qualityOf(candidate.index, answer);
  });
  const partial: JuliusBoard = {
    modelId: JEV_MODEL_ID,
    status: "running",
    ...(backbone ? { backbone } : {}),
    quality,
    blocks: [],
    inputTokens,
    elapsedMs: Date.now() - startedAt,
  };
  params.onProgress?.(partial);
  if (params.isCancelled?.()) {
    throw new Error("Stopped.");
  }

  // Round 2 — block rulings, one call per candidate, in parallel.
  const backboneText = texts.get(winner) ?? "";
  const ruled = await Promise.all(
    candidates.map(async (candidate) => {
      const own = blocks.filter((block) => block.candidate === candidate.index);
      const questions: Record<string, JevQuestion> = {};
      for (const block of own) {
        questions[`block_${block.id}`] = {
          type: "choice",
          instructions: `Block ${block.id} of candidate ${candidateLetter(candidate.index)}: keep it in the final answer as written, keep it with the Verifier's fix, drop it as wrong, or drop it as redundant?`,
          criteria: BLOCK_CRITERIA,
        };
      }
      const evaluation = await evaluateWithJev({
        authKey: params.authKey,
        state: {
          task: BLOCK_TASK,
          request,
          verifier_report: verifier,
          ...(candidate.index === winner
            ? {}
            : { backbone: { letter: candidateLetter(winner), text: backboneText } }),
          candidate: {
            letter: candidateLetter(candidate.index),
            model: candidate.modelId,
            is_backbone: candidate.index === winner,
            blocks: own.map((block) => ({ id: block.id, text: block.text })),
          },
        },
        questions,
        fetchImpl: params.fetchImpl,
        isCancelled: params.isCancelled,
      });
      account(evaluation);
      return own.map((block): JuliusBoardBlock => {
        const answer = evaluation.answers[`block_${block.id}`];
        if (answer.type !== "choice" || !BLOCK_DECISIONS.includes(answer.choice as JuliusBoardDecision)) {
          throw new Error(`Jev returned no ruling for block ${block.id}`);
        }
        const probability = chosenProbability(answer);
        return {
          id: block.id,
          candidate: block.candidate,
          excerpt: excerptOf(block.text),
          chars: block.text.length,
          decision: answer.choice as JuliusBoardDecision,
          ...(probability === undefined ? {} : { probability }),
          ...(answer.probabilities ? { probabilities: decisionProbabilities(answer.probabilities) } : {}),
        };
      });
    }),
  );
  const board: JuliusBoard = {
    ...partial,
    status: "done",
    blocks: ruled.flat(),
    inputTokens,
    elapsedMs: Date.now() - startedAt,
  };
  return { board, winner, blocks };
}

// ---------------------------------------------------------------------------
// The plan the editor reads.

function percent(value: number | undefined): string {
  return value === undefined ? "n/a" : `${Math.round(value * 100)}%`;
}

const DECISION_LABEL: Record<JuliusBoardDecision, string> = {
  keep: "KEEP",
  fix: "FIX — apply the Verifier's correction",
  drop_wrong: "DROP (wrong)",
  drop_redundant: "DROP (redundant)",
};

/** The plan the editor writes from: backbone, per-candidate quality, one line per block. */
export function boardPlanText(board: JuliusBoard, candidateModelIds: Map<number, string>): string {
  const lines: string[] = ["BOARD PLAN — Jev's rulings; the probability of each ruling is in brackets:"];
  if (board.backbone) {
    lines.push(`Backbone: candidate ${candidateLetter(board.backbone.winner)} (${percent(board.backbone.confidence)}). Build the final answer on it.`);
  }
  const indices = [...new Set(board.blocks.map((block) => block.candidate))].sort((a, b) => a - b);
  for (const index of indices) {
    const quality = board.quality.find((item) => item.candidate === index);
    lines.push(
      `Candidate ${candidateLetter(index)}${candidateModelIds.has(index) ? ` (${candidateModelIds.get(index)})` : ""}${
        quality ? ` — quality: ${quality.level}` : ""
      }:`,
    );
    for (const block of board.blocks.filter((item) => item.candidate === index)) {
      const probability = block.probability === undefined ? "" : ` [${block.probability.toFixed(2)}]`;
      lines.push(`- ${block.id} ${DECISION_LABEL[block.decision]}${probability} "${excerptOf(block.excerpt, 90)}"`);
    }
  }
  return lines.join("\n");
}
