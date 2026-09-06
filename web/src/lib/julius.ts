import { fallbackServedBy, runAgentTurn, streamCompletion } from "@/lib/chat";
import { unifyResearchSources } from "@/lib/citations";
import { newId } from "@/lib/env";
import { errorFromUnknown, withRetries } from "@/lib/errors";
import { SURF_TOOL_NAMES } from "@/lib/selfsurf";
import { builtinOpenAiTools } from "@/lib/tools";
import type {
  BuiltinToolId,
  ChatMessage,
  JuliusCandidateState,
  JuliusReviewState,
  JuliusSettings,
  JuliusState,
  OpenAiTool,
  ResearchSource,
  ResearchState,
} from "@/lib/types";

/** One candidate = the council quality-checks a single answer; 2+ = they compete. */
export const JULIUS_MIN_CANDIDATES = 1;
export const JULIUS_MAX_CANDIDATES = 4;

/**
 * The ruling and the final synthesis are the last, most expensive steps — a
 * transient network blip there must not throw away the whole council run, so
 * both get this many automatic attempts before falling back honestly.
 */
const COUNCIL_ATTEMPTS = 3;

/** Char caps keeping the debate transcript inside sane token budgets. */
const PROMPT_CHARS = 4_000;
const CANDIDATE_CHARS = 12_000;
const REVIEW_CHARS = 6_000;

export function defaultJuliusSettings(): JuliusSettings {
  return {
    candidateModelIds: ["spacexai/grok-4.6:xhigh", "openai/gpt-5.6-terra", "anthropic/claude-opus-5"],
    decision: "council",
    proponentModelId: "openai/gpt-5.6-sol",
    criticModelId: "spacexai/grok-4.6:high",
    verifierModelId: "google/gemini-3.7-flash",
    chairmanModelId: "spacexai/grok-4.6:xhigh",
  };
}

export function juliusLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

function cap(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n… [truncated]`;
}

/** Keeps only the live tail of a reasoning stream — enough to show life, cheap to hold. */
function thinkingTail(full: string): string {
  return full.length > 1600 ? `…${full.slice(-1600)}` : full;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function proponentPrompt(count: number): string {
  const closing =
    count > 1
      ? ` End with one final line "Champion: <letter>" naming the candidate you would crown, with one sentence why.`
      : ` Never invent praise the text does not earn — only strengths that are actually there.`;
  return `You are the PROPONENT on a review board examining candidate answer(s) to a user request. Your fixed role: you ALWAYS argue FOR. Find the genuine strengths, best ideas, and practical value — never criticize anything, the Critic handles that. Format: a short bold header per candidate letter with 2-4 bullet strengths, quoting short fragments as evidence.${closing}`;
}

function criticPrompt(count: number): string {
  const closing =
    count > 1
      ? ` End with one final line "Weakest: <letter>" with one sentence why.`
      : ` If something is genuinely solid, attack the next weakest point instead of inventing flaws.`;
  return `You are the CRITIC (adversary) on a review board examining candidate answer(s) to a user request. Your fixed role: you ALWAYS attack. Hunt for logical flaws, factual errors, risky advice, omissions, vagueness, and unfounded claims — never praise anything, the Proponent handles that. Format: a short bold header per candidate letter with 2-4 bullet weaknesses, quoting short fragments as evidence. Be concise, specific, and ruthless.${closing}`;
}

/** Verifier duties: facts + freshness; with the browser armed it may open live pages when search is stale. */
function verifierTask(surfEnabled: boolean): string {
  const today = new Date().toISOString().slice(0, 10);
  const browser = surfEnabled
    ? ` If search snippets are dated or thin for a time-sensitive claim, open the live source directly with the SelfSurf browser: surf_open the official site, registry, docs, changelog, or price page; surf_follow links; surf_find text on the page. SelfSurf keeps cookies and follows redirects but does NOT run JavaScript — if a page needs JS, say so honestly instead of guessing.`
    : "";
  return `You are the VERIFIER on a review board. Today is ${today}. Below are candidate answer(s) to a user request. Check the facts, numbers, dates, names, calculations, and whether each one actually fulfils the user's request. ALSO check FRESHNESS: for every time-sensitive claim (prices, versions, releases, rankings, schedules, laws, people in office, live stats) verify it still holds TODAY — use web_search with the "recency" filter for anything that changes.${browser} Format: a short bold header per candidate letter listing: verified claims (✓), wrong claims (✗ with the correction), stale claims (⏳ with the current value and its date), unverifiable claims (?), and any requirement violations. Stay neutral — no opinions on style or preference, facts only.`;
}

