import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clearAllData, db, deleteActivitiesBySource, exportBackup, importBackup, requestPersistentStorage, storageProtection, updateSettings, type StorageProtection } from '../db/db';
import { Icon } from '../components/Icon';
import { Segmented, Switch, useSettings, useToast } from '../components/ui';
import { MAP_STYLE_LIST } from '../lib/mapStyles';
import { seedDemoData, recomputeAllActivities } from '../lib/activityBuilder';
import { saveBlob } from '../media/share';
import { fmtDate } from '../lib/format';
import { isNative } from '../tracking/providers';
import { APP_VERSION, clearLog, formatDiagnostics, readLog } from '../lib/diagnostics';
import type { Units } from '../types';

export function SettingsPage() {
  const s = useSettings();
  const toast = useToast();
  const nav = useNavigate();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const [protection, setProtection] = useState<StorageProtection>('unknown');
  useEffect(() => { storageProtection().then(setProtection); }, []);

  /** Units/weight/stride affect splits, steps and kcal: recompute stored activities. */
  const setAndRecompute = async (patch: Parameters<typeof updateSettings>[0]) => {
    await updateSettings(patch);
    const n = await recomputeAllActivities();
    if (n) toast(`Saved · recalculated ${n} walk${n === 1 ? '' : 's'}`);
  };

  const backup = async () => {
    try {
      const outcome = await saveBlob(new Blob([await exportBackup()], { type: 'application/json' }), `stride-backup-${new Date().toISOString().slice(0, 10)}.json`);
      if (outcome !== 'cancelled') await updateSettings({ lastBackupAt: Date.now() });
    } catch (e) {
      toast(`Backup failed: ${(e as Error).message}`);
    }
  };

  /** Device facts and the recent error log, for bug reports. Never includes locations or walk names. */
  const copyDiagnostics = async () => {
    try {
      const [entries, walks, routes, draft, estimate] = await Promise.all([
        readLog(), db.activities.count(), db.routes.count(), db.drafts.count(),
        navigator.storage?.estimate?.().catch(() => undefined),
      ]);
      const text = formatDiagnostics({
        appVersion: APP_VERSION,
        platform: isNative() ? 'native' : 'web',
        facts: {
          'Walks': walks, 'Routes': routes, 'Unfinished draft': draft > 0,
          'Storage protection': protection,
          'Storage used': estimate?.usage != null ? `${(estimate.usage / 1e6).toFixed(1)} MB of ${((estimate.quota ?? 0) / 1e6).toFixed(0)} MB` : undefined,
          'Online': navigator.onLine, 'Service worker': !!navigator.serviceWorker?.controller,
          'Keep screen on': s.keepScreenOn, 'Max GPS accuracy (m)': s.maxAccuracyM, 'Units': s.units,
          'Last backup': s.lastBackupAt ? new Date(s.lastBackupAt).toISOString() : 'never',
        },
      }, entries);
      try {
        await navigator.clipboard.writeText(text);
        toast(`Diagnostics copied (${entries.length} log entr${entries.length === 1 ? 'y' : 'ies'})`);
      } catch {
        // No clipboard (insecure context, native WebView without permission): save a file instead.
        await saveBlob(new Blob([text], { type: 'text/plain' }), `stride-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`);
      }
    } catch (e) {
      toast(`Could not collect diagnostics: ${(e as Error).message}`);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <button className="icon-btn" onClick={() => nav(-1)} aria-label="Back"><Icon name="back" /></button>
        <h1 className="grow">Settings</h1>
      </div>
      <div className="stack-lg">
        <div className="card stack">
          <h3>Units & body</h3>
          <Segmented<Units> label="Units" value={s.units} onChange={(units) => setAndRecompute({ units })} options={[{ value: 'metric', label: 'Kilometres' }, { value: 'imperial', label: 'Miles' }]} />
          <div className="row">
            <div className="field grow"><label>Weight (kg) — for calories</label><input className="input" inputMode="decimal" defaultValue={s.weightKg} key={`w${s.weightKg}`} onBlur={(e) => { const v = parseFloat(e.target.value); if (v > 20 && v < 300) setAndRecompute({ weightKg: v }); }} /></div>
            <div className="field grow"><label>Stride (m) — for steps</label><input className="input" inputMode="decimal" defaultValue={s.strideM} key={`s${s.strideM}`} onBlur={(e) => { const v = parseFloat(e.target.value); if (v > 0.3 && v < 1.5) setAndRecompute({ strideM: v }); }} /></div>
          </div>
        </div>

        <div className="card stack">
          <h3>Recording</h3>
          <div className="field">
            <label>Ignore GPS fixes worse than ±{s.maxAccuracyM} m</label>
            <input type="range" className="scrubber" min={10} max={80} step={5} value={s.maxAccuracyM} onChange={(e) => updateSettings({ maxAccuracyM: Number(e.target.value) })} />
          </div>
          <div className="list-row"><span>Keep screen on while recording</span><Switch checked={s.keepScreenOn} onChange={(v) => updateSettings({ keepScreenOn: v })} label="Keep screen on while recording" /></div>
          <div className="faint small">{isNative() ? 'Native build: GPS continues in the background via a foreground service.' : 'Web: GPS works while this page is visible. For screen-off tracking use the Android/iOS build.'}</div>
        </div>

        <div className="card stack">
          <h3>Default map</h3>
          <div className="chips">{MAP_STYLE_LIST.map((m) => <button key={m.id} aria-pressed={s.defaultMapStyle === m.id} className={`chip ${s.defaultMapStyle === m.id ? 'on' : ''}`} onClick={() => updateSettings({ defaultMapStyle: m.id })}>{m.label}</button>)}</div>
        </div>

        <div className="card stack">
          <h3>Your data</h3>
          <p className="muted small" style={{ margin: 0 }}>Your walks stay on this device. No account, no cloud, no social features. A backup file is the only copy outside this device.</p>
          <p className="faint small" style={{ margin: 0 }}>Some features use online services, which see the area you are looking at but never your walks: map tiles (OpenFreeMap, CARTO, Esri), terrain and elevation (AWS Open Data), and route planning (routing.openstreetmap.de, which receives your waypoints).</p>
          <div className="list-row">
            <span>Last backup</span>
            <span className={s.lastBackupAt ? 'muted small' : 'small'} style={s.lastBackupAt ? undefined : { color: 'var(--warn)' }}>{s.lastBackupAt ? fmtDate(s.lastBackupAt) : 'Never'}</span>
          </div>
          {!isNative() && protection !== 'unknown' && (
            <div className="list-row">
              <span>
                Browser storage
                <div className="faint small">{protection === 'persistent' ? 'Protected: the browser won’t clear your walks to free space.' : 'Not protected: the browser may clear your walks if space runs low or the site goes unused.'}</div>
              </span>
              {protection !== 'persistent' && <button className="btn sm" onClick={async () => { const r = await requestPersistentStorage(); setProtection(r); toast(r === 'persistent' ? 'Storage protected' : 'The browser declined. Install the app or make regular backups.'); }}>Protect</button>}
            </div>
          )}
          <div className="row wrap">
            <button className="btn sm" onClick={backup}><Icon name="download" size={16} /> Export backup</button>
            <button className="btn sm" onClick={() => file.current?.click()}><Icon name="upload" size={16} /> Import backup</button>
            <input ref={file} type="file" accept="application/json,.json" hidden onChange={async (e) => {
              const f = e.target.files?.[0]; e.target.value = '';
              if (!f) return;
              try {
                const r = await importBackup(await f.text());
                if (r.staleStats) await recomputeAllActivities();
                toast(`Imported ${r.activities} walks, ${r.routes} routes${r.goals ? `, ${r.goals} goals` : ''}${r.skipped ? ` · skipped ${r.skipped} damaged record${r.skipped === 1 ? '' : 's'}` : ''}`);
              } catch (err) { toast((err as Error).message); }
            }} />
            <button className="btn sm" disabled={busy} onClick={async () => { setBusy(true); try { toast(`Added ${await seedDemoData(s)} demo walks`); } finally { setBusy(false); } }}>{busy ? <span className="spinner" /> : 'Add demo walks'}</button>
            <button className="btn sm" disabled={busy} onClick={async () => { const n = await deleteActivitiesBySource(['demo']); toast(n ? `Removed ${n} demo walks` : 'No demo walks to remove'); }}>Remove demo walks</button>
            <button className="btn sm danger" onClick={async () => { if (confirm('Delete ALL walks, routes and goals? This cannot be undone.')) { await clearAllData(); toast('All data deleted'); } }}><Icon name="trash" size={16} /> Delete all</button>
          </div>
        </div>
        <div className="card stack">
          <h3>Diagnostics</h3>
          <p className="faint small" style={{ margin: 0 }}>Stride keeps a short log of errors on this device. Copy it into a bug report if something goes wrong. It contains no locations or walk names.</p>
          <div className="row wrap">
            <button className="btn sm" onClick={copyDiagnostics}>Copy diagnostics</button>
            <button className="btn sm" onClick={async () => { await clearLog(); toast('Log cleared'); }}>Clear log</button>
          </div>
        </div>
        <div className="faint small" style={{ textAlign: 'center' }}>Stride {APP_VERSION} · Map data © OpenStreetMap contributors · Terrain © Mapzen/AWS Open Data</div>
      </div>
    </div>
  );
}
