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
import { GpsFilter, filterOptionsFor, type RawFix } from '../lib/gpsFilter';
import { haversine, type LngLat } from '../lib/geo';
import { liveMode, segmentContribution, trackTotals } from '../lib/stats';
import { db, getSettings, requestPersistentStorage } from '../db/db';
import { buildAndSaveActivity } from '../lib/activityBuilder';
import type { ActivitySource, RecordingDraft, TrackingMode, TrackPoint, TravelMode } from '../types';
import { createRealProvider, SimulatedProvider, type LocationProvider, type ProviderError } from './providers';
import { logError, logWarn } from '../lib/diagnostics';

export type RecorderStatus = 'idle' | 'acquiring' | 'recording' | 'paused' | 'saving';

export interface RecorderState {
  status: RecorderStatus;
  source: ActivitySource;
  /** 'walk' or a 'mixed' journey (walk, run, bus…). */
  mode: TrackingMode;
  /** Mixed journeys: what the user seems to be doing right now (null while still). */
  travelMode: TravelMode | null;
  /** Speed over the last ~40 s of movement, m/s. */
  currentSpeedMps: number;
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
  /** The last draft write failed (e.g. storage full): crash recovery isn't protecting this walk. */
  draftError: boolean;
}

const initial: RecorderState = {
  status: 'idle', source: 'gps', mode: 'walk', travelMode: null, currentSpeedMps: 0, startedAt: null, points: [], pauses: [], pausedAt: null,
  lastFix: null, distanceM: 0, movingS: 0, currentPace: 0, now: Date.now(), error: null, rejected: 0, autoPaused: false, draftError: false,
};

export const UNFINISHED_DRAFT_MESSAGE = 'An unfinished walk is waiting. Resume, save or discard it first.';

class Recorder {
  private state: RecorderState = initial;
  private listeners = new Set<() => void>();
  private provider: LocationProvider | null = null;
  private filter = new GpsFilter();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private lastDraftSave = 0;
  private wakeLock: WakeLockSentinel | null = null;
  /** Bumped by every acquire/stop so a slow, superseded acquire() can't leave a GPS watcher running. */
  private generation = 0;
  private maxAccuracyM: number | undefined;

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
  async acquire(opts: { simulatePath?: LngLat[]; speedup?: number; routeId?: string; mode?: TrackingMode; speedAt?: (d: number) => number } = {}) {
    // Take a token BEFORE awaiting anything: any later acquire/stop supersedes this one.
    const gen = ++this.generation;
    await this.teardownProvider();
    const settings = await getSettings();
    if (gen !== this.generation) return; // superseded while loading settings
    this.maxAccuracyM = settings.maxAccuracyM;
    const mode = opts.mode ?? 'walk';
    this.filter = new GpsFilter(filterOptionsFor(mode, settings.maxAccuracyM));
    const provider = opts.simulatePath ? new SimulatedProvider(opts.simulatePath, opts.speedup ?? 10, undefined, opts.speedAt) : createRealProvider();
    this.provider = provider;
    if (provider instanceof SimulatedProvider) provider.holdPosition = true;
    this.set({ ...initial, status: 'acquiring', source: opts.simulatePath ? 'simulated' : 'gps', mode, routeId: opts.routeId, now: provider.now() });
    await provider.start(this.onFix, (error) => {
      if (this.provider !== provider) return;
      if (this.state.error?.code !== error.code) logWarn('gps', `provider error: ${error.code}`);
      this.set({ error });
    });
    if (gen !== this.generation || this.provider !== provider) { await provider.stop(); return; }
    this.startTicker();
  }