function chairmanPrompt(candidateCount: number, researchMode: boolean): string {
  if (candidateCount <= 1) {
    return `You are the CHAIRMAN of a quality board. A single answer to the user's request was reviewed by a Proponent (argues for by design), a Critic (attacks by design), and a Verifier (neutral fact-checker). Discount the Proponent's excess praise and the Critic's excess hostility; weigh the Verifier's evidence heavily. Judge whether the answer can be trusted as is.

Respond in EXACTLY this format:
VERDICT: <3-6 sentences: overall quality call (solid / usable with caveats / unreliable), which criticisms and verification findings actually matter — with the concrete corrections, and what is confirmed solid.>`;
  }
  const researchNote = researchMode
    ? " Every candidate is a deep-research report produced by a different model over the same question. Judge factual accuracy, honesty and quality of sourcing, depth, and how well each actually answers the request — a correct, well-sourced report beats a longer padded one."
    : "";
  return `You are the CHAIRMAN of a decision board. ${candidateCount} candidate answers to the same user request were produced in parallel, then reviewed by a Proponent (argues for by design), a Critic (attacks by design), and a Verifier (neutral fact-checker). Discount the Proponent's excess praise and the Critic's excess hostility; weigh the Verifier's evidence heavily. Pick the single answer that serves the user best.${researchNote}

Respond in EXACTLY this format:
WINNER: <letter>
VERDICT: <3-6 sentences: why this candidate wins, the strongest argument against it and why it does not change the outcome, plus any caveat the user should know.>`;
}

/** Number → link table appended to the debate transcript in research mode. */
function sourceIndexBlock(sources: ResearchSource[] | undefined): string | null {
  if (!sources || sources.length === 0) {
    return null;
  }
  const lines = sources
    .slice(0, 150)
    .map((source, index) => `[${index + 1}] ${source.title.slice(0, 110)} — ${source.url}`);
  if (sources.length > lines.length) {
    lines.push(`…plus ${sources.length - lines.length} more — never cite numbers beyond the list above.`);
  }
  return `SOURCE INDEX — the shared numbering every candidate report cites via [n] markers:\n${lines.join("\n")}`;
}

function buildTranscript(
  prompt: string,
  candidates: JuliusCandidateState[],
  sources?: ResearchSource[],
): string {
  const parts = [`USER REQUEST:\n"""\n${cap(prompt, PROMPT_CHARS)}\n"""`];
  candidates.forEach((candidate, index) => {
    if (!candidate.content.trim()) {
      return;
    }
    const flag = candidate.status === "error" ? " (incomplete — generation was interrupted)" : "";
    const tag = candidate.label
      ? " (deep-research report: an independent multi-wave web investigation with cited sources)"
      : "";
    parts.push(
      `CANDIDATE ${juliusLetter(index)} — model ${candidate.modelId}${tag}${flag}:\n"""\n${cap(candidate.content, CANDIDATE_CHARS)}\n"""`,
    );
  });
  const index = sourceIndexBlock(sources);
  if (index) {
    parts.push(index);
  }
  return parts.join("\n\n");
}

function parseChairman(text: string, candidates: JuliusCandidateState[]): { winner: number; verdict: string } {
  const valid = (index: number): boolean =>
    index >= 0 && index < candidates.length && candidates[index].content.trim().length > 0;
  const match = /WINNER\s*:\s*([A-Z])/i.exec(text);
  let winner = match ? match[1].toUpperCase().charCodeAt(0) - 65 : -1;
  if (!valid(winner)) {
    winner = candidates.findIndex((item) => item.status === "done" && item.content.trim().length > 0);
  }
  if (!valid(winner)) {
    winner = candidates.findIndex((item) => item.content.trim().length > 0);
  }
  const verdict = text
    .replace(/^\s*WINNER\s*:.*$/im, "")
    .replace(/^\s*VERDICT\s*:\s*/im, "")
    .trim();
  return { winner: Math.max(0, winner), verdict: verdict || text.trim() };
}

/**
 * Web-only tool pool for candidates — no media generation, no SelfSurf
 * (parallel candidates each browsing with separate sessions would multiply
 * cost without a shared jar; the main chat turn is the surf surface).
 */
