/**
 * Activity statistics computed from a filtered track.
 * Pure functions — unit-tested in stats.test.ts.
 */
import { haversine, cumulativeDistances, type LngLat } from './geo';
import type { ActivityStats, JourneyStats, Split, TrackPoint, TravelMode } from '../types';

/** Segments slower than this are considered "not moving" (auto-pause). */
export const MOVING_SPEED_MPS = 0.3;
/** Gaps longer than this (e.g. GPS lost, manual pause) never count as moving time. */
export const MAX_GAP_S = 60;
/** Standard best-effort distances (m). */
export const BEST_EFFORT_DISTANCES = [1000, 1609.344, 5000, 10000, 21097.5];

export function toLngLat(points: TrackPoint[]): LngLat[] {
  return points.map((p) => [p.lon, p.lat]);
}

/**
 * Bump when the stats algorithm changes in a way that alters stored results;
 * saved activities are recomputed on next launch (see migrateStats).
 * v2: signal gaps no longer add distance without time (fake best efforts).
 */
export const STATS_VERSION = 2;

/** Whether the segment (a, b] overlaps any manual pause interval. */
export function overlapsPause(a: number, b: number, pauses: [number, number][]): boolean {
  for (const [s, e] of pauses) if (a < e && b > s) return true;
  return false;
}

/**
 * How one track segment contributes to distance and moving time. Shared by the
 * live recorder and computeStats so the numbers on screen while walking are
 * exactly the numbers that get saved.
 *
 *  - Segments overlapping a manual pause count for nothing.
 *  - Normal segments count their distance; their time counts as moving when
 *    the walker was moving (speed >= MOVING_SPEED_MPS).
 *  - Signal gaps (dt > MAX_GAP_S: tunnel, screen locked on the web) count
 *    their distance, but we don't know how long the walker actually moved,
 *    so we credit at most the time it would take at the slowest "moving"
 *    speed. Without this a gap added distance with zero time, producing
 *    impossible best efforts and paces.
 */
export function segmentContribution(a: TrackPoint, b: TrackPoint, pauses: [number, number][]): { d: number; moving: number } {
  if (overlapsPause(a.t, b.t, pauses)) return { d: 0, moving: 0 };
  const d = haversine([a.lon, a.lat], [b.lon, b.lat]);
  const dt = (b.t - a.t) / 1000;
  if (dt <= 0) return { d, moving: 0 };
  if (dt > MAX_GAP_S) return { d, moving: Math.min(dt, d / MOVING_SPEED_MPS) };
  return { d, moving: d / dt >= MOVING_SPEED_MPS ? dt : 0 };
}

/** Distance and moving time of a whole track (used to restore a recovered draft). */
export function trackTotals(points: TrackPoint[], pauses: [number, number][]): { distanceM: number; movingS: number } {
  let distanceM = 0, movingS = 0;
  for (let i = 1; i < points.length; i++) {
    const c = segmentContribution(points[i - 1], points[i], pauses);
    distanceM += c.d;
    movingS += c.moving;
  }
  return { distanceM, movingS };
}

/** Total paused time (ms) that falls inside [from, to]. */
export function pausedWithin(pauses: [number, number][], from: number, to: number): number {
  return pauses.reduce((s, [a, b]) => s + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0);
}

/**
 * Elevation gain/loss with hysteresis: only count a climb once elevation has
 * moved `threshold` meters from the last reference. This is the standard way
 * to stop noise (GPS or DEM interpolation) from inflating totals.
 */
export function elevationGainLoss(eles: number[], threshold = 3): { gain: number; loss: number } {
  let gain = 0, loss = 0;
  if (eles.length < 2) return { gain, loss };
  let ref = eles[0];
  for (let i = 1; i < eles.length; i++) {
    const d = eles[i] - ref;
    if (d >= threshold) { gain += d; ref = eles[i]; }
    else if (d <= -threshold) { loss -= d; ref = eles[i]; }
  }
  return { gain, loss };
}

