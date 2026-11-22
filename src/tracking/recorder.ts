/**
 * Recording state machine (a tiny observable store, no framework needed).
 *
 *   idle ──acquire()──▶ acquiring ──start()──▶ recording ⇄ paused
 *                                                 └──finish()──▶ saved Activity
 *
 * - Every accepted fix is appended to an IndexedDB draft (throttled) so a
 *   crash, reload or OS kill never loses a walk; see `recoverDraft()`.
 * - Live distance / moving time are computed incrementally; the final saved
 *   stats are recomputed from scratch (with DEM elevation) in activityBuilder.
 * - Screen Wake Lock keeps the browser from sleeping (web GPS stops when the
 *   page is hidden on most mobile browsers; native builds don't need it).
 */
import { useSyncExternalStore } from 'react';
import { GpsFilter, type RawFix } from '../lib/gpsFilter';
import { haversine, type LngLat } from '../lib/geo';
import { MAX_GAP_S, MOVING_SPEED_MPS } from '../lib/stats';
import { db, getSettings } from '../db/db';
import { buildAndSaveActivity } from '../lib/activityBuilder';
import type { ActivitySource, RecordingDraft, TrackPoint } from '../types';
import { createRealProvider, SimulatedProvider, type LocationProvider, type ProviderError } from './providers';

export type RecorderStatus = 'idle' | 'acquiring' | 'recording' | 'paused' | 'saving';

export interface RecorderState {
  status: RecorderStatus;
  source: ActivitySource;
  startedAt: number | null;
  points: TrackPoint[];
  pauses: [number, number][];
  pausedAt: number | null;
  /** Latest raw fix (for "you are here" + accuracy indicator), even if filtered out */
  lastFix: RawFix | null;
  distanceM: number;
  movingS: number;
  /** Rolling pace over the last ~200 m (s/km) */
  currentPace: number;
  now: number;
  error: ProviderError | null;
  routeId?: string;
  rejected: number;
  autoPaused: boolean;
}

const initial: RecorderState = {
  status: 'idle', source: 'gps', startedAt: null, points: [], pauses: [], pausedAt: null,
  lastFix: null, distanceM: 0, movingS: 0, currentPace: 0, now: Date.now(), error: null, rejected: 0, autoPaused: false,
};

class Recorder {
  private state: RecorderState = initial;
  private listeners = new Set<() => void>();
  private provider: LocationProvider | null = null;
  private filter = new GpsFilter();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private lastDraftSave = 0;
  private wakeLock: WakeLockSentinel | null = null;

