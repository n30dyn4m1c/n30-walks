import { describe, expect, it } from 'vitest';
import { bestEffort, computeStats, elevationGainLoss, segmentContribution, trackTotals, walkingMet } from './stats';
import type { TrackPoint } from '../types';

/** Straight walk north at constant speed, one point per `dt` seconds. */
function walk(meters: number, speed: number, dt = 5, ele?: (d: number) => number): TrackPoint[] {
  const pts: TrackPoint[] = [];
  for (let d = 0, t = 0; d <= meters; d += speed * dt, t += dt * 1000) pts.push({ lat: 46 + d / 111195, lon: 8, t, ...(ele ? { ele: ele(d) } : {}) });
  return pts;
}

describe('stats', () => {
  it('computes distance, moving time and pace', () => {
    const s = computeStats(walk(2000, 1.25), { weightKg: 70, strideM: 0.75 });
    expect(s.distanceM).toBeCloseTo(2000, -1);
    expect(s.movingS).toBeCloseTo(1600, -1);
    expect(s.avgPaceSPerKm).toBeCloseTo(800, -1); // 13:20 /km
    expect(s.splits.length).toBe(2);
    expect(s.splits[0].paceSPerKm).toBeCloseTo(800, -1);
    expect(s.estSteps).toBeCloseTo(2667, -1);
  });

  it('excludes manual pauses from distance and elapsed time', () => {
    const a = walk(1000, 1.25);
    const gapStart = a[a.length - 1].t;
    const b = walk(1000, 1.25).map((p) => ({ ...p, lat: p.lat + 1000 / 111195 + 200 / 111195, t: p.t + gapStart + 600_000 }));
    const s = computeStats([...a, ...b], { weightKg: 70, strideM: 0.75, pauses: [[gapStart, gapStart + 600_000]] });
    // The 200 m moved while paused should not count.
    expect(s.distanceM).toBeCloseTo(2000, -1);
    expect(s.elapsedS).toBeCloseTo(1600, -1);
  });

  it('best effort finds the fastest 1 km inside a longer walk', () => {
    const slow = walk(1000, 1.0);
    const fast = walk(1000, 2.0).map((p) => ({ ...p, lat: p.lat + 1000 / 111195, t: p.t + slow[slow.length - 1].t + 5000 }));
    const s = computeStats([...slow, ...fast], { weightKg: 70, strideM: 0.75 });
    expect(s.bestEfforts['1000']).toBeGreaterThanOrEqual(495);
    expect(s.bestEfforts['1000']).toBeLessThanOrEqual(520);
    expect(s.bestEfforts['5000']).toBeUndefined();
  });

  it('bestEffort returns null when too short', () => {
    expect(bestEffort([0, 100], [0, 60], 1000)).toBeNull();
  });

  it('elevation hysteresis ignores noise but counts real climbs', () => {
    const noisy = Array.from({ length: 200 }, (_, i) => 500 + Math.sin(i) * 1.5);
    expect(elevationGainLoss(noisy, 3).gain).toBe(0);
    const climb = Array.from({ length: 101 }, (_, i) => 500 + i);
    expect(elevationGainLoss(climb, 3).gain).toBeCloseTo(99, 0);
  });

  it('uses DEM elevations for gain', () => {
    const s = computeStats(walk(1000, 1.25, 5, (d) => 600 + d * 0.1), { weightKg: 70, strideM: 0.75, elevationSource: 'dem' });
    expect(s.elevGainM).toBeGreaterThan(90);
    expect(s.elevGainM).toBeLessThan(101);
    expect(s.elevationSource).toBe('dem');
  });

  it('MET rises with speed', () => {
    expect(walkingMet(1.0)).toBeLessThan(walkingMet(1.5));
  });

  it('a GPS signal gap never yields an impossible best effort or pace', () => {
    // 400 m walk, 5 min with no fixes (screen locked) walking 420 m, 400 m walk — all at 1.4 m/s.
    const a = walk(400, 1.4);
    const last = a[a.length - 1];
    const b = walk(400, 1.4).map((p) => ({ ...p, lat: p.lat + 820 / 111195, t: p.t + last.t + 300_000 }));
    const s = computeStats([...a, ...b], { weightKg: 70, strideM: 0.75 });
    expect(s.distanceM).toBeCloseTo(1220, -1);
    // True pace is ~714 s/km. Before the fix: 1 km "in" ~414 s, average ~470 s/km.
    expect(s.avgPaceSPerKm).toBeGreaterThan(690);
    expect(s.bestEfforts['1000']).toBeGreaterThan(690);
    for (const sp of s.splits) expect(sp.durationS).toBeGreaterThan(0);
  });

  it('a long stop with little movement credits only a small moving time', () => {
    const p0 = { lat: 46, lon: 8, t: 0 };
    const p1 = { lat: 46 + 30 / 111195, lon: 8, t: 20 * 60_000 }; // 30 m in 20 min
    const c = segmentContribution(p0, p1, []);
    expect(c.d).toBeCloseTo(30, 0);
    expect(c.moving).toBeCloseTo(100, 0); // 30 m at 0.3 m/s, not 1200 s
  });

  it('clips pauses to the track (finishing while paused)', () => {
    const a = walk(1000, 1.25);
    const last = a[a.length - 1].t;
    const s = computeStats(a, { weightKg: 70, strideM: 0.75, pauses: [[last, last + 600_000]] });
    expect(s.elapsedS).toBeCloseTo(800, -1);
    expect(s.elapsedS).toBeGreaterThanOrEqual(s.movingS);
  });

  it('trackTotals matches computeStats (live and saved stats agree)', () => {
    const a = walk(1000, 1.25);
    const gapStart = a[a.length - 1].t;
    const b = walk(500, 1.25).map((p) => ({ ...p, lat: p.lat + 1200 / 111195, t: p.t + gapStart + 120_000 }));
    const pts = [...a, ...b];
    const pauses: [number, number][] = [[gapStart + 1000, gapStart + 119_000]];
    const s = computeStats(pts, { weightKg: 70, strideM: 0.75, pauses });
    const t = trackTotals(pts, pauses);
    expect(t.distanceM).toBeCloseTo(s.distanceM, 6);
    expect(t.movingS).toBeCloseTo(s.movingS, 6);
  });
});
