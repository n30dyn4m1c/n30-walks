/**
 * Core domain types. Everything persisted lives in IndexedDB (see src/db/db.ts).
 *
 * Design notes:
 *  - Activity summaries and their raw tracks are stored in separate tables so
 *    list / analytics screens never load thousands of GPS points.
 *  - Personal records are DERIVED from per-activity `bestEfforts`, never stored
 *    on their own, so deleting or editing an activity can't leave stale PRs.
 */

export type Units = 'metric' | 'imperial';

/** One filtered GPS fix. Compact field names keep large tracks small. */
export interface TrackPoint {
  lat: number;
  lon: number;
  /** Unix ms timestamp */
  t: number;
  /** Elevation in meters (DEM-corrected when available, else GPS altitude) */
  ele?: number;
  /** Horizontal accuracy (m) reported by the device */
  acc?: number;
}

export type ActivitySource = 'gps' | 'simulated' | 'gpx' | 'demo';

export interface Split {
  /** 1-based index of the split (km or mile) */
  index: number;
  distanceM: number;
  durationS: number;
  paceSPerKm: number;
  elevDeltaM: number;
}

export interface ActivityStats {
  distanceM: number;
  elapsedS: number;
  movingS: number;
  /** Average moving pace, seconds per km (Infinity-safe: 0 when no distance) */
  avgPaceSPerKm: number;
  avgSpeedMps: number;
  elevGainM: number;
  elevLossM: number;
  minEleM: number | null;
  maxEleM: number | null;
  estSteps: number;
  estKcal: number;
  /** Fastest time (s) for standard distances, keyed by meters. */
  bestEfforts: Record<string, number>;
  splits: Split[];
  elevationSource: 'dem' | 'gps' | 'none';
}

export interface Activity {
  id: string;
  name: string;
  type: 'walk' | 'hike';
  startedAt: number;
  endedAt: number;
  source: ActivitySource;
  stats: ActivityStats;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
  /** Simplified path for thumbnails: [lon, lat][] (~80 pts) */
  preview: [number, number][];
  routeId?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Track {
  activityId: string;
  points: TrackPoint[];
  /** Pause intervals [startMs, endMs] (manual pauses) */
  pauses: [number, number][];
}

export interface Route {
  id: string;
  name: string;
  /** User waypoints [lon, lat] */
  waypoints: [number, number][];
  /** Full routed geometry [lon, lat] */
  geometry: [number, number][];
  distanceM: number;
  elevGainM?: number;
  source: 'planned' | 'discovered' | 'gpx' | 'activity';
  /** Whether routing snapped to paths or used straight lines */
  snapped: boolean;
  createdAt: number;
  updatedAt: number;
}

export type GoalMetric = 'distance' | 'duration' | 'count' | 'elevation' | 'steps';
export type GoalPeriod = 'day' | 'week' | 'month' | 'year';

export interface Goal {
  id: string;
  metric: GoalMetric;
  period: GoalPeriod;
  /** meters | seconds | count | meters | steps */
  target: number;
  createdAt: number;
}

export type OverlayTemplate = 'classic' | 'minimal' | 'bold';
export type MapStyleId = 'outdoor' | 'light' | 'dark' | 'satellite' | 'relief';

/** Everything the user can customise about a flyover video / status image. */
export interface OverlayConfig {
  template: OverlayTemplate;
  accent: string;
  routeColor: string;
  mapStyle: MapStyleId;
  title: string;
  showDistance: boolean;
  showDuration: boolean;
  showPace: boolean;
  showElevation: boolean;
  showSteps: boolean;
  showDate: boolean;
  showProfile: boolean;
  /** Video length in seconds (WhatsApp Status max is 60s; we cap at 30) */
  videoSeconds: 10 | 15 | 20 | 30;
  quality: '1080p' | '720p';
  /** Terrain exaggeration for 3D */
  exaggeration: number;
}

export interface Settings {
  id: 'settings';
  units: Units;
  weightKg: number;
  strideM: number;
  defaultMapStyle: MapStyleId;
  overlay: OverlayConfig;
  /** Reject GPS fixes worse than this horizontal accuracy (m) */
  maxAccuracyM: number;
  keepScreenOn: boolean;
  onboarded: boolean;
  /** STATS_VERSION the stored activity stats were computed with (see migrateStats) */
  statsVersion?: number;
  /** When the user last exported a JSON backup (ms) */
  lastBackupAt?: number;
}

/** In-progress recording, persisted continuously for crash recovery. */
export interface RecordingDraft {
  id: 'draft';
  startedAt: number;
  points: TrackPoint[];
  pauses: [number, number][];
  pausedAt: number | null;
  source: ActivitySource;
  routeId?: string;
  updatedAt: number;
}
