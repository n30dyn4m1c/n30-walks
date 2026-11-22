/**
 * Flyover camera planning — pure math, no map dependency (unit-tested).
 *
 * Timeline for normalised time u ∈ [0, 1]:
 *   intro  [0, INTRO)       overview of the whole route → swoop down to the start
 *   follow [INTRO, OUTRO)   chase-cam follows the walker along the route
 *   outro  [OUTRO, 1]       pull back up to an orbiting overview of the full route
 *
 * Smoothness comes from three things:
 *   1. The route is resampled at a fixed spacing and lightly smoothed, so GPS
 *      zig-zags don't jerk the camera.
 *   2. Camera bearing looks along a long chord (lookahead) and is then
 *      circular-averaged over a wide window — it turns gently ahead of corners.
 *   3. All phase transitions use smoothstep easing on every camera parameter.
 */
import {
  angleDelta, bbox, bearing, circularMean, cumulativeDistances, fitZoom, lowerIndex,
  pointAtDistance, resample, type LngLat,
} from '../lib/geo';
import { rollingPace, MOVING_SPEED_MPS, MAX_GAP_S } from '../lib/stats';
import type { TrackPoint } from '../types';

export const INTRO = 0.12;
export const OUTRO = 0.86;
/** Reference viewport (CSS px) the plan is computed for; other sizes shift zoom by log2(w/REF_W). */
export const REF_W = 540;
export const REF_H = 960;

export interface FlyoverPlan {
  coords: LngLat[];
  cum: number[];
  total: number;
  bearings: number[];
  /**
   * Smoothed ground elevation (m) under each resampled coord, or null if the
   * track has no elevation. We drive the camera's centre altitude from this
   * instead of letting MapLibre sample whatever terrain tile happens to be
   * loaded — that sampling flips between zoom levels and makes the camera jump.
   */
  centerEle: number[] | null;
  followZoom: number;
  overview: { center: LngLat; zoom: number; bearing: number; ele: number | null };
  /** Source track series for live stats, indexed by track distance */
  track: { cum: number[]; movingS: number[]; ele: (number | null)[]; pace: number[]; clockMs: number[] };
  /** Elevation profile sampled evenly over distance (for the overlay chart) */
  profile: number[];
}

export interface CameraState {
  center: LngLat;
  zoom: number;
  pitch: number;
  bearing: number;
  /** Fraction of the screen height to push the focus point down (via padding) */
  focusOffset: number;
  /** Ground elevation (m, unexaggerated) at the camera centre, or null to let MapLibre clamp */
  elevation: number | null;
  /** Distance along the route reached so far (m) */
  distance: number;
  phase: 'intro' | 'follow' | 'outro';
}

export interface LiveStats {
  distanceM: number;
  movingS: number;
  eleM: number | null;
  paceSPerKm: number;
  clockMs: number;
}

const smoothstep = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
/**
 * Trapezoidal velocity profile: accelerate over the first `a`, cruise, then
 * decelerate over the last `a`. Position is C1-continuous and maps 0→0, 1→1.
 */
export function easeEnds(s: number, a = 0.05): number {
  const x = Math.max(0, Math.min(1, s));
  const v = 1 / (1 - a);
  if (x < a) return (v * x * x) / (2 * a);
  if (x > 1 - a) return 1 - (v * (1 - x) * (1 - x)) / (2 * a);
  return v * (x - a / 2);
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpAngle = (a: number, b: number, t: number) => (a + angleDelta(a, b) * t + 360) % 360;

/** Meters per CSS pixel → MapLibre zoom (512 px tiles). */
export function zoomForWidth(widthM: number, lat: number, widthPx = REF_W): number {
  return Math.log2((40075016.686 * Math.cos((lat * Math.PI) / 180) * widthPx) / (512 * widthM));
}

/** Moving average over coordinates (keeps endpoints fixed). */
function smoothCoords(c: LngLat[], w: number): LngLat[] {
  if (c.length < 3) return c;
  return c.map((p, i) => {
    if (i === 0 || i === c.length - 1) return p;
    let x = 0, y = 0, n = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(c.length - 1, i + w); k++) { x += c[k][0]; y += c[k][1]; n++; }
    return [x / n, y / n];
  });
}

