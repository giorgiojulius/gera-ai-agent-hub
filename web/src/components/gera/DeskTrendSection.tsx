import { ArrowDownRight, ArrowUpRight, Minus, TrendingUp } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import {
  autoDeskGranularity,
  bucketDeskTimeline,
  compareDeskPeriods,
  effectiveDeskSpan,
  percentDelta,
  type DeskPeriodSummary,
  type DeskTrendBucket,
  type DeskTrendGranularity,
} from "@/lib/desk-trends";
import type { DeskStatsRange, DeskTimelinePoint } from "@/lib/projects";
import { TID } from "@/lib/testids";
import { cn } from "@/lib/utils";

type Metric = "replies" | "response" | "quality";

const METRICS: Array<{ id: Metric; label: string }> = [
  { id: "replies", label: "Volume" },
  { id: "response", label: "Reply time" },
  { id: "quality", label: "Quality" },
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
const BAD = "#dc2626";
const MUTED = "hsl(336, 8%, 78%)";

/** "45s" / "12m" / "3h" — compact duration for the axis and tooltips. */
function duration(ms: number): string {
  if (ms <= 0) return "—";
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function rangeLabel(from: number, to: number): string {
  const fmt = (at: number): string => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${fmt(from)} – ${fmt(to)}`;
}

/**
 * Period-over-period delta pill. `lowerIsBetter` flips the colour so a faster
 * median reads green; a missing base renders a neutral "no previous data".
 */
function Delta({
  current,
  previous,
  lowerIsBetter = false,
  suffix = "",
  absolute = false,
}: {
  current: number | null;
  previous: number | null;
  lowerIsBetter?: boolean;
  suffix?: string;
  absolute?: boolean;
}) {
  if (current === null || previous === null) {
    return <span className="text-[10px] text-muted-foreground/70">no previous data</span>;
  }
  const delta = absolute ? current - previous : percentDelta(current, previous);
  if (delta === null) {
    return <span className="text-[10px] text-muted-foreground/70">no previous data</span>;
  }
  if (delta === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-muted-foreground">
        <Minus className="h-3 w-3" /> same as before
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
      {absolute ? suffix : "%"}
    </span>
  );
}

function ComparisonCard({
  label,
  value,
  children,
  testId,
}: {
  label: string;
  value: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/60 px-3 py-2.5" data-testid={testId}>
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-bold tracking-tight">{value}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function TrendTooltip({ active, payload, metric }: { active?: boolean; payload?: Array<{ payload: DeskTrendBucket }>; metric: Metric }) {
  const bucket = payload?.[0]?.payload;
  if (!active || !bucket) return null;
  const graded = bucket.good + bucket.bad;
  return (
    <div className="rounded-xl border border-border/70 bg-card px-3 py-2 text-[11px] shadow-lg">
      <p className="font-semibold">{rangeLabel(bucket.start, bucket.end - 1)}</p>
      <p className="mt-1 text-muted-foreground">
        {bucket.replies} {bucket.replies === 1 ? "reply" : "replies"} · {bucket.conversations}{" "}
        {bucket.conversations === 1 ? "conversation" : "conversations"}
      </p>
      {metric === "response" || bucket.responseSamples > 0 ? (
        <p className="text-muted-foreground">
          median {duration(bucket.medianResponseMs)} ·{" "}
          {bucket.responseSamples > 0 ? `${Math.round((bucket.withinOneHour / bucket.responseSamples) * 100)}% within 1h` : "no timing"}
        </p>
      ) : null}
      {graded > 0 ? (
        <p>
          <span className="text-emerald-700">{bucket.good} good</span> · <span className="text-red-700">{bucket.bad} bad</span>
          {bucket.ungraded > 0 ? <span className="text-muted-foreground"> · {bucket.ungraded} ungraded</span> : null}
        </p>
      ) : bucket.replies > 0 ? (
        <p className="text-muted-foreground">not graded yet</p>
      ) : null}
    </div>
  );
}

function summaryValue(summary: DeskPeriodSummary, metric: Metric): string {
  if (metric === "replies") return String(summary.replies);
  if (metric === "response") return duration(summary.medianResponseMs);
  return summary.goodShare === null ? "—" : `${summary.goodShare}%`;
}

/**
 * Period trends for Team performance: a bucketed chart of the selected date
 * range (days / weeks / months, empty buckets kept) plus a comparison with
 * the equally long period right before it. Purely derived from harvested
 * reply timestamps already returned with the stats — no extra requests.
 */
export const DeskTrendSection = memo(function DeskTrendSection({
  timeline,
  range,
  now,
}: {
  timeline: DeskTimelinePoint[];
  range: DeskStatsRange;
  now: number;
}) {
  const [metric, setMetric] = useState<Metric>("replies");
  const [manualGranularity, setManualGranularity] = useState<DeskTrendGranularity | null>(null);

  const span = useMemo(() => effectiveDeskSpan(timeline, range, now), [timeline, range, now]);
  const granularity: DeskTrendGranularity =
    manualGranularity ?? (span ? autoDeskGranularity(span.to - span.from) : "day");
  const buckets = useMemo(
    () => bucketDeskTimeline(timeline, range, granularity, now),
    [timeline, range, granularity, now],
  );
  const comparison = useMemo(() => compareDeskPeriods(timeline, range, now), [timeline, range, now]);

  if (!span || buckets.length === 0) {
    return null;
  }

  const chartData = buckets.map((bucket) => ({
    ...bucket,
    goodShare: bucket.good + bucket.bad > 0 ? Math.round((bucket.good / (bucket.good + bucket.bad)) * 100) : null,
    medianMinutes: bucket.medianResponseMs > 0 ? bucket.medianResponseMs / 60000 : null,
  }));
  const busiest = buckets.reduce<DeskTrendBucket | null>(
    (best, bucket) => (bucket.replies > (best?.replies ?? 0) ? bucket : best),
    null,
  );
  const activeBuckets = buckets.filter((bucket) => bucket.replies > 0).length;
  const previousHasData = (comparison?.previous.replies ?? 0) > 0;

  return (
    <section className="mb-3 rounded-2xl border border-border/60 bg-card p-3.5" data-testid={TID.screenDeskPerformanceTrend}>
      <div className="flex flex-wrap items-center gap-2">
        <TrendingUp className="h-4 w-4 text-ember" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold">Trend over the period</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {rangeLabel(span.from, span.to)} · {activeBuckets} of {buckets.length}{" "}
            {granularity === "day" ? "days" : granularity === "week" ? "weeks" : "months"} with replies
            {busiest ? ` · busiest ${busiest.label} (${busiest.replies})` : ""}
          </p>
        </div>
        <div className="flex rounded-full border border-border/70 p-0.5" role="tablist" aria-label="Bucket size">
          {GRANULARITIES.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={granularity === option.id}
              onClick={() => setManualGranularity(option.id)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
                granularity === option.id ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap gap-1.5" role="tablist" aria-label="Trend metric">
        {METRICS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={metric === option.id}
            onClick={() => setMetric(option.id)}
            data-testid={`${TID.screenDeskPerformanceTrend}-${option.id}`}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors",
              metric === option.id
                ? "border-ember bg-ember/10 text-foreground"
                : "border-border/70 text-muted-foreground hover:border-ember/40 hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="mt-2 h-44 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 8, right: 4, bottom: 0, left: -18 }} barCategoryGap="22%">
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
            <XAxis
              dataKey="label"
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              minTickGap={18}
            />
            <YAxis
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
              domain={metric === "quality" ? [0, 100] : [0, "auto"]}
              tickFormatter={(value: number) =>
                metric === "response" ? duration(value * 60000) : metric === "quality" ? `${value}%` : String(value)
              }
            />
            <Tooltip cursor={{ fill: "hsl(var(--ember) / 0.08)" }} content={<TrendTooltip metric={metric} />} />
            {metric === "replies" ? (
              <>
                <Bar dataKey="good" stackId="v" fill={GOOD} radius={[0, 0, 0, 0]} isAnimationActive={false} />
                <Bar dataKey="bad" stackId="v" fill={BAD} isAnimationActive={false} />
                <Bar dataKey="ungraded" stackId="v" fill={MUTED} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </>
            ) : metric === "response" ? (
              <Bar dataKey="medianMinutes" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                {chartData.map((bucket) => (
                  <Cell
                    key={bucket.start}
                    fill={bucket.medianResponseMs > 60 * 60 * 1000 ? BAD : EMBER}
                  />
                ))}
              </Bar>
            ) : (
              <Bar dataKey="goodShare" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                {chartData.map((bucket) => (
                  <Cell
                    key={bucket.start}
                    fill={bucket.goodShare === null ? MUTED : bucket.goodShare >= 70 ? GOOD : bucket.goodShare >= 40 ? EMBER : BAD}
                  />
                ))}
              </Bar>
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 px-1 text-[10px] text-muted-foreground/80">
        {metric === "replies"
          ? "Stacked by grade: green good, red bad, grey not graded yet."
          : metric === "response"
            ? "Median time to the teammate's reply; red buckets exceed one hour."
            : "Share of graded replies rated good; grey buckets have no grades yet."}
      </p>

      {comparison ? (
        <div className="mt-3">
          <p className="px-1 text-[11px] font-semibold">
            Compared with the previous {rangeLabel(comparison.previous.from, comparison.previous.to)}
          </p>
          {!previousHasData ? (
            <p className="mt-0.5 px-1 text-[10px] text-muted-foreground">
              No collected replies in the previous period — run analysis over a wider range to compare.
            </p>
          ) : null}
          <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <ComparisonCard label="Replies" value={summaryValue(comparison.current, "replies")} testId={`${TID.screenDeskPerformanceTrend}-compare-replies`}>
              <Delta current={comparison.current.replies} previous={previousHasData ? comparison.previous.replies : null} />
            </ComparisonCard>
            <ComparisonCard label="Conversations" value={String(comparison.current.conversations)}>
              <Delta
                current={comparison.current.conversations}
                previous={previousHasData ? comparison.previous.conversations : null}
              />
            </ComparisonCard>
            <ComparisonCard label="Median reply" value={summaryValue(comparison.current, "response")}>
              <Delta
                current={comparison.current.medianResponseMs > 0 ? comparison.current.medianResponseMs : null}
                previous={previousHasData && comparison.previous.medianResponseMs > 0 ? comparison.previous.medianResponseMs : null}
                lowerIsBetter
              />
            </ComparisonCard>
            <ComparisonCard label="Rated good" value={summaryValue(comparison.current, "quality")}>
              <Delta
                current={comparison.current.goodShare}
                previous={previousHasData ? comparison.previous.goodShare : null}
                absolute
                suffix=" pts"
              />
            </ComparisonCard>
          </div>
        </div>
      ) : null}
    </section>
  );
});
