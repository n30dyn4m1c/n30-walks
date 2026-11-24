import { useEffect, useMemo, useRef, useState } from 'react';
import { styleReady } from '../lib/mapStyles';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import type maplibregl from 'maplibre-gl';
import { db, deleteActivity } from '../db/db';
import { MapView } from '../components/MapView';
import { Icon } from '../components/Icon';
import { ElevationChart } from '../components/Charts';
import { Sheet, Stat, StylePicker, useActivities, useSettings, useToast } from '../components/ui';
import { addEndpoints, addRouteLayers, paceGradient, setHighlight } from '../lib/mapLayers';
import { rollingPace, toLngLat } from '../lib/stats';
import { cumulativeDistances, simplifyToCount } from '../lib/geo';
import { recordsSetBy } from '../lib/records';
import { trackToGpx } from '../lib/gpx';
import { enrichElevation } from '../lib/activityBuilder';
import { saveBlob, slug } from '../media/share';
import { distanceUnit, elevationUnit, fmtDate, fmtDistance, fmtDuration, fmtElevation, fmtNumber, fmtPace, fmtTime, paceUnit, uid } from '../lib/format';
import type { MapStyleId } from '../types';

export function ActivityPage() {
  const { id = '' } = useParams();
  const settings = useSettings();
  const u = settings.units;
  const nav = useNavigate();
  const toast = useToast();
  const activity = useLiveQuery(() => db.activities.get(id), [id]);
  const track = useLiveQuery(() => db.tracks.get(id), [id]);
  const all = useActivities();
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [styleId, setStyleId] = useState<MapStyleId>(settings.defaultMapStyle);
  const [terrain, setTerrain] = useState(true);
  const [paceColors, setPaceColors] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');

  const coords = useMemo(() => (track ? toLngLat(track.points) : []), [track]);
  const gradient = useMemo(() => (track && paceColors ? paceGradient(coords, rollingPace(track.points)) : null), [track, coords, paceColors]);
  const profile = useMemo(() => {
    if (!track) return null;
    const eles = track.points.map((p) => p.ele);
    if (eles.some((e) => e == null)) return null;
    return { d: cumulativeDistances(coords), e: eles as number[] };
  }, [track, coords]);
  // Walks saved without terrain elevation (offline at the end) get it filled in now.
  const elevationSource = activity?.stats.elevationSource;
  useEffect(() => {
    if (activity && elevationSource !== 'dem' && navigator.onLine !== false) {
      enrichElevation(activity.id).then((done) => { if (done) toast('Elevation updated from the terrain model'); }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity?.id, elevationSource]);
  const prs = useMemo(() => (all && activity ? recordsSetBy(activity.id, all) : []), [all, activity]);

  const draw = (map: maplibregl.Map) => {
    if (!coords.length || !styleReady(map)) return;
    if (map.getLayer('act-line')) { map.removeLayer('act-line'); map.removeLayer('act-casing'); }
    addRouteLayers(map, 'act', coords, { color: settings.overlay.routeColor, gradient, width: 5 });
    addEndpoints(map, 'act-ends', coords[0], coords[coords.length - 1]);
  };
  useEffect(() => { if (mapRef.current) draw(mapRef.current); }, [coords, gradient]);

  if (activity === undefined || track === undefined) return <div className="page"><span className="spinner" /></div>;
  if (!activity || !track) return <div className="page empty">Walk not found. <Link to="/history" className="btn sm">Back</Link></div>;
  const s = activity.stats;

  const saveEdit = async () => {
    await db.activities.update(activity.id, { name: name.trim() || activity.name, notes, updatedAt: Date.now() });
    setEditOpen(false);
  };
  const saveAsRoute = async () => {
    const now = Date.now();
    const geom = simplifyToCount(coords, 800);
    await db.routes.put({ id: uid(), name: activity.name, waypoints: [geom[0], geom[geom.length - 1]], geometry: geom, distanceM: s.distanceM, elevGainM: s.elevGainM, source: 'activity', snapped: true, createdAt: now, updatedAt: now });
    toast('Saved to your routes');
  };
  const remove = async () => {
    if (!confirm('Delete this walk permanently?')) return;
    await deleteActivity(activity.id);
    nav('/history', { replace: true });
  };

  return (
    <div className="page" style={{ paddingTop: 0 }}>
      <div className="map-wrap" style={{ height: '48vh', minHeight: 300, margin: '0 -16px', borderRadius: 0, borderLeft: 0, borderRight: 0, borderTop: 0 }}>
        <MapView styleId={styleId} terrain={terrain} exaggeration={1.4} bounds={activity.bbox} boundsPadding={{ top: 80, bottom: 40, left: 40, right: 40 }}
          initial={{ center: [(activity.bbox[0] + activity.bbox[2]) / 2, (activity.bbox[1] + activity.bbox[3]) / 2], zoom: 13, pitch: terrain ? 50 : 0 }}
          onReady={(m) => { mapRef.current = m; draw(m); }} />
        <div className="map-float" style={{ top: 'calc(12px + var(--safe-t))', left: 12, right: 12 }}>
          <div className="row between">
            <button className="icon-btn" onClick={() => nav(-1)} aria-label="Back"><Icon name="back" /></button>
            <div className="row" style={{ gap: 8 }}>
              <button className={`map-chip ${paceColors ? 'active' : ''}`} onClick={() => setPaceColors(!paceColors)} aria-pressed={paceColors}><Icon name="flame" size={16} /> Pace</button>
              <button className={`map-chip ${terrain ? 'active' : ''}`} onClick={() => setTerrain(!terrain)} aria-pressed={terrain}><Icon name="cube" size={16} /> 3D</button>
            </div>
          </div>
        </div>
        <div className="map-float" style={{ bottom: 12, left: 12 }}><StylePicker value={styleId} onChange={setStyleId} /></div>
      </div>

      <div className="stack-lg" style={{ marginTop: 18 }}>
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div className="grow">
            <h1 style={{ fontSize: 26 }}>{activity.name}</h1>
            <div className="faint small">{fmtDate(activity.startedAt, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · {fmtTime(activity.startedAt)}–{fmtTime(activity.endedAt)}</div>
            {activity.notes && <p className="muted" style={{ marginBottom: 0 }}>{activity.notes}</p>}
          </div>
          <button className="icon-btn" onClick={() => { setName(activity.name); setNotes(activity.notes ?? ''); setEditOpen(true); }} aria-label="Edit name and notes"><Icon name="edit" size={18} /></button>
        </div>

        {prs.length > 0 && (
          <div className="row wrap" style={{ gap: 6 }}>
            {prs.map((p) => <span key={p.key} className="badge"><Icon name="trophy" size={12} /> {p.label}</span>)}
          </div>
        )}

        <Link to={`/studio/${activity.id}`} className="btn primary lg block"><Icon name="cube" /> Play 3D flyover · Create Status</Link>

        <div className="card">
          <div className="stat-grid">
            <Stat label="Distance" value={fmtDistance(s.distanceM, u)} unit={distanceUnit(u)} size="lg" />
            <Stat label="Moving time" value={fmtDuration(s.movingS)} size="lg" />
            <Stat label="Avg pace" value={fmtPace(s.avgPaceSPerKm, u)} unit={paceUnit(u)} size="lg" />
            <Stat label="Elev gain" value={fmtElevation(s.elevGainM, u)} unit={elevationUnit(u)} />
            <Stat label="Elapsed" value={fmtDuration(s.elapsedS)} />
            <Stat label="Steps (est.)" value={fmtNumber(s.estSteps)} />
            <Stat label="Max elev" value={s.maxEleM != null ? fmtElevation(s.maxEleM, u) : '—'} unit={s.maxEleM != null ? elevationUnit(u) : ''} />
            <Stat label="Calories (est.)" value={fmtNumber(s.estKcal)} unit="kcal" />
            <Stat label="Avg speed" value={(u === 'imperial' ? s.avgSpeedMps * 2.23694 : s.avgSpeedMps * 3.6).toFixed(1)} unit={u === 'imperial' ? 'mph' : 'km/h'} />
          </div>
          {paceColors && gradient && <div className="legend" style={{ marginTop: 14 }}>Fast <span className="grad" /> Slow</div>}
        </div>

        {profile && (
          <div className="card">
            <div className="section-title" style={{ marginTop: 0, marginBottom: 8 }}><h3>Elevation</h3><span className="faint small">{s.elevationSource === 'dem' ? 'terrain model' : 'GPS altitude'}</span></div>
            <ElevationChart distances={profile.d} elevations={profile.e}
              formatX={(m) => fmtDistance(m, u, true)} formatY={(m) => fmtElevation(m, u, true)}
              onHover={(i) => { const m = mapRef.current; if (m && styleReady(m)) setHighlight(m, i == null ? null : coords[i]); }} />
          </div>
        )}

        {s.splits.length > 0 && (
          <div className="card">
            <h3 style={{ marginBottom: 6 }}>Splits</h3>
            <table className="splits">
              <thead><tr><th>{distanceUnit(u)}</th><th>Pace</th><th style={{ width: '40%' }} /><th style={{ textAlign: 'right' }}>Elev</th></tr></thead>
              <tbody>
                {(() => {
                  const fastest = Math.min(...s.splits.map((x) => x.paceSPerKm));
                  return s.splits.map((sp) => (
                    <tr key={sp.index}>
                      <td>{sp.distanceM < (u === 'imperial' ? 1609 : 1000) - 1 ? fmtDistance(sp.distanceM, u) : sp.index}</td>
                      <td>{fmtPace(sp.paceSPerKm, u)}</td>
                      <td><div className="pace-bar" style={{ width: `${Math.max(12, (fastest / sp.paceSPerKm) * 100)}%`, opacity: sp.paceSPerKm === fastest ? 1 : 0.55 }} /></td>
                      <td style={{ textAlign: 'right' }} className="muted">{sp.elevDeltaM >= 0 ? '+' : ''}{fmtElevation(sp.elevDeltaM, u)}</td>
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </div>
        )}

        <div className="row wrap">
          <button className="btn sm" onClick={saveAsRoute}><Icon name="routes" size={16} /> Save as route</button>
          <button className="btn sm" onClick={() => saveBlob(new Blob([trackToGpx(activity.name, track.points)], { type: 'application/gpx+xml' }), `${slug(activity.name)}.gpx`).catch((e) => toast(`Could not save the file: ${(e as Error).message}`))}><Icon name="download" size={16} /> Export GPX</button>
          <button className="btn sm danger" onClick={remove}><Icon name="trash" size={16} /> Delete</button>
        </div>
        <div className="faint small">{track.points.length} GPS points · source: {activity.source}{track.pauses.length ? ` · ${track.pauses.length} pause(s)` : ''}</div>
      </div>

      <Sheet open={editOpen} onClose={() => setEditOpen(false)} title="Edit walk">
        <div className="stack">
          <div className="field"><label>Name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label>Notes</label><textarea className="input" style={{ minHeight: 90, padding: 12 }} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          <button className="btn primary block" onClick={saveEdit}>Save</button>
        </div>
      </Sheet>
    </div>
  );
}
