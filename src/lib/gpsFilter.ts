/**
 * GPS fix filtering for walking.
 *
 * Raw phone GPS is noisy: it jumps when signal degrades, drifts while you
 * stand still, and occasionally reports wildly wrong fixes. Distance error
 * compounds — summing ±5 m jitter every second adds kilometres per hour.
 *
 * Pipeline per fix:
 *  1. Reject fixes with poor reported accuracy (configurable threshold).
 *  2. Wait for a good first fix: coarse Wi-Fi / cell fixes delivered while the
 *     GPS warms up are often hundreds of metres off, so the filter only
 *     starts from a fix with good accuracy (or the best of the first few).
 *  3. Gate every fix against where the Kalman filter PREDICTS the walker to
 *     be. A fix that lands too far from the prediction is held back as a
 *     possible glitch. It is only accepted if the next few fixes agree with
 *     it (a genuine move); a lone spike is dropped. This is what stops the
 *     long straight "spikes" off the track.
 *  4. After a signal gap (tunnel, screen off, pocket) the filter is re-seeded
 *     from fresh, confirmed fixes instead of extrapolating stale velocity.
 *  5. Smooth with a constant-velocity Kalman filter (state = position +
 *     velocity per axis, in local metres). Measurement noise comes from the
 *     reported accuracy; process noise models walking accelerations.
 *  6. Emit a point only when the walker is actually moving (filtered speed
 *     above a threshold) and has covered a minimum step. While stationary we
 *     emit a "heartbeat" at the last emitted position every 30 s so time-based
 *     stats stay continuous without adding phantom distance.
 */
import type { TrackPoint } from '../types';

export interface RawFix {
  lat: number;
  lon: number;
  t: number;
  acc: number;
  alt?: number | null;
  speed?: number | null;
}

export interface FilterOptions {
  maxAccuracyM: number;
  /** Accuracy needed to (re)start the track after a cold start or a gap. */
  startAccuracyM: number;
  /** m/s — no walker (or jogger) moves faster than this */
  maxSpeedMps: number;
  /** Process noise: std-dev of acceleration, m/s² */
  accelNoise: number;
  /** Minimum emitted step, meters */
  minStepM: number;
  /** Filtered speed below which the walker is considered stationary, m/s */
  stationarySpeedMps: number;
  /** A silence longer than this (s) is a signal gap: re-seed instead of extrapolating. */
  gapS: number;
  /** Consecutive agreeing fixes needed to accept a jump away from the prediction. */
  confirmFixes: number;
}

export const DEFAULT_FILTER: FilterOptions = {
  maxAccuracyM: 35,
  startAccuracyM: 20,
  maxSpeedMps: 6,
  // Tuned against the tests in gpsFilter.test.ts (±4–5 m noise, sharp turns,
  // glitches, gaps): ~1 % distance error on straight walks, ~3 % on winding
  // paths, corners followed within a few metres.
  accelNoise: 0.15,
  minStepM: 7,
  stationarySpeedMps: 0.45,
  gapS: 12,
  confirmFixes: 3,
};

export type FilterResult =
  | { kind: 'accepted'; point: TrackPoint }
  | { kind: 'rejected'; reason: 'accuracy' | 'speed' | 'stationary' | 'stale' | 'warmup' };

/** 1-D constant-velocity Kalman filter. */
class Axis {
  p = 0; v = 0;
  P00 = 0; P01 = 0; P10 = 0; P11 = 0;
  init(z: number, r: number) { this.p = z; this.v = 0; this.P00 = r; this.P01 = this.P10 = 0; this.P11 = 4; }
  predict(dt: number, q: number) {
    this.p += this.v * dt;
    const q2 = q * q, dt2 = dt * dt;
    const P00 = this.P00 + dt * (this.P10 + this.P01) + dt2 * this.P11 + (q2 * dt2 * dt2) / 4;
    const P01 = this.P01 + dt * this.P11 + (q2 * dt2 * dt) / 2;
    const P10 = this.P10 + dt * this.P11 + (q2 * dt2 * dt) / 2;
    const P11 = this.P11 + q2 * dt2;
    this.P00 = P00; this.P01 = P01; this.P10 = P10; this.P11 = P11;
  }
  update(z: number, r: number) {
    const S = this.P00 + r;
    const K0 = this.P00 / S, K1 = this.P10 / S;
    const y = z - this.p;
    this.p += K0 * y;
    this.v += K1 * y;
    const P00 = (1 - K0) * this.P00, P01 = (1 - K0) * this.P01;
    const P10 = this.P10 - K1 * this.P00, P11 = this.P11 - K1 * this.P01;
    this.P00 = P00; this.P01 = P01; this.P10 = P10; this.P11 = P11;
  }
}

