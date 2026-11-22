import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { Icon } from '../components/Icon';
import { BarChart, ProgressRing } from '../components/Charts';
import { Segmented, Sheet, useActivities, useSettings } from '../components/ui';
import { bucketize, computeRecords, goalProgress, dayStreak, weekStreak, type PersonalRecord } from '../lib/records';
import { distanceValue, fmtDate, fmtDistance, fmtDuration, fmtDurationShort, fmtElevation, fmtNumber, distanceUnit, M_PER_MI, FT_PER_M, uid } from '../lib/format';
import type { Goal, GoalMetric, GoalPeriod, Units } from '../types';

const METRIC_LABEL: Record<GoalMetric, string> = { distance: 'Distance', duration: 'Time', count: 'Walks', elevation: 'Elevation', steps: 'Steps' };
const PERIOD_LABEL: Record<GoalPeriod, string> = { day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' };

export function goalLabel(g: Goal) { return `${PERIOD_LABEL[g.period]} ${METRIC_LABEL[g.metric].toLowerCase()} goal`; }

export function fmtGoalValue(metric: GoalMetric, v: number, units: Units): string {
  switch (metric) {
    case 'distance': return `${fmtDistance(v, units)} ${distanceUnit(units)}`;
    case 'duration': return fmtDurationShort(v);
    case 'count': return `${Math.round(v)}`;
    case 'elevation': return fmtElevation(v, units, true);
    case 'steps': return fmtNumber(v);
  }
}

/** Goal target in user-facing units → stored base units. */
function toBase(metric: GoalMetric, v: number, units: Units) {
  if (metric === 'distance') return units === 'imperial' ? v * M_PER_MI : v * 1000;
  if (metric === 'duration') return v * 60;
  if (metric === 'elevation') return units === 'imperial' ? v / FT_PER_M : v;
  return v;
}
function fromBase(metric: GoalMetric, v: number, units: Units) {
  if (metric === 'distance') return distanceValue(v, units);
  if (metric === 'duration') return v / 60;
  if (metric === 'elevation') return units === 'imperial' ? v * FT_PER_M : v;
  return v;
}
const unitHint = (m: GoalMetric, u: Units) => (m === 'distance' ? distanceUnit(u) : m === 'duration' ? 'minutes' : m === 'elevation' ? (u === 'imperial' ? 'ft' : 'm') : m === 'steps' ? 'steps' : 'walks');

function prValue(r: PersonalRecord, units: Units) {
  switch (r.kind) {
    case 'time': return fmtDuration(r.value);
    case 'distance': return `${fmtDistance(r.value, units)} ${distanceUnit(units)}`;
    case 'duration': return fmtDuration(r.value);
    case 'elevation': return fmtElevation(r.value, units, true);
    case 'steps': return fmtNumber(r.value);
  }
}

export function ProgressPage() {
  const settings = useSettings();
  const u = settings.units;
  const activities = useActivities() ?? [];
  const goals = useLiveQuery(() => db.goals.toArray(), []) ?? [];
  const [metric, setMetric] = useState<GoalMetric>('distance');
  const [period, setPeriod] = useState<'week' | 'month'>('week');
  const [editing, setEditing] = useState<Goal | null>(null);
  const [target, setTarget] = useState('');

  const records = computeRecords(activities);
  const buckets = bucketize(activities, metric, period, 12);
  const totalDist = activities.reduce((s, a) => s + a.stats.distanceM, 0);
  const totalTime = activities.reduce((s, a) => s + a.stats.movingS, 0);
  const totalElev = activities.reduce((s, a) => s + a.stats.elevGainM, 0);

  const openNew = () => { setEditing({ id: uid(), metric: 'distance', period: 'week', target: 20000, createdAt: Date.now() }); setTarget('20'); };
  const openEdit = (g: Goal) => { setEditing(g); setTarget(String(+fromBase(g.metric, g.target, u).toFixed(1))); };
  const saveGoal = async () => {
    if (!editing) return;
    const v = parseFloat(target);
    if (!(v > 0)) return;
    await db.goals.put({ ...editing, target: toBase(editing.metric, v, u) });
    setEditing(null);
  };

  return (
    <div className="page">
      <div className="page-head"><h1>Progress</h1></div>
      <div className="stack-lg">
        <section className="stack">
          <div className="section-title"><h2>Goals</h2><button className="btn sm" onClick={openNew}><Icon name="plus" size={16} /> New goal</button></div>
          {goals.length === 0 && <div className="card muted small">No goals yet. A weekly distance goal is a great start — the Today screen tracks it.</div>}
          {goals.map((g) => {
            const p = goalProgress(g, activities);
            return (
              <div key={g.id} className="card row link" style={{ gap: 16 }} onClick={() => openEdit(g)}>
                <ProgressRing fraction={p.fraction} expected={p.expectedFraction} size={72} stroke={8}><strong style={{ fontSize: 15 }}>{Math.round(p.fraction * 100)}%</strong></ProgressRing>
                <div className="grow">
                  <h3>{goalLabel(g)}</h3>
                  <div className="tnum" style={{ marginTop: 4 }}><strong>{fmtGoalValue(g.metric, p.value, u)}</strong> <span className="muted">of {fmtGoalValue(g.metric, g.target, u)}</span></div>
                  <div className="faint small">{p.fraction >= 1 ? 'Completed ✓' : `${fmtGoalValue(g.metric, Math.max(0, g.target - p.value), u)} to go · ends ${fmtDate(p.end - 1)}`}</div>
                </div>
              </div>
            );
          })}
        </section>

        <section className="card stack">
          <div className="row between wrap">
            <h2>Trends</h2>
            <Segmented value={period} onChange={setPeriod} options={[{ value: 'week', label: 'Weeks' }, { value: 'month', label: 'Months' }]} />
          </div>
          <div className="chips">
            {(['distance', 'duration', 'count', 'elevation', 'steps'] as GoalMetric[]).map((m) => (
              <button key={m} className={`chip ${metric === m ? 'on' : ''}`} onClick={() => setMetric(m)}>{METRIC_LABEL[m]}</button>
            ))}
          </div>
          <BarChart data={buckets} format={(v) => fmtGoalValue(metric, v, u)} />
        </section>

        <section className="stack">
          <div className="section-title"><h2>Personal records</h2><Icon name="trophy" className="muted" /></div>
          {records.length === 0 && <div className="card muted small">Records appear after your first walk. Fastest 1 km / mile / 5 km / 10 km are measured on any stretch of a walk.</div>}
          <div className="card" style={{ padding: '4px 16px' }}>
            {records.map((r) => (
              <Link key={r.key} to={`/activity/${r.activityId}`} className="list-row">
                <div><div style={{ fontWeight: 650 }}>{r.label}</div><div className="faint small">{fmtDate(r.achievedAt, { day: 'numeric', month: 'short', year: 'numeric' })}</div></div>
                <strong className="tnum">{prValue(r, u)}</strong>
              </Link>
            ))}
          </div>
        </section>

        <section className="card">
          <h2 style={{ marginBottom: 14 }}>All time</h2>
          <div className="stat-grid">
            <div className="stat"><div className="label">Walks</div><div className="value">{activities.length}</div></div>
            <div className="stat"><div className="label">Distance</div><div className="value">{fmtDistance(totalDist, u)}<small>{distanceUnit(u)}</small></div></div>
            <div className="stat"><div className="label">Time</div><div className="value">{fmtDurationShort(totalTime)}</div></div>
            <div className="stat"><div className="label">Climbed</div><div className="value">{fmtElevation(totalElev, u)}<small>{u === 'imperial' ? 'ft' : 'm'}</small></div></div>
            <div className="stat"><div className="label">Day streak</div><div className="value">{dayStreak(activities)}</div></div>
            <div className="stat"><div className="label">Week streak</div><div className="value">{weekStreak(activities)}</div></div>
          </div>
        </section>
      </div>

      <Sheet open={!!editing} onClose={() => setEditing(null)} title={editing && goals.some((g) => g.id === editing.id) ? 'Edit goal' : 'New goal'}>
        {editing && (
          <div className="stack">
            <div className="field"><label>Metric</label>
              <select className="input" value={editing.metric} onChange={(e) => setEditing({ ...editing, metric: e.target.value as GoalMetric })}>
                {Object.entries(METRIC_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div className="field"><label>Period</label>
              <Segmented value={editing.period} onChange={(p) => setEditing({ ...editing, period: p })} options={(['day', 'week', 'month', 'year'] as GoalPeriod[]).map((p) => ({ value: p, label: PERIOD_LABEL[p] }))} />
            </div>
            <div className="field"><label>Target ({unitHint(editing.metric, u)})</label><input className="input" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} /></div>
            <button className="btn primary block" onClick={saveGoal}>Save goal</button>
            {goals.some((g) => g.id === editing.id) && <button className="btn danger block" onClick={async () => { await db.goals.delete(editing.id); setEditing(null); }}>Delete goal</button>}
          </div>
        )}
      </Sheet>
    </div>
  );
}
