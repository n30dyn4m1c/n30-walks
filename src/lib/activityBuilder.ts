/**
 * Turns a finished set of track points into a persisted Activity + Track:
 * DEM elevation correction → stats → bbox/preview → save.
 */
import type { Activity, ActivitySource, Settings, Track, TrackPoint } from '../types';
import { bbox, simplifyToCount } from './geo';
import { computeStats, toLngLat, STATS_VERSION } from './stats';
import { sampleElevations } from './elevation';
import { defaultWalkName, uid, M_PER_MI } from './format';
import { db, getSettings, saveActivity, updateSettings } from '../db/db';
import { proceduralLoop, timedWalk, DEMO_START } from './demo';
import { destination } from './geo';
import { GpsFilter } from './gpsFilter';

export async function withDemElevation(points: TrackPoint[]): Promise<{ points: TrackPoint[]; source: 'dem' | 'gps' | 'none' }> {
  const dem = await sampleElevations(toLngLat(points));
  if (dem) return { points: points.map((p, i) => ({ ...p, ele: dem[i] })), source: 'dem' };
  const hasGps = points.filter((p) => p.ele != null).length > points.length / 2;
  return { points, source: hasGps ? 'gps' : 'none' };
}

export interface BuildOptions {
  settings: Settings;
  source: ActivitySource;
  pauses?: [number, number][];
  name?: string;
  routeId?: string;
  id?: string;
  /** Delete the recording draft in the same transaction as the save. */
  clearDraft?: boolean;
}

export async function buildAndSaveActivity(rawPoints: TrackPoint[], opts: BuildOptions): Promise<Activity> {
  if (rawPoints.length < 2) throw new Error('Not enough GPS points to save this walk.');
  const { points, source: elevationSource } = await withDemElevation(rawPoints);
  const stats = computeStats(points, {
    weightKg: opts.settings.weightKg,
    strideM: opts.settings.strideM,
    pauses: opts.pauses,
    elevationSource,
    splitM: opts.settings.units === 'imperial' ? M_PER_MI : 1000,
  });
  const coords = toLngLat(points);
  const now = Date.now();
  const activity: Activity = {
    id: opts.id ?? uid(),
    name: opts.name ?? defaultWalkName(points[0].t),
    type: stats.elevGainM > 150 ? 'hike' : 'walk',
    startedAt: points[0].t,
    endedAt: points[points.length - 1].t,
    source: opts.source,
    stats,
    bbox: bbox(coords),
    preview: simplifyToCount(coords, 80).map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)] as [number, number]),
    routeId: opts.routeId,
    createdAt: now,
    updatedAt: now,
  };
  const track: Track = { activityId: activity.id, points, pauses: opts.pauses ?? [] };
  await saveActivity(activity, track, { clearDraft: opts.clearDraft });
  return activity;
}

/** Recompute stats (e.g. after units/weight change) from the stored track. */
export function recomputeStats(activity: Activity, track: Track, settings: Settings, elevationSource?: 'dem'): Activity {
  const stats = computeStats(track.points, {
    weightKg: settings.weightKg, strideM: settings.strideM, pauses: track.pauses,
    elevationSource: elevationSource ?? (activity.stats.elevationSource === 'dem' ? 'dem' : undefined),
    splitM: settings.units === 'imperial' ? M_PER_MI : 1000,
  });
  return { ...activity, stats, type: stats.elevGainM > 150 ? 'hike' : activity.type, updatedAt: Date.now() };
}

/** Recompute every stored activity in one transaction (units/weight change, algorithm update). */
export async function recomputeAllActivities(settings?: Settings): Promise<number> {
  const s = settings ?? (await getSettings());
  return db.transaction('rw', db.activities, db.tracks, async () => {
    const [acts, tracks] = await Promise.all([db.activities.toArray(), db.tracks.toArray()]);
    const byId = new Map(tracks.map((t) => [t.activityId, t]));
    const next = acts.flatMap((a) => { const t = byId.get(a.id); return t ? [recomputeStats(a, t, s)] : []; });
    await db.activities.bulkPut(next);
    return next.length;
  });
}

