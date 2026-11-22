/**
 * Stats overlay renderer for 9:16 media (WhatsApp Status = 1080×1920).
 *
 * One canvas-2D drawing routine is shared by:
 *   - the live flyover preview (drawn over the map at screen resolution),
 *   - every frame of the exported MP4,
 *   - the exported still image.
 * So the preview is pixel-for-pixel what gets shared.
 *
 * Layout is authored on a 1080×1920 grid and scaled to the target size.
 * WhatsApp Status overlays its own UI in the top ~8% (progress bars, name)
 * and bottom ~10% (reply bar), so key content stays inside a safe area.
 */
import type { OverlayConfig, Units } from '../types';
import { distanceUnit, elevationUnit, fmtDate, fmtDistance, fmtDuration, fmtElevation, fmtNumber, fmtPace, paceUnit } from '../lib/format';

export const BASE_W = 1080;
export const BASE_H = 1920;
const SAFE_TOP = 190;
const SAFE_BOTTOM = 200;
export const FONT = '"Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export interface OverlayTotals {
  distanceM: number;
  movingS: number;
  paceSPerKm: number;
  elevGainM: number;
  steps: number;
}

export interface OverlayData {
  title: string;
  dateMs: number;
  units: Units;
  totals: OverlayTotals;
  /** Live values while the flyover is in progress; omit for a summary (image / end card). */
  live?: { distanceM: number; movingS: number; eleM: number | null };
  /** Fraction of route revealed, 0..1 */
  progress: number;
  profile: number[];
  attribution: string;
  /** Global overlay opacity (fade in at start of video) */
  alpha?: number;
}

interface StatItem { label: string; value: string; unit: string }

function statItems(cfg: OverlayConfig, d: OverlayData): StatItem[] {
  const u = d.units;
  const live = d.live;
  const dist = live ? live.distanceM : d.totals.distanceM;
  const time = live ? live.movingS : d.totals.movingS;
  const pace = live ? (live.distanceM > 30 ? live.movingS / (live.distanceM / 1000) : 0) : d.totals.paceSPerKm;
  const out: StatItem[] = [];
  if (cfg.showDistance) out.push({ label: 'Distance', value: fmtDistance(dist, u), unit: distanceUnit(u) });
  if (cfg.showDuration) out.push({ label: 'Time', value: fmtDuration(time), unit: '' });
  if (cfg.showPace) out.push({ label: 'Avg pace', value: fmtPace(pace, u), unit: paceUnit(u) });
  if (cfg.showElevation) {
    if (live && live.eleM != null) out.push({ label: 'Altitude', value: fmtElevation(live.eleM, u), unit: elevationUnit(u) });
    else out.push({ label: 'Elev gain', value: fmtElevation(d.totals.elevGainM, u), unit: elevationUnit(u) });
  }
  if (cfg.showSteps) out.push({ label: 'Steps', value: fmtNumber(d.totals.steps * (live ? d.progress : 1)), unit: '' });
  return out;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function scrims(ctx: CanvasRenderingContext2D, topH: number, bottomH: number, strength = 1) {
  let g = ctx.createLinearGradient(0, 0, 0, topH);
  g.addColorStop(0, `rgba(0,0,0,${0.62 * strength})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, BASE_W, topH);
  g = ctx.createLinearGradient(0, BASE_H - bottomH, 0, BASE_H);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.45, `rgba(0,0,0,${0.5 * strength})`);
  g.addColorStop(1, `rgba(0,0,0,${0.82 * strength})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, BASE_H - bottomH, BASE_W, bottomH);
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number, weight: number, size: number, min = 28): number {
  let s = size;
  ctx.font = `${weight} ${s}px ${FONT}`;
  while (ctx.measureText(text).width > maxW && s > min) { s -= 2; ctx.font = `${weight} ${s}px ${FONT}`; }
  return s;
}

function header(ctx: CanvasRenderingContext2D, cfg: OverlayConfig, d: OverlayData, color = '#fff') {
  const x = 72;
  let y = SAFE_TOP + 20;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = cfg.accent;
  ctx.font = `800 30px ${FONT}`;
  ctx.letterSpacing = '6px';
  ctx.fillText('STRIDE', x, y);
  ctx.letterSpacing = '0px';
  y += 84;
  ctx.fillStyle = color;
  const title = d.title || 'Walk';
  fitText(ctx, title, BASE_W - 144, 800, 76, 44);
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 18;
  ctx.fillText(title, x, y);
  ctx.shadowBlur = 0;
  if (cfg.showDate) {
    y += 54;
    ctx.globalAlpha *= 0.82;
    ctx.font = `500 36px ${FONT}`;
    ctx.fillText(fmtDate(d.dateMs, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), x, y);
    ctx.globalAlpha /= 0.82;
  }
}

/** Elevation profile with a progress cursor. */
function profileChart(ctx: CanvasRenderingContext2D, d: OverlayData, accent: string, x: number, y: number, w: number, h: number, light = true) {
  const p = d.profile;
  if (p.length < 2) return;
  let min = Math.min(...p), max = Math.max(...p);
  if (max - min < 20) { const mid = (max + min) / 2; min = mid - 10; max = mid + 10; }
  const px = (i: number) => x + (i / (p.length - 1)) * w;
  const py = (v: number) => y + h - ((v - min) / (max - min)) * h;
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    p.forEach((v, i) => ctx.lineTo(px(i), py(v)));
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
  };
  ctx.save();
  path();
  ctx.fillStyle = light ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.14)';
  ctx.fill();
  // Revealed portion in accent.
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y - 10, w * d.progress, h + 20);
  ctx.clip();
  path();
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, accent);
  g.addColorStop(1, accent + '33');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
  // Profile line
  ctx.beginPath();
  p.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
  ctx.strokeStyle = light ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 3;
  ctx.stroke();
  // Cursor
  if (d.progress > 0 && d.progress < 1) {
    const fi = d.progress * (p.length - 1);
    const i0 = Math.floor(fi), i1 = Math.min(p.length - 1, i0 + 1);
    const v = p[i0] + (p[i1] - p[i0]) * (fi - i0);
    ctx.beginPath();
    ctx.arc(x + w * d.progress, py(v), 11, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = accent;
    ctx.stroke();
  }
  ctx.restore();
}

