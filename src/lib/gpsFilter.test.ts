import { describe, expect, it } from 'vitest';
import { GpsFilter } from './gpsFilter';
import { haversine } from './geo';
import { rng, gaussian } from './demo';

describe('GpsFilter', () => {
  it('rejects low-accuracy fixes and teleport glitches', () => {
    const f = new GpsFilter();
    expect(f.push({ lat: 46, lon: 8, t: 0, acc: 5 }).kind).toBe('accepted');
    expect(f.push({ lat: 46.0001, lon: 8, t: 1000, acc: 80 })).toEqual({ kind: 'rejected', reason: 'accuracy' });
    // 1 km in 1 s
    expect(f.push({ lat: 46.009, lon: 8, t: 2000, acc: 5 })).toEqual({ kind: 'rejected', reason: 'speed' });
  });

  it('suppresses stationary jitter (distance does not grow while standing)', () => {
    const f = new GpsFilter();
    const r = rng(3);
    let dist = 0;
    let last: { lat: number; lon: number } | null = null;
    for (let i = 0; i < 300; i++) {
      const res = f.push({ lat: 46 + (gaussian(r) * 4) / 111320, lon: 8 + (gaussian(r) * 4) / 77000, t: i * 1000, acc: 6 });
      if (res.kind === 'accepted') {
        if (last) dist += haversine([last.lon, last.lat], [res.point.lon, res.point.lat]);
        last = res.point;
      }
    }
    // 5 minutes of ±4 m noise. Raw summing would give ~1.5 km; filtered should be tiny.
    expect(dist).toBeLessThan(30);
  });

  it('tracks a straight walk with small distance error', () => {
    const f = new GpsFilter();
    const r = rng(9);
    let dist = 0;
    let last: { lat: number; lon: number } | null = null;
    // 1.4 m/s north for 10 minutes = 840 m, with ±4 m noise
    for (let i = 0; i <= 600; i++) {
      const trueLat = 46 + (1.4 * i) / 111320;
      const res = f.push({ lat: trueLat + (gaussian(r) * 4) / 111320, lon: 8 + (gaussian(r) * 4) / 77000, t: i * 1000, acc: 6 });
      if (res.kind === 'accepted') {
        if (last) dist += haversine([last.lon, last.lat], [res.point.lon, res.point.lat]);
        last = res.point;
      }
    }
    expect(Math.abs(dist - 840) / 840).toBeLessThan(0.04);
  });
});

describe('GpsFilter on a curvy loop', () => {
  it('keeps distance within 5% on a realistic winding walk with 5 m noise', async () => {
    const { proceduralLoop } = await import('./demo');
    const { cumulativeDistances, pointAtDistance } = await import('./geo');
    const path = proceduralLoop([8.03, 46.62], 3000, 11);
    const cum = cumulativeDistances(path);
    const f = new GpsFilter();
    const r = rng(5);
    let dist = 0;
    let last: { lat: number; lon: number } | null = null;
    for (let t = 0, d = 0; d < cum[cum.length - 1]; t++, d += 1.4) {
      const { p } = pointAtDistance(path, cum, d);
      const res = f.push({ lat: p[1] + (gaussian(r) * 5) / 111320, lon: p[0] + (gaussian(r) * 5) / 76500, t: t * 1000, acc: 7 });
      if (res.kind === 'accepted') {
        if (last) dist += haversine([last.lon, last.lat], [res.point.lon, res.point.lat]);
        last = res.point;
      }
    }
    expect(Math.abs(dist - 3000) / 3000).toBeLessThan(0.05);
  });
});

/** Walk a path at 1.4 m/s with noise, feeding the filter; returns emitted points. */
function run(f: GpsFilter, fixes: { lat: number; lon: number; t: number; acc: number }[]) {
  const out: { lat: number; lon: number; t: number }[] = [];
  for (const x of fixes) { const r = f.push(x); if (r.kind === 'accepted') out.push(r.point); }
  return out;
}
const M = 111_320, K = Math.cos((46 * Math.PI) / 180);
/** Local metres → fix. */
const at = (x: number, y: number, t: number, acc = 6) => ({ lat: 46 + y / M, lon: 8 + x / (M * K), t, acc });
const toXY = (p: { lat: number; lon: number }) => [(p.lon - 8) * M * K, (p.lat - 46) * M] as const;
function pathLength(pts: { lat: number; lon: number }[]) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversine([pts[i - 1].lon, pts[i - 1].lat], [pts[i].lon, pts[i].lat]);
  return d;
}

