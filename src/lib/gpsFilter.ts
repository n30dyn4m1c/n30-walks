/**
 * GPS fix filtering for walking.
 *
 * Raw phone GPS is noisy: it jumps when signal degrades, drifts while you
 * stand still, and occasionally reports wildly wrong fixes. Distance error
 * compounds — summing ±5 m jitter every second adds kilometres per hour.
 *
 * Pipeline per fix:
 *  1. Reject fixes with poor reported accuracy (configurable threshold).
 *  2. Reject physically impossible jumps (implied speed > maxSpeed, allowing
 *     for both fixes' reported error).
 *  3. Smooth with a constant-velocity Kalman filter (state = position +
 *     velocity per axis, in local metres). Measurement noise comes from the
 *     reported accuracy; process noise models walking accelerations. Unlike a
 *     position-only filter this has no lag on straight sections and very
 *     little jitter.
 *  4. Emit a point only when the walker is actually moving (filtered speed
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
  /** m/s — above this a fix is treated as a glitch (walking + jogging headroom) */
  maxSpeedMps: number;
  /** Process noise: std-dev of acceleration, m/s² */
  accelNoise: number;
  /** Minimum emitted step, meters */
  minStepM: number;
  /** Filtered speed below which the walker is considered stationary, m/s */
  stationarySpeedMps: number;
}

export const DEFAULT_FILTER: FilterOptions = {
  maxAccuracyM: 35,
  maxSpeedMps: 7,
  // Tuned against the noise tests in gpsFilter.test.ts (±4–5 m noise):
  // ~1 % error on straight walks, ~3 % on winding paths, <30 m drift per 5 min standing still.
  accelNoise: 0.1,
  minStepM: 7,
  stationarySpeedMps: 0.45,
};

export type FilterResult =
  | { kind: 'accepted'; point: TrackPoint }
  | { kind: 'rejected'; reason: 'accuracy' | 'speed' | 'stationary' | 'stale' };

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

export class GpsFilter {
  private opts: FilterOptions;
  private x = new Axis();
  private y = new Axis();
  private origin: { lat: number; lon: number; k: number } | null = null;
  private initialised = false;
  private lastT = 0;
  private lastEmitted: TrackPoint | null = null;
  private lastEmittedXY: [number, number] | null = null;
  private lastRaw: RawFix | null = null;

  constructor(opts: Partial<FilterOptions> = {}) {
    this.opts = { ...DEFAULT_FILTER, ...opts };
  }

  /** Re-seed after a pause so resumed walking doesn't "teleport" through the filter. */
  reset(keepLastEmitted = true) {
    this.initialised = false;
    this.lastRaw = null;
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

  push(fix: RawFix): FilterResult {
    const o = this.opts;
    const acc = Math.max(2, fix.acc || 10);
    if (acc > o.maxAccuracyM) return { kind: 'rejected', reason: 'accuracy' };
    if (this.lastRaw && fix.t <= this.lastRaw.t) return { kind: 'rejected', reason: 'stale' };
    const [zx, zy] = this.toXY(fix.lat, fix.lon);

    if (this.lastRaw) {
      const dt = (fix.t - this.lastRaw.t) / 1000;
      const [lx, ly] = this.toXY(this.lastRaw.lat, this.lastRaw.lon);
      const d = Math.hypot(zx - lx, zy - ly);
      const slack = acc + Math.max(2, this.lastRaw.acc || 10);
      if (dt > 0 && (d - slack) / dt > o.maxSpeedMps) return { kind: 'rejected', reason: 'speed' };
    }
    this.lastRaw = fix;

    const r = acc * acc;
    if (!this.initialised) {
      this.x.init(zx, r);
      this.y.init(zy, r);
      this.initialised = true;
    } else {
      const dt = Math.max(0.001, (fix.t - this.lastT) / 1000);
      this.x.predict(dt, o.accelNoise);
      this.y.predict(dt, o.accelNoise);
      this.x.update(zx, r);
      this.y.update(zy, r);
    }
    this.lastT = fix.t;

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
      const moving = speed >= o.stationarySpeedMps;
      const threshold = Math.max(o.minStepM, posStd);
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
