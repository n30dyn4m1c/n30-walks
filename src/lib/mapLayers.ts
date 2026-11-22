/** Shared MapLibre layer helpers for routes, markers and the live position. */
import type maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import type { LngLat } from './geo';
import { cumulativeDistances, lowerIndex } from './geo';

export const lineFeature = (coords: LngLat[]): GeoJSON.Feature<GeoJSON.LineString> => ({
  type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords.length >= 2 ? coords : coords.length ? [coords[0], coords[0]] : [] },
});
export const pointFeature = (c: LngLat, props: Record<string, unknown> = {}): GeoJSON.Feature<GeoJSON.Point> => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: c } });
export const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features });

export function setData(map: maplibregl.Map, id: string, data: GeoJSON.GeoJSON) {
  const src = map.getSource(id) as GeoJSONSource | undefined;
  if (src) src.setData(data);
  else map.addSource(id, { type: 'geojson', data, lineMetrics: true });
}

/** Pace → colour (fast green → slow red) relative to this activity's own pace spread. */
export function paceGradient(coords: LngLat[], pace: number[], stops = 64): maplibregl.ExpressionSpecification | null {
  if (coords.length < 2 || pace.length !== coords.length) return null;
  const valid = pace.filter((p) => p > 0).sort((a, b) => a - b);
  if (valid.length < 5) return null;
  const lo = valid[Math.floor(valid.length * 0.1)], hi = valid[Math.floor(valid.length * 0.9)];
  if (hi - lo < 5) return null;
  const cum = cumulativeDistances(coords);
  const total = cum[cum.length - 1];
  const expr: unknown[] = ['interpolate', ['linear'], ['line-progress']];
  for (let k = 0; k < stops; k++) {
    const f = k / (stops - 1);
    const i = lowerIndex(cum, f * total);
    const t = Math.max(0, Math.min(1, (pace[i] - lo) / (hi - lo)));
    // green (#22c55e) → yellow (#facc15) → red (#ef4444)
    const c = t < 0.5 ? mix([34, 197, 94], [250, 204, 21], t * 2) : mix([250, 204, 21], [239, 68, 68], (t - 0.5) * 2);
    expr.push(f, `rgb(${c.join(',')})`);
  }
  return expr as maplibregl.ExpressionSpecification;
}
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/** Route line with white casing; optional pace gradient. */
export function addRouteLayers(map: maplibregl.Map, id: string, coords: LngLat[], opts: { color?: string; gradient?: maplibregl.ExpressionSpecification | null; width?: number; dashed?: boolean; beforeId?: string } = {}) {
  setData(map, id, lineFeature(coords));
  const w = opts.width ?? 5;
  const layout = { 'line-cap': 'round', 'line-join': 'round' } as const;
  if (!map.getLayer(`${id}-casing`)) map.addLayer({ id: `${id}-casing`, type: 'line', source: id, layout, paint: { 'line-color': '#ffffff', 'line-width': w + 3.5, 'line-opacity': opts.dashed ? 0.6 : 1 } }, opts.beforeId);
  if (!map.getLayer(`${id}-line`)) {
    map.addLayer({
      id: `${id}-line`, type: 'line', source: id, layout,
      paint: {
        'line-width': w,
        ...(opts.gradient ? { 'line-gradient': opts.gradient } : { 'line-color': opts.color ?? '#ff5a36' }),
        ...(opts.dashed ? { 'line-dasharray': [1.2, 1.4] } : {}),
      },
    }, opts.beforeId);
  } else if (opts.gradient) map.setPaintProperty(`${id}-line`, 'line-gradient', opts.gradient);
}

/** Start (green) / finish (checkered-ish black) markers, rendered in WebGL. */
export function addEndpoints(map: maplibregl.Map, id: string, start: LngLat, end: LngLat) {
  setData(map, id, fc([pointFeature(start, { kind: 'start' }), pointFeature(end, { kind: 'end' })]));
  if (!map.getLayer(id)) {
    map.addLayer({ id, type: 'circle', source: id, paint: { 'circle-radius': 7, 'circle-color': ['match', ['get', 'kind'], 'start', '#22c55e', '#111111'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 3, 'circle-pitch-alignment': 'viewport' } });
  }
}

/** Blue-dot style current position with accuracy halo (accuracy radius in meters, zoom-scaled). */
export function setUserPosition(map: maplibregl.Map, c: LngLat | null, accuracyM = 10) {
  const id = 'me';
  setData(map, id, fc(c ? [pointFeature(c, { acc: accuracyM })] : []));
  if (!map.getLayer('me-acc')) {
    // radius in px = meters / metersPerPixel; approximate with exponential zoom interpolation at the equator, scaled by cos(lat)
    map.addLayer({ id: 'me-acc', type: 'circle', source: id, paint: {
      'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 10, ['/', ['get', 'acc'], 76.4], 20, ['/', ['get', 'acc'], 0.0746]],
      'circle-color': '#4ea1ff', 'circle-opacity': 0.15, 'circle-stroke-color': '#4ea1ff', 'circle-stroke-opacity': 0.35, 'circle-stroke-width': 1, 'circle-pitch-alignment': 'map',
    } });
    map.addLayer({ id: 'me-dot', type: 'circle', source: id, paint: { 'circle-radius': 8, 'circle-color': '#4ea1ff', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3, 'circle-pitch-alignment': 'viewport' } });
  }
}

/** Single highlight marker (e.g. elevation chart hover). */
export function setHighlight(map: maplibregl.Map, c: LngLat | null) {
  setData(map, 'hl', fc(c ? [pointFeature(c)] : []));
  if (!map.getLayer('hl')) map.addLayer({ id: 'hl', type: 'circle', source: 'hl', paint: { 'circle-radius': 8, 'circle-color': '#fff', 'circle-stroke-color': '#0b0f0d', 'circle-stroke-width': 3, 'circle-pitch-alignment': 'viewport' } });
}
