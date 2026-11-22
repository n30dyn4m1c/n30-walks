/**
 * Local-first persistence (IndexedDB via Dexie). Works identically in the
 * browser, installed PWA, and Capacitor's native WebView. No server, no
 * account, no social graph — the user's data never leaves the device unless
 * they export it.
 */
import Dexie, { type Table } from 'dexie';
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
  keepScreenOn: true,
  onboarded: false,
};

export async function getSettings(): Promise<Settings> {
  const s = await db.settings.get('settings');
  // Merge so new fields added in later versions get defaults.
  return { ...DEFAULT_SETTINGS, ...s, overlay: { ...DEFAULT_OVERLAY, ...s?.overlay } };
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const cur = await getSettings();
  await db.settings.put({ ...cur, ...patch, id: 'settings' });
}

export async function saveActivity(activity: Activity, track: Track): Promise<void> {
  await db.transaction('rw', db.activities, db.tracks, async () => {
    await db.activities.put(activity);
    await db.tracks.put(track);
  });
}

export async function deleteActivity(id: string): Promise<void> {
  await db.transaction('rw', db.activities, db.tracks, async () => {
    await db.activities.delete(id);
    await db.tracks.delete(id);
  });
}

/** Full JSON backup of all user data (for export / device migration). */
export async function exportBackup(): Promise<string> {
  const [activities, tracks, routes, goals, settings] = await Promise.all([
    db.activities.toArray(), db.tracks.toArray(), db.routes.toArray(), db.goals.toArray(), db.settings.toArray(),
  ]);
  return JSON.stringify({ app: 'stride', version: 1, exportedAt: Date.now(), activities, tracks, routes, goals, settings });
}

export async function importBackup(json: string): Promise<{ activities: number; routes: number }> {
  const data = JSON.parse(json);
  if (data?.app !== 'stride') throw new Error('Not a Stride backup file');
  await db.transaction('rw', [db.activities, db.tracks, db.routes, db.goals, db.settings], async () => {
    await db.activities.bulkPut(data.activities ?? []);
    await db.tracks.bulkPut(data.tracks ?? []);
    await db.routes.bulkPut(data.routes ?? []);
    await db.goals.bulkPut(data.goals ?? []);
    if (data.settings?.length) await db.settings.bulkPut(data.settings);
  });
  return { activities: data.activities?.length ?? 0, routes: data.routes?.length ?? 0 };
}

export async function clearAllData(): Promise<void> {
  await Promise.all([db.activities.clear(), db.tracks.clear(), db.routes.clear(), db.goals.clear(), db.drafts.clear()]);
}