function reviewWebTools(builtins: Record<BuiltinToolId, boolean>): OpenAiTool[] {
  return builtinOpenAiTools({
    web_search: builtins.web_search,
    fetch_url: builtins.fetch_url,
    selfsurf: false,
    generate_image: false,
    generate_video: false,
    generate_audio: false,
  });
}

/**
 * The verifier ALSO gets the SelfSurf browser (when the master toggle allows):
 * it is a single reviewer with one session, so cost stays flat — and freshness
 * checks often need the live page, not a cached search snippet.
 */
function verifierTools(builtins: Record<BuiltinToolId, boolean>): OpenAiTool[] {
  return builtinOpenAiTools({
    web_search: builtins.web_search,
    fetch_url: builtins.fetch_url,
    selfsurf: builtins.selfsurf,
    generate_image: false,
    generate_video: false,
    generate_audio: false,
  });
}

type Emitter = {
  emit: (force?: boolean) => void;
  snapshot: () => JuliusState;
};

/** Deep-copy snapshots + throttled emission: parallel streams must not flood setState. */
function makeEmitter(state: JuliusState, onUpdate: (julius: JuliusState) => void): Emitter {
  const snapshot = (): JuliusState => ({
    ...state,
    candidates: state.candidates.map((item) => ({
      ...item,
      toolCalls: item.toolCalls?.map((call) => ({ ...call })),
    })),
    reviews: state.reviews.map((item) => ({
      ...item,
      toolCalls: item.toolCalls?.map((call) => ({ ...call })),
    })),
  });
  let lastEmit = 0;
  let trailing: number | null = null;
  const emit = (force = false): void => {
    if (force) {
      if (trailing !== null) {
        window.clearTimeout(trailing);
        trailing = null;
      }
      lastEmit = Date.now();
      onUpdate(snapshot());
      return;
    }
    const now = Date.now();
    if (now - lastEmit >= 90) {
      lastEmit = now;
      onUpdate(snapshot());
      return;
    }
    if (trailing === null) {
      trailing = window.setTimeout(() => {
        trailing = null;
        lastEmit = Date.now();
        onUpdate(snapshot());
      }, 90);
    }
  };
  return { emit, snapshot };
}

type DebateContext = {
  state: JuliusState;
  transcript: string;
  settings: JuliusSettings;
  webTools: OpenAiTool[];
  /** Verifier's pool: web tools plus the SelfSurf browser for freshness checks. */
  verifierTools: OpenAiTool[];
  /** Hub/persona prompt — applied only to the user-facing final synthesis. */
  systemPrompt?: string;
  signal?: AbortSignal;
  emit: (force?: boolean) => void;
};

/** Runs the three council reviews in parallel: proponent, critic, verifier (with web). */
async function runDebate(ctx: DebateContext): Promise<void> {
  const count = ctx.state.candidates.filter((item) => item.content.trim().length > 0).length;
  const proponent: JuliusReviewState = {
    role: "proponent",
    modelId: ctx.settings.proponentModelId,
    content: "",
    status: "running",
  };
  const critic: JuliusReviewState = {
    role: "critic",
    modelId: ctx.settings.criticModelId,
    content: "",
    status: "running",
  };
  const verifier: JuliusReviewState = {
    role: "verifier",
    modelId: ctx.settings.verifierModelId,
    content: "",
    status: "running",
  };
  ctx.state.reviews = [proponent, critic, verifier];
  ctx.emit(true);

  const runPlainReview = async (review: JuliusReviewState, system: string): Promise<void> => {
    try {
      const completion = await streamCompletion({
        modelId: review.modelId,
        messages: [
          { role: "system", content: system },
          { role: "user", content: ctx.transcript },
        ],
        tools: [],
        handlers: {
          signal: ctx.signal,
          onReasoning: (full) => {
            review.thinking = thinkingTail(full);
            ctx.emit();
          },
          onText: (full) => {
            if (full) {
              review.content = full;
              ctx.emit();
            }
          },
        },
      });
      if (completion.content.trim()) {
        review.content = completion.content;
      }
      // Honest labeling: a review served by a gateway fallback must say so.
      review.servedBy = fallbackServedBy(review.modelId, completion.servedModelId);
      review.status = review.content.trim() ? "done" : "error";
    } catch (error) {
      review.status = "error";
      if (!review.content.trim()) {
        review.content = errorFromUnknown(error);
      }
    }
    review.thinking = undefined;
    ctx.emit(true);
  };

  const runVerifier = async (): Promise<void> => {
    const surfEnabled = ctx.verifierTools.some((tool) => SURF_TOOL_NAMES.has(tool.function.name));
    try {
      const result = await runAgentTurn({
        modelId: verifier.modelId,
        history: [
          {
            id: newId(),
            role: "user",
            content: `${verifierTask(surfEnabled)}\n\n${ctx.transcript}`,
            createdAt: Date.now(),
          },
        ],
        tools: ctx.verifierTools,
        handlers: {
          signal: ctx.signal,
          onReasoning: (full) => {
            verifier.thinking = thinkingTail(full);
            ctx.emit();
          },
          onText: (full) => {
            if (full) {
              verifier.content = full;
              ctx.emit();
            }
          },
          onToolCalls: (calls) => {
            verifier.toolCalls = calls;
            ctx.emit();
          },
        },
      });
      if (result.content.trim()) {
        verifier.content = result.content;
      }
      if (result.toolCalls.length > 0) {
        verifier.toolCalls = result.toolCalls;
      }
      verifier.servedBy = result.servedBy;
      verifier.status = verifier.content.trim() ? "done" : "error";
    } catch (error) {
      verifier.status = "error";
      if (!verifier.content.trim()) {
        verifier.content = errorFromUnknown(error);
      }
    }
    verifier.thinking = undefined;
    ctx.emit(true);
  };

  await Promise.all([
    runPlainReview(proponent, proponentPrompt(count)),
    runPlainReview(critic, criticPrompt(count)),
    runVerifier(),
  ]);
}

