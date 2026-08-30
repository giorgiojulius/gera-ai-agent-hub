// Model arena — admin-only insight into which models actually get used and
// how they hold up. Two data sources: automatic usage telemetry from every
// member's real turns (model, mode, outcome, token counts — never message
// content), and manual blind duels whose votes replay through standard Elo.
// A cost-adjusted Value column keeps expensive wins honest.
import { authedFetch, parseOrThrow } from "@/lib/backend";
import type { GatewayModel, ModelTokens } from "@/lib/types";

export type ArenaBattle = {
  id: string;
  /** Member whose vote this is — the journal is deliberately open inside the workspace. */
  voter: string;
  winnerId: string;
  loserId: string;
  /** true = tie; winner/loser order carries no meaning then. */
  draw: boolean;
  prompt: string;
  /** USD estimate per answer (tokens × gateway list rates); absent when the provider reported no usage. */
  winnerCost?: number;
  loserCost?: number;
  createdAt: number;
};

export type ArenaStanding = {
  modelId: string;
  /** Elo after replaying the whole journal chronologically. */
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  games: number;
  /** Mean $ per answer across battles where usage was metered. */
  avgCost?: number;
  costedAnswers: number;
  /** Cost-adjusted rating: rating − COST_WEIGHT·log₂(avgCost ÷ cheapest avgCost). */
  value: number;
  /** false = no cost data yet; value simply mirrors rating then. */
  hasCost: boolean;
};

export const ELO_START = 1000;
export const ELO_K = 32;
/** Every doubling of average answer cost subtracts this many Value points. */
export const COST_WEIGHT = 40;
/** Below this many games a rating is provisional — flagged in the UI. */
export const PROVISIONAL_GAMES = 5;

