import type { DeskStatsRange, DeskTimelinePoint } from "@/lib/projects";

export type DeskTrendGranularity = "day" | "week" | "month";

export type DeskTrendBucket = {
  /** Local-time start of the bucket, ms. */
  start: number;
  /** Local-time end of the bucket (exclusive), ms. */
  end: number;
  label: string;
  replies: number;
  conversations: number;
  good: number;
  bad: number;
  ungraded: number;
  responseSamples: number;
  medianResponseMs: number;
  withinOneHour: number;
};

export type DeskPeriodSummary = {
  from: number;
  to: number;
  replies: number;
  conversations: number;
  graded: number;
  good: number;
  bad: number;
  responseSamples: number;
  medianResponseMs: number;
  withinOneHourShare: number | null;
  goodShare: number | null;
};

export type DeskPeriodComparison = {
  current: DeskPeriodSummary;
  previous: DeskPeriodSummary;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(at: number): Date {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date;
}

function bucketStart(at: number, granularity: DeskTrendGranularity): Date {
  const date = startOfDay(at);
  if (granularity === "week") {
    // ISO week — Monday first.
    const weekday = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - weekday);
  } else if (granularity === "month") {
    date.setDate(1);
  }
  return date;
}

function advance(date: Date, granularity: DeskTrendGranularity): Date {
  const next = new Date(date);
  if (granularity === "day") {
    next.setDate(next.getDate() + 1);
  } else if (granularity === "week") {
    next.setDate(next.getDate() + 7);
  } else {
    next.setMonth(next.getMonth() + 1);
  }
  return next;
}

