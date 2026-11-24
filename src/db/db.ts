/**
 * Local-first persistence (IndexedDB via Dexie). Works identically in the
 * browser, installed PWA, and Capacitor's native WebView. No server, no
 * account, no social graph — the user's data never leaves the device unless
 * they export it.
 */
import Dexie, { type Table } from 'dexie';
import { Capacitor } from '@capacitor/core';
import { BACKUP_VERSION, parseBackup } from './backup';
import { STATS_VERSION } from '../lib/stats';
import type { Activity, Goal, OverlayConfig, RecordingDraft, Route, Settings, Track } from '../types';

export class StrideDB extends Dexie {
  activities!: Table<Activity, string>;
  tracks!: Table<Track, string>;
  routes!: Table<Route, string>;
  goals!: Table<Goal, string>;
  settings!: Table<Settings, string>;
  drafts!: Table<RecordingDraft, string>;

  constructor() {
    super('stride');
    this.version(1).stores({
      activities: 'id, startedAt',
      tracks: 'activityId',
      routes: 'id, updatedAt',
      goals: 'id',
      settings: 'id',
      drafts: 'id',
    });
  }
}

export const db = new StrideDB();

export const DEFAULT_OVERLAY: OverlayConfig = {
  template: 'classic',
  accent: '#b8f34a',
  routeColor: '#ff5a36',
  mapStyle: 'outdoor',
  title: '',
  showDistance: true,
  showDuration: true,
  showPace: true,
  showElevation: true,
  showSteps: false,
  showDate: true,
  showProfile: true,
  videoSeconds: 15,
  quality: '1080p',
  exaggeration: 1.5,
};

export const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  units: 'metric',
  weightKg: 70,
  strideM: 0.75,
  defaultMapStyle: 'outdoor',
  overlay: DEFAULT_OVERLAY,
  maxAccuracyM: 35,
  // Native builds track with the screen off (foreground service); only the web needs the screen on.
  keepScreenOn: !Capacitor.isNativePlatform(),
  onboarded: false,
};

export async function getSettings(): Promise<Settings> {
  const s = await db.settings.get('settings');
  // Merge so new fields added in later versions get defaults.
  return { ...DEFAULT_SETTINGS, ...s, overlay: { ...DEFAULT_OVERLAY, ...s?.overlay } };
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  // One transaction so two quick updates can't read the same old value and overwrite each other.
  await db.transaction('rw', db.settings, async () => {
    const cur = await getSettings();
    await db.settings.put({ ...cur, ...patch, id: 'settings' });
  });
}

/**
 * Save an activity and its track. With `clearDraft`, the crash-recovery draft is
 * deleted in the SAME transaction: either the walk is saved and the draft is
 * gone, or nothing changed and the draft is still there to retry from.
 */
export async function saveActivity(activity: Activity, track: Track, opts: { clearDraft?: boolean } = {}): Promise<void> {
  await db.transaction('rw', [db.activities, db.tracks, db.drafts], async () => {
    await db.activities.put(activity);
    await db.tracks.put(track);
    if (opts.clearDraft) await db.drafts.delete('draft');
  });
}

export type StorageProtection = 'persistent' | 'best-effort' | 'unknown';

/**
 * Ask the browser not to evict our IndexedDB under storage pressure (or, in
 * Safari, after 7 days without a visit). All walks live only here, so this
 * matters. Some browsers grant silently, Firefox asks the user.
 */
export async function requestPersistentStorage(): Promise<StorageProtection> {
  try {
    if (!navigator.storage?.persist) return 'unknown';
    if (await navigator.storage.persisted()) return 'persistent';
    return (await navigator.storage.persist()) ? 'persistent' : 'best-effort';
  } catch {
    return 'unknown';
  }
}

export async function storageProtection(): Promise<StorageProtection> {
  try {
    if (!navigator.storage?.persisted) return 'unknown';
    return (await navigator.storage.persisted()) ? 'persistent' : 'best-effort';
  } catch {
    return 'unknown';
  }
}