/** Classic Elo expectation of `a` beating `b`. */
export function expectedScore(a: number, b: number): number {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

type MutableRow = {
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  costSum: number;
  costedAnswers: number;
};

/**
 * Replays the battle journal chronologically through standard Elo
 * (K = 32, start 1000, a draw scores ½) and derives the cost-adjusted
 * Value column. Pure: same journal in, same standings out.
 */
export function computeStandings(battles: ArenaBattle[]): ArenaStanding[] {
  const ordered = [...battles].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const table = new Map<string, MutableRow>();
  const rowFor = (modelId: string): MutableRow => {
    const existing = table.get(modelId);
    if (existing) {
      return existing;
    }
    const created: MutableRow = { rating: ELO_START, wins: 0, losses: 0, draws: 0, costSum: 0, costedAnswers: 0 };
    table.set(modelId, created);
    return created;
  };

  for (const battle of ordered) {
    if (!battle.winnerId || !battle.loserId || battle.winnerId === battle.loserId) {
      continue; // self-battles would corrupt ratings
    }
    const winner = rowFor(battle.winnerId);
    const loser = rowFor(battle.loserId);
    const score = battle.draw ? 0.5 : 1;
    const delta = ELO_K * (score - expectedScore(winner.rating, loser.rating));
    winner.rating += delta;
    loser.rating -= delta;
    if (battle.draw) {
      winner.draws += 1;
      loser.draws += 1;
    } else {
      winner.wins += 1;
      loser.losses += 1;
    }
    if (typeof battle.winnerCost === "number" && Number.isFinite(battle.winnerCost)) {
      winner.costSum += battle.winnerCost;
      winner.costedAnswers += 1;
    }
    if (typeof battle.loserCost === "number" && Number.isFinite(battle.loserCost)) {
      loser.costSum += battle.loserCost;
      loser.costedAnswers += 1;
    }
  }

  const rows = [...table.entries()].map(([modelId, row]) => ({
    modelId,
    row,
    avgCost: row.costedAnswers > 0 ? row.costSum / row.costedAnswers : undefined,
  }));
  const positiveCosts = rows
    .map((item) => item.avgCost)
    .filter((cost): cost is number => typeof cost === "number" && cost > 0);
  const cheapest = positiveCosts.length > 0 ? Math.min(...positiveCosts) : undefined;

  return rows
    .map(({ modelId, row, avgCost }) => {
      let value = row.rating;
      let hasCost = false;
      if (typeof avgCost === "number" && avgCost > 0 && cheapest !== undefined) {
        hasCost = true;
        value = row.rating - COST_WEIGHT * Math.log2(avgCost / cheapest);
      }
      return {
        modelId,
        rating: Math.round(row.rating),
        wins: row.wins,
        losses: row.losses,
        draws: row.draws,
        games: row.wins + row.losses + row.draws,
        avgCost,
        costedAnswers: row.costedAnswers,
        value: Math.round(value),
        hasCost,
      };
    })
    .sort((a, b) => b.rating - a.rating || b.games - a.games || a.modelId.localeCompare(b.modelId));
}

/**
 * Prices one answer with gateway list rates; undefined when tokens or rates
 * are missing. Provider-cached prompt tokens (a subset of `prompt`) bill at
 * the cache-read rate when the catalog lists one; reasoning tokens are
 * already inside `completion` per the OpenAI-compatible spec.
 */
export function estimateAnswerCost(
  model: GatewayModel | undefined,
  tokens: ModelTokens | undefined,
): number | undefined {
  const input = model?.pricing?.input;
  const output = model?.pricing?.output;
  if (!tokens || typeof input !== "number" || typeof output !== "number") {
    return undefined;
  }
  const cached = Math.min(tokens.cached ?? 0, tokens.prompt);
  const cacheRate = model?.pricing?.inputCacheRead ?? input;
  return (tokens.prompt - cached) * input + cached * cacheRate + tokens.completion * output;
}

/** Prices generated media at list rates: images per asset, video per second, TTS per character. */
export function estimateMediaCost(
  model: GatewayModel | undefined,
  tally: { images?: number; videoSeconds?: number; speechChars?: number },
): number | undefined {
  const pricing = model?.pricing;
  if (!pricing) {
    return undefined;
  }
  let cost = 0;
  let priced = false;
  if (tally.images && typeof pricing.image === "number") {
    cost += tally.images * pricing.image;
    priced = true;
  }
  if (tally.videoSeconds && typeof pricing.videoPerSecond === "number") {
    cost += tally.videoSeconds * pricing.videoPerSecond;
    priced = true;
  }
  if (tally.speechChars && typeof pricing.speechChar === "number") {
    cost += tally.speechChars * pricing.speechChar;
    priced = true;
  }
  return priced ? cost : undefined;
}

export type UsageStat = {
  modelId: string;
  mode: string;
  runs: number;
  errors: number;
  users: number;
  promptTokens: number;
  completionTokens: number;
  /** Media units for per-asset modes: images, video seconds, TTS characters. */
  units: number;
  lastUsed: number;
};

export type UsageRow = {
  modelId: string;
  modes: string[];
  runs: number;
  errors: number;
  /** Distinct members; max across modes — a lower bound when a model spans modes. */
  users: number;
  promptTokens: number;
  completionTokens: number;
  /** Media units for per-asset modes: images, video seconds, TTS characters. */
  units: number;
  lastUsed: number;
  /** Fraction of all runs in the window, 0..1. */
  share: number;
};

/** Merges per-(model, mode) aggregates into one row per model, ranked by runs. */
export function mergeUsageStats(stats: UsageStat[]): UsageRow[] {
  const map = new Map<string, UsageRow>();
  let total = 0;
  for (const stat of stats) {
    total += stat.runs;
    const row = map.get(stat.modelId);
    if (!row) {
      map.set(stat.modelId, {
        modelId: stat.modelId,
        modes: [stat.mode],
        runs: stat.runs,
        errors: stat.errors,
        users: stat.users,
        promptTokens: stat.promptTokens,
        completionTokens: stat.completionTokens,
        units: stat.units,
        lastUsed: stat.lastUsed,
        share: 0,
      });
      continue;
    }
    if (!row.modes.includes(stat.mode)) {
      row.modes.push(stat.mode);
    }
    row.runs += stat.runs;
    row.errors += stat.errors;
    row.users = Math.max(row.users, stat.users);
    row.promptTokens += stat.promptTokens;
    row.completionTokens += stat.completionTokens;
    row.units += stat.units;
    row.lastUsed = Math.max(row.lastUsed, stat.lastUsed);
  }
  const rows = [...map.values()].sort(
    (a, b) => b.runs - a.runs || b.lastUsed - a.lastUsed || a.modelId.localeCompare(b.modelId),
  );
  for (const row of rows) {
    row.share = total > 0 ? row.runs / total : 0;
  }
  return rows;
}

export type UsageModeGroup = {
  /** Turn mode this table covers: chat, image, video, audio, or a future mode. */
  mode: string;
  rows: UsageRow[];
  /** Total runs inside this group — shares are relative to this. */
  runs: number;
};

const USAGE_MODE_ORDER = ["chat", "image", "video", "audio", "service"];

/**
 * Prices one usage-standings row for its mode: token modes at input/output
 * list rates, media modes per unit (image count, video seconds, TTS
 * characters). Undefined = honest "—": no rate listed or nothing metered.
 */
export function estimateUsageRowCost(
  model: GatewayModel | undefined,
  row: { runs: number; promptTokens: number; completionTokens: number; units: number },
  mode: string,
): number | undefined {
  if (mode === "image") {
    return row.units > 0 ? estimateMediaCost(model, { images: row.units }) : undefined;
  }
  if (mode === "video") {
    return row.units > 0 ? estimateMediaCost(model, { videoSeconds: row.units }) : undefined;
  }
  if (mode === "audio") {
    return row.units > 0 ? estimateMediaCost(model, { speechChars: row.units }) : undefined;
  }
  if (row.promptTokens + row.completionTokens === 0) {
    return undefined;
  }
  return estimateAnswerCost(model, {
    prompt: row.promptTokens,
    completion: row.completionTokens,
    calls: row.runs,
  });
}

/**
 * Splits per-(model, mode) aggregates into one standings table per mode —
 * chat first, then image, video, TTS — so media generators stop competing
 * with chat models for rank. Shares are computed within each group.
 */
export function splitUsageStats(stats: UsageStat[]): UsageModeGroup[] {
  const byMode = new Map<string, UsageStat[]>();
  for (const stat of stats) {
    const mode = stat.mode || "chat";
    const list = byMode.get(mode);
    if (list) {
      list.push(stat);
    } else {
      byMode.set(mode, [stat]);
    }
  }
  return [...byMode.entries()]
    .sort((a, b) => {
      const ia = USAGE_MODE_ORDER.indexOf(a[0]);
      const ib = USAGE_MODE_ORDER.indexOf(b[0]);
      return (
        (ia === -1 ? USAGE_MODE_ORDER.length : ia) - (ib === -1 ? USAGE_MODE_ORDER.length : ib) ||
        a[0].localeCompare(b[0])
      );
    })
    .map(([mode, group]) => {
      const rows = mergeUsageStats(group);
      return { mode, rows, runs: rows.reduce((sum, row) => sum + row.runs, 0) };
    });
}

/** Admin-only: per-model usage aggregates since a timestamp (0 = all time). */
export async function fetchUsageStats(since: number): Promise<UsageStat[]> {
  const response = await authedFetch(`/arena/usage/stats?since=${Math.max(0, Math.floor(since))}`);
  const data = await parseOrThrow<{ stats: UsageStat[] }>(response, "Could not load usage standings");
  return Array.isArray(data.stats)
    ? data.stats
        .filter(
          (item) =>
            typeof item?.modelId === "string" &&
            typeof item.mode === "string" &&
            typeof item.runs === "number",
        )
        .map((item) => ({ ...item, units: typeof item.units === "number" ? item.units : 0 }))
    : [];
}

/** Admin-only: wipes the usage telemetry journal for everyone (battles stay). */
export async function clearUsageStats(): Promise<void> {
  const response = await authedFetch("/arena/usage/clear", { method: "POST" });
  await parseOrThrow<{ ok: boolean }>(response, "Could not clear usage stats");
}

export type LogBattleInput = {
  winnerId: string;
  loserId: string;
  draw: boolean;
  prompt: string;
  winnerCost?: number;
  loserCost?: number;
};

export async function fetchArenaBattles(): Promise<ArenaBattle[]> {
  const response = await authedFetch("/arena/battles");
  const data = await parseOrThrow<{ battles: ArenaBattle[] }>(response, "Could not load the battle log");
  return Array.isArray(data.battles)
    ? data.battles.filter(
        (item) =>
          typeof item?.id === "string" &&
          typeof item.winnerId === "string" &&
          typeof item.loserId === "string" &&
          typeof item.createdAt === "number",
      )
    : [];
}

export async function logArenaBattle(input: LogBattleInput): Promise<void> {
  const response = await authedFetch("/arena/log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await parseOrThrow<{ battle: ArenaBattle }>(response, "Could not save the vote");
}

/** Admin-only: wipes the shared journal for everyone. */
export async function clearArenaBattles(): Promise<void> {
  const response = await authedFetch("/arena/clear", { method: "POST" });
  await parseOrThrow<{ ok: boolean }>(response, "Could not clear the log");
}

/** Maps backend error codes to copy a person can act on. */
export function arenaErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "sign_in_required") {
    return "Sign in to use the arena.";
  }
  if (code === "invite_required") {
    return "The arena needs an invited Gera account.";
  }
  if (code === "admin_required") {
    return "The arena is admin-only.";
  }
  return code || "Something went wrong. Try again.";
}
