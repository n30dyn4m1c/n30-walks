import { useEffect, useMemo, useRef, useState } from 'react';
import { styleReady } from '../lib/mapStyles';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import type maplibregl from 'maplibre-gl';
import { MapView } from '../components/MapView';
import { DraftCard } from '../components/DraftCard';
import { Icon } from '../components/Icon';
import { Sheet, Stat, StylePicker, Segmented, useMapStyle, useSettings, useToast } from '../components/ui';
import { db } from '../db/db';
import { recorder, useRecorder, elapsedSeconds, UNFINISHED_DRAFT_MESSAGE } from '../tracking/recorder';
import { isNative } from '../tracking/providers';
import { addRouteLayers, setUserPosition, lineFeature, setData } from '../lib/mapLayers';
import { fmtDistance, fmtDuration, fmtPace, distanceUnit, paceUnit, fmtDistance as fd } from '../lib/format';
import { proceduralLoop, DEMO_START } from '../lib/demo';
import type { LngLat } from '../lib/geo';

function accuracyClass(acc?: number) {
  if (acc == null) return '';
  return acc <= 12 ? 'good' : acc <= 30 ? 'ok' : 'bad';
}

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
  const [simKm, setSimKm] = useState('3');
  const [simSpeed, setSimSpeed] = useState<'5' | '10' | '30'>('10');
  const [params] = useSearchParams();
  const [routeId, setRouteId] = useState<string | undefined>(rec.routeId ?? params.get('route') ?? undefined);
  const plannedRoute = routes?.find((r) => r.id === routeId);
  const live = rec.status === 'recording' || rec.status === 'paused';

  // Warm up the real GPS as soon as the screen opens (unless already busy).
  useEffect(() => {
    if (recorder.getState().status === 'idle') recorder.acquire({ routeId }).catch(() => {});
    return () => { recorder.cancelAcquire(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const startWalk = async () => {
    try { await recorder.start({ routeId }); } catch (e) { toast((e as Error).message); }
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
    await recorder.acquire({ simulatePath: pathToWalk, speedup: speed, routeId });
    // Give the simulated "GPS" a beat to produce a fix, then start.
    setTimeout(() => { void startWalk(); }, 400);
    toast(`Simulating a walk at ${speed}× speed`);
  };

  const finish = async () => {
    try {
      const id = await recorder.finish();
      if (id) nav(`/activity/${id}`, { replace: true });
      else { toast('Walk too short to save'); recorder.acquire().catch(() => {}); }
    } catch (e) {
      // The recorder keeps the walk paused and its draft intact, so nothing is lost.
      toast(`Could not save (${(e as Error).message}). Your walk is paused and safe. Try Finish again.`);
    }
  };

  const elapsed = elapsedSeconds(rec);
  const avgPace = rec.distanceM > 20 ? rec.movingS / (rec.distanceM / 1000) : 0;
  const u = settings.units;
  const simulated = recorder.simulated;

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
            {rec.error ? 'GPS error' : fix ? `GPS ±${Math.round(fix.acc)} m` : 'Finding GPS…'}
            {rec.source === 'simulated' && <span className="badge">SIM {simulated?.speedup}×</span>}
          </div>
          <div className="row" style={{ gap: 8 }}>
            {!follow && here && <button className="map-chip" onClick={() => setFollow(true)}><Icon name="locate" size={18} /> Re-center</button>}
            <button className="map-chip" onClick={() => setStylesOpen(!stylesOpen)} aria-expanded={stylesOpen}><Icon name="layers" size={18} /> Map</button>
          </div>
        </div>
        {stylesOpen && <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}><StylePicker value={styleId} onChange={(v) => { setStyleId(v); setStylesOpen(false); }} /></div>}
        <div className="stack" style={{ marginTop: 10, gap: 8 }}>
          {rec.error && <div className="banner err">{rec.error.message}</div>}
          {rec.draftError && live && <div className="banner err">Can't write to storage (device full?). This walk isn't protected if the app closes: free up space, or finish and save it now.</div>}
          {!isNative() && live && rec.source === 'gps' && <div className="banner">Keep this screen on — the browser stops GPS when the screen locks. Use the Android app for pocket tracking.</div>}
          {rec.status === 'paused' && <div className="banner">Paused — tap Resume to keep recording.</div>}
          {rec.autoPaused && rec.status === 'recording' && <div className="banner">Not moving — the clock keeps running, distance doesn't.</div>}
          {simulated?.finished && live && <div className="banner">Simulated route complete — tap Finish to save it.</div>}
        </div>
      </div>

      {/* Bottom panel */}
      <div className="rec-panel">
        {live || rec.status === 'saving' ? (
          <>
            {plannedRoute && <div className="faint small" style={{ textAlign: 'center', marginBottom: 8 }}>Following “{plannedRoute.name}” · {fd(plannedRoute.distanceM, u, true)}</div>}
            <div style={{ textAlign: 'center' }}>
              <div className="stat xl"><div className="label">Time</div><div className="value tnum">{fmtDuration(elapsed)}</div></div>
            </div>
            <div className="stat-grid" style={{ marginTop: 16, textAlign: 'center' }}>
              <Stat label="Distance" value={fmtDistance(rec.distanceM, u)} unit={distanceUnit(u)} size="lg" />
              <Stat label="Pace" value={fmtPace(rec.currentPace, u)} unit={paceUnit(u)} size="lg" />
              <Stat label="Avg pace" value={fmtPace(avgPace, u)} unit={paceUnit(u)} size="lg" />
            </div>
            <div className="controls">
              {rec.status === 'recording' && (
                <button className="ctrl-btn pause" onClick={() => recorder.pause()}><Icon name="pause" size={26} stroke={3} /><span>Pause</span></button>
              )}
              {rec.status === 'paused' && (
                <button className="ctrl-btn go" onClick={() => recorder.resume()}><Icon name="play" size={26} fill /><span>Resume</span></button>
              )}
              {live && (
                <button className="ctrl-btn stop" onClick={() => setFinishOpen(true)}><Icon name="stop" size={22} fill /><span>Finish</span></button>
              )}
              {rec.status === 'saving' && <div className="row muted"><span className="spinner" /> Saving walk…</div>}
            </div>
          </>
        ) : (
          draft ? (
            <DraftCard draft={draft} />
          ) : (
          <div className="stack" style={{ alignItems: 'center', gap: 14 }}>
            <button className="start-btn" onClick={startWalk} disabled={!fix}>
              {fix ? <><Icon name="play" size={22} fill /> Start walk</> : <><span className="spinner" /> Finding your location…</>}
            </button>
            <div className="row" style={{ gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button className="chip" onClick={() => setRouteOpen(true)}><Icon name="routes" size={16} /> {plannedRoute ? plannedRoute.name : 'No route'} ▾</button>
              <button className="chip" onClick={() => setSimOpen(true)}><Icon name="sim" size={16} /> Test with simulator</button>
            </div>
          </div>
          )
        )}
      </div>

      <Sheet open={finishOpen} onClose={() => setFinishOpen(false)} title="Finish this walk?">
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>{fmtDistance(rec.distanceM, u)} {distanceUnit(u)} in {fmtDuration(elapsed)}</p>
          <button className="btn primary lg block" onClick={() => { setFinishOpen(false); finish(); }}><Icon name="check" /> Save walk</button>
          <button className="btn lg block" onClick={() => setFinishOpen(false)}>Keep walking</button>
          <button className="btn ghost block danger" onClick={() => { if (confirm('Delete this walk? It will not be saved.')) { setFinishOpen(false); recorder.discard().then(() => recorder.acquire()); } }}><Icon name="trash" size={18} /> Discard walk</button>
        </div>
      </Sheet>

      <Sheet open={simOpen} onClose={() => setSimOpen(false)} title="Simulate a walk">
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>Feeds realistic, noisy GPS fixes (with occasional glitches) through the real recording pipeline — perfect for testing at a desk. {plannedRoute ? `Walks your selected route “${plannedRoute.name}”.` : 'Walks a random loop from your position (or a demo location).'}</p>
          {!plannedRoute && (
            <div className="field"><label>Loop distance (km)</label><input className="input" inputMode="decimal" value={simKm} onChange={(e) => setSimKm(e.target.value)} /></div>
          )}
          <div className="field"><label>Speed</label>
            <Segmented label="Simulation speed" value={simSpeed} onChange={setSimSpeed} options={[{ value: '5', label: '5×' }, { value: '10', label: '10×' }, { value: '30', label: '30×' }]} />
          </div>
          <button className="btn primary block" onClick={startSim}>Start simulated walk</button>
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
