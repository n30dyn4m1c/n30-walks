/** Display formatting for distance, time, pace and elevation in either unit system. */
import type { Units } from '../types';

export const M_PER_MI = 1609.344;
export const FT_PER_M = 3.28084;

export function distanceValue(m: number, units: Units): number {
  return units === 'imperial' ? m / M_PER_MI : m / 1000;
}
export const distanceUnit = (units: Units) => (units === 'imperial' ? 'mi' : 'km');

/** "4.27" — two decimals under 100, one above. */
export function fmtDistance(m: number, units: Units, withUnit = false): string {
  const v = distanceValue(m, units);
  const s = v >= 100 ? v.toFixed(1) : v.toFixed(2);
  return withUnit ? `${s} ${distanceUnit(units)}` : s;
}

/** "1:02:03" or "12:34" */
export function fmtDuration(totalS: number): string {
  const s = Math.max(0, Math.round(totalS));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  const ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Compact human duration "1h 05m" / "42m" for summaries. */
export function fmtDurationShort(totalS: number): string {
  const s = Math.round(totalS);
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/** Pace from seconds-per-km → "12:05" per km or per mile. */
export function fmtPace(sPerKm: number, units: Units, withUnit = false): string {
  if (!sPerKm || !isFinite(sPerKm) || sPerKm > 3600) return withUnit ? `--:-- /${distanceUnit(units)}` : '--:--';
  const s = units === 'imperial' ? sPerKm * (M_PER_MI / 1000) : sPerKm;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  const str = sec === 60 ? `${m + 1}:00` : `${m}:${String(sec).padStart(2, '0')}`;
  return withUnit ? `${str} /${distanceUnit(units)}` : str;
}
export const paceUnit = (units: Units) => `/${distanceUnit(units)}`;

export function fmtElevation(m: number, units: Units, withUnit = false): string {
  const v = units === 'imperial' ? m * FT_PER_M : m;
  const s = Math.round(v).toLocaleString();
  return withUnit ? `${s} ${units === 'imperial' ? 'ft' : 'm'}` : s;
}
export const elevationUnit = (units: Units) => (units === 'imperial' ? 'ft' : 'm');

export function fmtDate(ms: number, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string {
  return new Date(ms).toLocaleDateString(undefined, opts);
}
export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Default activity name based on time of day: "Morning walk". */
export function defaultWalkName(startMs: number): string {
  const h = new Date(startMs).getHours();
  const part = h < 5 ? 'Night' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : h < 21 ? 'Evening' : 'Night';
  return `${part} walk`;
}

export function defaultJourneyName(startMs: number): string {
  return defaultWalkName(startMs).replace('walk', 'journey');
}

export function fmtSpeed(mps: number, u: Units): string {
  return (u === 'imperial' ? mps * 2.23694 : mps * 3.6).toFixed(1);
}
export const speedUnit = (u: Units) => (u === 'imperial' ? 'mph' : 'km/h');

export function fmtNumber(n: number): string {
  return Math.round(n).toLocaleString();
}

export function uid(): string {
  return (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
}
