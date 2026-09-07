// Server-side Julius panel — a faithful port of the browser pipeline
// (web/src/lib/julius.ts). Candidates answer the same request in parallel
// (as SPECIFIC models: gateway fallbacks are disabled so an imposter can
// never compete under another model's name), the council debates, the
// chairman rules, and the final deliverable is synthesized. In research mode
// every candidate runs its own multi-wave deep research first and their
// private source numberings are folded into one shared citation space.

import type { McpRoute } from "./automation-runner";
import {
  buildApiMessages,
  fallbackServedBy,
  runEngineTurn,
  streamGatewayText,
  withRetries,
  type EngineToolDef,
} from "./agent-engine";
import {
  builtinToolDefs,
  createServerSurfSession,
  createSourceLedger,
  executeServerTool,
  type ServerToolContext,
} from "./run-tools";
import type {
  BuiltinToolId,
  JuliusCandidateState,
  JuliusReviewState,
  JuliusState,
  JuliusWireSettings,
  ResearchState,
  RunSource,
  WireMessage,
} from "./run-protocol";

export const JULIUS_MAX_CANDIDATES = 4;

const COUNCIL_ATTEMPTS = 3;
const PROMPT_CHARS = 4_000;
const CANDIDATE_CHARS = 12_000;
const REVIEW_CHARS = 6_000;

