import { describe, expect, it } from 'vitest';
import { angleDelta, bearing, circularMean, cumulativeDistances, destination, haversine, pointAtDistance, resample, simplify, sliceToDistance, type LngLat } from './geo';

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
});
