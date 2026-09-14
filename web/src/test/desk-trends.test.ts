import { describe, expect, it } from "vitest";

import {
  autoDeskGranularity,
  bucketDeskTimeline,
  compareDeskPeriods,
  effectiveDeskSpan,
  percentDelta,
} from "@/lib/desk-trends";
import type { DeskTimelinePoint } from "@/lib/projects";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function localDay(year: number, month: number, day: number, hour = 12): number {
  return new Date(year, month - 1, day, hour).getTime();
}

function point(at: number, extra: Partial<DeskTimelinePoint> = {}): DeskTimelinePoint {
  return { at, adminId: "a1", conversationId: `c${at}`, responseMs: 10 * 60 * 1000, grade: "", ...extra };
}

describe("desk period trends", () => {
  it("picks day / week / month granularity from the span length", () => {
    expect(autoDeskGranularity(7 * DAY)).toBe("day");
    expect(autoDeskGranularity(31 * DAY)).toBe("day");
    expect(autoDeskGranularity(90 * DAY)).toBe("week");
    expect(autoDeskGranularity(365 * DAY)).toBe("month");
  });

  it("fills every day of the range, including days without replies", () => {
    const from = localDay(2026, 9, 1, 0);
    const to = localDay(2026, 9, 7, 23);
    const points = [
      point(localDay(2026, 9, 1), { grade: "good", responseMs: 20 * 60 * 1000 }),
      point(localDay(2026, 9, 1, 15), { grade: "bad", responseMs: 3 * HOUR, conversationId: "same" }),
      point(localDay(2026, 9, 1, 16), { conversationId: "same", responseMs: 0 }),
      point(localDay(2026, 9, 5), { grade: "good" }),
    ];
    const buckets = bucketDeskTimeline(points, { from, to }, "day", to);
    expect(buckets).toHaveLength(7);
    expect(buckets.map((bucket) => bucket.replies)).toEqual([3, 0, 0, 0, 1, 0, 0]);
    expect(buckets[0]).toMatchObject({ good: 1, bad: 1, ungraded: 1, conversations: 2, responseSamples: 2 });
    expect(buckets[0].medianResponseMs).toBe(3 * HOUR);
    expect(buckets[0].withinOneHour).toBe(1);
  });

  it("starts weekly buckets on Monday and ignores points outside the range", () => {
    const from = localDay(2026, 9, 2, 0); // Wednesday
    const to = localDay(2026, 9, 20, 23);
    const points = [point(localDay(2026, 9, 3)), point(localDay(2026, 9, 9)), point(localDay(2026, 8, 20))];
    const buckets = bucketDeskTimeline(points, { from, to }, "week", to);
    expect(new Date(buckets[0].start).getDay()).toBe(1);
    expect(buckets.reduce((sum, bucket) => sum + bucket.replies, 0)).toBe(2);
  });

  it("derives the span from the data when the range is open-ended", () => {
    const points = [point(localDay(2026, 9, 3)), point(localDay(2026, 9, 10))];
    const span = effectiveDeskSpan(points, { from: 0, to: 0 }, localDay(2026, 9, 14));
    expect(span).toEqual({ from: localDay(2026, 9, 3), to: localDay(2026, 9, 11) });
    expect(effectiveDeskSpan([], { from: 0, to: 0 })).toBeNull();
  });

  it("compares the selected period with the equally long one before it", () => {
    const from = localDay(2026, 9, 8, 0);
    const to = localDay(2026, 9, 14, 23);
    const points = [
      point(localDay(2026, 9, 9), { grade: "good", responseMs: 30 * 60 * 1000 }),
      point(localDay(2026, 9, 10), { grade: "good", responseMs: 40 * 60 * 1000 }),
      point(localDay(2026, 9, 12), { grade: "bad", responseMs: 2 * HOUR }),
      point(localDay(2026, 9, 2), { grade: "bad", responseMs: 4 * HOUR }),
      point(localDay(2026, 9, 4), { grade: "good", responseMs: 90 * 60 * 1000 }),
    ];
    const comparison = compareDeskPeriods(points, { from, to }, to);
    expect(comparison?.current).toMatchObject({ replies: 3, good: 2, bad: 1, goodShare: 67, withinOneHourShare: 67 });
    expect(comparison?.previous).toMatchObject({ replies: 2, good: 1, bad: 1, goodShare: 50, withinOneHourShare: 0 });
    expect(comparison?.current.medianResponseMs).toBe(40 * 60 * 1000);
    expect(percentDelta(comparison?.current.replies ?? 0, comparison?.previous.replies ?? 0)).toBe(50);
    expect(percentDelta(3, 0)).toBeNull();
  });
});