/**
 * Stored stats are derived data. When the algorithm changes (STATS_VERSION),
 * recompute them once so old walks pick up fixes — e.g. impossible best
 * efforts from GPS gaps disappear from personal records.
 */
export async function migrateStats(): Promise<void> {
  const settings = await getSettings();
  if ((settings.statsVersion ?? 1) >= STATS_VERSION) return;
  await recomputeAllActivities(settings);
  await updateSettings({ statsVersion: STATS_VERSION });
}

const enriching = new Set<string>();

/**
 * Walks are saved straight away even if the terrain model can't be reached
 * (offline at the end of a hike). This fills in DEM elevation afterwards and
 * recomputes the stats so elevation gain, profile and splits stay consistent.
 * Returns true if the activity was updated.
 */
export async function enrichElevation(activityId: string): Promise<boolean> {
  if (enriching.has(activityId)) return false;
  enriching.add(activityId);
  try {
    const [activity, track] = await Promise.all([db.activities.get(activityId), db.tracks.get(activityId)]);
    if (!activity || !track || activity.stats.elevationSource === 'dem' || track.points.length < 2) return false;
    const r = await withDemElevation(track.points);
    if (r.source !== 'dem') return false;
    const settings = await getSettings();
    const nextTrack: Track = { ...track, points: r.points };
    const next = recomputeStats(activity, nextTrack, settings, 'dem');
    await db.transaction('rw', db.activities, db.tracks, async () => {
      // Don't clobber edits (name, notes) made while we were fetching tiles.
      const cur = await db.activities.get(activityId);
      if (!cur) return;
      await db.tracks.put(nextTrack);
      await db.activities.put({ ...cur, stats: next.stats, type: next.type, updatedAt: Date.now() });
    });
    return true;
  } finally {
    enriching.delete(activityId);
  }
}

/**
 * Seed ~3 weeks of realistic demo walks so history, PRs, goals and analytics
 * have something to show on first run. Clearly labelled source: 'demo'.
 */
export async function seedDemoData(settings: Settings, center = DEMO_START): Promise<number> {
  const plans = [
    { daysAgo: 1, km: 5.2, speed: 1.55 }, { daysAgo: 2, km: 3.1, speed: 1.4 }, { daysAgo: 4, km: 7.4, speed: 1.35 },
    { daysAgo: 6, km: 4.0, speed: 1.6 }, { daysAgo: 8, km: 2.6, speed: 1.3 }, { daysAgo: 10, km: 6.1, speed: 1.45 },
    { daysAgo: 13, km: 10.3, speed: 1.4 }, { daysAgo: 16, km: 3.6, speed: 1.5 }, { daysAgo: 19, km: 5.0, speed: 1.42 },
  ];
  let i = 0;
  for (const p of plans) {
    i++;
    const start = destination(center, 300 * (i % 4), i * 70);
    const path = proceduralLoop(start, p.km * 1000, i * 13);
    const day = new Date();
    day.setDate(day.getDate() - p.daysAgo);
    day.setHours(7 + ((i * 5) % 12), (i * 17) % 60, 0, 0);
    const raw = timedWalk(path, day.getTime(), { speedMps: p.speed, seed: i, stop: i % 3 === 0 });
    // Run the demo through the same filter as live GPS so it behaves identically.
    const f = new GpsFilter();
    const pts: TrackPoint[] = [];
    for (const r of raw) { const res = f.push({ lat: r.lat, lon: r.lon, t: r.t, acc: r.acc ?? 5 }); if (res.kind === 'accepted') pts.push(res.point); }
    await buildAndSaveActivity(pts, { settings, source: 'demo', name: `${defaultWalkName(day.getTime())} (demo)` });
  }
  return plans.length;
}
