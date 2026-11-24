/**
 * Recorder integration tests: the real recorder, filter, stats and Dexie
 * (in-memory IndexedDB), with a hand-driven GPS provider and no network.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawFix } from '../lib/gpsFilter';

// A GPS we drive by hand: tests push fixes with explicit timestamps.
const gps = vi.hoisted(() => ({ onFix: null as null | ((f: RawFix) => void), now: 0 }));
vi.mock('./providers', () => {
  class FakeProvider {
    readonly kind = 'web' as const;
    now() { return gps.now; }
    async start(onFix: (f: RawFix) => void) { gps.onFix = onFix; }
    async stop() { gps.onFix = null; }
  }
  class SimulatedProvider extends FakeProvider {}
  return { createRealProvider: () => new FakeProvider(), SimulatedProvider, isNative: () => false };
});
// No terrain tiles in tests: elevation falls back to GPS / none.
vi.mock('../lib/elevation', () => ({ sampleElevations: async () => null, TERRARIUM_URL: '' }));

const { recorder } = await import('./recorder');
const { db } = await import('../db/db');

const T0 = Date.UTC(2026, 0, 1, 8);
/** Fix `m` metres north of the start, `s` seconds into the walk. */
function fixAt(m: number, s: number): RawFix {
  return { lat: 46 + m / 111195, lon: 8, acc: 5, t: T0 + s * 1000 };
}
/** Walk north at 1.4 m/s, one fix per second, from (m0, s0) for `secs` seconds. */
function walk(m0: number, s0: number, secs: number) {
  for (let i = 1; i <= secs; i++) {
    gps.now = T0 + (s0 + i) * 1000;
    gps.onFix?.(fixAt(m0 + i * 1.4, s0 + i));
  }
}

async function startWalk() {
  gps.now = T0;
  await recorder.acquire();
  gps.onFix?.(fixAt(0, 0));
  await recorder.start();
}

beforeEach(async () => {
  await recorder.discard();
  await Promise.all(db.tables.map((t) => t.clear()));
});
afterEach(() => vi.restoreAllMocks());

describe('recorder', () => {
  it('saved stats match the live stats, including movement while paused', async () => {
    await startWalk();
    walk(0, 0, 300); // 420 m
    gps.now = T0 + 301_000;
    recorder.pause();
    // The walker moves 200 m while paused: must not count, live or saved.
    gps.onFix?.(fixAt(620, 450));
    gps.now = T0 + 450_000;
    recorder.resume();
    walk(620, 450, 300);
    const live = recorder.getState();
    expect(live.distanceM).toBeGreaterThan(780);
    expect(live.distanceM).toBeLessThan(880);

    const id = await recorder.finish();
    expect(id).toBeTruthy();
    const a = (await db.activities.get(id!))!;
    expect(a.stats.distanceM).toBeCloseTo(live.distanceM, 3);
    expect(a.stats.movingS).toBeCloseTo(live.movingS, 3);
    expect(a.stats.elapsedS).toBeGreaterThanOrEqual(a.stats.movingS);
    expect(await db.drafts.get('draft')).toBeUndefined();
  });

  it('keeps the walk (paused, draft intact) when saving fails', async () => {
    await startWalk();
    walk(0, 0, 200);
    vi.spyOn(db.tracks, 'put').mockRejectedValueOnce(new Error('QuotaExceededError'));

    await expect(recorder.finish()).rejects.toThrow('QuotaExceededError');
    expect(recorder.getState().status).toBe('paused');
    const draft = await db.drafts.get('draft');
    expect(draft?.points.length).toBeGreaterThan(10);
    expect(await db.activities.count()).toBe(0);

    // Retry succeeds and only then clears the draft.
    const id = await recorder.finish();
    expect(id).toBeTruthy();
    expect(await db.activities.count()).toBe(1);
    expect(await db.drafts.get('draft')).toBeUndefined();
  });

  it('refuses to start a new walk over an unfinished one', async () => {
    // A draft left behind by a walk interrupted before an app restart.
    const points = [0, 1, 2].map((i) => ({ lat: 46 + i / 1000, lon: 8, t: T0 - 3_600_000 + i * 60_000 }));
    await db.drafts.put({ id: 'draft', startedAt: points[0].t, points, pauses: [], pausedAt: null, source: 'gps', updatedAt: points[2].t });
    await expect(startWalk()).rejects.toThrow(/unfinished walk/i);
    expect((await db.drafts.get('draft'))?.points).toEqual(points);
  });

  it('resumes a draft with its moving time and paused state', async () => {
    await startWalk();
    walk(0, 0, 300);
    gps.now = T0 + 301_000;
    recorder.pause();
    const before = recorder.getState();
    const draft = (await db.drafts.get('draft'))!;
    await recorder.discard();

    await recorder.resumeDraft(draft);
    const after = recorder.getState();
    expect(after.status).toBe('paused');
    expect(after.distanceM).toBeCloseTo(before.distanceM, 3);
    expect(after.movingS).toBeCloseTo(before.movingS, 3);
  });
});
