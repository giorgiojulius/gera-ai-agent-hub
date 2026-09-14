import { ArrowDownRight, ArrowUpRight, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { memo, useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  autoDeskGranularity,
  bucketDeskTimeline,
  bucketMetricValue,
  compareDeskPeriods,
  describeTrend,
  effectiveDeskSpan,
  formatMetric,
  percentDelta,
  type DeskTrendBucket,
  type DeskTrendGranularity,
  type DeskTrendMetric,
} from "@/lib/desk-trends";
import type { DeskStatsRange, DeskTimelinePoint } from "@/lib/projects";
import { TID } from "@/lib/testids";
import { cn } from "@/lib/utils";

const METRICS: Array<{ id: DeskTrendMetric; label: string }> = [
  { id: "quality", label: "Quality" },
  { id: "response", label: "Reply time" },
  { id: "withinHour", label: "Within 1h" },
  { id: "replies", label: "Volume" },
];

const GRANULARITIES: Array<{ id: DeskTrendGranularity; label: string }> = [
  { id: "day", label: "Days" },
  { id: "week", label: "Weeks" },
  { id: "month", label: "Months" },
];

const GRID_STROKE = "hsl(336, 10%, 86%)";
const AXIS_TICK = { fontSize: 10, fill: "hsl(332, 8%, 46%)" };
const EMBER = "hsl(var(--ember))";
const GOOD = "#059669";
const AMBER = "#d97706";
const BAD = "#dc2626";
const MUTED = "hsl(336, 8%, 78%)";
const TEAM_LINE = "hsl(332, 12%, 30%)";

type ChartRow = DeskTrendBucket & {
  own: number | null;
  team: number | null;
};

function rangeLabel(from: number, to: number): string {
  const fmt = (at: number): string => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${fmt(from)} – ${fmt(to)}`;
}

function barColor(row: ChartRow, metric: DeskTrendMetric): string {
  if (row.own === null) return MUTED;
  if (metric === "quality") return row.own >= 70 ? GOOD : row.own >= 40 ? AMBER : BAD;
  if (metric === "response") return row.own > 60 ? BAD : EMBER;
  if (metric === "withinHour") return row.own >= 80 ? GOOD : row.own >= 50 ? AMBER : BAD;
  return EMBER;
}

function DeltaPill({
  current,
  previous,
  lowerIsBetter = false,
  absolute = false,
}: {
  current: number | null;
  previous: number | null;
  lowerIsBetter?: boolean;
  absolute?: boolean;
}) {
  if (current === null || previous === null) {
    return <span className="text-[10px] text-muted-foreground/70">no previous data</span>;
  }
  const delta = absolute ? current - previous : percentDelta(current, previous);
  if (delta === null) return <span className="text-[10px] text-muted-foreground/70">no previous data</span>;
  if (delta === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-muted-foreground">
        <Minus className="h-3 w-3" /> same
      </span>
    );
  }
  const improved = lowerIsBetter ? delta < 0 : delta > 0;
  const Icon = delta > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[10px] font-semibold",
        improved ? "bg-emerald-500/12 text-emerald-700" : "bg-red-500/12 text-red-700",
      )}
    >
      <Icon className="h-3 w-3" />
      {delta > 0 ? "+" : ""}
      {delta}
      {absolute ? " pts" : "%"}
    </span>
  );
}

function TeammateTooltip({
  active,
  payload,
  metric,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartRow }>;
  metric: DeskTrendMetric;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="rounded-xl border border-border/70 bg-card px-3 py-2 text-[11px] shadow-lg">
      <p className="font-semibold">{rangeLabel(row.start, row.end - 1)}</p>
      <p className="mt-1">
        Teammate: <span className="font-semibold">{row.own === null ? "no data" : formatMetric(row.own, metric)}</span>
      </p>
      <p className="text-muted-foreground">
        Team: {row.team === null ? "no data" : formatMetric(row.team, metric)}
      </p>
      <p className="mt-1 text-muted-foreground">
        {row.replies} {row.replies === 1 ? "reply" : "replies"} · {row.conversations}{" "}
        {row.conversations === 1 ? "conversation" : "conversations"}
      </p>
    </div>
  );
}

/**
 * One teammate's period dynamics inside their performance card: bars for the
 * teammate under the chosen metric, a thin team-average line over the same
 * buckets, a one-line data-derived verdict and a previous-period comparison.
 * Everything is derived from the shared stats timeline — no extra requests.
 */
export const TeammateTrend = memo(function TeammateTrend({
  adminId,
  timeline,
  range,
  now,
}: {
  adminId: string;
  timeline: DeskTimelinePoint[];
  range: DeskStatsRange;
  now: number;
}) {
  const [metric, setMetric] = useState<DeskTrendMetric>("quality");
  const [manualGranularity, setManualGranularity] = useState<DeskTrendGranularity | null>(null);

  const own = useMemo(() => timeline.filter((point) => point.adminId === adminId), [timeline, adminId]);
  const span = useMemo(() => effectiveDeskSpan(timeline, range, now), [timeline, range, now]);
  const granularity: DeskTrendGranularity =
    manualGranularity ?? (span ? autoDeskGranularity(span.to - span.from) : "day");
  // Team buckets are built from the full timeline so both series share the same span.
  const teamBuckets = useMemo(
    () => bucketDeskTimeline(timeline, range, granularity, now),
    [timeline, range, granularity, now],
  );
  const ownBuckets = useMemo(
    () => bucketDeskTimeline(own, span ? { from: span.from, to: span.to } : range, granularity, now),
    [own, span, range, granularity, now],
  );
  const comparison = useMemo(
    () => (span ? compareDeskPeriods(own, { from: span.from, to: span.to }, now) : null),
    [own, span, now],
  );
  const verdict = useMemo(() => describeTrend(ownBuckets, metric, granularity), [ownBuckets, metric, granularity]);

  if (!span || ownBuckets.length === 0) return null;

  const teamByStart = new Map<number, DeskTrendBucket>();
  for (const bucket of teamBuckets) teamByStart.set(bucket.start, bucket);
  const rows: ChartRow[] = ownBuckets.map((bucket) => {
    const team = teamByStart.get(bucket.start);
    return {
      ...bucket,
      own: bucketMetricValue(bucket, metric),
      team: team ? bucketMetricValue(team, metric) : null,
    };
  });
  const isPercent = metric === "quality" || metric === "withinHour";
  const previousHasData = (comparison?.previous.replies ?? 0) > 0;
  const VerdictIcon = verdict.tone === "down" ? TrendingDown : verdict.tone === "up" ? TrendingUp : Minus;

  return (
    <div className="mt-2 rounded-xl border border-border/60 bg-background/60 p-2.5" data-testid={TID.screenDeskTeammateTrend}>
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Teammate trend metric">
          {METRICS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={metric === option.id}
              onClick={() => setMetric(option.id)}
              data-testid={`${TID.screenDeskTeammateTrend}-${option.id}`}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
                metric === option.id
                  ? "border-ember bg-ember/10 text-foreground"
                  : "border-border/70 text-muted-foreground hover:border-ember/40 hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex rounded-full border border-border/70 p-0.5" role="tablist" aria-label="Teammate bucket size">
          {GRANULARITIES.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={granularity === option.id}
              onClick={() => setManualGranularity(option.id)}
              className={cn(
                "rounded-full px-1.5 py-px text-[10px] font-medium transition-colors",
                granularity === option.id ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <p
        className={cn(
          "mt-2 flex items-start gap-1.5 text-[11px] font-medium",
          verdict.tone === "up" ? "text-emerald-700" : verdict.tone === "down" ? "text-red-700" : "text-muted-foreground",
        )}
        data-testid={`${TID.screenDeskTeammateTrend}-verdict`}
      >
        <VerdictIcon className="mt-px h-3.5 w-3.5 shrink-0" />
        <span>{verdict.text}</span>
      </p>

      <div className="mt-1.5 h-36 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 6, right: 4, bottom: 0, left: -18 }} barCategoryGap="24%">
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={18} />
            <YAxis
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
              domain={isPercent ? [0, 100] : [0, "auto"]}
              tickFormatter={(value: number) => formatMetric(value, metric)}
            />
            <Tooltip cursor={{ fill: "hsl(var(--ember) / 0.08)" }} content={<TeammateTooltip metric={metric} />} />
            {metric === "replies" ? (
              <>
                <Bar dataKey="good" stackId="v" fill={GOOD} isAnimationActive={false} />
                <Bar dataKey="bad" stackId="v" fill={BAD} isAnimationActive={false} />
                <Bar dataKey="ungraded" stackId="v" fill={MUTED} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </>
            ) : (
              <Bar dataKey="own" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                {rows.map((row) => (
                  <Cell key={row.start} fill={barColor(row, metric)} />
                ))}
              </Bar>
            )}
            <Line
              type="monotone"
              dataKey="team"
              stroke={TEAM_LINE}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={{ r: 2, strokeWidth: 0, fill: TEAM_LINE }}
              connectNulls
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 px-1 text-[10px] text-muted-foreground/80">
        Bars: this teammate. Dashed line: team{" "}
        {metric === "replies" ? "total replies" : metric === "response" ? "median" : "share"} for the same period.
      </p>

      {comparison ? (
        <div className="mt-2.5">
          <p className="px-1 text-[10px] font-semibold text-muted-foreground">
            vs previous {rangeLabel(comparison.previous.from, comparison.previous.to)}
            {!previousHasData ? " — no replies collected for this teammate then" : ""}
          </p>
          <div className="mt-1 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            <div className="rounded-lg border border-border/60 bg-card px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">Replies</p>
              <p className="text-sm font-bold">{comparison.current.replies}</p>
              <DeltaPill current={comparison.current.replies} previous={previousHasData ? comparison.previous.replies : null} />
            </div>
            <div className="rounded-lg border border-border/60 bg-card px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">Median reply</p>
              <p className="text-sm font-bold">
                {comparison.current.medianResponseMs > 0 ? formatMetric(comparison.current.medianResponseMs / 60000, "response") : "—"}
              </p>
              <DeltaPill
                current={comparison.current.medianResponseMs > 0 ? comparison.current.medianResponseMs : null}
                previous={previousHasData && comparison.previous.medianResponseMs > 0 ? comparison.previous.medianResponseMs : null}
                lowerIsBetter
              />
            </div>
            <div className="rounded-lg border border-border/60 bg-card px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">Rated good</p>
              <p className="text-sm font-bold">{comparison.current.goodShare === null ? "—" : `${comparison.current.goodShare}%`}</p>
              <DeltaPill current={comparison.current.goodShare} previous={previousHasData ? comparison.previous.goodShare : null} absolute />
            </div>
            <div className="rounded-lg border border-border/60 bg-card px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">Within 1h</p>
              <p className="text-sm font-bold">
                {comparison.current.withinOneHourShare === null ? "—" : `${comparison.current.withinOneHourShare}%`}
              </p>
              <DeltaPill
                current={comparison.current.withinOneHourShare}
                previous={previousHasData ? comparison.previous.withinOneHourShare : null}
                absolute
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
});
