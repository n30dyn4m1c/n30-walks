import { describe, expect, it } from 'vitest';
import { angleDelta, bearing, circularMean, cumulativeDistances, destination, haversine, nearestOnPath, pointAtDistance, resample, simplify, sliceToDistance, type LngLat } from './geo';

describe('geo', () => {
  it('haversine ~ 111.2 km per degree of latitude', () => {
    expect(haversine([0, 0], [0, 1])).toBeCloseTo(111195, -1);
  });
  it('destination/bearing round-trip', () => {
    const o: LngLat = [8.03, 46.62];
    const d = destination(o, 1000, 63);
    expect(haversine(o, d)).toBeCloseTo(1000, 0);
    expect(bearing(o, d)).toBeCloseTo(63, 0);
  });
  it('pointAtDistance interpolates along the path', () => {
    const path: LngLat[] = [[0, 0], [0, 0.01], [0.01, 0.01]];
    const cum = cumulativeDistances(path);
    const mid = pointAtDistance(path, cum, cum[1] / 2).p;
    expect(mid[1]).toBeCloseTo(0.005, 6);
    expect(sliceToDistance(path, cum, cum[2]).length).toBe(3);
  });
  it('simplify keeps endpoints and drops collinear points', () => {
    const line: LngLat[] = Array.from({ length: 50 }, (_, i) => [i * 0.0001, 0]);
    const s = simplify(line, 1);
    expect(s).toEqual([line[0], line[49]]);
  });
  it('resample yields evenly spaced points', () => {
    const r = resample([[0, 0], [0, 0.01]], 100);
    const c = cumulativeDistances(r);
    const gaps = c.slice(1).map((v, i) => v - c[i]);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(0.5);
  });
  it('angle helpers wrap correctly', () => {
    expect(angleDelta(350, 10)).toBe(20);
    expect(angleDelta(10, 350)).toBe(-20);
    expect(circularMean([350, 10])).toBeCloseTo(0, 5);
  });

  it('nearestOnPath: distance off the line and along it', () => {
    const start: LngLat = [0, 0];
    const line = [start, destination(start, 1000, 90)];
    const cum = cumulativeDistances(line);
    const p = destination(destination(start, 400, 90), 30, 0); // 400 m along, 30 m north
    const r = nearestOnPath(line, cum, p);
    expect(r.alongM).toBeCloseTo(400, -1);
    expect(r.offM).toBeCloseTo(30, 0);
  });
  it('nearestOnPath: on a loop, the hint picks the start or the end pass', () => {
    const a: LngLat = [0, 0];
    const b = destination(a, 500, 90), c = destination(b, 500, 0), d = destination(a, 500, 0);
    const loop = [a, b, c, d, a];
    const cum = cumulativeDistances(loop);
    const near = destination(a, 5, 45);
    expect(nearestOnPath(loop, cum, near, 0).alongM).toBeLessThan(50);
    expect(nearestOnPath(loop, cum, near, 1900).alongM).toBeGreaterThan(1950);
  });
});