/** Simple centred moving average (window in samples). */
export function smooth(values: number[], window = 5): number[] {
  const h = Math.floor(window / 2);
  return values.map((_, i) => {
    let s = 0, n = 0;
    for (let k = Math.max(0, i - h); k <= Math.min(values.length - 1, i + h); k++) { s += values[k]; n++; }
    return s / n;
  });
}

/**
 * Fastest time (s) to cover `target` meters anywhere in the track, using a
 * two-pointer sliding window over cumulative distance with linear
 * interpolation at the window start. O(n).
 */
export function bestEffort(cum: number[], times: number[], target: number): number | null {
  const n = cum.length;
  if (n < 2 || cum[n - 1] < target) return null;
  let best = Infinity;
  let j = 0;
  for (let i = 1; i < n; i++) {
    // Advance j while the window starting at j+1 still covers the target.
    while (j + 1 < i && cum[i] - cum[j + 1] >= target) j++;
    if (cum[i] - cum[j] < target) continue;
    // Interpolate the exact start between j and j+1 so the window is exactly `target`.
    const startDist = cum[i] - target;
    const segD = cum[j + 1] - cum[j];
    const f = segD > 0 ? (startDist - cum[j]) / segD : 0;
    const startT = times[j] + f * (times[j + 1] - times[j]);
    const dt = times[i] - startT;
    if (dt > 0 && dt < best) best = dt;
  }
  return isFinite(best) ? best : null;
}

/** MET for walking by speed (Compendium of Physical Activities, interpolated). */
export function walkingMet(speedMps: number): number {
  const table: [number, number][] = [[0.9, 2.0], [1.12, 2.8], [1.34, 3.5], [1.56, 4.3], [1.79, 5.0], [2.01, 7.0], [2.24, 8.3]];
  if (speedMps <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (speedMps <= table[i][0]) {
      const [s0, m0] = table[i - 1], [s1, m1] = table[i];
      return m0 + ((speedMps - s0) / (s1 - s0)) * (m1 - m0);
    }
  }
  return table[table.length - 1][1];
}

/** MET for running by speed (Compendium of Physical Activities, interpolated). */
export function runningMet(speedMps: number): number {
  const table: [number, number][] = [[2.24, 8.3], [2.68, 9.0], [3.0, 9.8], [3.35, 10.5], [3.58, 11.0], [4.02, 11.8], [4.47, 12.3], [4.92, 12.8], [5.36, 14.5]];
  if (speedMps <= table[0][0]) return walkingMet(speedMps);
  for (let i = 1; i < table.length; i++) {
    if (speedMps <= table[i][0]) {
      const [s0, m0] = table[i - 1], [s1, m1] = table[i];
      return m0 + ((speedMps - s0) / (s1 - s0)) * (m1 - m0);
    }
  }
  return table[table.length - 1][1];
}

// ---------------- travel modes (mixed journeys) ----------------

/** Sustained speed above this is running rather than walking (~8.6 km/h). */
export const WALK_MAX_MPS = 2.4;
/** Sustained speed above this is a vehicle (bus, train, car, bike) rather than running (~18 km/h). */
export const VEHICLE_MIN_MPS = 5.0;
/** Speed is judged over moving time within this many seconds either side of a segment. */
export const MODE_WINDOW_S = 30;
/** A stretch shorter than this (moving time) can't change the mode: it is merged into a neighbour. */
export const MIN_MODE_RUN_S = 60;

export function modeForSpeed(speedMps: number): TravelMode {
  return speedMps >= VEHICLE_MIN_MPS ? 'vehicle' : speedMps >= WALK_MAX_MPS ? 'run' : 'walk';
}

/**
 * Travel mode of every segment (points[i] → points[i+1]) of a journey,
 * inferred from speed. Returns an array of length points.length - 1.
 *
 *  1. Each moving segment gets the average speed over moving time in a ±30 s
 *     window, so GPS jitter and a single fast fix don't flip the mode.
 *  2. Stationary and paused segments carry the mode of the stretch they sit in:
 *     a bus waiting at a stop is still the bus, waiting at the stop is walking.
 *  3. Stretches shorter than a minute of moving time are merged into the
 *     longer neighbour, so a bus crawling for 20 s in traffic stays a bus.
 */