export function buildFlyoverPlan(points: TrackPoint[]): FlyoverPlan {
  const raw: LngLat[] = points.map((p) => [p.lon, p.lat]);
  const rawCum = cumulativeDistances(raw);
  const total = rawCum[rawCum.length - 1] || 1;

  const spacing = Math.max(3, Math.min(15, total / 1500));
  const coords = smoothCoords(resample(raw, spacing), 3);
  const cum = cumulativeDistances(coords);
  const len = cum[cum.length - 1] || 1;

  const lat = coords[0]?.[1] ?? 0;
  const viewWidthM = Math.max(380, Math.min(1400, total * 0.14));
  const followZoom = Math.max(13.2, Math.min(16.4, zoomForWidth(viewWidthM, lat)));

  // Bearing: look along a chord from slightly behind to well ahead.
  const ahead = Math.max(80, viewWidthM * 0.45);
  const behind = ahead * 0.25;
  const rawBear = coords.map((_, i) => {
    const a = pointAtDistance(coords, cum, Math.max(0, cum[i] - behind)).p;
    const b = pointAtDistance(coords, cum, Math.min(len, cum[i] + ahead)).p;
    return bearing(a, b);
  });
  // Wide circular moving average (≈ ±150 m of route) to remove residual wobble.
  const win = Math.max(2, Math.round(150 / spacing));
  const bearings = rawBear.map((_, i) => {
    const slice = rawBear.slice(Math.max(0, i - win), Math.min(rawBear.length, i + win + 1));
    return circularMean(slice);
  });

  const b = bbox(coords);
  const overviewZoom = fitZoom(b, REF_W, REF_H, 90) - 0.25;
  const overview = { center: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] as LngLat, zoom: overviewZoom, bearing: (bearings[0] + 330) % 360 };

  // Live-stat series on the ORIGINAL track (accurate times/elevations).
  const movingS: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const d = rawCum[i] - rawCum[i - 1];
    const dt = (points[i].t - points[i - 1].t) / 1000;
    movingS.push(movingS[i - 1] + (dt > 0 && dt <= MAX_GAP_S && d / dt >= MOVING_SPEED_MPS ? dt : 0));
  }
  const ele = points.map((p) => (p.ele != null && isFinite(p.ele) ? p.ele : null));
  const pace = rollingPace(points, 200);
  const clockMs = points.map((p) => p.t);

  const profileN = 120;
  const profile: number[] = [];
  const hasEle = ele.some((e) => e != null);
  if (hasEle) {
    for (let k = 0; k < profileN; k++) {
      const d = (total * k) / (profileN - 1);
      const i = lowerIndex(rawCum, d);
      profile.push(ele[i] ?? ele.find((e) => e != null) ?? 0);
    }
  }

  let centerEle: number[] | null = null;
  if (hasEle) {
    const firstEle = ele.find((e) => e != null) ?? 0;
    const sampled = cum.map((d) => {
      const i = lowerIndex(rawCum, (d / len) * total);
      return ele[i] ?? firstEle;
    });
    // Heavy smoothing (≈ ±100 m of route): the camera should glide, not follow every bump.
    const w = Math.max(2, Math.round(100 / spacing));
    centerEle = sampled.map((_, i) => {
      let sum = 0, n = 0;
      for (let k = Math.max(0, i - w); k <= Math.min(sampled.length - 1, i + w); k++) { sum += sampled[k]; n++; }
      return sum / n;
    });
  }
  const overviewEle = centerEle ? centerEle.reduce((a, b) => a + b, 0) / centerEle.length : null;

  return { coords, cum, total: len, bearings, centerEle, followZoom, overview: { ...overview, ele: overviewEle }, track: { cum: rawCum, movingS, ele, pace, clockMs }, profile };
}

