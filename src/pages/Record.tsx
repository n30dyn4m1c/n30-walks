import { useEffect, useMemo, useRef, useState } from 'react';
import { styleReady } from '../lib/mapStyles';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import type maplibregl from 'maplibre-gl';
import { MapView } from '../components/MapView';
import { Icon } from '../components/Icon';
import { Sheet, Stat, StylePicker, Segmented, useSettings, useToast } from '../components/ui';
import { db } from '../db/db';
import { recorder, useRecorder, elapsedSeconds } from '../tracking/recorder';
import { isNative } from '../tracking/providers';
import { addRouteLayers, setUserPosition, lineFeature, setData } from '../lib/mapLayers';
import { fmtDistance, fmtDuration, fmtPace, distanceUnit, paceUnit, fmtDistance as fd } from '../lib/format';
import { proceduralLoop, DEMO_START } from '../lib/demo';
import type { LngLat } from '../lib/geo';
import type { MapStyleId } from '../types';

function accuracyClass(acc?: number) {
  if (acc == null) return '';
  return acc <= 12 ? 'good' : acc <= 30 ? 'ok' : 'bad';
}

/** Hold-to-finish button: prevents ending a walk by accident. */
function HoldButton({ onDone, children }: { onDone: () => void; children: React.ReactNode }) {
  const [p, setP] = useState(0);
  const raf = useRef(0);
  const start = () => {
    const t0 = performance.now();
    const tick = () => {
      const f = Math.min(1, (performance.now() - t0) / 800);
      setP(f);
      if (f >= 1) { onDone(); setP(0); return; }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };
  const cancel = () => { cancelAnimationFrame(raf.current); setP(0); };
  return (
    <button className="round-btn stop" onPointerDown={start} onPointerUp={cancel} onPointerLeave={cancel} aria-label="Hold to finish"
      onKeyDown={(e) => { if (e.key === 'Enter') onDone(); }}>
      <div className="fill" style={{ transform: `scaleY(${p})` }} />
      <span>{children}</span>
    </button>
  );
}

export function RecordPage() {
  const settings = useSettings();
  const rec = useRecorder();
  const nav = useNavigate();
  const toast = useToast();
  const routes = useLiveQuery(() => db.routes.orderBy('updatedAt').reverse().toArray(), []);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [styleId, setStyleId] = useState<MapStyleId>(settings.defaultMapStyle);
  const [terrain, setTerrain] = useState(false);
  const [follow, setFollow] = useState(true);
  const [simOpen, setSimOpen] = useState(false);
  const [routeOpen, setRouteOpen] = useState(false);
  const [stylesOpen, setStylesOpen] = useState(false);
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

  const startSim = async () => {
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
    setTimeout(() => recorder.start({ routeId }), 400);
    toast(`Simulating a walk at ${speed}× speed`);
  };

  const finish = async () => {
    try {
      const id = await recorder.finish();
      if (id) nav(`/activity/${id}`, { replace: true });
      else { toast('Walk too short to save'); recorder.acquire().catch(() => {}); }
    } catch (e) {
      toast(`Could not save: ${(e as Error).message}`);
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
        terrain={terrain}
        initial={{ center: here ?? DEMO_START, zoom: here ? 16 : 3 }}
        onReady={(m) => { mapRef.current = m; m.setPadding({ top: 90, bottom: Math.round(window.innerHeight * 0.45), left: 0, right: 0 }); drawPlanned(m); drawLive(m); m.on('dragstart', () => setFollow(false)); }}
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
            <button className={`icon-btn ${terrain ? 'active' : ''}`} onClick={() => setTerrain(!terrain)} aria-label="Toggle 3D"><Icon name="cube" size={20} /></button>
            <button className="icon-btn" onClick={() => setStylesOpen(!stylesOpen)} aria-label="Map style"><Icon name="layers" size={20} /></button>
            <button className={`icon-btn ${follow ? 'active' : ''}`} onClick={() => setFollow(true)} aria-label="Follow my position"><Icon name="locate" size={20} /></button>
          </div>
        </div>
        {stylesOpen && <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}><StylePicker value={styleId} onChange={(v) => { setStyleId(v); setStylesOpen(false); }} /></div>}
        <div className="stack" style={{ marginTop: 10, gap: 8 }}>
          {rec.error && <div className="banner err">{rec.error.message}</div>}
          {!isNative() && live && rec.source === 'gps' && <div className="banner">Keep this screen open — browsers pause GPS in the background. Install the Android/iOS build for pocket tracking.</div>}
          {rec.autoPaused && rec.status === 'recording' && <div className="banner">Auto-paused — waiting for movement…</div>}
          {simulated?.finished && live && <div className="banner">Simulated route complete — hold ■ to finish.</div>}
        </div>
      </div>

      {/* Bottom panel */}
      <div className="rec-panel">
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
          {!live && rec.status !== 'saving' && (
            <>
              <button className="icon-btn" style={{ width: 56, height: 56 }} onClick={() => setRouteOpen(true)} aria-label="Choose a route to follow"><Icon name="routes" /></button>
              <button className="round-btn go" onClick={() => recorder.start({ routeId })} disabled={!fix}>
                {fix ? 'START' : <span className="spinner" />}
              </button>
              <button className="icon-btn" style={{ width: 56, height: 56 }} onClick={() => setSimOpen(true)} aria-label="Simulate a walk"><Icon name="sim" /></button>
            </>
          )}
          {rec.status === 'recording' && (
            <>
              <button className="round-btn pause" onClick={() => recorder.pause()} aria-label="Pause"><Icon name="pause" size={30} stroke={3} /></button>
              <HoldButton onDone={finish}><Icon name="stop" size={26} fill /></HoldButton>
            </>
          )}
          {rec.status === 'paused' && (
            <>
              <button className="round-btn go" onClick={() => recorder.resume()} aria-label="Resume"><Icon name="play" size={30} fill /></button>
              <HoldButton onDone={finish}><Icon name="stop" size={26} fill /></HoldButton>
            </>
          )}
          {rec.status === 'saving' && <div className="row muted"><span className="spinner" /> Saving walk & fetching elevation…</div>}
        </div>
        {live && <div className="faint small" style={{ textAlign: 'center', marginTop: 10 }}>Hold ■ to finish · {rec.points.length} points · {rec.rejected} noisy fixes filtered</div>}
        {live && rec.status === 'paused' && <div style={{ textAlign: 'center', marginTop: 8 }}><button className="btn ghost sm danger" onClick={() => { if (confirm('Discard this walk?')) recorder.discard().then(() => recorder.acquire()); }}>Discard walk</button></div>}
      </div>

      <Sheet open={simOpen} onClose={() => setSimOpen(false)} title="Simulate a walk">
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>Feeds realistic, noisy GPS fixes (with occasional glitches) through the real recording pipeline — perfect for testing at a desk. {plannedRoute ? `Walks your selected route “${plannedRoute.name}”.` : 'Walks a random loop from your position (or a demo location).'}</p>
          {!plannedRoute && (
            <div className="field"><label>Loop distance (km)</label><input className="input" inputMode="decimal" value={simKm} onChange={(e) => setSimKm(e.target.value)} /></div>
          )}
          <div className="field"><label>Speed</label>
            <Segmented value={simSpeed} onChange={setSimSpeed} options={[{ value: '5', label: '5×' }, { value: '10', label: '10×' }, { value: '30', label: '30×' }]} />
          </div>
          <button className="btn primary block" onClick={startSim}>Start simulated walk</button>
        </div>
      </Sheet>

      <Sheet open={routeOpen} onClose={() => setRouteOpen(false)} title="Follow a route">
        <div className="stack">
          <button className={`card tight link row between ${!routeId ? 'on' : ''}`} onClick={() => { setRouteId(undefined); setRouteOpen(false); }}><span>Free walk (no route)</span>{!routeId && <Icon name="check" />}</button>
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
