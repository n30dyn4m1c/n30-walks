import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db } from '../db/db';
import { Icon } from '../components/Icon';
import { ProgressRing, RouteThumb } from '../components/Charts';
import { useActivities, useSettings, useToast, Stat } from '../components/ui';
import { goalProgress, dayStreak, weekStreak, periodStart, metricValue } from '../lib/records';
import { fmtDate, fmtDistance, fmtDuration, fmtDurationShort, fmtPace, fmtElevation, distanceUnit, fmtNumber } from '../lib/format';
import { seedDemoData } from '../lib/activityBuilder';
import { useRecorder } from '../tracking/recorder';
import { DraftCard } from '../components/DraftCard';
import type { Activity, Goal } from '../types';
import { goalLabel, fmtGoalValue } from './Progress';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function ActivityRow({ a }: { a: Activity }) {
  const s = useSettings();
  return (
    <Link to={`/activity/${a.id}`} className="card tight link row" style={{ gap: 14 }}>
      <RouteThumb coords={a.preview} />
      <div className="grow">
        <div className="row between">
          <h3 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</h3>
          {a.source !== 'gps' && <span className="badge gray">{a.source}</span>}
        </div>
        <div className="faint small" style={{ margin: '2px 0 6px' }}>{fmtDate(a.startedAt)} · {new Date(a.startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</div>
        <div className="row small tnum" style={{ gap: 14 }}>
          <span><strong>{fmtDistance(a.stats.distanceM, s.units)}</strong> {distanceUnit(s.units)}</span>
          <span>{fmtDuration(a.stats.movingS)}</span>
          <span className="muted">{fmtPace(a.stats.avgPaceSPerKm, s.units, true)}</span>
        </div>
      </div>
    </Link>
  );
}

export function HomePage() {
  const settings = useSettings();
  const activities = useActivities();
  const goals = useLiveQuery(() => db.goals.toArray(), []);
  const draft = useLiveQuery(() => db.drafts.get('draft'), []);
  const rec = useRecorder();
  const toast = useToast();
  const [seeding, setSeeding] = useState(false);

  if (!activities) return <div className="page" />;
  const units = settings.units;
  const weekStart = periodStart(Date.now(), 'week');
  const week = activities.filter((a) => a.startedAt >= weekStart);
  const weekDist = week.reduce((s, a) => s + a.stats.distanceM, 0);
  const weekTime = week.reduce((s, a) => s + a.stats.movingS, 0);
  const weekSteps = week.reduce((s, a) => s + metricValue(a, 'steps'), 0);
  const goal: Goal = goals?.[0] ?? { id: 'implicit', metric: 'distance', period: 'week', target: 20000, createdAt: 0 };
  const gp = goalProgress(goal, activities);
  const latest = activities[0];

  const seed = async () => {
    setSeeding(true);
    try {
      const n = await seedDemoData(settings);
      toast(`Added ${n} demo walks`);
    } catch (e) {
      toast(`Could not create demo data: ${(e as Error).message}`);
    } finally { setSeeding(false); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="faint small">{fmtDate(Date.now(), { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          <h1>{greeting()}</h1>
        </div>
        <Link to="/settings" className="icon-btn" aria-label="Settings"><Icon name="settings" /></Link>
      </div>

      <div className="stack-lg">
        {draft && rec.status === 'idle' && <DraftCard draft={draft} />}

        <div className="hero-card">
          <div className="row" style={{ gap: 18 }}>
            <ProgressRing fraction={gp.fraction} expected={gp.expectedFraction} size={128}>
              <div>
                <div style={{ fontSize: 26, fontWeight: 800 }}>{Math.round(gp.fraction * 100)}%</div>
                <div className="faint" style={{ fontSize: 11 }}>{goal.period === 'week' ? 'this week' : `this ${goal.period}`}</div>
              </div>
            </ProgressRing>
            <div className="grow stack" style={{ gap: 6 }}>
              <div className="faint small">{goalLabel(goal)}</div>
              <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1.15 }} className="tnum">
                {fmtGoalValue(goal.metric, gp.value, units)}<span className="muted" style={{ fontSize: 15, fontWeight: 600 }}> / {fmtGoalValue(goal.metric, goal.target, units)}</span>
              </div>
              <div className="muted small">
                {gp.fraction >= 1 ? 'Goal reached — nice work! 🎉' : gp.fraction >= gp.expectedFraction ? 'Ahead of pace' : 'A walk today keeps you on track'}
              </div>
            </div>
          </div>
          <div className="stat-grid" style={{ marginTop: 18 }}>
            <Stat label="Week" value={fmtDistance(weekDist, units)} unit={distanceUnit(units)} />
            <Stat label="Time" value={fmtDurationShort(weekTime)} />
            <Stat label="Steps" value={fmtNumber(weekSteps)} />
          </div>
          <Link to="/record" className="btn primary lg block" style={{ marginTop: 18 }}><Icon name="walk" /> {rec.status === 'recording' || rec.status === 'paused' ? 'Back to your walk' : 'Start a walk'}</Link>
        </div>

        <div className="stat-grid two">
          <div className="card row"><Icon name="flame" className="muted" /><div><div style={{ fontSize: 22, fontWeight: 800 }}>{dayStreak(activities)}</div><div className="faint small">day streak</div></div></div>
          <div className="card row"><Icon name="target" className="muted" /><div><div style={{ fontSize: 22, fontWeight: 800 }}>{weekStreak(activities)}</div><div className="faint small">week streak</div></div></div>
        </div>

        {latest ? (
          <div className="stack">
            <div className="section-title"><h2>Latest walk</h2><Link to="/history" className="muted small">See all</Link></div>
            <ActivityRow a={latest} />
            <div className="row">
              <Link to={`/studio/${latest.id}`} className="btn block"><Icon name="cube" size={18} /> 3D flyover & Status</Link>
            </div>
            {latest.stats.elevGainM > 0 && <div className="faint small">Climbed {fmtElevation(latest.stats.elevGainM, units, true)} · {latest.stats.estKcal} kcal (est.)</div>}
          </div>
        ) : (
          <div className="card empty stack">
            <Icon name="walk" size={36} />
            <h2>No walks yet</h2>
            <p className="muted" style={{ margin: 0 }}>Record your first walk, or load a set of demo walks to explore the map, 3D flyover and WhatsApp Status export right away.</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <Link to="/record" className="btn primary">Record a walk</Link>
              <button className="btn" onClick={seed} disabled={seeding}>{seeding ? <span className="spinner" /> : 'Load demo walks'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