/** Smoothed bearing at distance d (interpolated between samples). */
function bearingAt(plan: FlyoverPlan, d: number): number {
  const i = Math.min(lowerIndex(plan.cum, d), plan.bearings.length - 1);
  const j = Math.min(i + 1, plan.bearings.length - 1);
  const seg = plan.cum[j] - plan.cum[i];
  const f = seg > 0 ? (d - plan.cum[i]) / seg : 0;
  return lerpAngle(plan.bearings[i], plan.bearings[j], f);
}

function eleAt(plan: FlyoverPlan, d: number): number | null {
  const e = plan.centerEle;
  if (!e) return null;
  const i = Math.min(lowerIndex(plan.cum, d), e.length - 1);
  const j = Math.min(i + 1, e.length - 1);
  const seg = plan.cum[j] - plan.cum[i];
  return lerp(e[i], e[j], seg > 0 ? (d - plan.cum[i]) / seg : 0);
}

function followCamera(plan: FlyoverPlan, d: number) {
  return { center: pointAtDistance(plan.coords, plan.cum, d).p, zoom: plan.followZoom, pitch: 62, bearing: bearingAt(plan, d), focusOffset: 0.18, elevation: eleAt(plan, d) };
}
const lerpEle = (a: number | null, b: number | null, t: number) => (a != null && b != null ? lerp(a, b, t) : null);

/** Camera for normalised time u. */
export function cameraAt(plan: FlyoverPlan, u: number): CameraState {
  const ov = plan.overview;
  if (u < INTRO) {
    const t = smoothstep(u / INTRO);
    const f = followCamera(plan, 0);
    // Zoom moves in log space naturally; arc slightly higher midway for a "swoop".
    const zoom = lerp(ov.zoom, f.zoom, t) - Math.sin(t * Math.PI) * 0.3;
    return {
      center: [lerp(ov.center[0], f.center[0], t), lerp(ov.center[1], f.center[1], t)],
      zoom, pitch: lerp(35, f.pitch, t), bearing: lerpAngle(ov.bearing, f.bearing, t),
      focusOffset: lerp(0, f.focusOffset, t), elevation: lerpEle(ov.ele, f.elevation, t), distance: 0, phase: 'intro',
    };
  }
  if (u < OUTRO) {
    const s = (u - INTRO) / (OUTRO - INTRO);
    const d = easeEnds(s) * plan.total;
    return { ...followCamera(plan, d), distance: d, phase: 'follow' };
  }
  const t = smoothstep((u - OUTRO) / (1 - OUTRO));
  const f = followCamera(plan, plan.total);
  const endBearing = (f.bearing + 70) % 360;
  return {
    center: [lerp(f.center[0], ov.center[0], t), lerp(f.center[1], ov.center[1], t)],
    zoom: lerp(f.zoom, ov.zoom + 0.15, t), pitch: lerp(f.pitch, 48, t), bearing: lerpAngle(f.bearing, endBearing, t),
    focusOffset: lerp(f.focusOffset, 0, t), elevation: lerpEle(f.elevation, ov.ele, t), distance: plan.total, phase: 'outro',
  };
}

/** Live stats at a distance along the route, interpolated from the source track. */
export function liveStatsAt(plan: FlyoverPlan, distance: number): LiveStats {
  const { cum, movingS, ele, pace, clockMs } = plan.track;
  // Map plan distance (resampled) back onto the original track's distance scale.
  const d = (distance / plan.total) * (cum[cum.length - 1] || 0);
  const i = lowerIndex(cum, d);
  const j = Math.min(i + 1, cum.length - 1);
  const seg = cum[j] - cum[i];
  const f = seg > 0 ? (d - cum[i]) / seg : 0;
  const e0 = ele[i], e1 = ele[j];
  return {
    distanceM: d,
    movingS: lerp(movingS[i], movingS[j], f),
    eleM: e0 != null && e1 != null ? lerp(e0, e1, f) : e0 ?? null,
    paceSPerKm: lerp(pace[i] ?? 0, pace[j] ?? 0, f),
    clockMs: lerp(clockMs[i], clockMs[j], f),
  };
}