const M_PER_DEG = 111_320;
const accOf = (f: RawFix) => Math.max(2, f.acc || 10);

export class GpsFilter {
  private opts: FilterOptions;
  private x = new Axis();
  private y = new Axis();
  private origin: { lat: number; lon: number; k: number } | null = null;
  private initialised = false;
  /** Time of the last fix fed into the Kalman filter. */
  private lastT = 0;
  /** Time of the last fix seen at all (for out-of-order / duplicate rejection). */
  private lastSeenT = -Infinity;
  private lastEmitted: TrackPoint | null = null;
  private lastEmittedXY: [number, number] | null = null;
  /** Fixes that disagree with the prediction, waiting for confirmation. */
  private pending: RawFix[] = [];
  /** Usable-accuracy fixes seen while waiting for a good starting fix. */
  private warmup: RawFix[] = [];

  constructor(opts: Partial<FilterOptions> = {}) {
    this.opts = { ...DEFAULT_FILTER, ...opts };
    this.opts.startAccuracyM = Math.min(this.opts.startAccuracyM, this.opts.maxAccuracyM);
  }

  /** Re-seed after a pause so resumed walking doesn't "teleport" through the filter. */
  reset(keepLastEmitted = true) {
    this.initialised = false;
    this.pending = [];
    this.warmup = [];
    if (!keepLastEmitted) { this.lastEmitted = null; this.lastEmittedXY = null; }
  }

  private toXY(lat: number, lon: number): [number, number] {
    if (!this.origin) this.origin = { lat, lon, k: Math.cos((lat * Math.PI) / 180) };
    return [(lon - this.origin.lon) * M_PER_DEG * this.origin.k, (lat - this.origin.lat) * M_PER_DEG];
  }
  private toLatLon(x: number, y: number): [number, number] {
    const o = this.origin!;
    return [o.lat + y / M_PER_DEG, o.lon + x / (M_PER_DEG * o.k)];
  }

  private seed(fix: RawFix) {
    const [zx, zy] = this.toXY(fix.lat, fix.lon);
    const r = accOf(fix) ** 2;
    this.x.init(zx, r);
    this.y.init(zy, r);
    this.initialised = true;
    this.lastT = fix.t;
    this.pending = [];
    this.warmup = [];
  }

  /** Do the held-back fixes agree with each other (a real move, not a spike)? */
  private pendingConsistent(): boolean {
    const o = this.opts;
    for (let i = 1; i < this.pending.length; i++) {
      const a = this.pending[i - 1], b = this.pending[i];
      const [ax, ay] = this.toXY(a.lat, a.lon), [bx, by] = this.toXY(b.lat, b.lon);
      const dt = (b.t - a.t) / 1000;
      if (Math.hypot(bx - ax, by - ay) > accOf(a) + accOf(b) + o.maxSpeedMps * dt) return false;
    }
    return true;
  }