export function classifyModes(points: TrackPoint[], pauses: [number, number][] = []): TravelMode[] {
  const n = points.length - 1;
  if (n <= 0) return [];
  const d: number[] = new Array(n), dt: number[] = new Array(n), moving: boolean[] = new Array(n), mid: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[i + 1];
    d[i] = haversine([a.lon, a.lat], [b.lon, b.lat]);
    dt[i] = Math.max(0, (b.t - a.t) / 1000);
    mid[i] = (a.t + b.t) / 2;
    moving[i] = !overlapsPause(a.t, b.t, pauses) && dt[i] > 0 && d[i] / dt[i] >= MOVING_SPEED_MPS;
  }

  // 1. Windowed speed over moving segments (two pointers over time).
  const labels: (TravelMode | null)[] = new Array(n).fill(null);
  const w = MODE_WINDOW_S * 1000;
  let lo = 0, hi = 0, sumD = 0, sumT = 0;
  for (let i = 0; i < n; i++) {
    while (hi < n && mid[hi] <= mid[i] + w) { if (moving[hi]) { sumD += d[hi]; sumT += dt[hi]; } hi++; }
    while (lo < n && mid[lo] < mid[i] - w) { if (moving[lo]) { sumD -= d[lo]; sumT -= dt[lo]; } lo++; }
    if (!moving[i]) continue;
    // A long gap segment on its own still says something: judge it by its own speed.
    labels[i] = modeForSpeed(sumT > 0 ? sumD / sumT : d[i] / dt[i]);
  }

  // 2. Stationary segments inherit the surrounding mode.
  const firstLabel = labels.find((l) => l != null) ?? 'walk';
  let cur: TravelMode = firstLabel;
  const modes: TravelMode[] = labels.map((l) => (cur = l ?? cur));

  // 3. Merge short stretches.
  type Run = { start: number; end: number; mode: TravelMode; movingS: number };
  const runsOf = (): Run[] => {
    const runs: Run[] = [];
    for (let i = 0; i < n; i++) {
      const last = runs[runs.length - 1];
      const m = moving[i] ? dt[i] : 0;
      if (last && last.mode === modes[i]) { last.end = i; last.movingS += m; }
      else runs.push({ start: i, end: i, mode: modes[i], movingS: m });
    }
    return runs;
  };
  for (let guard = 0; guard < n; guard++) {
    const runs = runsOf();
    if (runs.length < 2) break;
    let k = -1;
    for (let j = 0; j < runs.length; j++) if (runs[j].movingS < MIN_MODE_RUN_S && (k < 0 || runs[j].movingS < runs[k].movingS)) k = j;
    if (k < 0) break;
    const prev = runs[k - 1], next = runs[k + 1];
    const into = !prev ? next : !next ? prev : prev.mode === next.mode || prev.movingS >= next.movingS ? prev : next;
    for (let i = runs[k].start; i <= runs[k].end; i++) modes[i] = into.mode;
  }
  return modes;
}

/** Whether a track contains a vehicle stretch (e.g. a GPX import of a walk + bus journey). */
export function hasVehicleStretch(points: TrackPoint[]): boolean {
  return classifyModes(points).includes('vehicle');
}

/**
 * Current travel mode while recording, from the last ~40 s of moving time.
 * Null while standing still.
 */
export function liveMode(points: TrackPoint[], pauses: [number, number][] = []): { mode: TravelMode; speedMps: number } | null {
  const n = points.length;
  if (n < 2) return null;
  const end = points[n - 1].t;
  let sumD = 0, sumT = 0;
  for (let i = n - 1; i > 0 && end - points[i].t < 40_000; i--) {
    const a = points[i - 1], b = points[i];
    if (overlapsPause(a.t, b.t, pauses)) continue;
    const segD = haversine([a.lon, a.lat], [b.lon, b.lat]), segT = (b.t - a.t) / 1000;
    if (segT > 0 && segT <= MAX_GAP_S && segD / segT >= MOVING_SPEED_MPS) { sumD += segD; sumT += segT; }
  }
  if (sumT < 5) return null;
  const speedMps = sumD / sumT;
  return { mode: modeForSpeed(speedMps), speedMps };
}

