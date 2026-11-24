/**
 * Backup file format and validation. A backup is user-supplied JSON, so nothing
 * in it is trusted: every record is shape-checked and bad ones are skipped
 * rather than written to IndexedDB, where they would crash pages later.
 */
import type { Activity, Goal, OverlayConfig, Route, Settings, Track, TrackPoint } from '../types';

/** Bump when the backup layout changes incompatibly; older files must stay importable. */
export const BACKUP_VERSION = 1;

export interface ParsedBackup {
  version: number;
  activities: Activity[];
  tracks: Track[];
  routes: Route[];
  goals: Goal[];
  /** Only fields with a valid type; device-local fields (statsVersion, lastBackupAt) are dropped. */
  settings: Partial<Settings> | null;
  /** STATS_VERSION the backup's stats were computed with (1 if the file doesn't say). */
  statsVersion: number;
  /** Records that failed validation and were left out. */
  skipped: number;
}

const ACTIVITY_SOURCES = ['gps', 'simulated', 'gpx', 'demo'];
const ROUTE_SOURCES = ['planned', 'discovered', 'gpx', 'activity'];
const GOAL_METRICS = ['distance', 'duration', 'count', 'elevation', 'steps'];
const GOAL_PERIODS = ['day', 'week', 'month', 'year'];

/** String/number fields that must be one of a fixed set (a wrong value would break pickers). */
const ENUMS: Record<string, readonly unknown[]> = {
  units: ['metric', 'imperial'],
  defaultMapStyle: ['outdoor', 'light', 'dark', 'satellite', 'relief'],
  mapStyle: ['outdoor', 'light', 'dark', 'satellite', 'relief'],
  template: ['classic', 'minimal', 'bold'],
  quality: ['1080p', '720p'],
  videoSeconds: [10, 15, 20, 30],
};

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isLngLat = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length >= 2 && isNum(v[0]) && isNum(v[1]) && Math.abs(v[0]) <= 180 && Math.abs(v[1]) <= 90;
const isPath = (v: unknown): v is [number, number][] => Array.isArray(v) && v.every(isLngLat);
const isPair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);

function validActivity(a: unknown): a is Activity {
  if (!isObj(a)) return false;
  const s = a.stats;
  return isStr(a.id) && typeof a.name === 'string' && isNum(a.startedAt) && isNum(a.endedAt)
    && (a.type === 'walk' || a.type === 'hike') && ACTIVITY_SOURCES.includes(a.source)
    && isObj(s) && isNum(s.distanceM) && isNum(s.elapsedS) && isNum(s.movingS)
    && isObj(s.bestEfforts) && Array.isArray(s.splits)
    && Array.isArray(a.bbox) && a.bbox.length === 4 && a.bbox.every(isNum)
    && isPath(a.preview);
}

const validPoint = (p: unknown): p is TrackPoint =>
  isObj(p) && isNum(p.lat) && isNum(p.lon) && isNum(p.t) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180
  && (p.ele == null || isNum(p.ele)) && (p.acc == null || isNum(p.acc));

function validTrack(t: unknown): t is Track {
  return isObj(t) && isStr(t.activityId) && Array.isArray(t.points) && t.points.length >= 2
    && t.points.every(validPoint) && Array.isArray(t.pauses) && t.pauses.every(isPair);
}

function validRoute(r: unknown): r is Route {
  return isObj(r) && isStr(r.id) && typeof r.name === 'string' && isPath(r.waypoints)
    && isPath(r.geometry) && r.geometry.length >= 2 && isNum(r.distanceM)
    && ROUTE_SOURCES.includes(r.source) && isNum(r.createdAt) && isNum(r.updatedAt);
}

function validGoal(g: unknown): g is Goal {
  return isObj(g) && isStr(g.id) && GOAL_METRICS.includes(g.metric) && GOAL_PERIODS.includes(g.period)
    && isNum(g.target) && g.target > 0;
}

/** Keep only keys whose value has the same type as in `defaults`. */
function pickTyped<T extends object>(src: Record<string, any>, defaults: T, skip: string[] = []): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, def] of Object.entries(defaults)) {
    if (skip.includes(k) || !(k in src)) continue;
    const v = src[k];
    const typed = typeof def === 'number' ? isNum(v) : typeof v === typeof def && !isObj(v);
    if (typed && (!ENUMS[k] || ENUMS[k].includes(v))) out[k] = v;
  }
  return out as Partial<T>;
}

function sanitizeSettings(raw: unknown, defaults: Settings): Partial<Settings> | null {
  if (!isObj(raw)) return null;
  const s = pickTyped(raw, defaults, ['id', 'overlay', 'statsVersion', 'lastBackupAt']);
  if (isObj(raw.overlay)) s.overlay = { ...defaults.overlay, ...pickTyped<OverlayConfig>(raw.overlay, defaults.overlay) };
  return s;
}

/** A table must be missing or an array; then keep the valid records. */
function table<T>(data: Record<string, any>, key: string, valid: (v: unknown) => v is T): { ok: T[]; bad: number } {
  const v = data[key];
  if (v == null) return { ok: [], bad: 0 };
  if (!Array.isArray(v)) throw new Error(`This backup file is damaged ("${key}" is not a list).`);
  const ok = v.filter(valid);
  return { ok, bad: v.length - ok.length };
}

/**
 * Parse and validate a backup file. Throws a user-facing message if the file
 * can't be used at all; otherwise returns the valid records and a skip count.
 * Tracks are matched to activities by the caller (it also knows what's in the DB).
 */
export function parseBackup(json: string, defaults: Settings): ParsedBackup {
  let data: unknown;
  try { data = JSON.parse(json); } catch { throw new Error('This file isn’t a valid backup (not JSON).'); }
  if (!isObj(data) || data.app !== 'stride') throw new Error('Not a Stride backup file');
  if (!Number.isInteger(data.version) || data.version < 1) throw new Error('This backup file is damaged (unknown version).');
  if (data.version > BACKUP_VERSION) throw new Error('This backup was made by a newer version of Stride. Update the app, then import it again.');

  const activities = table(data, 'activities', validActivity);
  const tracks = table(data, 'tracks', validTrack);
  const routes = table(data, 'routes', validRoute);
  const goals = table(data, 'goals', validGoal);
  const settingsList = data.settings == null ? [] : data.settings;
  if (!Array.isArray(settingsList)) throw new Error('This backup file is damaged ("settings" is not a list).');
  const rawSettings = settingsList.find((s) => isObj(s) && s.id === 'settings');

  return {
    version: data.version,
    activities: activities.ok,
    tracks: tracks.ok,
    routes: routes.ok,
    goals: goals.ok,
    settings: sanitizeSettings(rawSettings, defaults),
    statsVersion: isObj(rawSettings) && isNum(rawSettings.statsVersion) ? rawSettings.statsVersion : 1,
    skipped: activities.bad + tracks.bad + routes.bad + goals.bad,
  };
}
