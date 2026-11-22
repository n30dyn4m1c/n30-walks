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