function attribution(ctx: CanvasRenderingContext2D, text: string, dark = false) {
  ctx.font = `500 20px ${FONT}`;
  ctx.fillStyle = dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.55)';
  ctx.textAlign = 'right';
  ctx.fillText(text, BASE_W - 40, BASE_H - 36);
  ctx.textAlign = 'left';
}

function statGrid(ctx: CanvasRenderingContext2D, items: StatItem[], x: number, y: number, w: number, color: string, labelColor: string) {
  const cols = items.length <= 3 ? items.length : items.length === 4 ? 2 : 3;
  const rows = Math.ceil(items.length / cols);
  const cw = w / cols;
  const rowH = 150;
  items.forEach((it, i) => {
    const cx = x + (i % cols) * cw;
    const cy = y + Math.floor(i / cols) * rowH;
    ctx.fillStyle = labelColor;
    ctx.font = `700 26px ${FONT}`;
    ctx.letterSpacing = '3px';
    ctx.fillText(it.label.toUpperCase(), cx, cy);
    ctx.letterSpacing = '0px';
    ctx.fillStyle = color;
    const size = fitText(ctx, it.value, cw - (it.unit ? 70 : 20), 800, cols === 2 ? 92 : 78, 40);
    ctx.fillText(it.value, cx, cy + size + 8);
    if (it.unit) {
      const vw = ctx.measureText(it.value).width;
      ctx.font = `600 30px ${FONT}`;
      ctx.fillStyle = labelColor;
      ctx.fillText(it.unit, cx + vw + 10, cy + size + 8);
    }
  });
  return rows * rowH;
}

/**
 * Draw the overlay. `ctx` must already be sized to the output; we scale from
 * the 1080×1920 design grid.
 */