/** The three council reviews formatted for the chairman and the final synthesis. */
function reviewsBlock(state: JuliusState): string {
  const byRole = (role: JuliusReviewState["role"]): JuliusReviewState | undefined =>
    state.reviews.find((item) => item.role === role);
  const block = (label: string, review: JuliusReviewState | undefined): string =>
    `${label}:\n"""\n${cap(review?.content.trim() || "(review unavailable)", REVIEW_CHARS)}\n"""`;
  return [
    "BOARD REVIEWS:",
    block("PROPONENT (argues for by design)", byRole("proponent")),
    block("CRITIC (attacks by design)", byRole("critic")),
    block("VERIFIER (neutral fact-check)", byRole("verifier")),
  ].join("\n\n");
}

/** Streams the chairman's ruling into state.verdict; returns the full ruling text. */
async function runChairman(ctx: DebateContext, candidateCount: number): Promise<string> {
  try {
    const ruling = await streamCompletion({
      modelId: ctx.settings.chairmanModelId,
      messages: [
        {
          role: "system",
          content: chairmanPrompt(
            candidateCount,
            ctx.state.candidates.some((item) => Boolean(item.label)),
          ),
        },
        { role: "user", content: [ctx.transcript, reviewsBlock(ctx.state)].join("\n\n") },
      ],
      tools: [],
      handlers: {
        signal: ctx.signal,
        onReasoning: (full) => {
          ctx.state.chairmanThinking = thinkingTail(full);
          ctx.emit();
        },
        onText: (full) => {
          if (full) {
            ctx.state.verdict = full;
            ctx.emit();
          }
        },
      },
    });
    ctx.state.chairmanServedBy =
      fallbackServedBy(ctx.settings.chairmanModelId, ruling.servedModelId) ?? ctx.state.chairmanServedBy;
    return ruling.content || ctx.state.verdict || "";
  } finally {
    ctx.state.chairmanThinking = undefined;
  }
}