describe('GpsFilter glitch handling', () => {
  it('drops isolated spikes and short bursts of bad fixes (no lines off the track)', () => {
    const f = new GpsFilter();
    const r = rng(21);
    const fixes = [];
    for (let i = 0; i <= 300; i++) {
      let x = gaussian(r) * 3, y = 1.4 * i + gaussian(r) * 3, acc = 6;
      // Spikes: one-off 150 m jump, then a 2-fix burst 200 m east, both with "good" accuracy.
      if (i === 60) { x += 150; acc = 12; }
      if (i === 150 || i === 151) { x += 200; acc = 15; }
      fixes.push(at(x, y, i * 1000, acc));
    }
    const pts = run(f, fixes);
    const maxOff = Math.max(...pts.map((p) => Math.abs(toXY(p)[0])));
    expect(maxOff).toBeLessThan(10);
    expect(Math.abs(pathLength(pts) - 420) / 420).toBeLessThan(0.05);
  });

  it('ignores a coarse first fix far from the real position', () => {
    const f = new GpsFilter();
    const fixes = [at(500, 500, 0, 30), at(500, 500, 1000, 30)];
    for (let i = 2; i < 120; i++) fixes.push(at(0, 1.4 * i, i * 1000, 5));
    const pts = run(f, fixes);
    expect(Math.max(...pts.map((p) => Math.hypot(...toXY(p)) > 0 ? Math.abs(toXY(p)[0]) : 0))).toBeLessThan(10);
  });

  it('re-acquires after a signal gap without a wild extrapolated line', () => {
    const f = new GpsFilter();
    const fixes = [];
    // Walk north, lose signal for 2 min (walker turns east), resume.
    for (let i = 0; i <= 60; i++) fixes.push(at(0, 1.4 * i, i * 1000));
    for (let i = 180; i <= 300; i++) fixes.push(at(1.4 * (i - 120), 84, i * 1000));
    const pts = run(f, fixes);
    // Nothing should be emitted north of the real track (stale velocity would overshoot to y ≈ 250).
    expect(Math.max(...pts.map((p) => toXY(p)[1]))).toBeLessThan(95);
    const last = toXY(pts[pts.length - 1]);
    expect(Math.hypot(last[0] - 1.4 * 180, last[1] - 84)).toBeLessThan(10);
  });

  it('recovers if the track was anchored on a bad fix', () => {
    const f = new GpsFilter();
    const fixes = [at(300, 0, 0, 8)];
    for (let i = 1; i < 60; i++) fixes.push(at(0, 1.4 * i, i * 1000, 5));
    const pts = run(f, fixes);
    const last = toXY(pts[pts.length - 1]);
    expect(Math.hypot(last[0], last[1] - 1.4 * 59)).toBeLessThan(10);
  });

  it('follows sharp corners closely', () => {
    const f = new GpsFilter();
    const r = rng(4);
    // 100 m square walked at 1.4 m/s, ±3 m noise.
    const corner = (s: number): [number, number] => {
      const e = s % 400;
      if (e < 100) return [e, 0];
      if (e < 200) return [100, e - 100];
      if (e < 300) return [300 - e, 100];
      return [0, 400 - e];
    };
    const fixes = [];
    for (let i = 0; i * 1.4 <= 400; i++) { const [x, y] = corner(i * 1.4); fixes.push(at(x + gaussian(r) * 3, y + gaussian(r) * 3, i * 1000, 5)); }
    const pts = run(f, fixes);
    // Distance from each emitted point to the square's outline.
    const off = pts.map((p) => {
      const [x, y] = toXY(p);
      return Math.min(Math.abs(y), Math.abs(x - 100), Math.abs(y - 100), Math.abs(x));
    });
    expect(Math.max(...off)).toBeLessThan(8);
    expect(Math.abs(pathLength(pts) - 400) / 400).toBeLessThan(0.06);
  });
});