  push(fix: RawFix): FilterResult {
    const o = this.opts;
    if (fix.t <= this.lastSeenT) return { kind: 'rejected', reason: 'stale' };
    this.lastSeenT = fix.t;
    const acc = accOf(fix);
    if (acc > o.maxAccuracyM) return { kind: 'rejected', reason: 'accuracy' };

    // ---- 1. Cold start / restart: wait for a trustworthy first fix ----
    if (!this.initialised) {
      if (acc <= o.startAccuracyM) this.seed(fix);
      else {
        this.warmup.push(fix);
        if (this.warmup.length < 5) return { kind: 'rejected', reason: 'warmup' };
        // Signal never gets good here: start from the best of what we have.
        const best = this.warmup.reduce((a, b) => (accOf(b) <= accOf(a) ? b : a));
        this.seed({ ...best, t: fix.t, alt: fix.alt });
        if (best !== fix) return { kind: 'rejected', reason: 'warmup' };
      }
      return this.emit(fix, true);
    }

    // ---- 2. Gate against the prediction ----
    const [zx, zy] = this.toXY(fix.lat, fix.lon);
    const dt = (fix.t - this.lastT) / 1000;
    const gap = dt > o.gapS;
    const predDt = Math.min(dt, o.gapS);
    const px = this.x.p + this.x.v * predDt, py = this.y.p + this.y.v * predDt;
    const d = Math.hypot(zx - px, zy - py);
    const posStd = Math.sqrt((this.x.P00 + this.y.P00) / 2);
    // Room for measurement error on both sides plus a sudden change of pace.
    const allowed = gap
      ? 2 * acc // after a gap, anything that isn't "still here" must be confirmed
      : 2.5 * Math.hypot(acc, posStd) + 2 * predDt;
    const plausibleSpeed = (d - acc - posStd) / Math.max(dt, 1) <= o.maxSpeedMps;

    if (d > allowed || !plausibleSpeed) {
      // Possible glitch. Hold it back; accept only if the next fixes agree.
      if (this.pending.length && !this.pendingConsistent()) this.pending = [];
      this.pending.push(fix);
      if (!this.pendingConsistent()) this.pending = [fix];
      const good = this.pending.filter((p) => accOf(p) <= o.startAccuracyM).length;
      const confirmed = this.pending.length >= o.confirmFixes && (good >= 1 || this.pending.length >= o.confirmFixes * 3);
      if (!confirmed) return { kind: 'rejected', reason: 'speed' };
      // A real move (or the old position was the glitch): restart from here.
      this.seed(fix);
      return this.emit(fix, true);
    }
    this.pending = [];

    if (gap) {
      // Back after a gap, still about where we were: re-seed, don't extrapolate.
      this.seed(fix);
      return this.emit(fix, false);
    }

    // ---- 3. Kalman update ----
    const r = acc * acc;
    this.x.predict(Math.max(0.001, dt), o.accelNoise);
    this.y.predict(Math.max(0.001, dt), o.accelNoise);
    this.x.update(zx, r);
    this.y.update(zy, r);
    this.lastT = fix.t;
    return this.emit(fix, false);
  }

  /** Decide whether the current filtered state becomes a track point. */
  private emit(fix: RawFix, fresh: boolean): FilterResult {
    const o = this.opts;
    const posStd = Math.sqrt((this.x.P00 + this.y.P00) / 2);
    const speed = Math.hypot(this.x.v, this.y.v);
    const [lat, lon] = this.toLatLon(this.x.p, this.y.p);
    const point: TrackPoint = {
      lat, lon, t: fix.t,
      acc: Math.round(posStd * 10) / 10,
      ...(fix.alt != null && isFinite(fix.alt) ? { ele: fix.alt } : {}),
    };

    if (this.lastEmitted && this.lastEmittedXY) {
      const step = Math.hypot(this.x.p - this.lastEmittedXY[0], this.y.p - this.lastEmittedXY[1]);
      // A freshly re-seeded position after a confirmed move is emitted straight away.
      const moving = fresh || speed >= o.stationarySpeedMps;
      const threshold = Math.max(o.minStepM, Math.min(posStd, 15));
      if (!moving || step < threshold) {
        if (fix.t - this.lastEmitted.t >= 30_000) {
          // Heartbeat: same position, new time → no phantom distance.
          const hb: TrackPoint = { ...this.lastEmitted, t: fix.t };
          this.lastEmitted = hb;
          return { kind: 'accepted', point: hb };
        }
        return { kind: 'rejected', reason: 'stationary' };
      }
    }
    this.lastEmitted = point;
    this.lastEmittedXY = [this.x.p, this.y.p];
    return { kind: 'accepted', point };
  }
}