/** System prompt for the board's final consolidated deliverable. */
function synthesisPrompt(single: boolean, researchMode: boolean, winnerLetter: string): string {
  const citing = researchMode
    ? ` The candidates are deep-research reports that all cite ONE shared numbered source list with bracketed markers like [7] — the SOURCE INDEX in the material maps every number to its link, and the app renders each marker as a clickable citation pill. Citation rules: keep Perplexity-grade density — nearly every factual sentence keeps the [n] markers of the material it came from, stacked like [3][12] when several sources corroborate; copy markers EXACTLY, never renumber, never cite a number missing from the index, never replace markers with bare URLs. Preserve the strongest data artifacts from the candidates: carry over \`\`\`chart, \`\`\`map, and \`\`\`mermaid fences and comparison tables built from real source data (deduplicate — keep the best version of each; never invent data points). End with a "Sources" section (titled in the report's language) listing only the numbers you actually cited, in ascending order, one per line as "- [n] [Title](url)" copied from the SOURCE INDEX.`
    : ` When citing web sources, write full markdown links [title](url) taken from the material — never bare numeric markers like [3]; the reader cannot resolve them.`;
  const reality = ` Sanity-check cost/time/effort claims against today's AI-tooling reality (${new Date().toISOString().slice(0, 10)}): AI coding agents now deliver in days what pre-2023 agencies quoted months and six figures for — correct or explicitly label stale baselines instead of repeating them.`;
  if (single) {
    return `You are the CHAIRMAN of a decision board writing the board's final deliverable. One answer was produced and then audited by a Proponent (praises by design), a Critic (attacks by design), and a neutral Verifier. Rewrite the answer into its final form: keep everything that is correct, fix every issue the reviews actually confirmed (the Verifier's evidence weighs most), and fill the real gaps they exposed. Never invent facts that are not in the material. The final version must not lose correct substance — as a rule it should be at least as complete as the original.${citing}${reality} Write directly to the user in the language of their request. Never mention the panel, the reviews, or this process. Output only the final answer.`;
  }
  return `You are the CHAIRMAN of a decision board writing the board's final deliverable. Several candidates answered the same request in parallel and were audited by a Proponent (praises by design), a Critic (attacks by design), and a neutral Verifier; you already ruled that candidate ${winnerLetter} won. Use the winner as the backbone — but do NOT simply repeat it. Merge in every genuinely valuable fact, number, example, caveat, source, or angle the other candidates contributed that the winner lacks, and fix every issue the reviews actually confirmed (the Verifier's evidence weighs most). Ignore a candidate only where it is plainly wrong or worthless. Never invent facts that are not in the material; when candidates contradict each other, keep the verified version. The result must never be less complete than the winning answer — as a rule it should be richer.${citing}${reality} Write directly to the user in the language of their request. Never mention the panel, candidates, letters, reviews, or this process. Output only the final answer.`;
}

/** Streams the final deliverable built from the winner, the rivals' valid material, and the reviews. */
async function runSynthesis(
  ctx: DebateContext,
  winnerIndex: number,
  ruling: string,
  onContent?: (full: string) => void,
): Promise<{ content: string; servedBy?: string }> {
  const single = ctx.state.candidates.length === 1;
  const researchMode = ctx.state.candidates.some((item) => Boolean(item.label));
  const completion = await streamCompletion({
    modelId: ctx.settings.chairmanModelId,
    messages: [
      {
        role: "system",
        content: [ctx.systemPrompt?.trim(), synthesisPrompt(single, researchMode, juliusLetter(winnerIndex))]
          .filter(Boolean)
          .join("\n\n"),
      },
      {
        role: "user",
        content: [
          ctx.transcript,
          reviewsBlock(ctx.state),
          `CHAIRMAN RULING:\n"""\n${cap(ruling.trim() || "(none)", REVIEW_CHARS)}\n"""`,
        ].join("\n\n"),
      },
    ],
    tools: [],
    handlers: {
      signal: ctx.signal,
      onText: (full) => {
        if (full) {
          onContent?.(full);
        }
      },
    },
  });
  return {
    content: completion.content.trim(),
    servedBy: fallbackServedBy(ctx.settings.chairmanModelId, completion.servedModelId),
  };
}

/** Runs one candidate's own deep-research pass; resolves with the report text. */
export type JuliusResearchRunner = (slot: {
  /** The candidate's model selection id — each candidate researches with its own model. */
  modelId: string;
  onText: (full: string) => void;
  onResearch: (research: ResearchState) => void;
}) => Promise<string>;

export type JuliusRunParams = {
  /** Thread history including the new user message. */
  history: ChatMessage[];
  /** The user request text (drives the debate transcript). */
  prompt: string;
  settings: JuliusSettings;
  /** Master builtin toggles — candidates/verifier get web tools only. */
  builtins: Record<BuiltinToolId, boolean>;
  /**
   * Deep research + Julius: when set, EVERY candidate runs its own multi-wave
   * research in parallel with the others, and the council then judges the
   * finished reports against each other.
   */
  research?: JuliusResearchRunner;
  systemPrompt?: string;
  signal?: AbortSignal;
  onUpdate: (julius: JuliusState) => void;
  /** Streams the final synthesized deliverable while the chairman writes it (council mode). */
  onContent?: (full: string) => void;
};

