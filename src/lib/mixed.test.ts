/**
 * Mixed journeys (walk → bus → walk): the GPS filter must keep the vehicle
 * stretch, and stats must split it out so pace, steps and PRs cover the
 * on-foot parts only.
 */
import { describe, expect, it } from 'vitest';
import { GpsFilter, filterOptionsFor } from './gpsFilter';
import { classifyModes, computeStats, hasVehicleStretch, liveMode } from './stats';
import { rng, gaussian } from './demo';
import type { TrackPoint } from '../types';

const M_PER_DEG = 111_320;

/** Leg spec: distance (m) at speed (m/s), optionally followed by a stop (s). */
type Leg = { m: number; v: number; stopS?: number };

/** Exact 1 Hz positions heading north through the legs. */
function journey(legs: Leg[]): { lat: number; lon: number; t: number }[] {
  const out: { lat: number; lon: number; t: number }[] = [];
  let d = 0, t = 0;
  out.push({ lat: 46, lon: 8, t: 0 });
  for (const leg of legs) {
    const end = d + leg.m;
    while (d < end) {
      d = Math.min(end, d + leg.v);
      t += 1000;
      out.push({ lat: 46 + d / M_PER_DEG, lon: 8, t });
    }
    for (let s = 0; s < (leg.stopS ?? 0); s++) { t += 1000; out.push({ lat: 46 + d / M_PER_DEG, lon: 8, t }); }
  }
  return out;
}

const WALK_BUS_WALK: Leg[] = [
  { m: 800, v: 1.35, stopS: 240 }, // walk to the stop, wait 4 min
  { m: 2500, v: 11, stopS: 40 }, // bus, a 40 s stop
  { m: 2500, v: 9 }, // bus
  { m: 500, v: 1.35 }, // walk from the stop
];

function filtered(raw: { lat: number; lon: number; t: number }[], mode: 'walk' | 'mixed', seed = 4): TrackPoint[] & { glitches?: number } {
  const f = new GpsFilter(filterOptionsFor(mode));
  const r = rng(seed);
  const pts: TrackPoint[] & { glitches?: number } = [];
  pts.glitches = 0;
  for (const p of raw) {
    const res = f.push({ lat: p.lat + (gaussian(r) * 4) / M_PER_DEG, lon: p.lon + (gaussian(r) * 4) / (M_PER_DEG * 0.69), t: p.t, acc: 6 });
    if (res.kind === 'accepted') pts.push(res.point);
    else if (res.reason === 'speed') pts.glitches!++;
  }
  return pts;
}

const opts = { weightKg: 70, strideM: 0.75 };

describe('mixed journeys', () => {
  it('the walking filter fights a bus ride, the mixed filter follows it', () => {
    const raw = journey(WALK_BUS_WALK);
    const walkOnly = filtered(raw, 'walk');
    const mixed = filtered(raw, 'mixed');
    // The walk filter treats bus fixes as glitches and only catches up in jumps
    // (cutting every corner on a real road); the mixed filter tracks it.
    expect(walkOnly.glitches).toBeGreaterThan(100);
    expect(mixed.glitches).toBeLessThan(20);
    const s = computeStats(mixed, { ...opts, mixed: true });
    expect(Math.abs(s.journey!.distanceM - 6300) / 6300).toBeLessThan(0.04);
  });

  it('splits a noisy walk → bus → walk journey into modes', () => {
    const s = computeStats(filtered(journey(WALK_BUS_WALK), 'mixed'), { ...opts, mixed: true });
    const j = s.journey!;
    expect(Math.abs(j.modes.vehicle.distanceM - 5000) / 5000).toBeLessThan(0.05);
    expect(Math.abs(j.modes.walk.distanceM - 1300) / 1300).toBeLessThan(0.06);
    expect(j.modes.run.distanceM).toBeLessThan(50);
    // On-foot figures exclude the bus.
    expect(s.distanceM).toBeCloseTo(j.modes.walk.distanceM + j.modes.run.distanceM, 3);
    expect(s.estSteps).toBeLessThan(2000);
    expect(s.avgPaceSPerKm).toBeGreaterThan(600); // walking pace, not bus pace
    // No impossible best efforts from the bus.
    expect(s.bestEfforts['1000'] ?? Infinity).toBeGreaterThan(600);
    expect(s.bestEfforts['5000']).toBeUndefined();
  });

  it('classifies walk, run and vehicle on clean data, keeping stops in their stretch', () => {
    const raw = journey([{ m: 600, v: 1.4 }, { m: 1500, v: 3.2 }, { m: 3000, v: 12, stopS: 50 }, { m: 2000, v: 12 }, { m: 400, v: 1.3 }]);
    const modes = classifyModes(raw.map((p) => ({ ...p })));
    const at = (sec: number) => modes[Math.min(modes.length - 1, raw.findIndex((p) => p.t >= sec * 1000))];
    expect(at(200)).toBe('walk');
    expect(at(430 + 200)).toBe('run');
    // During the bus stop (stationary) the mode stays 'vehicle'.
    const stopIdx = raw.findIndex((p, i) => i > 0 && p.t > 500_000 && raw[i - 1].lat === p.lat);
    expect(modes[stopIdx]).toBe('vehicle');
    expect(modes[modes.length - 1]).toBe('walk');
  });

  it('a short burst of speed does not change the mode', () => {
    // 20 s sprint for a bus that's leaving, inside a walk.
    const raw = journey([{ m: 500, v: 1.4 }, { m: 120, v: 6 }, { m: 500, v: 1.4 }]);
    expect(new Set(classifyModes(raw))).toEqual(new Set(['walk']));
    expect(hasVehicleStretch(raw)).toBe(false);
    expect(hasVehicleStretch(journey(WALK_BUS_WALK))).toBe(true);
  });

  it('walk activities keep the old stats (no journey breakdown)', () => {
    const raw = journey([{ m: 1000, v: 1.4 }]);
    const s = computeStats(raw, opts);
    expect(s.journey).toBeUndefined();
    expect(s.distanceM).toBeCloseTo(1000, -1);
  });

  it('climbing on the bus is not counted as climbing', () => {
    const raw = journey(WALK_BUS_WALK).map((p) => ({ ...p, ele: 500 + ((p.lat - 46) * M_PER_DEG > 800 && (p.lat - 46) * M_PER_DEG < 5800 ? ((p.lat - 46) * M_PER_DEG - 800) / 10 : (p.lat - 46) * M_PER_DEG >= 5800 ? 500 : 0) }));
    const s = computeStats(raw, { ...opts, mixed: true, elevationSource: 'dem' });
    expect(s.elevGainM).toBeLessThan(20);
    expect(s.maxEleM).toBeGreaterThan(990);
  });

  it('reports the live mode from recent movement', () => {
    const raw = journey([{ m: 500, v: 1.4 }, { m: 2000, v: 11 }]);
    expect(liveMode(raw)?.mode).toBe('vehicle');
    expect(liveMode(journey([{ m: 500, v: 1.4 }]))?.mode).toBe('walk');
    expect(liveMode(journey([{ m: 500, v: 1.4, stopS: 120 }]))).toBeNull();
  });
});
