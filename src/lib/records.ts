/**
 * Personal records, goal progress and analytics aggregation.
 * Everything here is derived from Activity summaries (cheap; no tracks needed).
 */
import type { Activity, Goal, GoalMetric, GoalPeriod } from '../types';
import { BEST_EFFORT_DISTANCES } from './stats';

export interface PersonalRecord {
  key: string;
  label: string;
  /** Lower-is-better (times) or higher-is-better (distance etc.) */
  better: 'lower' | 'higher';
  value: number;
  kind: 'time' | 'distance' | 'duration' | 'elevation' | 'steps';
  activityId: string;
  achievedAt: number;
}

export const EFFORT_LABELS: Record<string, string> = {
  '1000': 'Fastest 1 km',
  '1609.344': 'Fastest mile',
  '5000': 'Fastest 5 km',
  '10000': 'Fastest 10 km',
  '21097.5': 'Fastest half marathon',
};

/** Compute all-time PRs. Ties go to the earliest activity. */
export function computeRecords(activities: Activity[]): PersonalRecord[] {
  const sorted = [...activities].sort((a, b) => a.startedAt - b.startedAt);
  const out: PersonalRecord[] = [];
  const pick = (
    key: string, label: string, kind: PersonalRecord['kind'], better: PersonalRecord['better'],
    get: (a: Activity) => number | undefined,
  ) => {
    let best: PersonalRecord | null = null;
    for (const a of sorted) {
      const v = get(a);
      if (v == null || !isFinite(v) || v <= 0) continue;
      if (!best || (better === 'lower' ? v < best.value : v > best.value)) {
        best = { key, label, kind, better, value: v, activityId: a.id, achievedAt: a.startedAt };
      }
    }
    if (best) out.push(best);
  };
  for (const d of BEST_EFFORT_DISTANCES) {
    pick(`effort:${d}`, EFFORT_LABELS[String(d)] ?? `${d} m`, 'time', 'lower', (a) => a.stats.bestEfforts[String(d)]);
  }
  pick('longest-distance', 'Longest walk', 'distance', 'higher', (a) => a.stats.distanceM);
  pick('longest-duration', 'Longest time moving', 'duration', 'higher', (a) => a.stats.movingS);
  pick('most-elevation', 'Most climbing', 'elevation', 'higher', (a) => a.stats.elevGainM);
  pick('most-steps', 'Most steps (est.)', 'steps', 'higher', (a) => a.stats.estSteps);
  return out;
}

/** Records the given activity set (or tied) at the time it was recorded — for "New PR" badges. */
export function recordsSetBy(activityId: string, activities: Activity[]): PersonalRecord[] {
  return computeRecords(activities).filter((r) => r.activityId === activityId);
}

// ---------- periods ----------

/** Start of the period containing `ms` (weeks start Monday, local time). */
export function periodStart(ms: number, period: GoalPeriod): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  if (period === 'week') {
    const dow = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - dow);
  } else if (period === 'month') d.setDate(1);
  else if (period === 'year') d.setMonth(0, 1);
  return d.getTime();
}

export function periodEnd(ms: number, period: GoalPeriod): number {
  const d = new Date(periodStart(ms, period));
  if (period === 'day') d.setDate(d.getDate() + 1);
  else if (period === 'week') d.setDate(d.getDate() + 7);
  else if (period === 'month') d.setMonth(d.getMonth() + 1);
  else d.setFullYear(d.getFullYear() + 1);
  return d.getTime();
}

export function metricValue(a: Activity, metric: GoalMetric): number {
  switch (metric) {
    case 'distance': return a.stats.distanceM;
    case 'duration': return a.stats.movingS;
    case 'count': return 1;
    case 'elevation': return a.stats.elevGainM;
    case 'steps': return a.stats.estSteps;
  }
}

export interface GoalProgress {
  goal: Goal;
  value: number;
  fraction: number;
  start: number;
  end: number;
  /** Expected fraction if progressing linearly through the period */
  expectedFraction: number;
}

export function goalProgress(goal: Goal, activities: Activity[], now = Date.now()): GoalProgress {
  const start = periodStart(now, goal.period);
  const end = periodEnd(now, goal.period);
  const value = activities
    .filter((a) => a.startedAt >= start && a.startedAt < end)
    .reduce((s, a) => s + metricValue(a, goal.metric), 0);
  return {
    goal, value, start, end,
    fraction: goal.target > 0 ? value / goal.target : 0,
    expectedFraction: (now - start) / (end - start),
  };
}

export interface Bucket { start: number; label: string; value: number; count: number }

/** Totals per period for the last `n` periods (oldest first). */
export function bucketize(activities: Activity[], metric: GoalMetric, period: 'week' | 'month', n: number, now = Date.now()): Bucket[] {
  const buckets: Bucket[] = [];
  let cursor = periodStart(now, period);
  for (let i = 0; i < n; i++) {
    const d = new Date(cursor);
    buckets.unshift({
      start: cursor,
      label: period === 'week' ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : d.toLocaleDateString(undefined, { month: 'short' }),
      value: 0, count: 0,
    });
    const prev = new Date(cursor);
    if (period === 'week') prev.setDate(prev.getDate() - 7); else prev.setMonth(prev.getMonth() - 1);
    cursor = prev.getTime();
  }
  for (const a of activities) {
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (a.startedAt >= buckets[i].start) {
        if (a.startedAt < periodEnd(buckets[i].start, period)) { buckets[i].value += metricValue(a, metric); buckets[i].count++; }
        break;
      }
    }
  }
  return buckets;
}

/** Consecutive days (ending today or yesterday) with at least one walk. */
export function dayStreak(activities: Activity[], now = Date.now()): number {
  const days = new Set(activities.map((a) => periodStart(a.startedAt, 'day')));
  let cursor = periodStart(now, 'day');
  if (!days.has(cursor)) {
    const y = new Date(cursor); y.setDate(y.getDate() - 1); cursor = y.getTime();
    if (!days.has(cursor)) return 0;
  }
  let streak = 0;
  while (days.has(cursor)) {
    streak++;
    const d = new Date(cursor); d.setDate(d.getDate() - 1); cursor = d.getTime();
  }
  return streak;
}

/** Consecutive weeks (ending this week or last) with at least one walk. */
export function weekStreak(activities: Activity[], now = Date.now()): number {
  const weeks = new Set(activities.map((a) => periodStart(a.startedAt, 'week')));
  let cursor = periodStart(now, 'week');
  const back = (t: number) => { const d = new Date(t); d.setDate(d.getDate() - 7); return periodStart(d.getTime(), 'week'); };
  if (!weeks.has(cursor)) cursor = back(cursor);
  let n = 0;
  while (weeks.has(cursor)) { n++; cursor = back(cursor); }
  return n;
}