export function drawOverlay(ctx: CanvasRenderingContext2D, width: number, height: number, cfg: OverlayConfig, d: OverlayData) {
  ctx.save();
  ctx.scale(width / BASE_W, height / BASE_H);
  ctx.globalAlpha = d.alpha ?? 1;
  ctx.textAlign = 'left';
  const items = statItems(cfg, d);

  if (cfg.template === 'minimal') {
    scrims(ctx, 560, 760, 0.9);
    header(ctx, cfg, d);
    const dist = fmtDistance(d.live ? d.live.distanceM : d.totals.distanceM, d.units);
    let y = BASE_H - SAFE_BOTTOM - (cfg.showProfile ? 170 : 40);
    const rest = items.filter((i) => i.label !== 'Distance').map((i) => `${i.value}${i.unit && i.unit.startsWith('/') ? i.unit : i.unit ? ' ' + i.unit : ''}`).join('   ·   ');
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    fitText(ctx, rest, BASE_W - 144, 600, 40, 26);
    ctx.fillText(rest, 72, y);
    y -= 60;
    ctx.fillStyle = '#fff';
    ctx.font = `900 250px ${FONT}`;
    ctx.letterSpacing = '-8px';
    ctx.fillText(dist, 60, y);
    const dw = ctx.measureText(dist).width;
    ctx.letterSpacing = '0px';
    ctx.font = `800 64px ${FONT}`;
    ctx.fillStyle = cfg.accent;
    ctx.fillText(distanceUnit(d.units).toUpperCase(), 72 + dw, y);
    if (cfg.showProfile) profileChart(ctx, d, cfg.accent, 72, BASE_H - SAFE_BOTTOM - 120, BASE_W - 144, 90);
    attribution(ctx, d.attribution);
  } else if (cfg.template === 'bold') {
    scrims(ctx, 520, 300, 0.85);
    header(ctx, cfg, d);
    const cardH = (cfg.showProfile ? 170 : 0) + Math.ceil(items.length / (items.length <= 3 ? items.length : items.length === 4 ? 2 : 3)) * 150 + 90;
    const cy = BASE_H - SAFE_BOTTOM - cardH;
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 40;
    roundRect(ctx, 48, cy, BASE_W - 96, cardH, 48);
    ctx.fillStyle = cfg.accent;
    ctx.fill();
    ctx.shadowBlur = 0;
    statGrid(ctx, items, 100, cy + 90, BASE_W - 200, '#0b0f0d', 'rgba(11,15,13,0.6)');
    if (cfg.showProfile) profileChart(ctx, d, '#0b0f0d', 100, cy + cardH - 150, BASE_W - 200, 100, false);
    attribution(ctx, d.attribution);
  } else {
    // classic
    scrims(ctx, 520, 820, 1);
    header(ctx, cfg, d);
    const gridRows = Math.ceil(items.length / (items.length <= 3 ? items.length : items.length === 4 ? 2 : 3));
    let y = BASE_H - SAFE_BOTTOM - gridRows * 150 - (cfg.showProfile ? 170 : 0) + 40;
    // accent rule
    ctx.fillStyle = cfg.accent;
    roundRect(ctx, 72, y - 70, 90, 10, 5);
    ctx.fill();
    y += statGrid(ctx, items, 72, y, BASE_W - 144, '#ffffff', 'rgba(255,255,255,0.66)');
    if (cfg.showProfile) profileChart(ctx, d, cfg.accent, 72, y - 10, BASE_W - 144, 110);
    attribution(ctx, d.attribution);
  }
  ctx.restore();
}

/** Attribution string for the chosen map style (required by OSM/ODbL & providers). */
export function attributionFor(style: OverlayConfig['mapStyle']): string {
  switch (style) {
    case 'satellite': return '© Esri, Maxar · Terrain © Mapzen/AWS';
    case 'relief': return 'Terrain © Mapzen/AWS';
    case 'dark': return '© OpenStreetMap contributors © CARTO';
    default: return '© OpenStreetMap contributors · OpenFreeMap';
  }
}