export type JuliusRunResult = {
  julius: JuliusState;
  content: string;
  /** Set when a gateway fallback wrote the final text — the message must disclose it. */
  servedBy?: string;
};

/**
 * Julius panel. With 2+ candidates the models answer the same request in
 * parallel, then the user picks the winner or the council debates and the
 * chairman rules. With a single candidate the council quality-checks that
 * one answer: proponent defends, critic attacks, verifier fact-checks, and
 * the chairman issues a quality verdict instead of picking a winner.
 * With a research runner every candidate performs its own deep research in
 * parallel and the council judges the finished reports against each other.
 */
export async function runJuliusTurn(params: JuliusRunParams): Promise<JuliusRunResult> {
  const research = params.research;
  const state: JuliusState = {
    decision: params.settings.decision,
    status: "candidates",
    candidates: params.settings.candidateModelIds.slice(0, JULIUS_MAX_CANDIDATES).map(
      (modelId): JuliusCandidateState => ({
        id: newId(),
        modelId,
        label: research ? "Deep research" : undefined,
        content: "",
        status: "running",
      }),
    ),
    reviews: [],
    startedAt: Date.now(),
  };
  const single = state.candidates.length === 1;
  // A single candidate has nothing to "pick" — the council always reviews it.
  const councilMode = params.settings.decision === "council" || single;
  state.chairmanModelId = councilMode ? params.settings.chairmanModelId : undefined;

  const { emit, snapshot } = makeEmitter(state, params.onUpdate);
  emit(true);

  const webTools = reviewWebTools(params.builtins);

  // Phase 1 — all candidates run in parallel; in research mode each one
  // performs its own multi-wave deep research with its own model.
  await Promise.all(
    state.candidates.map(async (candidate, index) => {
      if (research) {
        try {
          const text = await research({
            modelId: candidate.modelId,
            onText: (full) => {
              if (full) {
                candidate.content = full;
                emit();
              }
            },
            onResearch: (progress) => {
              candidate.research = progress;
              emit();
            },
          });
          if (text.trim()) {
            candidate.content = text;
          }
          candidate.status = candidate.content.trim() ? "done" : "error";
          if (candidate.status === "error") {
            candidate.error = "The research produced an empty report.";
          }
        } catch (error) {
          candidate.status = "error";
          candidate.error = errorFromUnknown(error);
        }
        emit(true);
        return;
      }
      const panelNote = single
        ? "Write your single best, complete, self-contained answer. It will be independently fact-checked and quality-reviewed, so be precise and honest about uncertainty."
        : `Panel protocol: you are candidate ${juliusLetter(index)} of ${state.candidates.length} independent experts answering the same request in parallel. Write your single best, complete, self-contained answer. Never mention the panel or other candidates.`;
      try {
        const result = await runAgentTurn({
          modelId: candidate.modelId,
          history: params.history,
          tools: webTools,
            // The competition is between SPECIFIC models — a silent gateway
          // fallback would mislabel the card and let an imposter compete.
          // An honest per-candidate failure is data; the panel survives it.
          fallbacks: false,
          systemPrompt: [params.systemPrompt?.trim(), panelNote].filter(Boolean).join("\n\n"),
          handlers: {
            signal: params.signal,
            onReasoning: (full) => {
              candidate.thinking = thinkingTail(full);
              emit();
            },
            onText: (full) => {
              if (full) {
                candidate.content = full;
                emit();
              }
            },
            onToolCalls: (calls) => {
              candidate.toolCalls = calls;
              emit();
            },
          },
        });
        if (result.content.trim()) {
          candidate.content = result.content;
        }
        if (result.toolCalls.length > 0) {
          candidate.toolCalls = result.toolCalls;
        }
        candidate.servedBy = result.servedBy;
        candidate.status = candidate.content.trim() ? "done" : "error";
        if (candidate.status === "error") {
          candidate.error = "The model returned an empty answer.";
        }
      } catch (error) {
        candidate.status = "error";
        candidate.error = errorFromUnknown(error);
      }
      candidate.thinking = undefined;
      emit(true);
    }),
  );

  // Research mode: fold every candidate's private source numbering into ONE
  // shared list and rewrite their [n] markers to it — the council, chairman,
  // and final message then all cite the same resolvable numbers.
  if (research) {
    unifyResearchSources(state);
    emit(true);
  }

  const withText = state.candidates.filter((item) => item.content.trim().length > 0);

  if (withText.length === 0) {
    state.status = "error";
    state.finishedAt = Date.now();
    emit(true);
    const firstError = state.candidates.find((item) => item.error)?.error;
    return {
      julius: snapshot(),
      content: params.signal?.aborted
        ? "Stopped."
        : single
          ? `The candidate failed${firstError ? `: ${firstError}` : "."}`
          : `All ${state.candidates.length} candidates failed${firstError ? `: ${firstError}` : "."}`,
    };
  }

  // A stop during the candidate phase falls back to a manual pick over partials.
  if (params.signal?.aborted || !councilMode) {
    state.status = "choice";
    state.finishedAt = Date.now();
    emit(true);
    return { julius: snapshot(), content: "" };
  }

  // Phase 2 — council debate.
  state.status = "debate";
  const ctx: DebateContext = {
    state,
    transcript: buildTranscript(params.prompt, state.candidates, state.sources),
    settings: params.settings,
    webTools,
    verifierTools: verifierTools(params.builtins),
    systemPrompt: params.systemPrompt,
    signal: params.signal,
    emit,
  };
  await runDebate(ctx);

  if (params.signal?.aborted) {
    state.status = "choice";
    state.finishedAt = Date.now();
    emit(true);
    return { julius: snapshot(), content: "" };
  }

  // Phase 3 — the chairman weighs the debate and rules.
  let winnerIndex: number;
  let ruling: string;
  try {
    ruling = await withRetries(() => runChairman(ctx, withText.length), {
      attempts: COUNCIL_ATTEMPTS,
      signal: params.signal,
      shouldRetryResult: (text) => !text.trim(),
    });
    const parsed = parseChairman(ruling, state.candidates);
    state.winner = parsed.winner;
    state.verdict = parsed.verdict;
    state.decidedBy = "chairman";
    winnerIndex = parsed.winner;
  } catch (error) {
    state.finishedAt = Date.now();
    if (single) {
      // The answer itself is fine — deliver it with an honest note about the failed review.
      state.status = "done";
      state.winner = 0;
      state.verdict = isAbort(error)
        ? undefined
        : `The chairman could not rule after ${COUNCIL_ATTEMPTS} attempts (${errorFromUnknown(error)}) — the answer below is unreviewed.`;
      emit(true);
      return { julius: snapshot(), content: state.candidates[0].content, servedBy: state.candidates[0].servedBy };
    }
    // Multi-candidate: hand the pick to the user.
    state.status = "choice";
    state.verdict = isAbort(error)
      ? undefined
      : `The chairman could not rule after ${COUNCIL_ATTEMPTS} attempts (${errorFromUnknown(error)}) — pick the winner yourself.`;
    emit(true);
    return { julius: snapshot(), content: "" };
  }

  // Phase 4 — the final deliverable: the chairman folds the winner, every
  // valuable point the rivals contributed, and the confirmed review fixes
  // into one report — as a rule richer than the raw winner; junk candidates
  // are simply ignored.
  const winnerContent = state.candidates[winnerIndex]?.content ?? "";
  state.status = "synthesis";
  emit(true);
  let finalContent = winnerContent;
  let finalServedBy = state.candidates[winnerIndex]?.servedBy;
  const synthesisNote = (reason: string): void => {
    state.verdict = [
      state.verdict,
      `_Final synthesis unavailable after ${COUNCIL_ATTEMPTS} attempts (${reason}) — showing the winning answer unchanged._`,
    ]
      .filter(Boolean)
      .join("\n\n");
  };
  try {
    const merged = await withRetries(() => runSynthesis(ctx, winnerIndex, ruling, params.onContent), {
      attempts: COUNCIL_ATTEMPTS,
      signal: params.signal,
      shouldRetryResult: (result) => !result.content,
    });
    if (merged.content) {
      finalContent = merged.content;
      finalServedBy = merged.servedBy;
    } else if (!params.signal?.aborted) {
      synthesisNote("the model returned nothing");
    }
  } catch (error) {
    if (!isAbort(error)) {
      synthesisNote(errorFromUnknown(error));
    }
  }
  state.status = "done";
  state.finishedAt = Date.now();
  emit(true);
  return { julius: snapshot(), content: finalContent, servedBy: finalServedBy };
}


