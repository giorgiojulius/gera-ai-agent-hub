import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Square, Swords, Trash2, Trophy } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { MarkdownBody } from "@/components/gera/Markdown";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAgent } from "@/hooks/use-agent";
import { useAuth } from "@/hooks/use-auth";
import { fetchAccessStatus } from "@/lib/access";
import {
  COST_WEIGHT,
  PROVISIONAL_GAMES,
  arenaErrorMessage,
  clearArenaBattles,
  clearUsageStats,
  computeStandings,
  estimateAnswerCost,
  estimateUsageRowCost,
  fetchArenaBattles,
  fetchUsageStats,
  logArenaBattle,
  splitUsageStats,
  type ArenaBattle,
  type UsageRow,
} from "@/lib/arena";
import { streamCompletion } from "@/lib/chat";
import { findModel, formatUsd, modelsForMode, parseModelSelection } from "@/lib/models";
import type { GatewayModel, OpenAiChatMessage } from "@/lib/types";
import { beginUsageCapture, endUsageCapture } from "@/lib/usage";
import { cn } from "@/lib/utils";

type DuelSide = {
  selectionId: string;
  content: string;
  status: "running" | "done" | "error";
  error?: string;
  /** USD estimate of this answer (tokens × gateway list rates). */
  cost?: number;
};

type DuelPhase = "running" | "vote" | "failed" | "logged";

type Duel = {
  prompt: string;
  /** Index 0 = left pane, 1 = right pane — already shuffled for blindness. */
  sides: [DuelSide, DuelSide];
  phase: DuelPhase;
};

