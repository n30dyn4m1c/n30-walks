/**
 * Procedural walking paths for the GPS simulator and demo data.
 * Produces organic-looking loops (not road-snapped) of a target length.
 */
import { destination, cumulativeDistances, pathLength, pointAtDistance, type LngLat } from './geo';
import type { TrackPoint } from '../types';

/** Deterministic PRNG (mulberry32) so demo data and tests are reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Closed organic loop of ~`targetM` meters that starts and ends at `start`. */
export function proceduralLoop(start: LngLat, targetM: number, seed = 1): LngLat[] {
  const r = rng(seed);
  const ph = [r() * 6.28, r() * 6.28, r() * 6.28, r() * 6.28];
  const heading = r() * 360;
  const N = 360;
  const shape = (scale: number) => {
    // Centre is offset from start so the loop passes through the start point at θ = heading+180.
    const radiusAt = (θ: number) => scale * (1 + 0.22 * Math.sin(2 * θ + ph[0]) + 0.12 * Math.sin(3 * θ + ph[1]) + 0.06 * Math.sin(7 * θ + ph[2]) + 0.03 * Math.sin(13 * θ + ph[3]));
    const θ0 = ((heading + 180) * Math.PI) / 180;
    const centre = destination(start, radiusAt(θ0), heading);
    const pts: LngLat[] = [];
    for (let i = 0; i <= N; i++) {
      const θ = θ0 + (i / N) * 2 * Math.PI;
      pts.push(destination(centre, radiusAt(θ), ((θ * 180) / Math.PI) % 360));
    }
    pts[0] = start;
    pts[pts.length - 1] = start;
    return pts;
  };
  let scale = targetM / (2 * Math.PI);
  let pts = shape(scale);
  scale *= targetM / pathLength(pts);
  pts = shape(scale);
  return pts;
}

/**
 * Turn a path into a realistic timed walk: variable pace, a short stop,
 * GPS noise. Returns *raw-ish* points (already lightly noisy).
 */
export function timedWalk(path: LngLat[], startMs: number, opts: { speedMps?: number; seed?: number; noiseM?: number; stop?: boolean } = {}): TrackPoint[] {
  const r = rng(opts.seed ?? 7);
  const speed = opts.speedMps ?? 1.4;
  const noise = opts.noiseM ?? 2;
  const cum = cumulativeDistances(path);
  const total = cum[cum.length - 1];
  const out: TrackPoint[] = [];
  const phase = r() * 6;
  let d = 0, t = startMs;
  const stopAt = opts.stop ? total * (0.4 + r() * 0.2) : Infinity;
  let stopped = false;
  while (d < total) {
    const { p } = pointAtDistance(path, cum, d);
    const mPerDegLat = 111_320, mPerDegLon = 111_320 * Math.cos((p[1] * Math.PI) / 180);
    out.push({ lon: p[0] + (gaussian(r) * noise) / mPerDegLon, lat: p[1] + (gaussian(r) * noise) / mPerDegLat, t, acc: 4 + r() * 4 });
    if (!stopped && d >= stopAt) { stopped = true; t += 45_000; continue; }
    const v = speed * (1 + 0.12 * Math.sin(phase + d / 300) + 0.05 * gaussian(r));
    const dt = 3;
    d += Math.max(0.3, v) * dt;
    t += dt * 1000;
  }
  const end = path[path.length - 1];
  out.push({ lon: end[0], lat: end[1], t, acc: 5 });
  return out;
}

/**
 * Scenic default start for simulation/demo when no GPS fix is available:
 * Grindelwald, Switzerland — dramatic terrain makes the 3D flyover shine.
 */
export const DEMO_START: LngLat = [8.0337, 46.6243];