  async start(opts: { routeId?: string; mode?: TrackingMode } = {}) {
    if (this.state.status === 'recording' || this.state.status === 'paused' || this.state.status === 'saving') return;
    // Never overwrite an interrupted walk's draft by starting a new one.
    if (await db.drafts.get('draft')) throw new Error(UNFINISHED_DRAFT_MESSAGE);
    if (!this.provider) await this.acquire(opts);
    // Re-check after awaiting: a second tap on Start may have got here first.
    if (!this.provider || this.state.status !== 'acquiring') return;
    const now = this.provider!.now();
    if (this.simulated) this.simulated.holdPosition = false;
    const mode = opts.mode ?? this.state.mode;
    // Fresh filter tuned for the chosen mode (a walk filter would drop a bus ride as a glitch).
    this.filter = new GpsFilter(filterOptionsFor(mode, this.maxAccuracyM));
    this.set({ status: 'recording', mode, travelMode: null, currentSpeedMps: 0, startedAt: now, points: [], pauses: [], distanceM: 0, movingS: 0, error: null, routeId: opts.routeId ?? this.state.routeId });
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

  /**
   * Finish and persist. Returns the new activity id, or null if too short.
   * If saving fails, nothing is lost: the walk stays paused (GPS still on, draft
   * still stored) so the user can retry or keep walking, and the error is thrown.
   */
  async finish(): Promise<string | null> {
    const s = this.state;
    if (s.status !== 'recording' && s.status !== 'paused') return null;
    const now = this.provider?.now() ?? Date.now();
    const pausedAt = s.pausedAt ?? now;
    const pauses = [...s.pauses, [pausedAt, now] as [number, number]];
    this.set({ status: 'saving' });
    if (s.points.length < 2) {
      await this.stopProvider();
      await db.drafts.delete('draft');
      this.set({ ...initial });
      return null;
    }
    try {
      const settings = await getSettings();
      // The draft is deleted in the same transaction as the save — never before it.
      const a = await buildAndSaveActivity(s.points, { settings, source: s.source, pauses, routeId: s.routeId, mode: s.mode, clearDraft: true });
      await this.stopProvider();
      this.set({ ...initial });
      void requestPersistentStorage();
      return a.id;
    } catch (e) {
      logError('recorder', 'save failed; walk kept as a paused draft', e);
      if (this.simulated) this.simulated.holdPosition = true;
      this.set({ status: 'paused', pausedAt });
      await this.saveDraft(true);
      throw e;
    }
  }

  async discard() {
    await this.stopProvider();
    await db.drafts.delete('draft');
    this.set({ ...initial });
  }

  /** Stop GPS without recording (e.g. leaving the record screen while acquiring). */
  async cancelAcquire() {
    const st = this.state.status;
    // 'idle' too: an acquire() may still be loading settings; stopping bumps the generation so it bails.
    if (st === 'acquiring' || st === 'idle') { await this.stopProvider(); if (this.state.status === st) this.set({ ...initial }); }
  }

  /** Resume an interrupted recording from the persisted draft (real GPS only). */
  async resumeDraft(draft: RecordingDraft) {
    await this.acquire({ routeId: draft.routeId, mode: draft.mode ?? 'walk' });
    const now = Date.now();
    const source = draft.source === 'simulated' ? 'gps' : draft.source;
    const base = { startedAt: draft.startedAt, points: draft.points, source, error: null };
    if (draft.pausedAt != null) {
      // It was paused when the app died: come back paused.
      const t = trackTotals(draft.points, draft.pauses);
      this.set({ ...base, status: 'paused', pauses: draft.pauses, pausedAt: draft.pausedAt, distanceM: t.distanceM, movingS: t.movingS });
    } else {
      // The time the app was dead is recorded as a pause (we don't know where the walker went).
      const last = draft.points[draft.points.length - 1]?.t ?? draft.updatedAt;
      const pauses: [number, number][] = [...draft.pauses, [last, now]];
      const t = trackTotals(draft.points, pauses);
      this.set({ ...base, status: 'recording', pauses, pausedAt: null, distanceM: t.distanceM, movingS: t.movingS });
    }
    this.set({ currentPace: this.recentPace(draft.points), ...this.motion(draft.points, this.state.pauses) });
    this.requestWakeLock();
    await this.saveDraft(true);
  }

  /** Save an interrupted recording as it is. The draft is only removed once the walk is saved. */
  async saveDraftAsActivity(draft: RecordingDraft): Promise<string | null> {
    if (draft.points.length < 2) { await db.drafts.delete('draft'); return null; }
    const settings = await getSettings();
    const end = draft.points[draft.points.length - 1].t;
    const pauses: [number, number][] = draft.pausedAt != null ? [...draft.pauses, [draft.pausedAt, Math.max(end, draft.pausedAt)]] : draft.pauses;
    const a = await buildAndSaveActivity(draft.points, { settings, source: draft.source, pauses, routeId: draft.routeId, mode: draft.mode, clearDraft: true });
    void requestPersistentStorage();
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
          // Same rule as the saved stats (pauses, gaps), so live == saved.
          const c = segmentContribution(prev, res.point, s.pauses);
          distanceM += c.d;
          movingS += c.moving;
        }
        Object.assign(patch, { points: pts, distanceM, movingS, currentPace: this.recentPace(pts), ...this.motion(pts, s.pauses) });
      } else if (res.reason !== 'stationary') {
        patch.rejected = s.rejected + 1;
      }
    }
    this.set(patch);
    this.saveDraft();
  };

  private motion(pts: TrackPoint[], pauses: [number, number][]): Pick<RecorderState, 'travelMode' | 'currentSpeedMps'> {
    const m = liveMode(pts, pauses);
    return { travelMode: m?.mode ?? null, currentSpeedMps: m?.speedMps ?? 0 };
  }

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
      this.set(autoPaused ? { now, autoPaused, travelMode: null, currentSpeedMps: 0 } : { now, autoPaused });
    }, 250);
  }

  /** Stop GPS and cancel any acquire() still in flight. */
  private async stopProvider() {
    this.generation++;
    await this.teardownProvider();
  }

  private async teardownProvider() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    // Detach first so a provider created while we await stop() is never nulled out.
    const p = this.provider;
    this.provider = null;
    this.releaseWakeLock();
    await p?.stop();
  }

  private async saveDraft(force = false) {
    const s = this.state;
    if (s.status !== 'recording' && s.status !== 'paused') return;
    const now = Date.now();
    if (!force && now - this.lastDraftSave < 5000) return;
    this.lastDraftSave = now;
    const draft: RecordingDraft = {
      id: 'draft', startedAt: s.startedAt ?? now, points: s.points, pauses: s.pauses, pausedAt: s.pausedAt,
      source: s.source, routeId: s.routeId, mode: s.mode, updatedAt: now,
    };
    try {
      await db.drafts.put(draft);
      if (this.state.draftError) this.set({ draftError: false });
    } catch (e) {
      logWarn('recorder', 'draft save failed', e);
      if (!this.state.draftError) this.set({ draftError: true });
    }
  }

  private async requestWakeLock() {
    try {
      const settings = await getSettings();
      if (!settings.keepScreenOn || !('wakeLock' in navigator)) return;
      if (this.wakeLock && !this.wakeLock.released) return;
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) { logWarn('recorder', 'wake lock refused', e); /* not fatal: battery saver */ }
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