  getState = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  private set(patch: Partial<RecorderState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  get simulated(): SimulatedProvider | null {
    return this.provider instanceof SimulatedProvider ? this.provider : null;
  }

  /** Start the GPS (without recording) so the user sees their position & signal first. */
  async acquire(opts: { simulatePath?: LngLat[]; speedup?: number; routeId?: string } = {}) {
    await this.stopProvider();
    const settings = await getSettings();
    this.filter = new GpsFilter({ maxAccuracyM: settings.maxAccuracyM });
    this.provider = opts.simulatePath ? new SimulatedProvider(opts.simulatePath, opts.speedup ?? 10) : createRealProvider();
    if (this.provider instanceof SimulatedProvider) this.provider.holdPosition = true;
    this.set({ ...initial, status: 'acquiring', source: opts.simulatePath ? 'simulated' : 'gps', routeId: opts.routeId, now: this.provider.now() });
    await this.provider.start(this.onFix, (error) => this.set({ error }));
    this.startTicker();
  }

  async start(opts: { routeId?: string } = {}) {
    if (!this.provider) await this.acquire(opts);
    const now = this.provider!.now();
    if (this.simulated) this.simulated.holdPosition = false;
    this.filter.reset(false);
    this.set({ status: 'recording', startedAt: now, points: [], pauses: [], distanceM: 0, movingS: 0, error: null, routeId: opts.routeId ?? this.state.routeId });
    // Seed with the current fix so the walk starts exactly where the user is.
    const f = this.state.lastFix;
    if (f && now - f.t < 10_000) this.onFix({ ...f, t: now });
    this.requestWakeLock();
    await this.saveDraft(true);
  }

  pause() {
    if (this.state.status !== 'recording') return;
    if (this.simulated) this.simulated.holdPosition = true;
    this.set({ status: 'paused', pausedAt: this.provider!.now() });
    this.saveDraft(true);
  }

  resume() {
    if (this.state.status !== 'paused' || this.state.pausedAt == null) return;
    const now = this.provider!.now();
    if (this.simulated) this.simulated.holdPosition = false;
    this.filter.reset();
    this.set({ status: 'recording', pauses: [...this.state.pauses, [this.state.pausedAt, now]], pausedAt: null });
    this.saveDraft(true);
  }

  /** Finish and persist. Returns the new activity id, or null if too short. */
  async finish(): Promise<string | null> {
    const s = this.state;
    const now = this.provider?.now() ?? Date.now();
    const pauses = s.pausedAt != null ? [...s.pauses, [s.pausedAt, now] as [number, number]] : s.pauses;
    this.set({ status: 'saving' });
    await this.stopProvider();
    try {
      if (s.points.length < 2) return null;
      const settings = await getSettings();
      const a = await buildAndSaveActivity(s.points, { settings, source: s.source, pauses, routeId: s.routeId });
      return a.id;
    } finally {
      await db.drafts.delete('draft');
      this.set({ ...initial });
    }
  }

  async discard() {
    await this.stopProvider();
    await db.drafts.delete('draft');
    this.set({ ...initial });
  }

  /** Stop GPS without recording (e.g. leaving the record screen while acquiring). */
  async cancelAcquire() {
    if (this.state.status === 'acquiring') { await this.stopProvider(); this.set({ ...initial }); }
  }

  /** Resume an interrupted recording from the persisted draft (real GPS only). */
  async resumeDraft(draft: RecordingDraft) {
    await this.acquire({ routeId: draft.routeId });
    const distance = draft.points.reduce((acc, p, i) => (i ? acc + haversine([draft.points[i - 1].lon, draft.points[i - 1].lat], [p.lon, p.lat]) : 0), 0);
    // The gap while the app was dead is recorded as a pause.
    const last = draft.points[draft.points.length - 1]?.t ?? draft.updatedAt;
    const pauses: [number, number][] = [...draft.pauses, [last, Date.now()]];
    this.set({ status: 'recording', startedAt: draft.startedAt, points: draft.points, pauses, distanceM: distance, source: draft.source === 'simulated' ? 'gps' : draft.source });
    this.requestWakeLock();
  }

  async saveDraftAsActivity(draft: RecordingDraft): Promise<string | null> {
    await db.drafts.delete('draft');
    if (draft.points.length < 2) return null;
    const settings = await getSettings();
    const a = await buildAndSaveActivity(draft.points, { settings, source: draft.source, pauses: draft.pauses, routeId: draft.routeId });
    return a.id;
  }

  // ---------------- internals ----------------

  private onFix = (fix: RawFix) => {
    const s = this.state;
    const patch: Partial<RecorderState> = { lastFix: fix, error: null };
    if (s.status === 'recording') {
      const res = this.filter.push(fix);
      if (res.kind === 'accepted') {
        const pts = [...s.points, res.point];
        const prev = s.points[s.points.length - 1];
        let { distanceM, movingS } = s;
        if (prev) {
          const d = haversine([prev.lon, prev.lat], [res.point.lon, res.point.lat]);
          const dt = (res.point.t - prev.t) / 1000;
          distanceM += d;
          if (dt > 0 && dt <= MAX_GAP_S && d / dt >= MOVING_SPEED_MPS) movingS += dt;
        }
        Object.assign(patch, { points: pts, distanceM, movingS, currentPace: this.recentPace(pts) });
      } else if (res.reason !== 'stationary') {
        patch.rejected = s.rejected + 1;
      }
    }
    this.set(patch);
    this.saveDraft();
  };

  private recentPace(pts: TrackPoint[]): number {
    let d = 0;
    for (let i = pts.length - 1; i > 0; i--) {
      d += haversine([pts[i - 1].lon, pts[i - 1].lat], [pts[i].lon, pts[i].lat]);
      if (d >= 200) return (pts[pts.length - 1].t - pts[i - 1].t) / 1000 / (d / 1000);
    }
    // Early in the walk: use whatever we have once it's meaningful.
    return d >= 50 ? (pts[pts.length - 1].t - pts[0].t) / 1000 / (d / 1000) : 0;
  }

  private startTicker() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = setInterval(() => {
      const now = this.provider?.now() ?? Date.now();
      const s = this.state;
      // Auto-pause indicator: recording but no meaningful movement for 15 s.
      const last = s.points[s.points.length - 1];
      const autoPaused = s.status === 'recording' && !!last && now - last.t > 15_000;
      this.set({ now, autoPaused });
    }, 250);
  }

  private async stopProvider() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    await this.provider?.stop();
    this.provider = null;
    this.releaseWakeLock();
  }

  private async saveDraft(force = false) {
    const s = this.state;
    if (s.status !== 'recording' && s.status !== 'paused') return;
    const now = Date.now();
    if (!force && now - this.lastDraftSave < 5000) return;
    this.lastDraftSave = now;
    const draft: RecordingDraft = {
      id: 'draft', startedAt: s.startedAt ?? now, points: s.points, pauses: s.pauses, pausedAt: s.pausedAt,
      source: s.source, routeId: s.routeId, updatedAt: now,
    };
    await db.drafts.put(draft);
  }

  private async requestWakeLock() {
    try {
      const settings = await getSettings();
      if (!settings.keepScreenOn || !('wakeLock' in navigator)) return;
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch { /* not fatal: user may have battery saver on */ }
  }

  private releaseWakeLock() {
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  /** Wake locks are dropped when the page is hidden; re-acquire on return. */
  handleVisibility = () => {
    if (document.visibilityState === 'visible' && (this.state.status === 'recording' || this.state.status === 'paused')) this.requestWakeLock();
  };
}

export const recorder = new Recorder();
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', recorder.handleVisibility);

export function useRecorder(): RecorderState {
  return useSyncExternalStore(recorder.subscribe, recorder.getState);
}

/** Elapsed recording time excluding pauses, in seconds. */
export function elapsedSeconds(s: RecorderState): number {
  if (!s.startedAt) return 0;
  const pausedMs = s.pauses.reduce((acc, [a, b]) => acc + (b - a), 0) + (s.pausedAt != null ? s.now - s.pausedAt : 0);
  return Math.max(0, (s.now - s.startedAt - pausedMs) / 1000);
}
