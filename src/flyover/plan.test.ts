import { describe, expect, it } from 'vitest';
import { buildFlyoverPlan, cameraAt, easeEnds, liveStatsAt, INTRO, OUTRO } from './plan';
import { proceduralLoop, timedWalk } from '../lib/demo';
import { angleDelta } from '../lib/geo';

describe('flyover plan', () => {
  const pts = timedWalk(proceduralLoop([8.03, 46.62], 4000, 5), 0, { seed: 2 }).map((p, i) => ({ ...p, ele: 1000 + i * 0.1 }));
  const plan = buildFlyoverPlan(pts);

  it('easeEnds is monotonic and maps 0→0, 1→1', () => {
    let prev = -1;
    for (let s = 0; s <= 1.0001; s += 0.01) { const v = easeEnds(s); expect(v).toBeGreaterThanOrEqual(prev); prev = v; }
    expect(easeEnds(0)).toBe(0);
    expect(easeEnds(1)).toBeCloseTo(1, 9);
  });

  it('camera distance progresses monotonically through the follow phase', () => {
    let prev = -1;
    for (let i = 0; i <= 300; i++) {
      const c = cameraAt(plan, i / 300);
      expect(c.distance).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = c.distance;
    }
    expect(cameraAt(plan, 0).distance).toBe(0);
    expect(cameraAt(plan, 1).distance).toBeCloseTo(plan.total, 3);
  });

  it('camera is smooth: no large jumps in bearing between 30 fps frames (15 s video)', () => {
    const frames = 450;
    let maxTurn = 0;
    for (let i = 1; i < frames; i++) {
      const a = cameraAt(plan, (i - 1) / (frames - 1));
      const b = cameraAt(plan, i / (frames - 1));
      maxTurn = Math.max(maxTurn, Math.abs(angleDelta(a.bearing, b.bearing)));
    }
    expect(maxTurn).toBeLessThan(6); // degrees per frame
  });

  it('phases are continuous at boundaries', () => {
    const e = 1e-6;
    for (const b of [INTRO, OUTRO]) {
      const x = cameraAt(plan, b - e), y = cameraAt(plan, b + e);
      expect(Math.abs(x.zoom - y.zoom)).toBeLessThan(0.01);
      expect(Math.abs(x.pitch - y.pitch)).toBeLessThan(0.1);
      expect(Math.abs(angleDelta(x.bearing, y.bearing))).toBeLessThan(0.5);
    }
  });

  it('camera centre elevation is supplied and continuous (no terrain-sampling jumps)', () => {
    expect(plan.centerEle).not.toBeNull();
    let maxStep = 0;
    for (let i = 1; i < 450; i++) {
      const a = cameraAt(plan, (i - 1) / 449).elevation!, b = cameraAt(plan, i / 449).elevation!;
      maxStep = Math.max(maxStep, Math.abs(b - a));
    }
    expect(maxStep).toBeLessThan(3); // metres per frame
  });

  it('live stats map distance back to the track', () => {
    const end = liveStatsAt(plan, plan.total);
    expect(end.distanceM).toBeCloseTo(plan.track.cum[plan.track.cum.length - 1], 0);
    expect(liveStatsAt(plan, 0).movingS).toBe(0);
    expect(plan.profile.length).toBe(120);
  });
});
