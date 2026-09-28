import { Clock3, Flame } from "lucide-react";
import { memo, useMemo } from "react";

import { loadHeatmap, peakSlots, responseBuckets, WEEKDAY_LABELS } from "../../../../functions/desk-analytics";
import type { DeskTimelinePoint } from "@/lib/projects";
import { TID } from "@/lib/testids";
import { cn } from "@/lib/utils";

/** SLA bucket colours: fast → slow. */
const BUCKET_TONES = ["bg-emerald-500", "bg-emerald-400", "bg-lime-400", "bg-amber-400", "bg-orange-500", "bg-red-500"];

/**
 * Deterministic deep analytics over the stats timeline (no model, no spend):
 * how long customers waited, spread over SLA buckets, and a weekday × hour
 * load heatmap in the viewer's timezone with the busiest slots called out.
 */
export const DeskInsightsSection = memo(function DeskInsightsSection({
  timeline,
}: {
  timeline: DeskTimelinePoint[];
}) {
  const tz = useMemo(() => new Date().getTimezoneOffset(), []);
  const buckets = useMemo(() => responseBuckets(timeline), [timeline]);
  const grid = useMemo(() => loadHeatmap(timeline, tz), [timeline, tz]);
  const peaks = useMemo(() => peakSlots(grid, 3), [grid]);
  const timed = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const maxCell = Math.max(1, ...grid.map((row) => Math.max(...row)));

  return (
    <section
      className="mb-3 rounded-2xl border border-border/60 bg-card p-3.5"
      data-testid={TID.screenDeskInsights}
    >
      <div className="flex items-center gap-2">
        <Clock3 className="h-4 w-4 text-ember" />
        <p className="text-xs font-semibold">How long customers waited</p>
        <span className="ml-auto text-[10px] text-muted-foreground">{timed} timed replies</span>
      </div>
      {timed > 0 ? (
        <>
          <div className="mt-2.5 flex h-3 w-full overflow-hidden rounded-full bg-muted">
            {buckets.map((bucket, index) =>
              bucket.count > 0 ? (
                <div
                  key={bucket.id}
                  className={cn("h-full transition-all", BUCKET_TONES[index])}
                  style={{ width: `${(bucket.count / timed) * 100}%` }}
                  title={`${bucket.label}: ${bucket.count}`}
                />
              ) : null,
            )}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 sm:grid-cols-6">
            {buckets.map((bucket, index) => (
              <div key={bucket.id} className="flex items-center gap-1.5 text-[10px]">
                <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", BUCKET_TONES[index])} />
                <span className="text-muted-foreground">{bucket.label}</span>
                <span className="ml-auto font-semibold tabular-nums">
                  {Math.round((bucket.count / timed) * 100)}%
                </span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="mt-2 text-[11px] text-muted-foreground">No replies with a waiting customer in this range.</p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <Flame className="h-4 w-4 text-ember" />
        <p className="text-xs font-semibold">When the load hits</p>
        <span className="ml-auto text-[10px] text-muted-foreground">your timezone</span>
      </div>
      <div className="mt-2 overflow-x-auto">
        <div className="min-w-[440px]">
          <div className="ml-8 grid gap-[2px] text-[8px] text-muted-foreground" style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}>
            {Array.from({ length: 24 }, (_, hour) => (
              <span key={hour} className="text-center">
                {hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}
              </span>
            ))}
          </div>
          {grid.map((row, weekday) => (
            <div key={WEEKDAY_LABELS[weekday]} className="mt-[2px] flex items-center gap-1">
              <span className="w-7 shrink-0 text-[9px] text-muted-foreground">{WEEKDAY_LABELS[weekday]}</span>
              <div className="grid flex-1 gap-[2px]" style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}>
                {row.map((count, hour) => (
                  <div
                    key={hour}
                    className="h-3.5 rounded-[3px] bg-ember"
                    style={{ opacity: count === 0 ? 0.06 : 0.18 + (count / maxCell) * 0.82 }}
                    title={`${WEEKDAY_LABELS[weekday]} ${String(hour).padStart(2, "0")}:00 — ${count} ${count === 1 ? "reply" : "replies"}`}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      {peaks.length > 0 ? (
        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
          Peaks:{" "}
          {peaks
            .map((slot) => `${WEEKDAY_LABELS[slot.weekday]} ${String(slot.hour).padStart(2, "0")}:00 (${slot.count})`)
            .join(" · ")}
        </p>
      ) : null}
    </section>
  );
});
