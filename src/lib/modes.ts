/** Display helpers for travel modes of mixed journeys. */
import type { LngLat } from './geo';
import { cumulativeDistances } from './geo';
import type maplibregl from 'maplibre-gl';
import type { TravelMode } from '../types';

export const TRAVEL_MODES: TravelMode[] = ['walk', 'run', 'vehicle'];
export const MODE_LABEL: Record<TravelMode, string> = { walk: 'Walking', run: 'Running', vehicle: 'Bus / vehicle' };
export const MODE_ICON: Record<TravelMode, string> = { walk: 'walk', run: 'run', vehicle: 'bus' };
export const MODE_COLOR: Record<TravelMode, string> = { walk: '#22c55e', run: '#f97316', vehicle: '#3b82f6' };

/** Route colouring by travel mode: a hard colour change wherever the mode changes. */
export function modeGradient(coords: LngLat[], modes: TravelMode[]): maplibregl.ExpressionSpecification | null {
  if (coords.length < 2 || modes.length !== coords.length - 1) return null;
  const cum = cumulativeDistances(coords);
  const total = cum[cum.length - 1];
  if (!(total > 0)) return null;
  const expr: unknown[] = ['step', ['line-progress'], MODE_COLOR[modes[0]]];
  let last = 0;
  for (let i = 1; i < modes.length; i++) {
    if (modes[i] === modes[i - 1]) continue;
    const f = cum[i] / total;
    if (f <= last) continue; // stops must strictly increase
    expr.push(f, MODE_COLOR[modes[i]]);
    last = f;
  }
  return expr as maplibregl.ExpressionSpecification;
}
