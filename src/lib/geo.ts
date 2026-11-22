/**
 * Small, dependency-free geodesy helpers. All coordinates are WGS84 degrees.
 * Positions are [lon, lat] (GeoJSON order) unless a function says otherwise.
 */

export type LngLat = [number, number];

const R = 6371008.8; // mean Earth radius (m)
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in meters. */
export function haversine(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing a→b in degrees [0, 360). */
export function bearing(a: LngLat, b: LngLat): number {
  const φ1 = toRad(a[1]);
  const φ2 = toRad(b[1]);
  const Δλ = toRad(b[0] - a[0]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Point at `distM` meters from `origin` along `bearingDeg`. */
export function destination(origin: LngLat, distM: number, bearingDeg: number): LngLat {
  const δ = distM / R;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(origin[1]);
  const λ1 = toRad(origin[0]);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [((toDeg(λ2) + 540) % 360) - 180, toDeg(φ2)];
}

/** Cumulative distance array, same length as coords; first element is 0. */
export function cumulativeDistances(coords: LngLat[]): number[] {
  const out = new Array<number>(coords.length);
  let acc = 0;
  for (let i = 0; i < coords.length; i++) {
    if (i > 0) acc += haversine(coords[i - 1], coords[i]);
    out[i] = acc;
  }
  return out;
}

export function pathLength(coords: LngLat[]): number {
  const c = cumulativeDistances(coords);
  return c.length ? c[c.length - 1] : 0;
}

/** Binary search: largest index i such that arr[i] <= v. */
export function lowerIndex(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  if (hi < 0) return -1;
  if (v <= arr[0]) return 0;
  if (v >= arr[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Interpolate the position at distance `d` along a path, given its cumulative
 * distance array. Returns the point and the segment index it falls on.
 */
export function pointAtDistance(coords: LngLat[], cum: number[], d: number): { p: LngLat; i: number; f: number } {
  if (coords.length === 0) return { p: [0, 0], i: 0, f: 0 };
  if (coords.length === 1) return { p: coords[0], i: 0, f: 0 };
  const i = Math.min(lowerIndex(cum, d), coords.length - 2);
  const segLen = cum[i + 1] - cum[i];
  const f = segLen > 0 ? Math.max(0, Math.min(1, (d - cum[i]) / segLen)) : 0;
  const a = coords[i];
  const b = coords[i + 1];
  return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], i, f };
}

/** Sub-path from start to distance `d` (inclusive of the interpolated tip). */
export function sliceToDistance(coords: LngLat[], cum: number[], d: number): LngLat[] {
  if (coords.length < 2) return coords.slice();
  const { p, i } = pointAtDistance(coords, cum, d);
  const out = coords.slice(0, i + 1);
  out.push(p);
  return out;
}

export function bbox(coords: LngLat[]): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of coords) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  if (!isFinite(w)) return [0, 0, 0, 0];
  return [w, s, e, n];
}

/** Perpendicular distance (m) from p to segment a-b using a local equirectangular projection. */
function segDistance(p: LngLat, a: LngLat, b: LngLat): number {
  const k = Math.cos(toRad(p[1]));
  const ax = (a[0] - p[0]) * k, ay = a[1] - p[1];
  const bx = (b[0] - p[0]) * k, by = b[1] - p[1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return toRad(Math.sqrt(cx * cx + cy * cy)) * R;
}

/** Douglas–Peucker simplification with tolerance in meters (iterative, stack-safe). */
export function simplify(coords: LngLat[], tolM: number): LngLat[] {
  if (coords.length <= 2) return coords.slice();
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack: [number, number][] = [[0, coords.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDistance(coords[i], coords[s], coords[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx >= 0 && maxD > tolM) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

/** Simplify until at most `maxPoints` remain (doubling tolerance). */
export function simplifyToCount(coords: LngLat[], maxPoints: number): LngLat[] {
  let tol = 2;
  let out = coords;
  while (out.length > maxPoints && tol < 5000) {
    out = simplify(coords, tol);
    tol *= 2;
  }
  return out;
}

/**
 * Resample a path at a fixed spacing (m). Useful for smooth camera paths and
 * evenly spaced elevation sampling.
 */
export function resample(coords: LngLat[], spacingM: number): LngLat[] {
  if (coords.length < 2) return coords.slice();
  const cum = cumulativeDistances(coords);
  const total = cum[cum.length - 1];
  const n = Math.max(2, Math.ceil(total / spacingM) + 1);
  const out: LngLat[] = [];
  for (let k = 0; k < n; k++) out.push(pointAtDistance(coords, cum, (total * k) / (n - 1)).p);
  return out;
}

/** Shortest signed angular difference b - a in degrees, in (-180, 180]. */
export function angleDelta(a: number, b: number): number {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/** Circular mean of angles (deg), optionally weighted. */
export function circularMean(angles: number[], weights?: number[]): number {
  let x = 0, y = 0;
  angles.forEach((a, i) => {
    const w = weights ? weights[i] : 1;
    x += Math.cos(toRad(a)) * w;
    y += Math.sin(toRad(a)) * w;
  });
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Zoom level that fits a bbox into a viewport (Web Mercator, 512px tiles as MapLibre uses). */
export function fitZoom(b: [number, number, number, number], widthPx: number, heightPx: number, paddingPx = 40): number {
  const [w, s, e, n] = b;
  const merc = (lat: number) => Math.log(Math.tan(Math.PI / 4 + toRad(lat) / 2));
  const dx = Math.max(1e-9, (e - w) / 360);
  const dy = Math.max(1e-9, (merc(n) - merc(s)) / (2 * Math.PI));
  const zx = Math.log2((widthPx - 2 * paddingPx) / 512 / dx);
  const zy = Math.log2((heightPx - 2 * paddingPx) / 512 / dy);
  return Math.max(1, Math.min(18, Math.min(zx, zy)));
}