function timeAgo(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

const COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function formatCount(value: number): string {
  return COMPACT.format(value);
}

type UsageWindow = "7" | "30" | "all";

function usageModeLabel(mode: string): string {
  if (mode === "chat") {
    return "Chat";
  }
  if (mode === "image") {
    return "Image";
  }
  if (mode === "video") {
    return "Video";
  }
  if (mode === "audio") {
    return "TTS · audio";
  }
  if (mode === "service") {
    return "Service · router, planner, titles";
  }
  return mode;
}

/** Column header for per-asset units of a media mode. */
function unitsLabel(mode: string): string {
  if (mode === "image") {
    return "Images";
  }
  if (mode === "video") {
    return "Seconds";
  }
  if (mode === "audio") {
    return "Chars";
  }
  return "Units";
}

/**
 * One mode's standings table. Token modes show token + cost columns; media
 * modes show per-asset units (images, video seconds, TTS characters) priced
 * at list rates. Columns with nothing to say hide instead of showing zeros.
 */
function UsageStandingsTable({
  mode,
  rows,
  models,
  modelName,
}: {
  mode: string;
  rows: UsageRow[];
  models: GatewayModel[];
  modelName: (id: string) => string;
}) {
  const showTokens = rows.some((row) => row.promptTokens + row.completionTokens > 0);
  const showUnits = rows.some((row) => row.units > 0);
  const showCost = rows.some(
    (row) => estimateUsageRowCost(findModel(models, row.modelId), row, mode) !== undefined,
  );
  return (
    <div className="overflow-x-auto rounded-2xl border border-border/70 bg-card">
      <table className={cn("w-full text-left text-xs", showTokens || showUnits ? "min-w-[640px]" : "min-w-[480px]")}>
        <thead>
          <tr className="border-b border-border/60 text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 font-medium">#</th>
            <th className="px-3 py-2 font-medium">Model</th>
            <th className="px-3 py-2 text-right font-medium">Runs</th>
            <th className="px-3 py-2 text-right font-medium">Share</th>
            <th className="px-3 py-2 text-right font-medium">Members</th>
            <th className="px-3 py-2 text-right font-medium">Errors</th>
            {showTokens ? <th className="px-3 py-2 text-right font-medium">Tokens</th> : null}
            {showUnits ? <th className="px-3 py-2 text-right font-medium">{unitsLabel(mode)}</th> : null}
            {showCost ? <th className="px-3 py-2 text-right font-medium">≈$ total</th> : null}
            <th className="px-3 py-2 text-right font-medium">Last used</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const cost = estimateUsageRowCost(findModel(models, row.modelId), row, mode);
            const errorRate = row.runs > 0 ? Math.round((row.errors / row.runs) * 100) : 0;
            return (
              <tr key={row.modelId} className="border-b border-border/40 last:border-b-0">
                <td className="px-3 py-2 tabular-nums text-muted-foreground">{index + 1}</td>
                <td className="max-w-[220px] px-3 py-2">
                  <span className="flex items-center gap-1.5">
                    {index === 0 ? <Trophy className="h-3 w-3 shrink-0 text-gold" /> : null}
                    <span className="truncate">{modelName(row.modelId)}</span>
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{row.runs}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {Math.round(row.share * 100)}%
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{row.users}</td>
                <td
                  className={cn(
                    "px-3 py-2 text-right tabular-nums",
                    errorRate > 0 ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {errorRate}%
                </td>
                {showTokens ? (
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                    {formatCount(row.promptTokens + row.completionTokens)}
                  </td>
                ) : null}
                {showUnits ? (
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                    {row.units > 0 ? formatCount(row.units) : "—"}
                  </td>
                ) : null}
                {showCost ? (
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                    {cost !== undefined && cost > 0 ? `≈${formatUsd(cost)}` : "—"}
                  </td>
                ) : null}
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {row.lastUsed > 0 ? timeAgo(row.lastUsed) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Model arena, tucked into Settings: blind two-model duels, a shared
 * cross-member battle journal, Elo standings, and a cost-adjusted Value
 * column so expensive wins stay honest.
 */
export function ArenaStudio() {
  const { state, models } = useAgent();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const chatModels = useMemo(() => modelsForMode(models, "chat"), [models]);

  const [modelA, setModelA] = useState<string>("");
  const [modelB, setModelB] = useState<string>("");
  const [prompt, setPrompt] = useState<string>("");
  const [duel, setDuel] = useState<Duel | null>(null);
  const [confirmClear, setConfirmClear] = useState<boolean>(false);
  const [confirmClearUsage, setConfirmClearUsage] = useState<boolean>(false);
  const abortRef = useRef<AbortController | null>(null);

  // Defaults once the catalog arrives: current chat model vs the first different engine.
  useEffect(() => {
    if (chatModels.length === 0 || (modelA && modelB)) {
      return;
    }
    const fallbackA = chatModels.some((model) => model.id === state.settings.modelId)
      ? state.settings.modelId
      : chatModels[0]?.id ?? "";
    const catalogA = parseModelSelection(fallbackA).catalogId;
    const fallbackB = chatModels.find((model) => parseModelSelection(model.id).catalogId !== catalogA)?.id ?? "";
    if (!modelA) {
      setModelA(fallbackA);
    }
    if (!modelB) {
      setModelB(fallbackB);
    }
  }, [chatModels, modelA, modelB, state.settings.modelId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const statusQuery = useQuery({
    queryKey: ["access-status", user?.id ?? "anon"],
    queryFn: fetchAccessStatus,
    enabled: user !== null,
  });
  const isAdmin = statusQuery.data?.role === "admin";

  const [usageWindow, setUsageWindow] = useState<UsageWindow>("30");
  const usageQuery = useQuery({
    queryKey: ["arena-usage", usageWindow],
    queryFn: () =>
      fetchUsageStats(usageWindow === "all" ? 0 : Date.now() - Number(usageWindow) * 86_400_000),
    enabled: user !== null && isAdmin,
    staleTime: 30_000,
  });
  const usageGroups = useMemo(() => splitUsageStats(usageQuery.data ?? []), [usageQuery.data]);

  const battlesQuery = useQuery({
    queryKey: ["arena-battles"],
    queryFn: fetchArenaBattles,
    enabled: user !== null && isAdmin,
    staleTime: 30_000,
  });
  const battles = useMemo(() => battlesQuery.data ?? [], [battlesQuery.data]);
  const standings = useMemo(() => computeStandings(battles), [battles]);
  const recent = useMemo(() => [...battles].slice(-30).reverse(), [battles]);
  const bestValueId = useMemo(() => {
    const costed = standings.filter((row) => row.hasCost);
    if (costed.length < 2) {
      return undefined;
    }
    return [...costed].sort((a, b) => b.value - a.value)[0]?.modelId;
  }, [standings]);

  const modelName = useCallback(
    (id: string) => findModel(models, id)?.name ?? id,
    [models],
  );

  const patchSide = useCallback((index: 0 | 1, patch: Partial<DuelSide>) => {
    setDuel((prev) => {
      if (!prev) {
        return prev;
      }
      const sides = [...prev.sides] as [DuelSide, DuelSide];
      sides[index] = { ...sides[index], ...patch };
      return { ...prev, sides };
    });
  }, []);

  const running = duel?.phase === "running";

  const runDuel = useCallback(async () => {
    const text = prompt.trim();
    if (!text) {
      toast.error("Write a duel prompt first.");
      return;
    }
    if (!modelA || !modelB) {
      toast.error("Pick both contenders.");
      return;
    }
    const catalogA = parseModelSelection(modelA).catalogId;
    const catalogB = parseModelSelection(modelB).catalogId;
    if (catalogA === catalogB) {
      toast.error("Pick two different engines — token costs can't be told apart between two runs of the same model.");
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Blind test: shuffle which model lands on which side; revealed after the vote.
    const order: [string, string] = Math.random() < 0.5 ? [modelA, modelB] : [modelB, modelA];
    setDuel({
      prompt: text,
      sides: [
        { selectionId: order[0], content: "", status: "running" },
        { selectionId: order[1], content: "", status: "running" },
      ],
      phase: "running",
    });

    const system =
      `You are one of two anonymous assistants in a blind quality duel. ` +
      `Today's date: ${new Date().toISOString().slice(0, 10)} (UTC). ` +
      `Answer the user's message directly and as well as you can. No tools are available — ` +
      `if the answer needs live data you cannot know, say so honestly instead of inventing it.`;
    const messages: OpenAiChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: text },
    ];

    // One shared capture; per-side split comes from byModel — that is why the
    // two contenders must be different base engines.
    const capture = beginUsageCapture();
    const runSide = async (index: 0 | 1) => {
      try {
        await streamCompletion({
          modelId: order[index],
          messages,
          tools: [],
          handlers: {
            signal: controller.signal,
            onText: (full) => patchSide(index, { content: full }),
          },
        });
        patchSide(index, { status: "done" });
      } catch (error) {
        const message =
          error instanceof DOMException && error.name === "AbortError"
            ? "Stopped."
            : error instanceof Error
              ? error.message
              : "The call failed.";
        patchSide(index, { status: "error", error: message });
      }
    };
    await Promise.allSettled([runSide(0), runSide(1)]);
    const usage = endUsageCapture(capture);

    setDuel((prev) => {
      if (!prev) {
        return prev;
      }
      const sides = prev.sides.map((side) => {
        const catalogId = parseModelSelection(side.selectionId).catalogId;
        const cost = estimateAnswerCost(findModel(models, side.selectionId), usage?.byModel[catalogId]);
        return cost !== undefined ? { ...side, cost } : side;
      }) as [DuelSide, DuelSide];
      const bothDone = sides.every((side) => side.status === "done" && side.content.trim().length > 0);
      return { ...prev, sides, phase: bothDone ? "vote" : "failed" };
    });
  }, [prompt, modelA, modelB, models, patchSide]);

  const voteMutation = useMutation({
    mutationFn: async (choice: "left" | "right" | "draw") => {
      if (!duel) {
        throw new Error("No duel.");
      }
      const [left, right] = duel.sides;
      const winner = choice === "right" ? right : left;
      const loser = choice === "right" ? left : right;
      await logArenaBattle({
        winnerId: winner.selectionId,
        loserId: loser.selectionId,
        draw: choice === "draw",
        prompt: duel.prompt,
        winnerCost: winner.cost,
        loserCost: loser.cost,
      });
    },
    onSuccess: () => {
      setDuel((prev) => (prev ? { ...prev, phase: "logged" } : prev));
      void queryClient.invalidateQueries({ queryKey: ["arena-battles"] });
    },
    onError: (error) => toast.error(arenaErrorMessage(error)),
  });

  const clearMutation = useMutation({
    mutationFn: clearArenaBattles,
    onSuccess: () => {
      setConfirmClear(false);
      void queryClient.invalidateQueries({ queryKey: ["arena-battles"] });
      toast.success("Battle log cleared for everyone.");
    },
    onError: (error) => toast.error(arenaErrorMessage(error)),
  });

  const clearUsageMutation = useMutation({
    mutationFn: clearUsageStats,
    onSuccess: () => {
      setConfirmClearUsage(false);
      void queryClient.invalidateQueries({ queryKey: ["arena-usage"] });
      toast.success("Usage journal cleared — standings rebuild from new turns.");
    },
    onError: (error) => toast.error(arenaErrorMessage(error)),
  });

  const revealed = duel?.phase === "logged" || duel?.phase === "failed";
  const catalogOfA = modelA ? parseModelSelection(modelA).catalogId : "";
  const catalogOfB = modelB ? parseModelSelection(modelB).catalogId : "";

  // Honest gate: members never reach this pane via the nav, but a deep link
  // lands here — say plainly why it is empty instead of erroring.
  if (statusQuery.data !== undefined && !isAdmin) {
    return (
      <p className="mt-8 max-w-xl rounded-2xl border border-border/70 bg-card px-4 py-4 text-sm text-muted-foreground">
        The arena is admin-only — your account doesn't have access.
      </p>
    );
  }

  return (
    <div className="mt-4">
      <section className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Usage standings · automatic
            </h3>
            {usageQuery.isFetching ? (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            ) : null}
          </div>
          <div className="flex items-center gap-1.5">
            {usageGroups.length > 0 ? (
              confirmClearUsage ? (
                <span className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-7 rounded-lg px-2 text-[11px]"
                    disabled={clearUsageMutation.isPending}
                    onClick={() => clearUsageMutation.mutate()}
                  >
                    Really clear usage
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 rounded-lg px-2 text-[11px]"
                    onClick={() => setConfirmClearUsage(false)}
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 rounded-lg px-2 text-[11px] text-muted-foreground"
                  onClick={() => setConfirmClearUsage(true)}
                >
                  <Trash2 className="h-3 w-3" />
                  Clear
                </Button>
              )
            ) : null}
            <Select value={usageWindow} onValueChange={(value) => setUsageWindow(value as UsageWindow)}>
              <SelectTrigger className="h-7 w-[120px] rounded-lg bg-white text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7" className="text-xs">
                  Last 7 days
                </SelectItem>
                <SelectItem value="30" className="text-xs">
                  Last 30 days
                </SelectItem>
                <SelectItem value="all" className="text-xs">
                  All time
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {usageQuery.isError ? (
          <p className="mt-2 text-xs text-destructive">{arenaErrorMessage(usageQuery.error)}</p>
        ) : usageGroups.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {usageQuery.isPending
              ? "Loading usage…"
              : "No usage recorded in this window yet — standings fill in as members chat."}
          </p>
        ) : (
          <div className="mt-2 space-y-4">
            {usageGroups.map((group) => (
              <div key={group.mode}>
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">
                  {usageModeLabel(group.mode)} · {group.runs} {group.runs === 1 ? "run" : "runs"}
                </p>
                <div className="mt-1.5">
                  <UsageStandingsTable mode={group.mode} rows={group.rows} models={models} modelName={modelName} />
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Collected automatically from real turns: model, mode, outcome, token counts and media units — never
          message content, and incognito threads report nothing. Standings are split by mode — share is
          relative to that table's runs. “Service” rows are internal helper calls (tool router, research
          planner, thread titles) kept out of the chat table on purpose — they measure spend, not adoption.
          This measures adoption and reliability, not answer quality — that is what blind duels below are
          for. Errors = failed turns (a manual Stop is not an error). Costs are estimates at current gateway
          list rates: tokens for text, per asset for media (images, video seconds, TTS characters). Events
          logged before the service split keep their old chat label — Clear starts the journal fresh. The log
          keeps the most recent 50,000 events.
        </p>
      </section>

      <h3 className="mt-6 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        Blind duel · manual
      </h3>
      <section className="mt-2 rounded-2xl border border-border/70 bg-card p-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <p className="pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
              Contender A
            </p>
            <Select value={modelA} onValueChange={setModelA} disabled={running}>
              <SelectTrigger className="h-9 rounded-xl bg-white text-xs">
                <SelectValue placeholder="Pick a model" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {chatModels.map((model) => (
                  <SelectItem
                    key={model.id}
                    value={model.id}
                    disabled={parseModelSelection(model.id).catalogId === catalogOfB}
                    className="text-xs"
                  >
                    {model.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
              Contender B
            </p>
            <Select value={modelB} onValueChange={setModelB} disabled={running}>
              <SelectTrigger className="h-9 rounded-xl bg-white text-xs">
                <SelectValue placeholder="Pick a model" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {chatModels.map((model) => (
                  <SelectItem
                    key={model.id}
                    value={model.id}
                    disabled={parseModelSelection(model.id).catalogId === catalogOfA}
                    className="text-xs"
                  >
                    {model.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          disabled={running}
          placeholder={'One prompt for both — e.g. "Explain quantum entanglement to a 10-year-old"'}
          className="mt-2 min-h-[72px] rounded-xl border-border bg-white text-sm"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">
            Sides are shuffled and unnamed until the vote — names and costs reveal after.
          </p>
          {running ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => abortRef.current?.abort()}
              className="h-8 gap-1.5 rounded-xl text-xs"
            >
              <Square className="h-3.5 w-3.5" />
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void runDuel()}
              className="h-8 gap-1.5 rounded-xl bg-ember text-xs text-ember-foreground hover:bg-ember/90"
            >
              <Swords className="h-3.5 w-3.5" />
              Run duel
            </Button>
          )}
        </div>

        {duel ? (
          <div className="mt-4">
            <div className="grid gap-3 md:grid-cols-2">
              {duel.sides.map((side, index) => {
                const title = revealed
                  ? modelName(side.selectionId)
                  : index === 0
                    ? "Model A"
                    : "Model B";
                return (
                  <div
                    key={index}
                    className="flex min-w-0 flex-col rounded-2xl border border-border/70 bg-background p-3"
                  >
                    <div className="flex items-center justify-between gap-2 pb-2">
                      <p className="truncate text-xs font-semibold">{title}</p>
                      {side.status === "running" ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                      ) : revealed && side.cost !== undefined ? (
                        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                          ≈{formatUsd(side.cost)}
                        </span>
                      ) : null}
                    </div>
                    <div className="max-h-72 min-h-[80px] overflow-y-auto text-sm">
                      {side.status === "error" ? (
                        <p className="text-xs text-destructive">{side.error}</p>
                      ) : side.content ? (
                        <MarkdownBody text={side.content} streaming={side.status === "running"} />
                      ) : (
                        <p className="text-xs italic text-muted-foreground">Thinking…</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {duel.phase === "vote" ? (
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-xl text-xs"
                  disabled={voteMutation.isPending}
                  onClick={() => voteMutation.mutate("left")}
                >
                  A is better
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-xl text-xs"
                  disabled={voteMutation.isPending}
                  onClick={() => voteMutation.mutate("draw")}
                >
                  Draw
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-xl text-xs"
                  disabled={voteMutation.isPending}
                  onClick={() => voteMutation.mutate("right")}
                >
                  B is better
                </Button>
              </div>
            ) : null}
            {duel.phase === "failed" ? (
              <p className="mt-3 text-center text-xs text-muted-foreground">
                A side failed or was stopped — this duel is not scored. Run it again.
              </p>
            ) : null}
            {duel.phase === "logged" ? (
              <p className="mt-3 text-center text-xs text-muted-foreground">
                Vote saved to the shared log — names and costs revealed above.
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="mt-6">
        <div className="flex items-center gap-2">
          <h3 className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Duel standings · {standings.length}
          </h3>
          {battlesQuery.isFetching ? (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        {battlesQuery.isError ? (
          <p className="mt-2 text-xs text-destructive">{arenaErrorMessage(battlesQuery.error)}</p>
        ) : standings.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">No duels yet — run the first one above.</p>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-2xl border border-border/70 bg-card">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead>
                <tr className="border-b border-border/60 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Model</th>
                  <th className="px-3 py-2 text-right font-medium">Elo</th>
                  <th className="px-3 py-2 text-right font-medium">W-L-D</th>
                  <th className="px-3 py-2 text-right font-medium">Win %</th>
                  <th className="px-3 py-2 text-right font-medium">$ / answer</th>
                  <th className="px-3 py-2 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((row, index) => {
                  const decided = row.wins + row.losses;
                  const winRate = decided > 0 ? Math.round((row.wins / decided) * 100) : null;
                  return (
                    <tr key={row.modelId} className="border-b border-border/40 last:border-b-0">
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{index + 1}</td>
                      <td className="max-w-[220px] px-3 py-2">
                        <span className="flex items-center gap-1.5">
                          {index === 0 ? <Trophy className="h-3 w-3 shrink-0 text-gold" /> : null}
                          <span className="truncate">{modelName(row.modelId)}</span>
                          {row.games < PROVISIONAL_GAMES ? (
                            <span
                              title={`Fewer than ${PROVISIONAL_GAMES} games — provisional`}
                              className="text-muted-foreground"
                            >
                              *
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{row.rating}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {row.wins}-{row.losses}-{row.draws}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {winRate === null ? "—" : `${winRate}%`}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                        {row.avgCost !== undefined ? `≈${formatUsd(row.avgCost)}` : "—"}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2 text-right font-mono tabular-nums",
                          row.modelId === bestValueId ? "font-semibold text-emerald-700" : "",
                        )}
                      >
                        {row.hasCost ? row.value : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Elo: start 1000, K = 32, a draw scores ½. Value = Elo − {COST_WEIGHT} × log₂(avg $ per answer ÷
          cheapest) — every price doubling costs {COST_WEIGHT} points. * = fewer than {PROVISIONAL_GAMES} games,
          provisional. Costs are token estimates at gateway list rates; media generation is not counted.
        </p>
      </section>

      <section className="mt-6">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Battle log · {battles.length}
          </h3>
          {isAdmin && battles.length > 0 ? (
            confirmClear ? (
              <span className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7 rounded-lg px-2 text-[11px]"
                  disabled={clearMutation.isPending}
                  onClick={() => clearMutation.mutate()}
                >
                  Really clear all
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 rounded-lg px-2 text-[11px]"
                  onClick={() => setConfirmClear(false)}
                >
                  Cancel
                </Button>
              </span>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 rounded-lg px-2 text-[11px] text-muted-foreground"
                onClick={() => setConfirmClear(true)}
              >
                <Trash2 className="h-3 w-3" />
                Clear
              </Button>
            )
          ) : null}
        </div>
        {battles.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">Every vote lands here with who cast it.</p>
        ) : (
          <div className="mt-2 divide-y divide-border/50 rounded-2xl border border-border/70 bg-card px-4">
            {recent.map((battle: ArenaBattle) => (
              <div key={battle.id} className="py-2.5">
                <p className="text-xs">
                  {battle.draw ? (
                    <>
                      Draw: <span className="font-medium">{modelName(battle.winnerId)}</span> vs{" "}
                      <span className="font-medium">{modelName(battle.loserId)}</span>
                    </>
                  ) : (
                    <>
                      <span className="font-medium">{modelName(battle.winnerId)}</span>{" "}
                      <span className="text-muted-foreground">beat</span> {modelName(battle.loserId)}
                    </>
                  )}
                </p>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {battle.voter} · {timeAgo(battle.createdAt)}
                  {battle.winnerCost !== undefined || battle.loserCost !== undefined
                    ? ` · ${battle.winnerCost !== undefined ? `≈${formatUsd(battle.winnerCost)}` : "—"} vs ${
                        battle.loserCost !== undefined ? `≈${formatUsd(battle.loserCost)}` : "—"
                      }`
                    : ""}
                  {battle.prompt ? ` · “${battle.prompt}”` : ""}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