export interface StatsOptions {
  weightKg: number;
  strideM: number;
  pauses?: [number, number][];
  elevationSource?: ActivityStats['elevationSource'];
  /** Split length in meters (1000 for km, 1609.344 for miles) */
  splitM?: number;
  /**
   * Mixed journey: classify stretches by speed. Distance, moving time, pace,
   * splits, best efforts, steps, calories and climbing then cover the on-foot
   * stretches only, and `journey` holds the full trip.
   */
  mixed?: boolean;
}

export function computeStats(points: TrackPoint[], opts: StatsOptions): ActivityStats {
  const pauses = opts.pauses ?? [];
  const n = points.length;
  const empty: ActivityStats = {
    distanceM: 0, elapsedS: 0, movingS: 0, avgPaceSPerKm: 0, avgSpeedMps: 0,
    elevGainM: 0, elevLossM: 0, minEleM: null, maxEleM: null, estSteps: 0, estKcal: 0,
    bestEfforts: {}, splits: [], elevationSource: 'none',
  };
  if (n === 0) return empty;

  const modes = opts.mixed ? classifyModes(points, pauses) : null;
  const zero = () => ({ distanceM: 0, movingS: 0 });
  const journey: JourneyStats | undefined = modes ? { distanceM: 0, movingS: 0, modes: { walk: zero(), run: zero(), vehicle: zero() } } : undefined;

  let distance = 0;
  let moving = 0;
  // "Effective" cumulative distance/time series excluding pauses (and, for a
  // mixed journey, vehicle stretches) — used for splits and best efforts.
  const cum: number[] = [0];
  const movT: number[] = [0];
  for (let i = 1; i < n; i++) {
    const c = segmentContribution(points[i - 1], points[i], pauses);
    if (journey && modes) {
      const m = journey.modes[modes[i - 1]];
      m.distanceM += c.d; m.movingS += c.moving;
      journey.distanceM += c.d; journey.movingS += c.moving;
    }
    if (!modes || modes[i - 1] !== 'vehicle') {
      distance += c.d;
      moving += c.moving;
    }
    cum.push(distance);
    movT.push(moving);
  }

  // Manual pauses are excluded from elapsed time. Only the part of each pause inside the
  // track counts (a walk finished while paused has a pause running past the last point).
  const pausedMs = pausedWithin(pauses, points[0].t, points[n - 1].t);
  const elapsed = Math.max(0, (points[n - 1].t - points[0].t - pausedMs) / 1000);

  // Elevation
  const raw = points.map((p) => p.ele).filter((e): e is number => e != null && isFinite(e));
  let gain = 0, loss = 0, minE: number | null = null, maxE: number | null = null;
  let elevationSource: ActivityStats['elevationSource'] = 'none';
  if (raw.length >= 2 && raw.length >= n * 0.5) {
    const win = opts.elevationSource === 'dem' ? 3 : 7, thr = opts.elevationSource === 'dem' ? 2 : 4;
    const sm = smooth(raw, win);
    minE = Math.min(...sm);
    maxE = Math.max(...sm);
    elevationSource = opts.elevationSource ?? 'gps';
    if (!modes) ({ gain, loss } = elevationGainLoss(sm, thr));
    else {
      // Climbing counts on foot only: the bus up the hill isn't your effort.
      for (const run of footRuns(modes)) {
        const e = points.slice(run[0], run[1] + 1).map((p) => p.ele).filter((v): v is number => v != null && isFinite(v));
        if (e.length < 2) continue;
        const r = elevationGainLoss(smooth(e, win), thr);
        gain += r.gain; loss += r.loss;
      }
    }
  }

  // Splits (per km / mile), measured on moving time.
  const splitM = opts.splitM ?? 1000;
  const splits: Split[] = [];
  let splitStartIdx = 0;
  let nextBoundary = splitM;
  const eleAt = (i: number) => points[i].ele ?? NaN;
  const eleDelta = (i: number, j: number) => { const v = eleAt(i) - eleAt(j); return isFinite(v) ? v : 0; };
  for (let i = 1; i < n; i++) {
    while (cum[i] >= nextBoundary) {
      const f = (nextBoundary - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
      const tAt = movT[i - 1] + f * (movT[i] - movT[i - 1]);
      const prevT = splits.length ? splits.reduce((s, x) => s + x.durationS, 0) : 0;
      const dur = tAt - prevT;
      splits.push({
        index: splits.length + 1, distanceM: splitM, durationS: dur,
        paceSPerKm: dur / (splitM / 1000), elevDeltaM: eleDelta(i, splitStartIdx),
      });
      splitStartIdx = i;
      nextBoundary += splitM;
    }
  }
  const usedT = splits.reduce((s, x) => s + x.durationS, 0);
  const remD = distance - splits.length * splitM;
  if (remD > splitM * 0.05) {
    const dur = moving - usedT;
    splits.push({ index: splits.length + 1, distanceM: remD, durationS: dur, paceSPerKm: dur / (remD / 1000), elevDeltaM: eleDelta(n - 1, splitStartIdx) });
  }

  const bestEfforts: Record<string, number> = {};
  for (const target of BEST_EFFORT_DISTANCES) {
    // Best efforts on moving time: a coffee stop shouldn't ruin a 5 km PR.
    const b = bestEffort(cum, movT, target);
    if (b != null) bestEfforts[String(target)] = Math.round(b);
  }

  const avgSpeed = moving > 0 ? distance / moving : 0;
  let kcal: number;
  if (journey) {
    const met = (m: { distanceM: number; movingS: number }, f: (v: number) => number) => (m.movingS > 0 ? f(m.distanceM / m.movingS) * opts.weightKg * (m.movingS / 3600) : 0);
    kcal = met(journey.modes.walk, walkingMet) + met(journey.modes.run, runningMet);
  } else kcal = walkingMet(avgSpeed) * opts.weightKg * (moving / 3600);
  return {
    distanceM: distance,
    elapsedS: elapsed,
    movingS: moving,
    avgPaceSPerKm: distance > 0 ? moving / (distance / 1000) : 0,
    avgSpeedMps: avgSpeed,
    elevGainM: gain,
    elevLossM: loss,
    minEleM: minE,
    maxEleM: maxE,
    estSteps: Math.round(distance / Math.max(0.3, opts.strideM)),
    estKcal: Math.round(kcal),
    bestEfforts,
    splits,
    elevationSource,
    ...(journey ? { journey } : {}),
  };
}

/** Point-index ranges [first, last] of the on-foot stretches of a classified journey. */
function footRuns(modes: TravelMode[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < modes.length; i++) {
    if (modes[i] === 'vehicle') continue;
    const last = out[out.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}

/** Per-point pace (s/km) using a distance-windowed rolling average — for map colouring & live stats. */
export function rollingPace(points: TrackPoint[], windowM = 150): number[] {
  const coords = toLngLat(points);
  const cum = cumulativeDistances(coords);
  const out: number[] = new Array(points.length).fill(0);
  let j = 0;
  for (let i = 0; i < points.length; i++) {
    while (j < i && cum[i] - cum[j] > windowM) j++;
    const d = cum[i] - cum[j];
    const dt = (points[i].t - points[j].t) / 1000;
    out[i] = d > 10 && dt > 0 ? dt / (d / 1000) : 0;
  }
  // Backfill the warm-up region with the first valid value.
  const first = out.find((v) => v > 0) ?? 0;
  for (let i = 0; i < out.length && out[i] === 0; i++) out[i] = first;
  return out;
}