function bucketLabel(date: Date, granularity: DeskTrendGranularity): string {
  if (granularity === "month") {
    return date.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  }
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function median(sorted: number[]): number {
  return sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
}

/** Effective [from, to] for a range where zero means "unbounded" — falls back to the data itself. */
export function effectiveDeskSpan(
  points: DeskTimelinePoint[],
  range: DeskStatsRange,
  now: number = Date.now(),
): { from: number; to: number } | null {
  let from = range.from;
  let to = range.to;
  if (from <= 0 || to <= 0) {
    if (points.length === 0) {
      return from > 0 || to > 0 ? { from: from > 0 ? from : to - 30 * DAY_MS, to: to > 0 ? to : now } : null;
    }
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    for (const point of points) {
      if (point.at < min) min = point.at;
      if (point.at > max) max = point.at;
    }
    if (from <= 0) from = min;
    if (to <= 0) to = Math.max(max, Math.min(now, max + DAY_MS));
  }
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

/** Day for a month or less, week up to ~6 months, month beyond. */
export function autoDeskGranularity(spanMs: number): DeskTrendGranularity {
  const days = spanMs / DAY_MS;
  if (days <= 31) return "day";
  if (days <= 190) return "week";
  return "month";
}

/**
 * Groups harvested replies into contiguous local-time buckets across the whole
 * span (empty buckets included) so a chart shows real gaps, not a compressed run.
 */
export function bucketDeskTimeline(
  points: DeskTimelinePoint[],
  range: DeskStatsRange,
  granularity: DeskTrendGranularity,
  now: number = Date.now(),
): DeskTrendBucket[] {
  const span = effectiveDeskSpan(points, range, now);
  if (!span) return [];
  const buckets: DeskTrendBucket[] = [];
  const index = new Map<number, { rows: DeskTimelinePoint[]; conversations: Set<string> }>();
  let cursor = bucketStart(span.from, granularity);
  const limit = 400;
  while (cursor.getTime() <= span.to && buckets.length < limit) {
    const next = advance(cursor, granularity);
    buckets.push({
      start: cursor.getTime(),
      end: next.getTime(),
      label: bucketLabel(cursor, granularity),
      replies: 0,
      conversations: 0,
      good: 0,
      bad: 0,
      ungraded: 0,
      responseSamples: 0,
      medianResponseMs: 0,
      withinOneHour: 0,
    });
    index.set(cursor.getTime(), { rows: [], conversations: new Set() });
    cursor = next;
  }
  for (const point of points) {
    if (point.at < span.from || point.at > span.to) continue;
    const key = bucketStart(point.at, granularity).getTime();
    const slot = index.get(key);
    if (!slot) continue;
    slot.rows.push(point);
    slot.conversations.add(point.conversationId);
  }
  for (const bucket of buckets) {
    const slot = index.get(bucket.start);
    if (!slot) continue;
    const times = slot.rows.map((row) => row.responseMs).filter((ms) => ms > 0).sort((a, b) => a - b);
    bucket.replies = slot.rows.length;
    bucket.conversations = slot.conversations.size;
    bucket.good = slot.rows.filter((row) => row.grade === "good").length;
    bucket.bad = slot.rows.filter((row) => row.grade === "bad").length;
    bucket.ungraded = bucket.replies - bucket.good - bucket.bad;
    bucket.responseSamples = times.length;
    bucket.medianResponseMs = median(times);
    bucket.withinOneHour = times.filter((ms) => ms <= 60 * 60 * 1000).length;
  }
  return buckets;
}

function summarize(points: DeskTimelinePoint[], from: number, to: number): DeskPeriodSummary {
  const rows = points.filter((point) => point.at >= from && point.at <= to);
  const times = rows.map((row) => row.responseMs).filter((ms) => ms > 0).sort((a, b) => a - b);
  const good = rows.filter((row) => row.grade === "good").length;
  const bad = rows.filter((row) => row.grade === "bad").length;
  const graded = good + bad;
  return {
    from,
    to,
    replies: rows.length,
    conversations: new Set(rows.map((row) => row.conversationId)).size,
    graded,
    good,
    bad,
    responseSamples: times.length,
    medianResponseMs: median(times),
    withinOneHourShare:
      times.length > 0 ? Math.round((times.filter((ms) => ms <= 60 * 60 * 1000).length / times.length) * 100) : null,
    goodShare: graded > 0 ? Math.round((good / graded) * 100) : null,
  };
}

/**
 * Selected period vs the equally long period right before it. The previous
 * window is only as informative as the collected data — callers should say so
 * when `previous.replies` is zero.
 */
export function compareDeskPeriods(
  points: DeskTimelinePoint[],
  range: DeskStatsRange,
  now: number = Date.now(),
): DeskPeriodComparison | null {
  const span = effectiveDeskSpan(points, range, now);
  if (!span || span.to <= span.from) return null;
  const length = span.to - span.from;
  return {
    current: summarize(points, span.from, span.to),
    previous: summarize(points, span.from - length, span.from - 1),
  };
}

/** Signed percent delta rounded to whole points; null when the base is empty. */
export function percentDelta(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export type DeskTrendMetric = "quality" | "response" | "withinHour" | "replies";

/**
 * Single comparable number for a bucket under the chosen metric, or null when
 * the bucket has no evidence for it (no grades / no timing / no replies).
 * Quality and within-hour are whole percents, response is minutes, replies a count.
 */
export function bucketMetricValue(bucket: DeskTrendBucket, metric: DeskTrendMetric): number | null {
  if (metric === "replies") return bucket.replies > 0 ? bucket.replies : null;
  if (metric === "response") return bucket.responseSamples > 0 ? bucket.medianResponseMs / 60000 : null;
  if (metric === "withinHour") {
    return bucket.responseSamples > 0 ? Math.round((bucket.withinOneHour / bucket.responseSamples) * 100) : null;
  }
  const graded = bucket.good + bucket.bad;
  return graded > 0 ? Math.round((bucket.good / graded) * 100) : null;
}

export type DeskTrendVerdict = {
  tone: "up" | "down" | "flat" | "none";
  text: string;
};

const METRIC_NOUN: Record<DeskTrendMetric, string> = {
  quality: "Quality",
  response: "Reply time",
  withinHour: "Within-1h share",
  replies: "Volume",
};

function unitWord(granularity: DeskTrendGranularity, count: number): string {
  const base = granularity === "day" ? "day" : granularity === "week" ? "week" : "month";
  return count === 1 ? base : `${base}s`;
}

/** Human number for a metric value produced by `bucketMetricValue`. */
export function formatMetric(value: number, metric: DeskTrendMetric): string {
  if (metric === "replies") return `${Math.round(value)}`;
  if (metric === "response") {
    const minutes = Math.round(value);
    if (minutes < 1) return "<1m";
    if (minutes < 90) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    return hours < 36 ? `${hours}h` : `${Math.round(hours / 24)}d`;
  }
  return `${Math.round(value)}%`;
}

/**
 * One-line, model-free reading of a metric series: consecutive streak at the
 * tail, a last-bucket dip/jump versus the earlier mean, or "stable". Buckets
 * without evidence are skipped, so gaps do not break a streak. Needs at least
 * two informative buckets; otherwise says so instead of guessing.
 */
export function describeTrend(
  buckets: DeskTrendBucket[],
  metric: DeskTrendMetric,
  granularity: DeskTrendGranularity,
): DeskTrendVerdict {
  const values: number[] = [];
  for (const bucket of buckets) {
    const value = bucketMetricValue(bucket, metric);
    if (value !== null) values.push(value);
  }
  const noun = METRIC_NOUN[metric];
  if (values.length < 2) {
    return {
      tone: "none",
      text: `Not enough ${unitWord(granularity, 2)} with data to read a ${noun.toLowerCase()} trend yet.`,
    };
  }
  const lowerIsBetter = metric === "response";
  // Relative tolerance so a one-point wiggle is not called a trend.
  const tolerance = metric === "replies" ? 0.15 : metric === "response" ? 0.2 : 0;
  const flatBand = metric === "quality" || metric === "withinHour" ? 3 : 0;
  const direction = (prev: number, next: number): 1 | -1 | 0 => {
    const diff = next - prev;
    if (Math.abs(diff) <= flatBand || Math.abs(diff) <= Math.abs(prev) * tolerance) return 0;
    return diff > 0 ? 1 : -1;
  };
  let streak = 1;
  const lastDirection = direction(values[values.length - 2], values[values.length - 1]);
  if (lastDirection !== 0) {
    for (let index = values.length - 2; index > 0; index -= 1) {
      if (direction(values[index - 1], values[index]) === lastDirection) streak += 1;
      else break;
    }
  }
  const improving = lowerIsBetter ? lastDirection < 0 : lastDirection > 0;
  if (lastDirection !== 0 && streak >= 2) {
    const verb = lowerIsBetter ? (improving ? "getting faster" : "getting slower") : improving ? "rising" : "falling";
    return {
      tone: improving ? "up" : "down",
      text: `${noun} ${verb} ${streak} ${unitWord(granularity, streak)} in a row.`,
    };
  }
  const last = values[values.length - 1];
  const earlier = values.slice(0, -1);
  const mean = earlier.reduce((sum, value) => sum + value, 0) / earlier.length;
  const jump = direction(mean, last);
  if (jump !== 0) {
    const better = lowerIsBetter ? jump < 0 : jump > 0;
    const phrase = lowerIsBetter
      ? better
        ? "faster than before"
        : "slower than before"
      : better
        ? "above the earlier level"
        : "below the earlier level";
    return {
      tone: better ? "up" : "down",
      text: `Latest ${unitWord(granularity, 1)}: ${noun.toLowerCase()} ${phrase} (${formatMetric(last, metric)} vs ${formatMetric(mean, metric)} before).`,
    };
  }
  return { tone: "flat", text: `${noun} stable across the period, around ${formatMetric(mean, metric)}.` };
}

export type DeskTeammateShift = {
  adminId: string;
  name: string;
  current: DeskPeriodSummary;
  previous: DeskPeriodSummary;
  /** Percentage points of good share; null without grades in either period. */
  qualityDelta: number | null;
  /** Percent change of the median reply time; negative = faster. */
  responseDelta: number | null;
  repliesDelta: number | null;
  /** Sorting weight — largest movement first. */
  magnitude: number;
};

/**
 * Period-over-period movement per teammate, sorted by how much they changed.
 * Teammates with no replies in either window are left out — there is nothing
 * to compare, and inventing a delta would mislead.
 */
export function rankTeammateShifts(
  points: DeskTimelinePoint[],
  teammates: Array<{ adminId: string; name: string }>,
  range: DeskStatsRange,
  now: number = Date.now(),
): DeskTeammateShift[] {
  const span = effectiveDeskSpan(points, range, now);
  if (!span || span.to <= span.from) return [];
  const length = span.to - span.from;
  const shifts: DeskTeammateShift[] = [];
  for (const teammate of teammates) {
    const own = points.filter((point) => point.adminId === teammate.adminId);
    const current = summarize(own, span.from, span.to);
    const previous = summarize(own, span.from - length, span.from - 1);
    if (current.replies === 0 || previous.replies === 0) continue;
    const qualityDelta =
      current.goodShare !== null && previous.goodShare !== null ? current.goodShare - previous.goodShare : null;
    const responseDelta =
      current.medianResponseMs > 0 && previous.medianResponseMs > 0
        ? percentDelta(current.medianResponseMs, previous.medianResponseMs)
        : null;
    shifts.push({
      adminId: teammate.adminId,
      name: teammate.name,
      current,
      previous,
      qualityDelta,
      responseDelta,
      repliesDelta: percentDelta(current.replies, previous.replies),
      magnitude: Math.max(Math.abs(qualityDelta ?? 0), Math.abs(responseDelta ?? 0) / 2),
    });
  }
  return shifts.sort((a, b) => b.magnitude - a.magnitude);
}