function cap(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n… [truncated]`;
}

function thinkingTail(full: string): string {
  return full.length > 1600 ? `…${full.slice(-1600)}` : full;
}

function juliusLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0 && error.message.length < 220) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

// ---------------------------------------------------------------------------
// Citation remapping (port of web/src/lib/citations.ts — pure logic).

/** Rewrites bracketed citation markers using a local→shared number map. */
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

/** Folds every candidate's private source numbering into ONE shared list. */
export function unifyResearchSources(state: JuliusState): void {
  const numberByUrl = new Map<string, number>();
  const shared: RunSource[] = [];
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

// ---------------------------------------------------------------------------
// Prompts (verbatim ports).

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

function verifierTask(surfEnabled: boolean, mcpEnabled: boolean): string {
  const today = new Date().toISOString().slice(0, 10);
  const browser = surfEnabled
    ? ` If search snippets are dated or thin for a time-sensitive claim, open the live source directly with the SelfSurf browser: surf_open the official site, registry, docs, changelog, or price page; surf_follow links; surf_find text on the page. SelfSurf keeps cookies and follows redirects but does NOT run JavaScript — if a page needs JS, say so honestly instead of guessing.`
    : "";
  const connectors = mcpEnabled
    ? ` Connected repository/account tools whose names start with mcp_ are available. When a candidate makes a claim about a connected source, inspect that source with the matching read tool instead of declaring it unreachable. Never perform writes while verifying.`
    : "";
  return `You are the VERIFIER on a review board. Today is ${today}. Below are candidate answer(s) to a user request. Check the facts, numbers, dates, names, calculations, and whether each one actually fulfils the user's request. ALSO check FRESHNESS: for every time-sensitive claim (prices, versions, releases, rankings, schedules, laws, people in office, live stats) verify it still holds TODAY — use web_search with the "recency" filter for anything that changes.${browser}${connectors} Format: a short bold header per candidate letter listing: verified claims (✓), wrong claims (✗ with the correction), stale claims (⏳ with the current value and its date), unverifiable claims (?), and any requirement violations. Stay neutral — no opinions on style or preference, facts only.`;
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

function sourceIndexBlock(sources: RunSource[] | undefined): string | null {
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

function buildTranscript(prompt: string, candidates: JuliusCandidateState[], sources?: RunSource[]): string {
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

// ---------------------------------------------------------------------------

type Emitter = {
  emit: (force?: boolean) => void;
  snapshot: () => JuliusState;
};

/** Deep-copy snapshots + throttled emission: parallel streams must not flood the wire. */
function makeEmitter(state: JuliusState, onUpdate: (julius: JuliusState) => void): Emitter {
  const snapshot = (): JuliusState => ({
    ...state,
    candidates: state.candidates.map((item) => ({
      ...item,
      toolCalls: item.toolCalls?.map((call) => ({ ...call })),
      research: item.research
        ? { ...item.research, steps: item.research.steps.map((step) => ({ ...step })), sources: [...item.research.sources] }
        : undefined,
    })),
    reviews: state.reviews.map((item) => ({
      ...item,
      toolCalls: item.toolCalls?.map((call) => ({ ...call })),
    })),
    sources: state.sources ? [...state.sources] : undefined,
  });
  let lastEmit = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  const emit = (force = false): void => {
    if (force) {
      if (trailing !== null) {
        clearTimeout(trailing);
        trailing = null;
      }
      lastEmit = Date.now();
      onUpdate(snapshot());
      return;
    }
    const now = Date.now();
    if (now - lastEmit >= 120) {
      lastEmit = now;
      onUpdate(snapshot());
      return;
    }
    if (trailing === null) {
      trailing = setTimeout(() => {
        trailing = null;
        lastEmit = Date.now();
        onUpdate(snapshot());
      }, 120);
    }
  };
  return { emit, snapshot };
}

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

/** Runs one candidate's own deep-research pass; resolves with the report text. */
export type ServerJuliusResearchRunner = (slot: {
  modelId: string;
  onText: (full: string) => void;
  onResearch: (research: ResearchState) => void;
}) => Promise<string>;

export type ServerJuliusParams = {
  authKey: string;
  history: WireMessage[];
  prompt: string;
  settings: JuliusWireSettings;
  builtins: Record<BuiltinToolId, boolean>;
  /** Native GitHub tools shared by plain candidates and the council verifier. */
  mcpToolDefs?: EngineToolDef[];
  mcpRoutes?: Map<string, McpRoute>;
  research?: ServerJuliusResearchRunner;
  systemPrompt?: string;
  /**
   * Output ceiling (tokens) of a model per the gateway catalog. Every phase
   * runs its own model (candidates, council, chairman), so each completion
   * carries that model's ceiling instead of the provider default; unknown →
   * no cap is sent and a cut text is continued in place.
   */
  maxOutputTokensFor?: (modelId: string) => Promise<number | undefined>;
  isCancelled?: () => boolean;
  onUpdate: (julius: JuliusState) => void;
  onContent?: (full: string) => void;
  onUsage?: (modelId: string, usage: unknown) => void;
};

export type ServerJuliusResult = {
  julius: JuliusState;
  content: string;
  servedBy?: string;
};

function webOnlyBuiltins(builtins: Record<BuiltinToolId, boolean>, surf: boolean): Record<BuiltinToolId, boolean> {
  return {
    web_search: builtins.web_search,
    fetch_url: builtins.fetch_url,
    selfsurf: surf ? builtins.selfsurf : false,
    generate_image: false,
    generate_video: false,
    generate_audio: false,
  };
}

const VERIFIER_GITHUB_WRITE_SUFFIXES = [
  "_create_issue",
  "_add_issue_comment",
  "_create_branch",
  "_put_file",
  "_delete_file",
  "_create_pull",
  "_update_pull",
] as const;

/** A fact-checker may inspect the connected repo, but can never mutate it. */
function verifierMcpToolDefs(tools: EngineToolDef[]): EngineToolDef[] {
  return tools.filter(
    (tool) => !VERIFIER_GITHUB_WRITE_SUFFIXES.some((suffix) => tool.function.name.endsWith(suffix)),
  );
}

/** Runtime routes must never exceed the names actually advertised to a phase. */
export function mcpRoutesForToolDefs(
  tools: EngineToolDef[],
  routes: Map<string, McpRoute> | undefined,
): Map<string, McpRoute> | null {
  if (!routes) {
    return null;
  }
  const allowedNames = new Set(tools.map((tool) => tool.function.name));
  const allowed = new Map([...routes].filter(([name]) => allowedNames.has(name)));
  return allowed.size > 0 ? allowed : null;
}

/** Server-side Julius panel — candidates, council, chairman, synthesis. */
export async function runServerJulius(params: ServerJuliusParams): Promise<ServerJuliusResult> {
  const research = params.research;
  const state: JuliusState = {
    decision: params.settings.decision,
    status: "candidates",
    candidates: params.settings.candidateModelIds.slice(0, JULIUS_MAX_CANDIDATES).map(
      (modelId): JuliusCandidateState => ({
        id: crypto.randomUUID(),
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
  const councilMode = params.settings.decision === "council" || single;
  state.chairmanModelId = councilMode ? params.settings.chairmanModelId : undefined;

  const { emit, snapshot } = makeEmitter(state, params.onUpdate);
  emit(true);

  const webToolDefs: EngineToolDef[] = [
    ...builtinToolDefs(webOnlyBuiltins(params.builtins, false)),
    // Candidates run in parallel, so repository mutations here could fire N
    // times before a winner exists. Julius is analysis-only at every phase.
    ...verifierMcpToolDefs(params.mcpToolDefs ?? []),
  ];
  const verifierToolDefs: EngineToolDef[] = [
    ...builtinToolDefs(webOnlyBuiltins(params.builtins, true)),
    ...verifierMcpToolDefs(params.mcpToolDefs ?? []),
  ];

  const runEngineWith = async (input: {
    modelId: string;
    history: WireMessage[];
    tools: EngineToolDef[];
    systemPrompt?: string;
    fallbacks?: boolean;
    onText: (full: string) => void;
    onReasoning: (full: string) => void;
    onToolCalls: (calls: JuliusCandidateState["toolCalls"]) => void;
  }) => {
    const ledger = createSourceLedger();
    const allowedRoutes = mcpRoutesForToolDefs(input.tools, params.mcpRoutes);
    const ctx: ServerToolContext = {
      authKey: params.authKey,
      ledger,
      surf: createServerSurfSession(),
      // Definitions and execution routes share one allow-list. A hallucinated
      // hidden write name therefore cannot bypass Julius's read-only surface.
      mcpRoutes: allowedRoutes,
    };
    return runEngineTurn({
      authKey: params.authKey,
      modelId: input.modelId,
      apiMessages: buildApiMessages(input.history, input.systemPrompt),
      tools: input.tools,
      executeTool: (name, argsJson) => executeServerTool(name, argsJson, ctx),
      fallbacks: input.fallbacks,
      maxOutputTokens: await params.maxOutputTokensFor?.(input.modelId),
      isStopped: params.isCancelled,
      handlers: {
        onText: input.onText,
        onReasoning: input.onReasoning,
        onToolCalls: (calls) => input.onToolCalls(calls.map((call) => ({ ...call }))),
      },
      onUsage: params.onUsage,
    });
  };

  // Phase 1 — all candidates run in parallel.
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
          candidate.error = messageOf(error);
        }
        emit(true);
        return;
      }
      const panelNote = single
        ? "Write your single best, complete, self-contained answer. It will be independently fact-checked and quality-reviewed, so be precise and honest about uncertainty."
        : `Panel protocol: you are candidate ${juliusLetter(index)} of ${state.candidates.length} independent experts answering the same request in parallel. Write your single best, complete, self-contained answer. Never mention the panel or other candidates.`;
      try {
        const result = await runEngineWith({
          modelId: candidate.modelId,
          history: params.history,
          tools: webToolDefs,
          // The competition is between SPECIFIC models — a silent gateway
          // fallback would mislabel the card and let an imposter compete.
          fallbacks: false,
          systemPrompt: [params.systemPrompt?.trim(), panelNote].filter(Boolean).join("\n\n"),
          onText: (full) => {
            if (full) {
              candidate.content = full;
              emit();
            }
          },
          onReasoning: (full) => {
            candidate.thinking = thinkingTail(full);
            emit();
          },
          onToolCalls: (calls) => {
            candidate.toolCalls = calls;
            emit();
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
        candidate.error = messageOf(error);
      }
      candidate.thinking = undefined;
      emit(true);
    }),
  );

  // Research mode: fold every candidate's private numbering into ONE shared list.
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
      content: params.isCancelled?.()
        ? "Stopped."
        : single
          ? `The candidate failed${firstError ? `: ${firstError}` : "."}`
          : `All ${state.candidates.length} candidates failed${firstError ? `: ${firstError}` : "."}`,
    };
  }

  // A stop during the candidate phase falls back to a manual pick over partials.
  if (params.isCancelled?.() || !councilMode) {
    state.status = "choice";
    state.finishedAt = Date.now();
    emit(true);
    return { julius: snapshot(), content: "" };
  }

  // Phase 2 — council debate.
  state.status = "debate";
  const transcript = buildTranscript(params.prompt, state.candidates, state.sources);
  const proponent: JuliusReviewState = {
    role: "proponent",
    modelId: params.settings.proponentModelId,
    content: "",
    status: "running",
  };
  const critic: JuliusReviewState = {
    role: "critic",
    modelId: params.settings.criticModelId,
    content: "",
    status: "running",
  };
  const verifier: JuliusReviewState = {
    role: "verifier",
    modelId: params.settings.verifierModelId,
    content: "",
    status: "running",
  };
  state.reviews = [proponent, critic, verifier];
  emit(true);

  const count = withText.length;

  const runPlainReview = async (review: JuliusReviewState, system: string): Promise<void> => {
    try {
      const completion = await streamGatewayText({
        authKey: params.authKey,
        modelId: review.modelId,
        messages: [
          { role: "system", content: system },
          { role: "user", content: transcript },
        ],
        maxOutputTokens: await params.maxOutputTokensFor?.(review.modelId),
        isCancelled: params.isCancelled,
        handlers: {
          onText: (full) => {
            if (full) {
              review.content = full;
              emit();
            }
          },
          onReasoning: (full) => {
            review.thinking = thinkingTail(full);
            emit();
          },
        },
        onUsage: params.onUsage,
      });
      if (completion.content.trim()) {
        review.content = completion.content;
      }
      review.servedBy = fallbackServedBy(review.modelId, completion.servedModelId);
      review.status = review.content.trim() ? "done" : "error";
    } catch (error) {
      review.status = "error";
      if (!review.content.trim()) {
        review.content = messageOf(error);
      }
    }
    review.thinking = undefined;
    emit(true);
  };

  const runVerifier = async (): Promise<void> => {
    const surfEnabled = verifierToolDefs.some((tool) => tool.function.name.startsWith("surf_"));
    const mcpEnabled = verifierToolDefs.some((tool) => tool.function.name.startsWith("mcp_"));
    try {
      const result = await runEngineWith({
        modelId: verifier.modelId,
        history: [
          { role: "user", content: `${verifierTask(surfEnabled, mcpEnabled)}\n\n${transcript}` },
        ],
        tools: verifierToolDefs,
        onText: (full) => {
          if (full) {
            verifier.content = full;
            emit();
          }
        },
        onReasoning: (full) => {
          verifier.thinking = thinkingTail(full);
          emit();
        },
        onToolCalls: (calls) => {
          verifier.toolCalls = calls;
          emit();
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
        verifier.content = messageOf(error);
      }
    }
    verifier.thinking = undefined;
    emit(true);
  };

  await Promise.all([
    runPlainReview(proponent, proponentPrompt(count)),
    runPlainReview(critic, criticPrompt(count)),
    runVerifier(),
  ]);

  if (params.isCancelled?.()) {
    state.status = "choice";
    state.finishedAt = Date.now();
    emit(true);
    return { julius: snapshot(), content: "" };
  }

  // Phase 3 — the chairman weighs the debate and rules.
  const runChairman = async (): Promise<string> => {
    try {
      const ruling = await streamGatewayText({
        authKey: params.authKey,
        modelId: params.settings.chairmanModelId,
        messages: [
          {
            role: "system",
            content: chairmanPrompt(count, state.candidates.some((item) => Boolean(item.label))),
          },
          { role: "user", content: [transcript, reviewsBlock(state)].join("\n\n") },
        ],
        maxOutputTokens: await params.maxOutputTokensFor?.(params.settings.chairmanModelId),
        isCancelled: params.isCancelled,
        handlers: {
          onText: (full) => {
            if (full) {
              state.verdict = full;
              emit();
            }
          },
          onReasoning: (full) => {
            state.chairmanThinking = thinkingTail(full);
            emit();
          },
        },
        onUsage: params.onUsage,
      });
      state.chairmanServedBy =
        fallbackServedBy(params.settings.chairmanModelId, ruling.servedModelId) ?? state.chairmanServedBy;
      return ruling.content || state.verdict || "";
    } finally {
      state.chairmanThinking = undefined;
    }
  };

  let winnerIndex: number;
  let ruling: string;
  try {
    ruling = await withRetries(() => runChairman(), {
      attempts: COUNCIL_ATTEMPTS,
      isCancelled: params.isCancelled,
      shouldRetryResult: (text) => !text.trim(),
    });
    const parsed = parseChairman(ruling, state.candidates);
    state.winner = parsed.winner;
    state.verdict = parsed.verdict;
    state.decidedBy = "chairman";
    winnerIndex = parsed.winner;
  } catch (error) {
    state.finishedAt = Date.now();
    const stopped = params.isCancelled?.() === true;
    if (single) {
      state.status = "done";
      state.winner = 0;
      state.verdict = stopped
        ? undefined
        : `The chairman could not rule after ${COUNCIL_ATTEMPTS} attempts (${messageOf(error)}) — the answer below is unreviewed.`;
      emit(true);
      return { julius: snapshot(), content: state.candidates[0].content, servedBy: state.candidates[0].servedBy };
    }
    state.status = "choice";
    state.verdict = stopped
      ? undefined
      : `The chairman could not rule after ${COUNCIL_ATTEMPTS} attempts (${messageOf(error)}) — pick the winner yourself.`;
    emit(true);
    return { julius: snapshot(), content: "" };
  }

  // Phase 4 — the final deliverable.
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
  const runSynthesis = async (): Promise<{ content: string; servedBy?: string }> => {
    const researchMode = state.candidates.some((item) => Boolean(item.label));
    const completion = await streamGatewayText({
      authKey: params.authKey,
      modelId: params.settings.chairmanModelId,
      messages: [
        {
          role: "system",
          content: [params.systemPrompt?.trim(), synthesisPrompt(single, researchMode, juliusLetter(winnerIndex))]
            .filter(Boolean)
            .join("\n\n"),
        },
        {
          role: "user",
          content: [
            transcript,
            reviewsBlock(state),
            `CHAIRMAN RULING:\n"""\n${cap(ruling.trim() || "(none)", REVIEW_CHARS)}\n"""`,
          ].join("\n\n"),
        },
      ],
      maxOutputTokens: await params.maxOutputTokensFor?.(params.settings.chairmanModelId),
      isCancelled: params.isCancelled,
      handlers: {
        onText: (full) => {
          if (full) {
            params.onContent?.(full);
          }
        },
      },
      onUsage: params.onUsage,
    });
    return {
      content: completion.content.trim(),
      servedBy: fallbackServedBy(params.settings.chairmanModelId, completion.servedModelId),
    };
  };
  try {
    const merged = await withRetries(() => runSynthesis(), {
      attempts: COUNCIL_ATTEMPTS,
      isCancelled: params.isCancelled,
      shouldRetryResult: (result) => !result.content,
    });
    if (merged.content) {
      finalContent = merged.content;
      finalServedBy = merged.servedBy;
    } else if (!params.isCancelled?.()) {
      synthesisNote("the model returned nothing");
    }
  } catch (error) {
    if (!params.isCancelled?.()) {
      synthesisNote(messageOf(error));
    }
  }
  state.status = "done";
  state.finishedAt = Date.now();
  emit(true);
  return { julius: snapshot(), content: finalContent, servedBy: finalServedBy };
}
