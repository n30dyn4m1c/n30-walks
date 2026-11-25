import { useEffect, useMemo, useRef, useState } from 'react';
import { styleReady } from '../lib/mapStyles';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import type maplibregl from 'maplibre-gl';
import { MapView } from '../components/MapView';
import { DraftCard } from '../components/DraftCard';
import { Icon } from '../components/Icon';
import { HoldButton, Sheet, Stat, StylePicker, Segmented, useMapStyle, useSettings, useToast } from '../components/ui';
import { db } from '../db/db';
import { recorder, useRecorder, elapsedSeconds, UNFINISHED_DRAFT_MESSAGE } from '../tracking/recorder';
import { isNative, openLocationSettings } from '../tracking/providers';
import { buzz } from '../lib/haptics';
import { addRouteLayers, setUserPosition, lineFeature, setData } from '../lib/mapLayers';
import { fmtDistance, fmtDuration, fmtPace, distanceUnit, paceUnit, fmtDistance as fd, fmtSpeed, speedUnit, M_PER_MI } from '../lib/format';
import { MODE_COLOR, MODE_ICON, MODE_LABEL } from '../lib/modes';
import type { TrackingMode } from '../types';
import { proceduralLoop, DEMO_START } from '../lib/demo';
import { cumulativeDistances, nearestOnPath, type LngLat } from '../lib/geo';

function accuracyClass(acc?: number) {
  if (acc == null) return '';
  return acc <= 12 ? 'good' : acc <= 30 ? 'ok' : 'bad';
}

/** Signal meter: Searching → Weak → Ready. */
function signalLabel(acc?: number) {
  if (acc == null) return 'Searching for GPS…';
  return `${acc > 30 ? 'Weak GPS' : 'GPS ready'} ±${Math.round(acc)} m`;
}

/** More than this far from a followed route (or the fix's own accuracy, if worse) counts as off route. */
const OFF_ROUTE_M = 40;
/** After this long without a fix, offer "Start anyway". */
const START_ANYWAY_AFTER_MS = 8000;
/** Hidden for longer than this while recording on the web: tell the user GPS was off. */
const GAP_NOTICE_MS = 60_000;
const LOCK_TIP_KEY = 'stride.lockTipSeen';
const MODE_KEY = 'stride.trackingMode';

function readFlag(key: string) { try { return localStorage.getItem(key) === '1'; } catch { return false; } }
function writeFlag(key: string) { try { localStorage.setItem(key, '1'); } catch { /* storage blocked */ } }
function readMode(): TrackingMode { try { return localStorage.getItem(MODE_KEY) === 'mixed' ? 'mixed' : 'walk'; } catch { return 'walk'; } }
function writeMode(m: TrackingMode) { try { localStorage.setItem(MODE_KEY, m); } catch { /* storage blocked */ } }

