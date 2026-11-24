import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_VERSION, parseBackup } from './backup';
import { DEFAULT_SETTINGS, db, exportBackup, findDuplicateActivity, getSettings, importBackup } from './db';
import type { Activity, Track } from '../types';

const T0 = Date.UTC(2026, 0, 1, 8);

function activity(id: string, over: Partial<Activity> = {}): Activity {
  return {
    id, name: `Walk ${id}`, type: 'walk', startedAt: T0, endedAt: T0 + 600_000, source: 'gps',
    stats: {
      distanceM: 800, elapsedS: 600, movingS: 580, avgPaceSPerKm: 725, avgSpeedMps: 1.38, elevGainM: 0, elevLossM: 0,
      minEleM: null, maxEleM: null, estSteps: 1000, estKcal: 40, bestEfforts: {}, splits: [], elevationSource: 'none',
    },
    bbox: [8, 46, 8.01, 46.01], preview: [[8, 46], [8.01, 46.01]], createdAt: T0, updatedAt: T0, ...over,
  };
}
const track = (activityId: string): Track => ({
  activityId, pauses: [], points: [{ lat: 46, lon: 8, t: T0 }, { lat: 46.007, lon: 8, t: T0 + 600_000 }],
});
const file = (body: Record<string, unknown>) => JSON.stringify({ app: 'stride', version: 1, ...body });

describe('parseBackup', () => {
  it('rejects files that are not usable at all', () => {
    expect(() => parseBackup('{oops', DEFAULT_SETTINGS)).toThrow(/not JSON/);
    expect(() => parseBackup(JSON.stringify({ app: 'other' }), DEFAULT_SETTINGS)).toThrow(/Not a Stride backup/);
    expect(() => parseBackup(JSON.stringify({ app: 'stride' }), DEFAULT_SETTINGS)).toThrow(/unknown version/);
    expect(() => parseBackup(file({ version: BACKUP_VERSION + 1 }), DEFAULT_SETTINGS)).toThrow(/newer version/);
    expect(() => parseBackup(file({ activities: {} }), DEFAULT_SETTINGS)).toThrow(/not a list/);
  });

  it('skips malformed records and keeps the rest', () => {
    const r = parseBackup(file({
      activities: [activity('a'), { ...activity('b'), stats: null }, { id: 'c' }, null],
      tracks: [track('a'), { ...track('b'), points: [{ lat: 'x', lon: 8, t: 0 }, { lat: 46, lon: 8, t: 1 }] }],
      routes: [{ id: 'r', name: 'R', waypoints: [], geometry: [[8, 46]], distanceM: 1, source: 'planned', createdAt: 0, updatedAt: 0 }],
      goals: [{ id: 'g', metric: 'distance', period: 'week', target: 20000, createdAt: 0 }, { id: 'h', metric: 'distance', period: 'week', target: -1 }],
    }), DEFAULT_SETTINGS);
    expect(r.activities.map((a) => a.id)).toEqual(['a']);
    expect(r.tracks.map((t) => t.activityId)).toEqual(['a']);
    expect(r.routes).toHaveLength(0); // geometry needs 2+ points
    expect(r.goals.map((g) => g.id)).toEqual(['g']);
    expect(r.skipped).toBe(3 + 1 + 1 + 1);
  });

  it('keeps only well-typed settings and drops device-local fields', () => {
    const r = parseBackup(file({
      settings: [{ id: 'settings', units: 'imperial', weightKg: 'heavy', defaultMapStyle: 'neon', statsVersion: 1, lastBackupAt: 5, overlay: { accent: '#fff', quality: '4k' } }],
    }), DEFAULT_SETTINGS);
    expect(r.settings).toMatchObject({ units: 'imperial', overlay: { accent: '#fff', quality: DEFAULT_SETTINGS.overlay.quality } });
    expect(r.settings).not.toHaveProperty('weightKg');
    expect(r.settings).not.toHaveProperty('defaultMapStyle');
    expect(r.settings).not.toHaveProperty('statsVersion');
    expect(r.settings).not.toHaveProperty('lastBackupAt');
    expect(r.statsVersion).toBe(1);
  });
});

describe('importBackup', () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });

  it('round-trips an exported backup', async () => {
    await db.activities.put(activity('a'));
    await db.tracks.put(track('a'));
    const json = await exportBackup();
    await Promise.all(db.tables.map((t) => t.clear()));
    const r = await importBackup(json);
    expect(r).toMatchObject({ activities: 1, skipped: 0 });
    expect(await db.tracks.get('a')).toBeTruthy();
  });

  it('imports a walk only when it has a track, and drops orphan tracks', async () => {
    await db.tracks.put(track('onDevice'));
    const r = await importBackup(file({
      activities: [activity('withTrack'), activity('onDevice'), activity('noTrack')],
      tracks: [track('withTrack'), track('orphan')],
    }));
    expect(r.activities).toBe(2);
    expect(r.skipped).toBe(2);
    expect((await db.activities.toCollection().primaryKeys()).sort()).toEqual(['onDevice', 'withTrack']);
    expect(await db.tracks.get('orphan')).toBeUndefined();
  });

  it('flags walks whose stats predate the current algorithm', async () => {
    const old = await importBackup(file({ activities: [activity('a')], tracks: [track('a')], settings: [{ id: 'settings', statsVersion: 1 }] }));
    expect(old.staleStats).toBe(true);
  });

  it('merges settings without clobbering local-only fields', async () => {
    await db.settings.put({ ...DEFAULT_SETTINGS, lastBackupAt: 123, statsVersion: 2 });
    await importBackup(file({ settings: [{ id: 'settings', units: 'imperial', lastBackupAt: 1, statsVersion: 1 }] }));
    const s = await getSettings();
    expect(s).toMatchObject({ units: 'imperial', lastBackupAt: 123, statsVersion: 2 });
  });
});

describe('findDuplicateActivity', () => {
  beforeEach(async () => { await db.activities.clear(); });

  it('matches the same walk (start within 2 s, distance within 5%) only', async () => {
    await db.activities.put(activity('a'));
    expect((await findDuplicateActivity(T0 + 1500, 820))?.id).toBe('a');
    expect(await findDuplicateActivity(T0 + 5000, 800)).toBeUndefined();
    expect(await findDuplicateActivity(T0, 1200)).toBeUndefined();
  });
});