export async function deleteActivity(id: string): Promise<void> {
  await db.transaction('rw', db.activities, db.tracks, async () => {
    await db.activities.delete(id);
    await db.tracks.delete(id);
  });
}

/**
 * An already-saved walk that is the same recording as one being imported:
 * it starts within 2 s and its distance is within 5% (DEM/filtering can shift it a little).
 */
export async function findDuplicateActivity(startedAt: number, distanceM: number): Promise<Activity | undefined> {
  const near = await db.activities.where('startedAt').between(startedAt - 2000, startedAt + 2000, true, true).toArray();
  return near.find((a) => Math.abs(a.stats.distanceM - distanceM) <= Math.max(25, distanceM * 0.05));
}

/** Delete every walk (and its track) recorded from one of `sources`, e.g. demo walks. */
export async function deleteActivitiesBySource(sources: Activity['source'][]): Promise<number> {
  return db.transaction('rw', db.activities, db.tracks, async () => {
    const ids = (await db.activities.filter((a) => sources.includes(a.source)).primaryKeys()) as string[];
    await db.activities.bulkDelete(ids);
    await db.tracks.bulkDelete(ids);
    return ids.length;
  });
}

/** Full JSON backup of all user data (for export / device migration). */
export async function exportBackup(): Promise<string> {
  const [activities, tracks, routes, goals, settings] = await Promise.all([
    db.activities.toArray(), db.tracks.toArray(), db.routes.toArray(), db.goals.toArray(), db.settings.toArray(),
  ]);
  return JSON.stringify({ app: 'stride', version: BACKUP_VERSION, exportedAt: Date.now(), activities, tracks, routes, goals, settings });
}

export interface ImportResult {
  activities: number;
  routes: number;
  goals: number;
  /** Records left out because they were malformed or had no track. */
  skipped: number;
  /** True when the imported walks' stats predate the current STATS_VERSION and should be recomputed. */
  staleStats: boolean;
}

/**
 * Import a backup file. Everything is validated first (see parseBackup); a walk
 * is only imported with a usable track (from the file, or already on this device),
 * and tracks without a walk are dropped, so pages never meet half a record.
 */
export async function importBackup(json: string): Promise<ImportResult> {
  const data = parseBackup(json, DEFAULT_SETTINGS);
  return db.transaction('rw', [db.activities, db.tracks, db.routes, db.goals, db.settings], async () => {
    const fileTracks = new Map(data.tracks.map((t) => [t.activityId, t]));
    const missing = data.activities.filter((a) => !fileTracks.has(a.id)).map((a) => a.id);
    const onDevice = new Set((await db.tracks.bulkGet(missing)).flatMap((t) => (t ? [t.activityId] : [])));
    const activities = data.activities.filter((a) => fileTracks.has(a.id) || onDevice.has(a.id));
    const keep = new Set(activities.map((a) => a.id));
    const tracks = data.tracks.filter((t) => keep.has(t.activityId));

    await db.activities.bulkPut(activities);
    await db.tracks.bulkPut(tracks);
    await db.routes.bulkPut(data.routes);
    await db.goals.bulkPut(data.goals);
    if (data.settings) {
      const cur = await getSettings();
      await db.settings.put({ ...cur, ...data.settings, overlay: { ...cur.overlay, ...data.settings.overlay }, id: 'settings' });
    }
    return {
      activities: activities.length,
      routes: data.routes.length,
      goals: data.goals.length,
      skipped: data.skipped + (data.activities.length - activities.length) + (data.tracks.length - tracks.length),
      staleStats: activities.length > 0 && data.statsVersion < STATS_VERSION,
    };
  });
}

export async function clearAllData(): Promise<void> {
  await Promise.all([db.activities.clear(), db.tracks.clear(), db.routes.clear(), db.goals.clear(), db.drafts.clear()]);
}