export function RecordPage() {
  const settings = useSettings();
  const rec = useRecorder();
  const nav = useNavigate();
  const toast = useToast();
  const routes = useLiveQuery(() => db.routes.orderBy('updatedAt').reverse().toArray(), []);
  const draft = useLiveQuery(() => db.drafts.get('draft'), []);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [styleId, setStyleId] = useMapStyle(settings);
  const [follow, setFollow] = useState(true);
  const [simOpen, setSimOpen] = useState(false);
  const [routeOpen, setRouteOpen] = useState(false);
  const [stylesOpen, setStylesOpen] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [simKm, setSimKm] = useState('3');
  const [simSpeed, setSimSpeed] = useState<'5' | '10' | '30'>('10');
  const [params] = useSearchParams();
  const [routeId, setRouteId] = useState<string | undefined>(rec.routeId ?? params.get('route') ?? undefined);
  const plannedRoute = routes?.find((r) => r.id === routeId);
  const live = rec.status === 'recording' || rec.status === 'paused';
  // Walk only, or a mixed journey (walk, run, bus…). Remembered between sessions.
  const [pickedMode, setPickedMode] = useState<TrackingMode>(readMode);
  const pickMode = (m: TrackingMode) => { setPickedMode(m); writeMode(m); };
  const mixed = live || rec.status === 'saving' ? rec.mode === 'mixed' : pickedMode === 'mixed';
  const noun = mixed ? 'journey' : 'walk';

  // Warm up the real GPS as soon as the screen opens (unless already busy).
  useEffect(() => {
    if (recorder.getState().status === 'idle') recorder.acquire({ routeId }).catch(() => {});
    return () => { recorder.cancelAcquire(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // No fix for a while: let the user start anyway (the first fixes then start the track).
  const [searchingLong, setSearchingLong] = useState(false);
  const hasFix = !!rec.lastFix;
  useEffect(() => {
    if (hasFix) { setSearchingLong(false); return; }
    const t = setTimeout(() => setSearchingLong(true), START_ANYWAY_AFTER_MS);
    return () => clearTimeout(t);
  }, [hasFix]);

  const fix = rec.lastFix;
  const here: LngLat | null = fix ? [fix.lon, fix.lat] : null;
  const path = useMemo(() => rec.points.map((p) => [p.lon, p.lat] as LngLat), [rec.points]);

  // Draw live path + position.
  const drawLive = (map: maplibregl.Map) => {
    if (!styleReady(map)) return;
    const s = recorder.getState();
    addRouteLayers(map, 'live', s.points.map((p) => [p.lon, p.lat]), { color: settings.overlay.routeColor, width: 5 });
    const f = s.lastFix;
    setUserPosition(map, f ? [f.lon, f.lat] : null, f?.acc ?? 10);
  };
  const drawPlanned = (map: maplibregl.Map) => {
    if (!styleReady(map)) return;
    if (plannedRoute) addRouteLayers(map, 'planned', plannedRoute.geometry, { color: '#4ea1ff', width: 4, dashed: true, beforeId: map.getLayer('live-casing') ? 'live-casing' : undefined });
    else if (map.getSource('planned')) setData(map, 'planned', lineFeature([]));
  };

  useEffect(() => { if (mapRef.current) drawLive(mapRef.current); }, [path, fix]);
  useEffect(() => { if (mapRef.current) drawPlanned(mapRef.current); }, [plannedRoute]);

  // Camera follow.
  const firstFix = useRef(true);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !here || !follow) return;
    if (firstFix.current) { map.jumpTo({ center: here, zoom: 16.2 }); firstFix.current = false; }
    else map.easeTo({ center: here, duration: 600 });
  }, [fix?.t, follow]);

  // ---------- following a route: distance to go + off-route warning ----------
  const routeCum = useMemo(() => (plannedRoute ? cumulativeDistances(plannedRoute.geometry) : null), [plannedRoute]);
  const alongRef = useRef(0);
  const routeProgress = useMemo(() => {
    if (!plannedRoute || !routeCum || !fix || !live) return null;
    const r = nearestOnPath(plannedRoute.geometry, routeCum, [fix.lon, fix.lat], alongRef.current);
    const total = routeCum[routeCum.length - 1];
    return { alongM: r.alongM, offM: r.offM, toGoM: Math.max(0, total - r.alongM), off: r.offM > Math.max(OFF_ROUTE_M, fix.acc) };
  }, [plannedRoute, routeCum, fix, live]);
  useEffect(() => { alongRef.current = 0; }, [plannedRoute?.id, rec.startedAt]);
  useEffect(() => { if (routeProgress && !routeProgress.off) alongRef.current = routeProgress.alongM; }, [routeProgress]);
  const offRoute = !!routeProgress?.off;
  useEffect(() => { if (offRoute) buzz([60, 80, 60]); }, [offRoute]);

  // ---------- screen-reader announcement at every km / mile ----------
  const u = settings.units;
  const unitM = u === 'imperial' ? M_PER_MI : 1000;
  const wholeUnits = live ? Math.floor(rec.distanceM / unitM) : 0;
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (wholeUnits < 1) return;
    const s = recorder.getState();
    const pace = s.distanceM > 0 ? s.movingS / (s.distanceM / 1000) : 0;
    setAnnouncement(`${wholeUnits} ${u === 'imperial' ? 'mile' : 'kilometre'}${wholeUnits === 1 ? '' : 's'}. Time ${fmtDuration(elapsedSeconds(s))}. Average pace ${fmtPace(pace, u)} ${paceUnit(u)}.`);
  }, [wholeUnits, u]);

  // ---------- web: the browser stops GPS while the screen is locked ----------
  const webGps = !isNative() && live && rec.source === 'gps';
  const [lockTipSeen, setLockTipSeen] = useState(() => readFlag(LOCK_TIP_KEY));
  const [gapMin, setGapMin] = useState<number | null>(null);
  useEffect(() => {
    if (!webGps) return;
    let hiddenAt: number | null = document.hidden ? Date.now() : null;
    const onVis = () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (hiddenAt != null && Date.now() - hiddenAt > GAP_NOTICE_MS) setGapMin(Math.round((Date.now() - hiddenAt) / 60_000));
      hiddenAt = null;
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [webGps]);

  const startWalk = async () => {
    try { await recorder.start({ routeId, mode: pickedMode }); } catch (e) { toast((e as Error).message); }
  };

  const startSim = async () => {
    if (draft) { setSimOpen(false); toast(UNFINISHED_DRAFT_MESSAGE); return; }
    const speed = Number(simSpeed);
    let pathToWalk: LngLat[];
    if (plannedRoute) pathToWalk = plannedRoute.geometry;
    else {
      const origin: LngLat = here ?? DEMO_START;
      pathToWalk = proceduralLoop(origin, Math.max(0.3, parseFloat(simKm) || 3) * 1000, Math.floor(Math.random() * 1000));
    }
    setSimOpen(false);
    firstFix.current = true;
    // Mixed: walk to the stop, ride, walk the last bit.
    let speedAt: ((d: number) => number) | undefined;
    if (pickedMode === 'mixed') {
      const total = cumulativeDistances(pathToWalk).at(-1) ?? 0;
      const walkStart = Math.min(600, total * 0.15), walkEnd = total - Math.min(400, total * 0.1);
      speedAt = (d) => (d < walkStart || d > walkEnd ? 1.4 : 11);
    }
    await recorder.acquire({ simulatePath: pathToWalk, speedup: speed, routeId, mode: pickedMode, speedAt });
    // Give the simulated "GPS" a beat to produce a fix, then start.
    setTimeout(() => { void startWalk(); }, 400);
    toast(`Simulating a ${pickedMode === 'mixed' ? 'walk + bus journey' : 'walk'} at ${speed}× speed`);
  };

  const finish = async () => {
    try {
      const id = await recorder.finish();
      if (id) nav(`/activity/${id}`, { replace: true });
      else { toast(`${mixed ? 'Journey' : 'Walk'} too short to save`); recorder.acquire().catch(() => {}); }
    } catch (e) {
      // The recorder keeps the walk paused and its draft intact, so nothing is lost.
      toast(`Could not save (${(e as Error).message}). Your walk is paused and safe. Try Finish again.`);
    }
  };

  const elapsed = elapsedSeconds(rec);
  const avgPace = rec.distanceM > 20 ? rec.movingS / (rec.distanceM / 1000) : 0;
  const simulated = recorder.simulated;
  const pause = () => { buzz(30); recorder.pause(); };
  const resume = () => { buzz([30, 60, 30]); recorder.resume(); };
  const closeFinish = () => { setFinishOpen(false); setConfirmDiscard(false); };
  const retryGps = () => { firstFix.current = true; recorder.acquire({ routeId }).catch(() => {}); };
  // Before a walk starts, a GPS problem replaces the Start button with a card that says what to do.
  const gpsProblem = !live && rec.status !== 'saving' && !draft ? rec.error : null;

  return (
    <div className="page full">
      <MapView
        styleId={styleId}
        initial={{ center: here ?? DEMO_START, zoom: here ? 16 : 3 }}
        onReady={(m) => {
          mapRef.current = m;
          m.setPadding({ top: 90, bottom: Math.round(window.innerHeight * 0.45), left: 0, right: 0 });
          drawPlanned(m); drawLive(m);
          m.on('dragstart', () => setFollow(false));
          // The first fix may have arrived before the map was ready.
          const f = recorder.getState().lastFix;
          if (f && firstFix.current) { m.jumpTo({ center: [f.lon, f.lat], zoom: 16.2 }); firstFix.current = false; }
        }}
      />

      {/* Top bar */}
      <div className="map-float" style={{ top: 'calc(12px + var(--safe-t))', left: 12, right: 12 }}>
        <div className="row between">
          <div className="gps-pill" aria-live="polite">
            <span className={`dot ${accuracyClass(fix?.acc)}`} />
            {rec.error ? 'GPS error' : signalLabel(fix?.acc)}
            {rec.source === 'simulated' && <span className="badge">SIM {simulated?.speedup}×</span>}
          </div>
          <div className="row" style={{ gap: 8 }}>
            {!follow && here && <button className="map-chip" onClick={() => setFollow(true)}><Icon name="locate" size={18} /> Re-center</button>}
            <button className="map-chip" onClick={() => setStylesOpen(!stylesOpen)} aria-expanded={stylesOpen}><Icon name="layers" size={18} /> Map</button>
          </div>
        </div>
        {stylesOpen && <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}><StylePicker value={styleId} onChange={(v) => { setStyleId(v); setStylesOpen(false); }} /></div>}
        <div className="stack" style={{ marginTop: 10, gap: 8 }}>
          {rec.error && live && <div className="banner err">{rec.error.message}</div>}
          {offRoute && routeProgress && <div className="banner err" role="status">Off route · {fd(routeProgress.offM, u, true)} from the line</div>}
          {rec.draftError && live && <div className="banner err">Can't write to storage (device full?). This walk isn't protected if the app closes: free up space, or finish and save it now.</div>}
          {webGps && gapMin != null && (
            <div className="banner row between" role="status">
              <span>GPS was off for {gapMin} min while the screen was locked. That stretch is a straight line.</span>
              <button className="icon-btn sm" aria-label="Dismiss" onClick={() => setGapMin(null)}><Icon name="close" size={16} /></button>
            </div>
          )}
          {webGps && !lockTipSeen && (
            <div className="banner row between">
              <span>Tip: keep this screen on. The browser stops GPS when the screen locks. The Android app tracks in your pocket.</span>
              <button className="icon-btn sm" aria-label="Got it" onClick={() => { writeFlag(LOCK_TIP_KEY); setLockTipSeen(true); }}><Icon name="close" size={16} /></button>
            </div>
          )}
          {rec.status === 'paused' && <div className="banner">Paused — tap Resume to keep recording.</div>}
          {rec.autoPaused && rec.status === 'recording' && <div className="banner">Stopped · moving time paused</div>}
          {simulated?.finished && live && <div className="banner">Simulated route complete — tap Finish to save it.</div>}
        </div>
      </div>

      {/* Bottom panel */}
      <div className="rec-panel">
        {live || rec.status === 'saving' ? (
          <>
            {plannedRoute && (
              <div className="faint small" style={{ textAlign: 'center', marginBottom: 8 }}>
                Following “{plannedRoute.name}” · {routeProgress ? <strong className="tnum" style={{ color: 'var(--text)' }}>{fd(routeProgress.toGoM, u, true)} to go</strong> : fd(plannedRoute.distanceM, u, true)}
              </div>
            )}
            <div className="stat-grid two" style={{ textAlign: 'center' }}>
              <Stat label="Time" value={fmtDuration(elapsed)} size="xl" />
              <Stat label="Distance" value={fmtDistance(rec.distanceM, u)} unit={distanceUnit(u)} size="xl" />
            </div>
            {mixed ? (
              <div className="stat-grid two" style={{ marginTop: 14, textAlign: 'center' }}>
                <div className="stat" aria-live="polite">
                  <div className="label">Now</div>
                  <div className="value row" style={{ justifyContent: 'center', gap: 6, fontSize: 18, color: rec.travelMode ? MODE_COLOR[rec.travelMode] : undefined }}>
                    {rec.travelMode ? <><Icon name={MODE_ICON[rec.travelMode]} size={20} /> {MODE_LABEL[rec.travelMode]}</> : 'Stopped'}
                  </div>
                </div>
                {rec.travelMode === 'vehicle'
                  ? <Stat label="Speed now" value={fmtSpeed(rec.currentSpeedMps, u)} unit={speedUnit(u)} />
                  : <Stat label="Pace now" value={fmtPace(rec.currentPace, u)} unit={paceUnit(u)} />}
              </div>
            ) : (
              <div className="stat-grid two" style={{ marginTop: 14, textAlign: 'center' }}>
                <Stat label="Pace now" value={fmtPace(rec.currentPace, u)} unit={paceUnit(u)} />
                <Stat label="Avg pace" value={fmtPace(avgPace, u)} unit={paceUnit(u)} />
              </div>
            )}
            <div className="sr-only" aria-live="polite">{announcement}</div>
            <div className="controls">
              {rec.status === 'recording' && (
                <button className="ctrl-btn pause" onClick={pause}><Icon name="pause" size={26} stroke={3} /><span>Pause</span></button>
              )}
              {rec.status === 'paused' && (
                <button className="ctrl-btn go" onClick={resume}><Icon name="play" size={26} fill /><span>Resume</span></button>
              )}
              {live && (
                <HoldButton className="ctrl-btn stop" title="Press and hold to finish" onHold={() => setFinishOpen(true)} onTap={() => toast(`Hold Finish to end the ${noun}`)}><Icon name="stop" size={22} fill /><span>Finish</span></HoldButton>
              )}
              {rec.status === 'saving' && <div className="row muted"><span className="spinner" /> Saving {noun}…</div>}
            </div>
          </>
        ) : (
          draft ? (
            <DraftCard draft={draft} />
          ) : gpsProblem ? (
            <div className="card stack" role="alert">
              <h3>{gpsProblem.code === 'denied' ? 'Stride can’t see your location' : gpsProblem.code === 'unsupported' ? 'No GPS on this device' : 'No GPS signal yet'}</h3>
              <p className="muted small" style={{ margin: 0 }}>
                {gpsProblem.code === 'denied'
                  ? isNative() ? 'Allow location access for Stride in Settings (“While using the app” or “Always”), then try again.' : 'Allow location for this site in your browser’s site settings (the icon next to the address), then try again.'
                  : gpsProblem.code === 'unsupported' ? gpsProblem.message
                  : 'Move outdoors or near a window, and check that location is switched on.'}
              </p>
              <div className="row wrap">
                {gpsProblem.code === 'denied' && isNative() && <button className="btn primary sm" onClick={() => openLocationSettings().catch(() => {})}>Open settings</button>}
                {gpsProblem.code !== 'unsupported' && <button className={`btn sm ${gpsProblem.code === 'denied' && isNative() ? '' : 'primary'}`} onClick={retryGps}>Try again</button>}
                <button className="btn sm ghost" onClick={() => setSimOpen(true)}><Icon name="sim" size={16} /> Use the simulator</button>
              </div>
            </div>
          ) : (
          <div className="stack" style={{ alignItems: 'center', gap: 14 }}>
            <Segmented label="What are you tracking?" value={pickedMode} onChange={pickMode}
              options={[{ value: 'walk', label: 'Walk' }, { value: 'mixed', label: 'Mixed journey' }]} />
            <button className="start-btn" onClick={startWalk} disabled={!fix}>
              {fix ? <><Icon name="play" size={22} fill /> Start {noun}</> : <><span className="spinner" /> Finding your location…</>}
            </button>
            {pickedMode === 'mixed' && <div className="faint small" style={{ textAlign: 'center', maxWidth: 340 }}>Tracks the whole trip, including rides. Walking, running and vehicle stretches are detected by speed; only the on-foot parts count toward pace, steps and records.</div>}
            {fix && fix.acc > 30 && <div className="faint small" style={{ textAlign: 'center' }}>Weak signal: waiting a moment gives a cleaner start.</div>}
            {!fix && searchingLong && <button className="btn sm ghost" onClick={startWalk}>Start anyway</button>}
            <div className="row" style={{ gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button className="chip" onClick={() => setRouteOpen(true)}><Icon name="routes" size={16} /> {plannedRoute ? plannedRoute.name : 'No route'} ▾</button>
              <button className="chip" onClick={() => setSimOpen(true)}><Icon name="sim" size={16} /> Test with simulator</button>
            </div>
          </div>
          )
        )}
      </div>

      <Sheet open={finishOpen} onClose={closeFinish} title={`Finish this ${noun}?`}>
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>{fmtDistance(rec.distanceM, u)} {distanceUnit(u)} in {fmtDuration(elapsed)}</p>
          <button className="btn primary lg block" onClick={() => { closeFinish(); finish(); }}><Icon name="check" /> Save {noun}</button>
          <button className="btn lg block" onClick={closeFinish}>{mixed ? 'Keep going' : 'Keep walking'}</button>
          {confirmDiscard ? (
            <button className="btn block danger" onClick={() => { closeFinish(); recorder.discard().then(() => recorder.acquire()); toast(`${mixed ? 'Journey' : 'Walk'} discarded`); }}><Icon name="trash" size={18} /> Tap again to delete this {noun}</button>
          ) : (
            <button className="btn ghost block danger" onClick={() => setConfirmDiscard(true)}><Icon name="trash" size={18} /> Discard {noun}</button>
          )}
        </div>
      </Sheet>

      <Sheet open={simOpen} onClose={() => setSimOpen(false)} title={`Simulate a ${noun}`}>
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>Feeds realistic, noisy GPS fixes (with occasional glitches) through the real recording pipeline — perfect for testing at a desk. {plannedRoute ? `Walks your selected route “${plannedRoute.name}”.` : 'Walks a random loop from your position (or a demo location).'}{pickedMode === 'mixed' ? ' Mixed mode: walks to a “bus stop”, rides at ~40 km/h, then walks the last stretch.' : ''}</p>
          {!plannedRoute && (
            <div className="field"><label>Loop distance (km)</label><input className="input" inputMode="decimal" value={simKm} onChange={(e) => setSimKm(e.target.value)} /></div>
          )}
          <div className="field"><label>Speed</label>
            <Segmented label="Simulation speed" value={simSpeed} onChange={setSimSpeed} options={[{ value: '5', label: '5×' }, { value: '10', label: '10×' }, { value: '30', label: '30×' }]} />
          </div>
          <button className="btn primary block" onClick={startSim}>Start simulated {noun}</button>
        </div>
      </Sheet>

      <Sheet open={routeOpen} onClose={() => setRouteOpen(false)} title="Walk a saved route">
        <div className="stack">
          <button className={`card tight link row between ${!routeId ? 'on' : ''}`} onClick={() => { setRouteId(undefined); setRouteOpen(false); }}><span>No route — just walk</span>{!routeId && <Icon name="check" />}</button>
          {routes?.map((r) => (
            <button key={r.id} className="card tight link row between" onClick={() => { setRouteId(r.id); setRouteOpen(false); const m = mapRef.current; if (m) { setFollow(false); const xs = r.geometry.map((c) => c[0]), ys = r.geometry.map((c) => c[1]); m.fitBounds([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], { padding: 60 }); } }}>
              <span>{r.name} <span className="faint small">· {fd(r.distanceM, u, true)}</span></span>{routeId === r.id && <Icon name="check" />}
            </button>
          ))}
          {!routes?.length && <p className="muted small">No saved routes yet — plan one in the Routes tab.</p>}
        </div>
      </Sheet>
    </div>
  );
}
