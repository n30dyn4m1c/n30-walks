/**
 * Flyover Studio: live 3D flyover preview in a 9:16 frame, overlay
 * customisation, and WhatsApp-ready MP4 / JPEG export.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import type maplibregl from 'maplibre-gl';
import { db, DEFAULT_SETTINGS, updateSettings } from '../db/db';
import { MapView } from '../components/MapView';
import { Icon } from '../components/Icon';
import { Segmented, Switch, useSettings, useToast } from '../components/ui';
import { buildFlyoverPlan, liveStatsAt, OUTRO, type FlyoverPlan } from '../flyover/plan';
import { FlyoverScene } from '../flyover/scene';
import { attributionFor, drawOverlay } from '../media/overlay';
import { keepAwake } from '../lib/wakeLock';
import { exportFlyoverVideo, outputSize, videoExportSupported, WHATSAPP_LIMIT_BYTES, type ExportProgress, type VideoResult } from '../media/videoExport';
import { exportStatusImage } from '../media/imageExport';
import { canShareFiles, saveBlob, shareBlob, slug } from '../media/share';
import { MAP_STYLE_LIST, styleReady } from '../lib/mapStyles';
import { fmtDuration } from '../lib/format';
import { enrichElevation } from '../lib/activityBuilder';
import type { Activity, OverlayConfig, Track } from '../types';

const ACCENTS = ['#b8f34a', '#ffffff', '#ffd166', '#4ea1ff', '#ff7ab6', '#2ee6c5'];
const ROUTE_COLORS = ['#ff5a36', '#b8f34a', '#4ea1ff', '#ffd166', '#ffffff', '#c084fc'];

type Result = { kind: 'video'; url: string; blob: Blob; info: VideoResult } | { kind: 'image'; url: string; blob: Blob };

export function StudioPage() {
  const { id = '' } = useParams();
  const activity = useLiveQuery(() => db.activities.get(id), [id]);
  const track = useLiveQuery(() => db.tracks.get(id), [id]);
  const [elevChecked, setElevChecked] = useState(false);
  // The flyover camera needs ground elevation along the route. Walks saved offline may lack it:
  // fill it in from the DEM now (track AND stats, so elevation gain stays consistent).
  useEffect(() => {
    if (!track || !activity || elevChecked) return;
    if (track.points.every((p) => p.ele != null) && activity.stats.elevationSource === 'dem') { setElevChecked(true); return; }
    enrichElevation(activity.id).catch(() => false).finally(() => setElevChecked(true));
  }, [track, activity, elevChecked]);
  if (activity === undefined || track === undefined || (track && !elevChecked)) return <div className="page"><span className="spinner" /></div>;
  if (!activity || !track) return <div className="page empty">Walk not found.</div>;
  return <Studio activity={activity} track={track} />;
}

function Studio({ activity, track }: { activity: Activity; track: Track }) {
  const settings = useSettings();
  const nav = useNavigate();
  const toast = useToast();
  const [cfg, setCfg] = useState<OverlayConfig>(() => ({ ...settings.overlay, title: activity.name }));
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const plan = useMemo<FlyoverPlan>(() => buildFlyoverPlan(track.points), [track]);

  // Persist look & feel (not the per-walk title) as the user's default. Sliders fire on
  // every input event, so the write is debounced, and flushed when leaving Studio.
  const pendingSave = useRef<number | null>(null);
  const flushSave = useCallback(() => {
    if (pendingSave.current == null) return;
    window.clearTimeout(pendingSave.current);
    pendingSave.current = null;
    const { title: _t, ...rest } = cfgRef.current;
    updateSettings({ overlay: { ...rest, title: '' } }).catch(() => {});
  }, []);
  useEffect(() => flushSave, [flushSave]);
  const patch = (p: Partial<OverlayConfig>) => {
    setCfg((c) => ({ ...c, ...p }));
    if (pendingSave.current != null) window.clearTimeout(pendingSave.current);
    pendingSave.current = window.setTimeout(flushSave, 300);
  };
  // Settings arrive asynchronously from IndexedDB: adopt the saved look once.
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || settings === DEFAULT_SETTINGS) return;
    hydrated.current = true;
    setCfg((c) => ({ ...settings.overlay, title: c.title }));
  }, [settings]);

  // ---------- player ----------
  const mapRef = useRef<maplibregl.Map | null>(null);
  const sceneRef = useRef<FlyoverScene | null>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(true);
  const [u, setU] = useState(0);
  const uRef = useRef(0);
  const playingRef = useRef(true);
  playingRef.current = playing;
  /** While exporting, the preview stops rendering so the encoder gets the whole GPU. */
  const exportingRef = useRef(false);

  const renderOverlay = useCallback((uu: number, distance: number) => {
    const c = overlayRef.current, frame = frameRef.current;
    if (!c || !frame) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(frame.clientWidth * dpr), h = Math.round(frame.clientHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    const s = activity.stats;
    const live = liveStatsAt(plan, distance);
    drawOverlay(ctx, w, h, cfgRef.current, {
      title: cfgRef.current.title || activity.name, dateMs: activity.startedAt, units: settings.units,
      // The flyover follows the whole track, so a mixed journey shows trip totals (live and final agree).
      totals: s.journey
        ? { distanceM: s.journey.distanceM, movingS: s.journey.movingS, paceSPerKm: s.journey.distanceM > 0 ? s.journey.movingS / (s.journey.distanceM / 1000) : 0, elevGainM: s.elevGainM, steps: s.estSteps }
        : { distanceM: s.distanceM, movingS: s.movingS, paceSPerKm: s.avgPaceSPerKm, elevGainM: s.elevGainM, steps: s.estSteps },
      live: uu < OUTRO ? { distanceM: live.distanceM, movingS: live.movingS, eleM: live.eleM } : undefined,
      progress: distance / plan.total, profile: plan.profile, attribution: attributionFor(cfgRef.current.mapStyle),
    });
  }, [activity, plan, settings.units]);

  const showFrame = useCallback((uu: number) => {
    const scene = sceneRef.current, map = mapRef.current;
    if (!scene || !map || !styleReady(map)) return;
    const cam = scene.setFrame(uu, performance.now() / 1000);
    renderOverlay(uu, cam.distance);
  }, [renderOverlay]);

  // Animation loop: u advances in real time over the configured video length.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastUi = 0;
    const loop = (now: number) => {
      const dt = now - last;
      last = now;
      if (playingRef.current) {
        let next = uRef.current + dt / (cfgRef.current.videoSeconds * 1000);
        if (next > 1) next = 0; // loop
        uRef.current = next;
        // Throttle React updates for the scrubber; the map/overlay render every frame regardless.
        if (now - lastUi > 120) { lastUi = now; setU(next); }
      }
      if (!exportingRef.current) showFrame(uRef.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [showFrame]);

  useEffect(() => { sceneRef.current?.setColor(cfg.routeColor); }, [cfg.routeColor]);
  useEffect(() => { sceneRef.current?.setExaggeration(cfg.exaggeration); }, [cfg.exaggeration]);

  const onMapReady = (map: maplibregl.Map) => {
    mapRef.current = map;
    const scene = new FlyoverScene(map, plan, cfgRef.current.routeColor, cfgRef.current.exaggeration);
    scene.install();
    sceneRef.current = scene;
  };

  // ---------- export ----------
  const [busy, setBusy] = useState<null | 'video' | 'image'>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(0);
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);
  // Leaving the studio cancels an export in progress (it would otherwise keep rendering off-screen).
  useEffect(() => () => abortRef.current?.abort(), []);

  const doExportVideo = async () => {
    setError(null); setResult(null); setBusy('video'); setPlaying(false);
    exportingRef.current = true;
    const ctl = new AbortController();
    abortRef.current = ctl;
    startedRef.current = performance.now();
    // An export can take minutes on a phone: if the screen sleeps, rendering stalls.
    const release = await keepAwake();
    let lastPass = 1;
    try {
      const info = await exportFlyoverVideo(activity, track, cfg, settings.units, (p) => {
        if ((p.pass ?? 1) !== lastPass) { lastPass = p.pass ?? 1; startedRef.current = performance.now(); }
        setProgress(p);
      }, ctl.signal);
      if (ctl.signal.aborted) return;
      setResult({ kind: 'video', url: URL.createObjectURL(info.blob), blob: info.blob, info });
      if (!info.whatsappReady) toast('No H.264 encoder here — exported VP9. Use Chrome/Safari on your phone for WhatsApp.');
      else if (!info.fitsWhatsApp) toast('The video is larger than WhatsApp allows. Try 720p or a shorter length.');
    } catch (e) {
      if ((e as DOMException).name !== 'AbortError') setError((e as Error).message);
    } finally { release(); setBusy(null); setProgress(null); exportingRef.current = false; }
  };

  const doExportImage = async () => {
    setError(null); setResult(null); setBusy('image');
    exportingRef.current = true;
    const release = await keepAwake();
    try {
      const blob = await exportStatusImage(activity, track, cfg, settings.units, '3d');
      setResult({ kind: 'image', url: URL.createObjectURL(blob), blob });
    } catch (e) { setError((e as Error).message); } finally { release(); setBusy(null); exportingRef.current = false; }
  };

  const share = async () => {
    if (!result) return;
    const ext = result.kind === 'video' ? 'mp4' : 'jpg';
    try {
      const outcome = await shareBlob(result.blob, `stride-${slug(activity.name)}.${ext}`);
      if (outcome === 'downloaded') toast('Saved to downloads — send it to your phone and post to Status');
      if (outcome === 'shared') toast('Pick WhatsApp → My status');
    } catch (e) {
      toast(`Could not share: ${(e as Error).message}`);
    }
  };

  const pct = progress ? Math.round((progress.frame / progress.frames) * 100) : 0;
  const eta = progress && progress.frame > 5 ? ((performance.now() - startedRef.current) / progress.frame) * (progress.frames - progress.frame) / 1000 : null;

  return (
    <div className="page studio-page">
      <div className="page-head">
        <button className="icon-btn" onClick={() => nav(-1)} aria-label="Back"><Icon name="back" /></button>
        <div className="grow" style={{ minWidth: 0 }}>
          <h2 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Flyover Studio</h2>
          <div className="faint small">9:16 · WhatsApp Status ready</div>
        </div>
      </div>

      <div className="studio">
        {/* Preview */}
        <div className="stack">
          <div className="phone-frame" ref={frameRef}>
            <MapView attribution={false} onFallback={(f) => toast(`${f} map unavailable (offline?) — showing Relief`)} styleId={cfg.mapStyle} terrain exaggeration={cfg.exaggeration} interactive={false}
              initial={{ center: plan.overview.center, zoom: plan.overview.zoom, pitch: 40 }} onReady={onMapReady} />
            <canvas className="overlay" ref={overlayRef} />
          </div>
          <div className="row" style={{ maxWidth: 440, margin: '0 auto', width: '100%' }}>
            <button className="icon-btn active" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause' : 'Play'}><Icon name={playing ? 'pause' : 'play'} size={18} fill={!playing} /></button>
            <input className="scrubber grow" type="range" min={0} max={1000} value={Math.round(u * 1000)} aria-label="Scrub flyover"
              onChange={(e) => { setPlaying(false); uRef.current = Number(e.target.value) / 1000; setU(uRef.current); }} />
            <span className="faint small tnum" style={{ width: 70, textAlign: 'right' }}>{fmtDuration(u * cfg.videoSeconds)} / {fmtDuration(cfg.videoSeconds)}</span>
          </div>
        </div>

        {/* Controls */}
        <div className="stack-lg">
          <div className="card stack">
            <h3>Export</h3>
            <div className="row">
              <button className="btn primary grow" onClick={doExportVideo} disabled={!!busy || !videoExportSupported()}>
                {busy === 'video' ? <span className="spinner" /> : <Icon name="video" size={18} />} Video (MP4)
              </button>
              <button className="btn grow" onClick={doExportImage} disabled={!!busy}>
                {busy === 'image' ? <span className="spinner" /> : <Icon name="image" size={18} />} Image (JPEG)
              </button>
            </div>
            {!videoExportSupported() && <div className="banner">This browser lacks WebCodecs video encoding. Use Chrome, Edge, or Safari 17+ — or export an image.</div>}
            {busy === 'video' && progress && (
              <div className="stack" style={{ gap: 6 }}>
                <div className="faint small">Keep Stride open on this screen until the export finishes.</div>
                <div className="progress-bar"><div style={{ width: `${pct}%` }} /></div>
                <div className="row between small muted">
                  <span>{progress.phase === 'loading' ? 'Loading terrain & tiles…' : progress.phase === 'finalizing' ? 'Finalizing MP4…' : progress.pass === 2 ? `File too large, re-encoding smaller · ${progress.frame}/${progress.frames}` : `Rendering frame ${progress.frame}/${progress.frames}`}</span>
                  <span className="tnum">{eta != null ? `~${Math.ceil(eta)}s left` : `${pct}%`}</span>
                </div>
                <button className="btn ghost sm" onClick={() => abortRef.current?.abort()}>Cancel</button>
              </div>
            )}
            {error && <div className="banner err">{error}</div>}
            {result && (
              <div className="stack">
                <div style={{ maxWidth: 260, margin: '0 auto', width: '100%', aspectRatio: '9/16', borderRadius: 18, overflow: 'hidden', border: '1px solid var(--line)' }}>
                  {result.kind === 'video'
                    ? <video src={result.url} controls autoPlay loop muted playsInline style={{ width: '100%', height: '100%', display: 'block', background: '#000' }} />
                    : <img src={result.url} alt="Status image preview" style={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover' }} />}
                </div>
                <div className="faint small" style={{ textAlign: 'center' }}>
                  {result.kind === 'video'
                    ? `${result.info.width}×${result.info.height} · ${result.info.seconds}s · ${result.info.codec.startsWith('avc') ? 'H.264' : 'VP9'} · `
                    : `${outputSize(cfg.quality).width}×${outputSize(cfg.quality).height} JPEG · `}
                  {(result.blob.size / 1e6).toFixed(1)} MB
                  {result.kind === 'video' && (result.info.whatsappReady && result.blob.size <= WHATSAPP_LIMIT_BYTES
                    ? <span className="badge" style={{ marginLeft: 6 }}>WhatsApp-ready</span>
                    : <span className="badge" style={{ marginLeft: 6, color: 'var(--warn)', background: 'rgba(255,181,71,0.14)' }}>{result.info.whatsappReady ? 'Over 16 MB' : 'Not H.264'}</span>)}
                </div>
                <div className="row">
                  <button className="btn primary grow" onClick={share}><Icon name="share" size={18} /> {canShareFiles() ? 'Share to WhatsApp' : 'Save for WhatsApp'}</button>
                  <button className="btn" onClick={() => saveBlob(result.blob, `stride-${slug(activity.name)}.${result.kind === 'video' ? 'mp4' : 'jpg'}`).catch((e) => toast(`Could not save the file: ${(e as Error).message}`))} aria-label="Download"><Icon name="download" size={18} /></button>
                </div>
              </div>
            )}
          </div>

          <div className="card stack">
            <h3>Layout</h3>
            <div className="row">
              {(['classic', 'minimal', 'bold'] as const).map((t) => (
                <button key={t} className={`template-card ${cfg.template === t ? 'on' : ''}`} onClick={() => patch({ template: t })}>{t[0].toUpperCase() + t.slice(1)}</button>
              ))}
            </div>
            <div className="field"><label>Title</label><input className="input" value={cfg.title} onChange={(e) => setCfg({ ...cfg, title: e.target.value })} maxLength={40} /></div>
          </div>

          <div className="card stack">
            <h3>Map</h3>
            <div className="chips">
              {MAP_STYLE_LIST.map((s) => <button key={s.id} className={`chip ${cfg.mapStyle === s.id ? 'on' : ''}`} onClick={() => patch({ mapStyle: s.id })}>{s.label}</button>)}
            </div>
            <div className="field">
              <label>Terrain exaggeration · {cfg.exaggeration.toFixed(1)}×</label>
              <input type="range" className="scrubber" min={1} max={3} step={0.1} value={cfg.exaggeration} onChange={(e) => patch({ exaggeration: Number(e.target.value) })} />
            </div>
            <div className="field"><label>Route colour</label>
              <div className="row wrap">{ROUTE_COLORS.map((c) => <button key={c} aria-label={`Route colour ${c}`} className={`color-dot ${cfg.routeColor === c ? 'on' : ''}`} style={{ background: c }} onClick={() => patch({ routeColor: c })} />)}</div>
            </div>
            <div className="field"><label>Accent colour</label>
              <div className="row wrap">{ACCENTS.map((c) => <button key={c} aria-label={`Accent ${c}`} className={`color-dot ${cfg.accent === c ? 'on' : ''}`} style={{ background: c }} onClick={() => patch({ accent: c })} />)}</div>
            </div>
          </div>

          <div className="card stack">
            <h3>Stats shown</h3>
            {([
              ['showDistance', 'Distance'], ['showDuration', 'Time'], ['showPace', 'Pace'], ['showElevation', 'Elevation'],
              ['showSteps', 'Steps (est.)'], ['showDate', 'Date'], ['showProfile', 'Elevation profile'],
            ] as [keyof OverlayConfig, string][]).map(([k, label]) => (
              <div key={k} className="list-row"><span>{label}</span><Switch checked={!!cfg[k]} onChange={(v) => patch({ [k]: v } as Partial<OverlayConfig>)} label={label} /></div>
            ))}
          </div>

          <div className="card stack">
            <h3>Video</h3>
            <div className="field"><label>Length</label>
              <Segmented label="Video length" value={String(cfg.videoSeconds) as '10' | '15' | '20' | '30'} onChange={(v) => patch({ videoSeconds: Number(v) as OverlayConfig['videoSeconds'] })}
                options={[{ value: '10', label: '10s' }, { value: '15', label: '15s' }, { value: '20', label: '20s' }, { value: '30', label: '30s' }]} />
            </div>
            <div className="field"><label>Quality</label>
              <Segmented label="Video quality" value={cfg.quality} onChange={(v) => patch({ quality: v })} options={[{ value: '1080p', label: '1080×1920' }, { value: '720p', label: '720×1280 (faster)' }]} />
            </div>
            <p className="faint small" style={{ margin: 0 }}>Rendered frame-by-frame at 30 fps, H.264 MP4, sized under 16 MB so WhatsApp posts it without trimming or heavy recompression.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
