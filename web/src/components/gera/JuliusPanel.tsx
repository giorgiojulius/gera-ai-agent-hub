import {
  AlertCircle,
  Check,
  ChevronDown,
  Crown,
  Gavel,
  Landmark,
  Loader2,
  Scale,
  ShieldCheck,
  Swords,
  Telescope,
  ThumbsUp,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { MarkdownBody } from "@/components/gera/Markdown";
import { useAgent } from "@/hooks/use-agent";
import { juliusLetter } from "@/lib/julius";
import { findModel, modelShortName } from "@/lib/models";
import { TID } from "@/lib/testids";
import type {
  GatewayModel,
  JuliusBoard,
  JuliusBoardDecision,
  JuliusCandidateState,
  JuliusReviewState,
  JuliusRole,
  JuliusState,
  ResearchSource,
  ResearchState,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const ROLE_META: Record<JuliusRole, { label: string; hint: string; busy: string; icon: LucideIcon }> = {
  proponent: {
    label: "Proponent",
    hint: "argues for",
    busy: "Reading the answers, building the case for them…",
    icon: ThumbsUp,
  },
  critic: {
    label: "Critic",
    hint: "attacks",
    busy: "Reading the answers, hunting for weaknesses…",
    icon: Swords,
  },
  verifier: {
    label: "Verifier",
    hint: "facts & freshness",
    busy: "Checking facts and freshness — web search + SelfSurf when sources look stale…",
    icon: ShieldCheck,
  },
};

/** Live reasoning tail rendered while a model thinks before writing. */
function ThinkingTail({ text }: { text: string }) {
  return (
    <p className="max-h-20 overflow-hidden text-[11px] leading-relaxed text-muted-foreground/80">
      <span className="animate-pulse font-medium text-ember">thinking · </span>
      {text.slice(-360)}
    </p>
  );
}

function modelLabel(models: GatewayModel[], id: string): string {
  return findModel(models, id)?.name ?? id;
}

/**
 * The Julius panel card: parallel candidate answers streaming side by side,
 * the council debate (proponent / critic / verifier), the chairman's ruling,
 * and manual winner picking. With a single candidate it renders as a quality
 * check — the council audits one answer instead of picking between several.
 */
export function JuliusPanel({
  julius,
  messageId,
  hasFinalContent = false,
  readOnly = false,
}: {
  julius: JuliusState;
  messageId: string;
  /** The message already shows the final text below — hides the duplicate single card. */
  hasFinalContent?: boolean;
  /** Shared/public rendering — the viewer can look but never pick a winner. */
  readOnly?: boolean;
}) {
  const { models, chooseJuliusWinner } = useAgent();
  const running =
    julius.status === "candidates" || julius.status === "debate" || julius.status === "synthesis";
  const single = julius.candidates.length === 1;
  const researchMode = julius.candidates.some((item) => Boolean(item.label));
  const jevMode = julius.decision === "council_v2" || Boolean(julius.board);
  const [manual, setManual] = useState<boolean | null>(null);
  // Quality checks stay open when finished — the verdict is the point.
  const open = manual ?? !(julius.status === "done" && !single);
  const [, setTick] = useState<number>(0);

  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const seconds = Math.max(0, Math.round(((julius.finishedAt ?? Date.now()) - julius.startedAt) / 1000));
  const winner = julius.winner != null ? julius.candidates[julius.winner] : undefined;
  const summary =
    julius.status === "candidates"
      ? researchMode
        ? single
          ? `Deep research in progress… council audit next · ${seconds}s`
          : `${julius.candidates.length} deep-research runs in parallel… · ${seconds}s`
        : single
          ? `Drafting the answer… · ${seconds}s`
          : `Asking ${julius.candidates.length} models in parallel… · ${seconds}s`
      : julius.status === "debate"
        ? jevMode
          ? julius.board?.status === "running"
            ? `Jev is ruling on every block… · ${seconds}s`
            : `The Verifier is checking the ${single ? (researchMode ? "report" : "answer") : `${julius.candidates.length} ${researchMode ? "reports" : "answers"}`}… · ${seconds}s`
          : single
            ? `The council is checking the ${researchMode ? "report" : "answer"}… · ${seconds}s`
            : researchMode
              ? `The council is comparing ${julius.candidates.length} research reports… · ${seconds}s`
              : `The council is debating… · ${seconds}s`
        : julius.status === "synthesis"
          ? jevMode
            ? `The editor is writing from Jev's plan… · ${seconds}s`
            : researchMode
              ? `Writing the final research from all reports… · ${seconds}s`
              : single
                ? `Writing the final answer after the review… · ${seconds}s`
                : `Merging the best of all answers… · ${seconds}s`
          : julius.status === "choice"
            ? researchMode
              ? "Pick the winning report"
              : "Pick the winning answer"
          : julius.status === "error"
            ? "Panel failed"
            : single
              ? julius.verdict
                ? "Quality check · council verdict below"
                : "Quality check finished"
              : winner
                ? `${julius.decidedBy === "jev" ? "Backbone" : "Winner"}: ${juliusLetter(julius.winner ?? 0)} · ${modelLabel(models, winner.modelId)} · ${
                    julius.decidedBy === "chairman"
                      ? "council ruling"
                      : julius.decidedBy === "jev"
                        ? "Jev's ruling"
                        : "your pick"
                  }`
                : `${seconds}s`;

  // In quality-check mode the reviewed answer is already the message body —
  // rendering the card again would duplicate the whole text.
  const hideCandidates = single && hasFinalContent && julius.status !== "choice";

  // Council v2 renders Jev's board structurally; `verdict` then only carries
  // honest notes (Jev unreachable, editor write failed).
  const showVerdictBox = jevMode
    ? Boolean(julius.verdict)
    : Boolean(julius.verdict) ||
      (julius.status === "debate" &&
        julius.reviews.length > 0 &&
        julius.reviews.every((review) => review.status !== "running"));

  return (
    <div className="mb-3 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setManual(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left"
      >
        <Landmark className={cn("h-4 w-4 shrink-0 text-ember", running && "animate-pulse")} />
        <span className="shrink-0 text-sm font-medium">{single ? "Julius · quality check" : "Julius"}</span>
        <span className={cn("min-w-0 flex-1 truncate text-xs text-muted-foreground", running && "animate-pulse")}>
          {summary}
        </span>
        <ChevronDown
          className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div className="space-y-2.5 border-t border-border/60 px-3 py-2.5">
          {hideCandidates ? (
            researchMode ? (
              <div className="grid gap-2">
                {julius.candidates.map((candidate, index) => (
                  <CandidateCard
                    key={candidate.id}
                    candidate={candidate}
                    index={index}
                    julius={julius}
                    name={modelLabel(models, candidate.modelId)}
                    onPick={() => chooseJuliusWinner(messageId, index)}
                    compact
                    readOnly={readOnly}
                  />
                ))}
              </div>
            ) : null
          ) : (
            <div className={cn("grid gap-2", julius.candidates.length > 1 && "sm:grid-cols-2")}>
              {julius.candidates.map((candidate, index) => (
                <CandidateCard
                  key={candidate.id}
                  candidate={candidate}
                  index={index}
                  julius={julius}
                  name={modelLabel(models, candidate.modelId)}
                  onPick={() => chooseJuliusWinner(messageId, index)}
                  readOnly={readOnly}
                />
              ))}
            </div>
          )}
          {julius.reviews.length > 0 ? (
            <div className="space-y-1.5">
              {julius.reviews.map((review) => (
                <ReviewRow
                  key={review.role}
                  review={review}
                  name={modelLabel(models, review.modelId)}
                  sources={julius.sources}
                />
              ))}
            </div>
          ) : null}
          {jevMode && julius.board ? (
            <BoardSection board={julius.board} julius={julius} models={models} />
          ) : null}
          {showVerdictBox ? (
            <div data-testid={TID.juliusVerdict} className="rounded-xl border border-ember/40 bg-ember/5 px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-xs font-medium">
                <Gavel className="h-3.5 w-3.5 text-ember" />
                {jevMode ? "Editor" : "Chairman"}
                {julius.chairmanModelId ? (
                  <span className="font-normal text-muted-foreground">
                    · {modelLabel(models, julius.chairmanModelId)}
                  </span>
                ) : null}
                {julius.chairmanServedBy ? (
                  <span
                    title={`The chairman model was unavailable — the gateway answered with ${julius.chairmanServedBy} instead.`}
                    className="rounded-full bg-gold/15 px-1.5 py-0.5 text-[9px] font-medium text-gold"
                  >
                    via {modelShortName(julius.chairmanServedBy)}
                  </span>
                ) : null}
              </p>
              {julius.verdict ? (
                <div className="mt-1 text-[13px]">
                  <MarkdownBody
                    text={julius.verdict}
                    streaming={julius.status === "debate"}
                    sources={julius.sources}
                  />
                </div>
              ) : julius.chairmanThinking ? (
                <div className="mt-1">
                  <ThinkingTail text={julius.chairmanThinking} />
                </div>
              ) : (
                <p className="mt-1 animate-pulse text-xs text-muted-foreground">Deliberating…</p>
              )}
            </div>
          ) : null}
          {julius.status === "choice" && !readOnly ? (
            <p className="text-center text-[11px] text-muted-foreground">
              Tap “Use this answer” on the candidate you want — it becomes the reply.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const DECISION_META: Record<JuliusBoardDecision, { label: string; tone: string; dot: string }> = {
  keep: { label: "keep", tone: "text-gold", dot: "bg-gold" },
  fix: { label: "fix", tone: "text-ember", dot: "bg-ember" },
  drop_wrong: { label: "drop · wrong", tone: "text-destructive/90", dot: "bg-destructive/80" },
  drop_redundant: { label: "drop · redundant", tone: "text-muted-foreground", dot: "bg-muted-foreground/60" },
};

function percentLabel(value: number | undefined): string {
  return value === undefined ? "" : `${Math.round(value * 100)}%`;
}

/**
 * Council v2: Jev's board — the backbone pick with its probability per
 * candidate, every candidate's quality grade, the keep / fix / drop tally as a
 * proportional bar, and (expanded) the ruling on every block with the
 * excerpt it applies to.
 */
function BoardSection({ board, julius, models }: { board: JuliusBoard; julius: JuliusState; models: GatewayModel[] }) {
  const [showBlocks, setShowBlocks] = useState<boolean>(false);
  const tally: Record<JuliusBoardDecision, number> = { keep: 0, fix: 0, drop_wrong: 0, drop_redundant: 0 };
  for (const block of board.blocks) {
    tally[block.decision] += 1;
  }
  const total = board.blocks.length;
  const running = board.status === "running";
  const name = (index: number): string => {
    const candidate = julius.candidates[index];
    return candidate ? modelLabel(models, candidate.modelId) : `Candidate ${juliusLetter(index)}`;
  };
  const byCandidate = [...new Set(board.blocks.map((block) => block.candidate))].sort((a, b) => a - b);

  return (
    <div data-testid={TID.juliusBoard} className="rounded-xl border border-ember/40 bg-ember/5 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <Scale className={cn("h-3.5 w-3.5 text-ember", running && "animate-pulse")} />
        <span>Jev’s board</span>
        <span className="font-normal text-muted-foreground">· {modelShortName(board.modelId)} · decision model</span>
        {running ? <Loader2 className="ml-auto h-3 w-3 animate-spin text-ember" /> : null}
        {board.status === "error" ? <AlertCircle className="ml-auto h-3 w-3 text-destructive/80" /> : null}
        {board.status === "done" && board.inputTokens ? (
          <span className="ml-auto tabular-nums text-[10px] font-normal text-muted-foreground">
            {board.inputTokens.toLocaleString()} tokens in · 0 out{board.elapsedMs ? ` · ${(board.elapsedMs / 1000).toFixed(1)}s` : ""}
          </span>
        ) : null}
      </p>
      {board.status === "error" && board.error ? (
        <p className="mt-1 text-xs text-destructive/90">{board.error}</p>
      ) : null}
      {board.backbone ? (
        <div className="mt-2 space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Backbone</p>
          {board.backbone.probabilities.map((probability, index) =>
            julius.candidates[index] ? (
              <div key={`backbone-${index}`} className="flex items-center gap-2 text-[11px]">
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full font-mono text-[9px] font-semibold",
                    index === board.backbone?.winner ? "bg-gold/20 text-gold" : "bg-foreground/5 text-muted-foreground",
                  )}
                >
                  {juliusLetter(index)}
                </span>
                <span className="w-28 shrink-0 truncate">{name(index)}</span>
                <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/5">
                  <span
                    className={cn("block h-full rounded-full", index === board.backbone?.winner ? "bg-gold" : "bg-muted-foreground/40")}
                    style={{ width: `${Math.max(2, Math.round(probability * 100))}%` }}
                  />
                </span>
                <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">{percentLabel(probability)}</span>
                {index === board.backbone?.winner ? <Crown className="h-3 w-3 shrink-0 text-gold" /> : null}
              </div>
            ) : null,
          )}
        </div>
      ) : null}
      {board.quality.length > 0 ? (
        <div className="mt-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Quality</p>
          <div className="mt-0.5 flex flex-wrap gap-1.5">
            {board.quality.map((item) => (
              <span
                key={`quality-${item.candidate}`}
                className="rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[10px]"
                title={`${name(item.candidate)} — confidence ${percentLabel(item.confidence)}`}
              >
                <span className="font-mono font-semibold">{juliusLetter(item.candidate)}</span> {item.level}
                <span className="text-muted-foreground"> · {percentLabel(item.confidence)}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {total > 0 ? (
        <div className="mt-2">
          <button
            type="button"
            data-testid={TID.juliusBoardToggle}
            onClick={() => setShowBlocks((value) => !value)}
            aria-expanded={showBlocks}
            className="flex w-full items-center gap-2 text-left"
          >
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {total} blocks
            </span>
            <span className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/5">
              {(Object.keys(DECISION_META) as JuliusBoardDecision[]).map((decision) =>
                tally[decision] > 0 ? (
                  <span
                    key={decision}
                    className={cn("block h-full", DECISION_META[decision].dot)}
                    style={{ width: `${(tally[decision] / total) * 100}%` }}
                  />
                ) : null,
              )}
            </span>
            <ChevronDown
              className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", showBlocks && "rotate-180")}
            />
          </button>
          <p className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
            {(Object.keys(DECISION_META) as JuliusBoardDecision[]).map((decision) => (
              <span key={decision} className="inline-flex items-center gap-1">
                <span className={cn("inline-block h-1.5 w-1.5 rounded-full", DECISION_META[decision].dot)} />
                {tally[decision]} {DECISION_META[decision].label}
              </span>
            ))}
          </p>
          {showBlocks ? (
            <div className="mt-1.5 max-h-64 space-y-2 overflow-y-auto pr-0.5">
              {byCandidate.map((index) => (
                <div key={`blocks-${index}`}>
                  <p className="text-[10px] font-medium">
                    <span className="font-mono">{juliusLetter(index)}</span> · {name(index)}
                    {board.backbone?.winner === index ? <span className="text-gold"> · backbone</span> : null}
                  </p>
                  <ul className="mt-0.5 space-y-0.5">
                    {board.blocks
                      .filter((block) => block.candidate === index)
                      .map((block) => (
                        <li
                          key={block.id}
                          data-testid={TID.juliusBoardBlock}
                          data-decision={block.decision}
                          className="flex items-start gap-1.5 text-[11px] leading-snug"
                        >
                          <span className={cn("mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full", DECISION_META[block.decision].dot)} />
                          <span className={cn("w-[5.5rem] shrink-0 font-medium", DECISION_META[block.decision].tone)}>
                            {DECISION_META[block.decision].label}
                            {block.probability === undefined ? "" : ` ${percentLabel(block.probability)}`}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={block.excerpt}>
                            {block.excerpt}
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : running ? (
        <p className="mt-1 animate-pulse text-xs text-muted-foreground">
          {board.quality.length > 0 ? "Ruling on every block…" : "Picking the backbone and grading the candidates…"}
        </p>
      ) : null}
    </div>
  );
}

function CandidateCard({
  candidate,
  index,
  julius,
  name,
  onPick,
  compact = false,
  readOnly = false,
}: {
  candidate: JuliusCandidateState;
  index: number;
  julius: JuliusState;
  name: string;
  onPick: () => void;
  /** Header + research trail only — used when the message body already shows the text. */
  compact?: boolean;
  /** Public share page — picking is disabled. */
  readOnly?: boolean;
}) {
  const isWinner =
    julius.winner === index && (julius.status === "done" || julius.status === "synthesis");
  const settled = julius.status === "choice" || julius.status === "done" || julius.status === "error";
  const pickable =
    !readOnly && settled && !isWinner && candidate.status !== "running" && candidate.content.trim().length > 0;
  const toolCount = candidate.toolCalls?.length ?? 0;

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-xl border",
        isWinner ? "border-gold/70 bg-gold/5" : "border-border/60 bg-background/50",
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-border/40 px-2.5 py-1.5">
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-semibold",
            isWinner ? "bg-gold/20 text-gold" : "bg-foreground/5 text-muted-foreground",
          )}
        >
          {juliusLetter(index)}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {candidate.label ? `${candidate.label} · ${name}` : name}
        </span>
        {candidate.servedBy ? (
          <span
            title={`${name} was unavailable — the gateway answered with ${candidate.servedBy} instead.`}
            className="shrink-0 rounded-full bg-gold/15 px-1.5 py-0.5 text-[9px] font-medium text-gold"
          >
            via {modelShortName(candidate.servedBy)}
          </span>
        ) : null}
        {isWinner ? <Crown className="h-3.5 w-3.5 shrink-0 text-gold" /> : null}
        {toolCount > 0 ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">{toolCount} tools</span>
        ) : null}
        {candidate.status === "running" ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-ember" />
        ) : candidate.status === "error" ? (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive/80" />
        ) : (
          <Check className="h-3.5 w-3.5 shrink-0 text-gold" />
        )}
      </div>
      {candidate.research ? <ResearchStrip research={candidate.research} /> : null}
      {compact ? null : (
        <div className="max-h-60 min-h-[2.5rem] flex-1 overflow-y-auto px-2.5 py-2 text-[13px]">
          {candidate.content ? (
            <MarkdownBody
              text={candidate.content}
              streaming={candidate.status === "running"}
              sources={julius.sources ?? candidate.research?.sources}
            />
          ) : candidate.status === "error" ? (
            <p className="text-xs text-destructive/90">{candidate.error ?? "Failed."}</p>
          ) : candidate.thinking ? (
            <ThinkingTail text={candidate.thinking} />
          ) : (
            <p className="animate-pulse text-xs text-muted-foreground">
              {candidate.research ? "Researching…" : "Thinking…"}
            </p>
          )}
        </div>
      )}
      {!compact && candidate.status === "error" && candidate.content && candidate.error ? (
        <p className="border-t border-border/40 px-2.5 py-1 text-[10px] text-destructive/80">{candidate.error}</p>
      ) : null}
      {!compact && pickable ? (
        <button
          type="button"
          onClick={onPick}
          className="border-t border-border/40 py-1.5 text-xs font-medium text-ember transition-colors hover:bg-ember/10"
        >
          {julius.winner != null ? "Use this instead" : "Use this answer"}
        </button>
      ) : null}
    </div>
  );
}

/** Compact per-candidate research trail: live counters + the current step. */
function ResearchStrip({ research }: { research: ResearchState }) {
  const searches = research.steps.filter((step) => step.kind === "search").length;
  const reads = research.steps.filter((step) => step.kind === "read").length;
  const browses = research.steps.filter((step) => step.kind === "browse").length;
  const current =
    research.status === "running"
      ? [...research.steps].reverse().find((step) => step.status === "running")
      : undefined;
  return (
    <div className="flex items-center gap-1.5 bg-ember/[0.05] px-2.5 py-1 text-[10px] text-muted-foreground">
      <Telescope
        className={cn("h-3 w-3 shrink-0 text-ember", research.status === "running" && "animate-pulse")}
      />
      <span className="shrink-0 tabular-nums">
        {searches} searches · {reads} reads{browses > 0 ? ` · ${browses} browsed` : ""} · {research.sources.length}{" "}
        sources
      </span>
      {current ? <span className="min-w-0 flex-1 truncate">— {current.label}</span> : null}
      {research.status === "error" ? <span className="shrink-0 text-destructive/80">stopped</span> : null}
    </div>
  );
}

function ReviewRow({
  review,
  name,
  sources,
}: {
  review: JuliusReviewState;
  name: string;
  /** Shared research source list — resolves [n] markers quoted from reports. */
  sources?: ResearchSource[];
}) {
  const meta = ROLE_META[review.role];
  const Icon = meta.icon;
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? review.status === "running";
  const toolCount = review.toolCalls?.length ?? 0;

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-background/50">
      <button
        type="button"
        onClick={() => setManual(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <Icon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            review.role === "critic"
              ? "text-destructive/80"
              : review.role === "proponent"
                ? "text-gold"
                : "text-ember",
          )}
        />
        <span className="shrink-0 text-xs font-medium">{meta.label}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{meta.hint}</span>
        <span className="min-w-0 flex-1 truncate text-right text-[10px] text-muted-foreground">{name}</span>
        {review.servedBy ? (
          <span
            title={`${name} was unavailable — the gateway answered with ${review.servedBy} instead.`}
            className="shrink-0 rounded-full bg-gold/15 px-1.5 py-0.5 text-[9px] font-medium text-gold"
          >
            via {modelShortName(review.servedBy)}
          </span>
        ) : null}
        {toolCount > 0 ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">{toolCount} tools</span>
        ) : null}
        {review.status === "running" ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-ember" />
        ) : review.status === "error" ? (
          <AlertCircle className="h-3 w-3 shrink-0 text-destructive/80" />
        ) : (
          <Check className="h-3 w-3 shrink-0 text-gold" />
        )}
        <ChevronDown
          className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        review.content ? (
          <div className="max-h-48 overflow-y-auto border-t border-border/40 px-2.5 py-2 text-[13px]">
            <MarkdownBody text={review.content} streaming={review.status === "running"} sources={sources} />
          </div>
        ) : review.status === "running" ? (
          <div className="border-t border-border/40 px-2.5 py-2">
            {review.thinking ? (
              <ThinkingTail text={review.thinking} />
            ) : (
              <p className="animate-pulse text-xs text-muted-foreground">{meta.busy}</p>
            )}
          </div>
        ) : null
      ) : null}
    </div>
  );
}
