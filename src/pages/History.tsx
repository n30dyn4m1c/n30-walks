import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useActivities, useSettings, useToast } from '../components/ui';
import { ActivityRow } from './Home';
import { Icon } from '../components/Icon';
import { fmtDistance, fmtDurationShort, distanceUnit, uid } from '../lib/format';
import { parseGpx } from '../lib/gpx';
import { buildAndSaveActivity } from '../lib/activityBuilder';
import { db, findDuplicateActivity } from '../db/db';
import { pathLength } from '../lib/geo';
import { hasVehicleStretch } from '../lib/stats';
import type { Activity } from '../types';

export function HistoryPage() {
  const activities = useActivities();
  const settings = useSettings();
  const toast = useToast();
  const nav = useNavigate();
  const file = useRef<HTMLInputElement>(null);

  const importGpx = async (f: File) => {
    try {
      const g = parseGpx(await f.text());
      if (g.hasTime) {
        const dup = await findDuplicateActivity(g.points[0].t, pathLength(g.coords));
        if (dup) { toast('This walk is already in your history'); nav(`/activity/${dup.id}`); return; }
        const mode = hasVehicleStretch(g.points) ? 'mixed' : 'walk';
        const a = await buildAndSaveActivity(g.points, { settings, source: 'gpx', name: g.name, mode });
        toast(mode === 'mixed' ? 'Imported as a mixed journey (it includes a ride)' : 'Imported walk');
        nav(`/activity/${a.id}`);
      } else {
        // No timestamps → it's a route, not a recorded activity.
        const now = Date.now();
        await db.routes.put({ id: uid(), name: g.name, waypoints: [g.coords[0], g.coords[g.coords.length - 1]], geometry: g.coords, distanceM: pathLength(g.coords), source: 'gpx', snapped: true, createdAt: now, updatedAt: now });
        toast('GPX has no timestamps — saved as a route');
        nav('/routes');
      }
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const groups = new Map<string, Activity[]>();
  for (const a of activities ?? []) {
    const k = new Date(a.startedAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(a);
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>History</h1>
        <button className="btn sm" onClick={() => file.current?.click()}><Icon name="upload" size={16} /> Import GPX</button>
        <input ref={file} type="file" accept=".gpx,application/gpx+xml,application/xml" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importGpx(f); e.target.value = ''; }} />
      </div>
      {activities && activities.length === 0 && <div className="empty">No walks recorded yet.</div>}
      <div className="stack-lg">
        {[...groups.entries()].map(([month, list]) => {
          const dist = list.reduce((s, a) => s + a.stats.distanceM, 0);
          const time = list.reduce((s, a) => s + a.stats.movingS, 0);
          return (
            <section key={month} className="stack">
              <div className="section-title">
                <h2>{month}</h2>
                <span className="faint small tnum">{list.length} walks · {fmtDistance(dist, settings.units)} {distanceUnit(settings.units)} · {fmtDurationShort(time)}</span>
              </div>
              {list.map((a) => <ActivityRow key={a.id} a={a} />)}
            </section>
          );
        })}
      </div>
    </div>
  );
}
