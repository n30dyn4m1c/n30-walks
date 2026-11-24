/**
 * Route planning (tap waypoints, snapped to walkable paths) and discovery
 * (auto-generated round-trip loops of a chosen length from where you are).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { styleReady } from '../lib/mapStyles';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import type maplibregl from 'maplibre-gl';
import { db } from '../db/db';
import { MapView } from '../components/MapView';
import { Icon } from '../components/Icon';
import { RouteThumb, ElevationChart } from '../components/Charts';
import { Segmented, StylePicker, Switch, useMapStyle, useSettings, useToast } from '../components/ui';
import { addRouteLayers, fc, pointFeature, setData } from '../lib/mapLayers';
import { routeThrough, straightRoute, generateLoop, type RouteResult } from '../lib/routing';
import { sampleElevations } from '../lib/elevation';
import { elevationGainLoss, smooth } from '../lib/stats';
import { bbox, cumulativeDistances, resample, simplifyToCount, type LngLat } from '../lib/geo';
import { fmtDistance, fmtElevation, uid, M_PER_MI } from '../lib/format';
import { routeToGpx } from '../lib/gpx';
import { saveBlob, slug } from '../media/share';
import { DEMO_START } from '../lib/demo';
import type { Route } from '../types';

type Mode = 'saved' | 'plan' | 'discover';
const LOOP_COLORS = ['#ff5a36', '#4ea1ff', '#b8f34a'];

function useProfile(geometry: LngLat[] | null) {
  const [p, setP] = useState<{ d: number[]; e: number[]; gain: number } | null>(null);
  useEffect(() => {
    if (!geometry || geometry.length < 2) { setP(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const pts = resample(geometry, 25);
      const e = await sampleElevations(pts);
      if (cancelled || !e) return;
      const sm = smooth(e, 3);
      setP({ d: cumulativeDistances(pts), e: sm, gain: elevationGainLoss(sm, 2).gain });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [geometry]);
  return p;
}

export function RoutesPage() {
  const settings = useSettings();
  const u = settings.units;
  const toast = useToast();
  const nav = useNavigate();
  const routes = useLiveQuery(() => db.routes.orderBy('updatedAt').reverse().toArray(), []);
  const [mode, setMode] = useState<Mode>('saved');
  const [styleId, setStyleId] = useMapStyle(settings);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [here, setHere] = useState<LngLat | null>(null);

  // planning state
  const [waypoints, setWaypoints] = useState<LngLat[]>([]);
  const [snap, setSnap] = useState(true);
  const [loopBack, setLoopBack] = useState(false);
  const [planned, setPlanned] = useState<RouteResult | null>(null);
  const [routing, setRouting] = useState(false);
  const [name, setName] = useState('');

  // discovery state
  const [targetKm, setTargetKm] = useState(5);
  const [loops, setLoops] = useState<(RouteResult & { waypoints: LngLat[] })[]>([]);
  const [picked, setPicked] = useState(0);
  const [generating, setGenerating] = useState(false);

  const [selected, setSelected] = useState<Route | null>(null);

  useEffect(() => {
    navigator.geolocation?.getCurrentPosition((p) => setHere([p.coords.longitude, p.coords.latitude]), () => {}, { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 });
  }, []);

  // Route waypoints whenever they change.
  useEffect(() => {
    const wps = loopBack && waypoints.length >= 2 ? [...waypoints, waypoints[0]] : waypoints;
    if (wps.length < 2) { setPlanned(null); return; }
    const ctl = new AbortController();
    setRouting(true);
    const t = setTimeout(async () => {
      try { setPlanned(snap ? await routeThrough(wps, ctl.signal) : straightRoute(wps)); } catch { /* aborted */ } finally { setRouting(false); }
    }, 250);
    return () => { ctl.abort(); clearTimeout(t); };
  }, [waypoints, snap, loopBack]);

  const activeGeometry: LngLat[] | null =
    mode === 'plan' ? planned?.geometry ?? null : mode === 'discover' ? loops[picked]?.geometry ?? null : selected?.geometry ?? null;
  const profile = useProfile(activeGeometry);

  // Draw map content for the current mode.
  const draw = (map: maplibregl.Map) => {
    if (!styleReady(map)) return;
    for (const i of [0, 1, 2]) {
      const g = mode === 'discover' && loops[i] ? loops[i].geometry : [];
      addRouteLayers(map, `loop${i}`, g, { color: LOOP_COLORS[i], width: i === picked ? 6 : 3.5 });
      map.setPaintProperty(`loop${i}-line`, 'line-opacity', i === picked ? 1 : 0.55);
      map.setPaintProperty(`loop${i}-casing`, 'line-opacity', i === picked ? 1 : 0);
    }
    if (map.getLayer(`loop${picked}-casing`)) { map.moveLayer(`loop${picked}-casing`); map.moveLayer(`loop${picked}-line`); }
    addRouteLayers(map, 'plan', mode === 'plan' ? planned?.geometry ?? [] : mode === 'saved' ? selected?.geometry ?? [] : [], { color: settings.overlay.routeColor, width: 5 });
    setData(map, 'wps', fc(mode === 'plan' ? waypoints.map((w, i) => pointFeature(w, { i: String(i + 1) })) : []));
    if (!map.getLayer('wps')) map.addLayer({ id: 'wps', type: 'circle', source: 'wps', paint: { 'circle-radius': 7, 'circle-color': '#fff', 'circle-stroke-color': '#0b0f0d', 'circle-stroke-width': 3, 'circle-pitch-alignment': 'viewport' } });
    setData(map, 'start-pt', fc(mode === 'discover' ? [pointFeature(here ?? (map.getCenter().toArray() as LngLat))] : []));
    if (!map.getLayer('start-pt')) map.addLayer({ id: 'start-pt', type: 'circle', source: 'start-pt', paint: { 'circle-radius': 9, 'circle-color': '#22c55e', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
  };
  // Redraw only when what's drawn changes (not on every keystroke in the name field).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (mapRef.current) draw(mapRef.current); }, [mode, loops, picked, planned, selected, waypoints, here, settings.overlay.routeColor]);

  const fit = (g: LngLat[]) => {
    const b = bbox(g);
    mapRef.current?.fitBounds(b, { padding: 50, duration: 700 });
  };

  const onMapClick = (e: maplibregl.MapMouseEvent) => {
    if (mode !== 'plan') return;
    setWaypoints((w) => [...w, [e.lngLat.lng, e.lngLat.lat]]);
  };

  const discover = async () => {
    const start: LngLat = here ?? (mapRef.current?.getCenter().toArray() as LngLat) ?? DEMO_START;
    setGenerating(true);
    try {
      const meters = targetKm * (u === 'imperial' ? M_PER_MI : 1000);
      const res = await Promise.all([0, 1, 2].map((s) => generateLoop(start, meters, s + Math.floor(Math.random() * 50))));
      setLoops(res);
      setPicked(0);
      fit(res.flatMap((r) => r.geometry));
      if (!res.some((r) => r.snapped)) toast('Routing service unreachable — showing straight-line loops');
    } finally { setGenerating(false); }
  };

  const save = async (r: RouteResult, wps: LngLat[], source: Route['source'], defaultName: string) => {
    const now = Date.now();
    const geom = simplifyToCount(r.geometry, 1500);
    const route: Route = { id: uid(), name: name.trim() || defaultName, waypoints: wps, geometry: geom, distanceM: r.distanceM, elevGainM: profile?.gain, source, snapped: r.snapped, createdAt: now, updatedAt: now };
    await db.routes.put(route);
    toast('Route saved');
    setName('');
    setWaypoints([]);
    setLoops([]);
    setMode('saved');
    setSelected(route);
  };

  const center = here ?? DEMO_START;
  const stats = useMemo(() => {
    if (!activeGeometry) return null;
    const dist = mode === 'plan' ? planned?.distanceM : mode === 'discover' ? loops[picked]?.distanceM : selected?.distanceM;
    return { dist: dist ?? 0, gain: profile?.gain ?? (mode === 'saved' ? selected?.elevGainM : undefined) };
  }, [activeGeometry, profile, mode, planned, loops, picked, selected]);

  return (
    <div className="page" style={{ paddingTop: 0 }}>
      <div className="map-wrap" style={{ height: '50vh', minHeight: 300, margin: '0 -16px', borderRadius: 0, borderLeft: 0, borderRight: 0, borderTop: 0 }}>
        <MapView styleId={styleId} initial={{ center, zoom: here ? 14 : 13 }} onReady={(m) => { mapRef.current = m; draw(m); }} onClick={onMapClick} />
        <div className="map-float" style={{ top: 'calc(12px + var(--safe-t))', left: 12, right: 12 }}>
          <Segmented label="Routes view" value={mode} onChange={(m) => { setMode(m); setSelected(null); }} options={[{ value: 'saved', label: 'Saved' }, { value: 'plan', label: 'Plan' }, { value: 'discover', label: 'Discover' }]} />
        </div>
        <div className="map-float" style={{ bottom: 12, left: 12 }}><StylePicker value={styleId} onChange={setStyleId} /></div>
        {mode === 'plan' && waypoints.length === 0 && <div className="map-float gps-pill" style={{ bottom: 64, left: '50%', transform: 'translateX(-50%)' }}>Tap the map to add waypoints</div>}
      </div>

      <div className="stack-lg" style={{ marginTop: 16 }}>
        {stats && (
          <div className="card stack">
            <div className="row between">
              <div><div className="faint small">Distance</div><div style={{ fontSize: 26, fontWeight: 800 }} className="tnum">{fmtDistance(stats.dist, u, true)}</div></div>
              <div style={{ textAlign: 'right' }}><div className="faint small">Elevation gain</div><div style={{ fontSize: 26, fontWeight: 800 }} className="tnum">{stats.gain != null ? fmtElevation(stats.gain, u, true) : '—'}</div></div>
            </div>
            {profile && <ElevationChart distances={profile.d} elevations={profile.e} height={90} formatX={(m) => fmtDistance(m, u, true)} formatY={(m) => fmtElevation(m, u, true)} />}
          </div>
        )}

        {mode === 'plan' && (
          <div className="card stack">
            <div className="list-row"><span>Snap to walking paths</span><Switch checked={snap} onChange={setSnap} label="Snap to walking paths" /></div>
            <div className="list-row"><span>Return to start (loop)</span><Switch checked={loopBack} onChange={setLoopBack} label="Return to start (loop)" /></div>
            {planned && !planned.snapped && snap && <div className="banner">Routing service unavailable — using straight lines.</div>}
            <div className="row">
              <button className="btn sm" onClick={() => setWaypoints((w) => w.slice(0, -1))} disabled={!waypoints.length}><Icon name="undo" size={16} /> Undo</button>
              <button className="btn sm ghost" onClick={() => setWaypoints([])} disabled={!waypoints.length}>Clear</button>
              {routing && <span className="spinner" />}
            </div>
            <div className="field"><label>Route name</label><input className="input" placeholder="Evening loop" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <button className="btn primary block" disabled={!planned || planned.geometry.length < 2} onClick={() => planned && save(planned, waypoints, 'planned', 'Planned route')}>Save route</button>
          </div>
        )}

        {mode === 'discover' && (
          <div className="card stack">
            <div className="faint small">Round-trip loops from {here ? 'your location' : 'the map centre'}, following walkable streets and paths.</div>
            <div className="chips">
              {[2, 3, 5, 8, 10].map((k) => <button key={k} className={`chip ${targetKm === k ? 'on' : ''}`} onClick={() => setTargetKm(k)}>{k} {u === 'imperial' ? 'mi' : 'km'}</button>)}
            </div>
            <button className="btn primary block" onClick={discover} disabled={generating}>{generating ? <span className="spinner" /> : <Icon name="shuffle" size={18} />} {loops.length ? 'Shuffle loops' : 'Find loops'}</button>
            {loops.length > 0 && (
              <>
                <div className="row">
                  {loops.map((l, i) => (
                    <button key={i} className={`template-card ${picked === i ? 'on' : ''}`} onClick={() => setPicked(i)} style={{ borderColor: picked === i ? LOOP_COLORS[i] : undefined }}>
                      <div style={{ width: 10, height: 10, borderRadius: 5, background: LOOP_COLORS[i], margin: '0 auto 4px' }} />
                      {fmtDistance(l.distanceM, u, true)}
                    </button>
                  ))}
                </div>
                <div className="field"><label>Route name</label><input className="input" placeholder={`${targetKm} ${u === 'imperial' ? 'mi' : 'km'} loop`} value={name} onChange={(e) => setName(e.target.value)} /></div>
                <button className="btn block" onClick={() => save(loops[picked], loops[picked].waypoints, 'discovered', `${targetKm} ${u === 'imperial' ? 'mi' : 'km'} loop`)}>Save this loop</button>
              </>
            )}
          </div>
        )}

        {mode === 'saved' && (
          <div className="stack">
            {!routes?.length && <div className="card empty">No saved routes yet. Plan one, discover a loop, or save a past walk as a route.</div>}
            {routes?.map((r) => (
              <div key={r.id} className="card tight stack" style={{ borderColor: selected?.id === r.id ? 'var(--accent)' : undefined }}>
                <button type="button" className="card-btn" aria-pressed={selected?.id === r.id} onClick={() => { setSelected(r); fit(r.geometry); }}>
                  <RouteThumb coords={simplifyToCount(r.geometry, 80)} color="#4ea1ff" />
                  <div className="grow">
                    <h3>{r.name}</h3>
                    <div className="faint small">{fmtDistance(r.distanceM, u, true)}{r.elevGainM != null ? ` · ↑ ${fmtElevation(r.elevGainM, u, true)}` : ''} · {r.source}</div>
                  </div>
                </button>
                {selected?.id === r.id && (
                  <div className="row wrap">
                    <button className="btn primary sm" onClick={() => nav(`/record?route=${r.id}`)}><Icon name="walk" size={16} /> Walk it</button>
                    <button className="btn sm" onClick={() => saveBlob(new Blob([routeToGpx(r.name, r.geometry)], { type: 'application/gpx+xml' }), `${slug(r.name)}.gpx`).catch((e) => toast(`Could not save the file: ${(e as Error).message}`))}><Icon name="download" size={16} /> GPX</button>
                    <button className="btn sm" aria-label="Rename route" onClick={async () => { const n = prompt('Rename route', r.name); if (n) await db.routes.update(r.id, { name: n, updatedAt: Date.now() }); }}><Icon name="edit" size={16} /></button>
                    <button className="btn sm danger" aria-label="Delete route" onClick={async () => { if (confirm('Delete route?')) { await db.routes.delete(r.id); setSelected(null); } }}><Icon name="trash" size={16} /></button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
