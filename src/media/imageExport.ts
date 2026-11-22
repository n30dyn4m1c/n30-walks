/**
 * Still 9:16 status image: hero 3D view of the whole route + stats overlay.
 */
import type maplibregl from 'maplibre-gl';
import { buildFlyoverPlan } from '../flyover/plan';
import { attributionFor, drawOverlay } from './overlay';
import { createOffscreenMap, waitForRender } from './offscreenMap';
import { outputSize } from './videoExport';
import type { Activity, OverlayConfig, Track, Units } from '../types';
import { fitZoom } from '../lib/geo';
import { REF_H, REF_W } from '../flyover/plan';

/** Add the full route (casing + line + start/finish dots). */
export function addStaticRoute(map: maplibregl.Map, coords: [number, number][], color: string) {
  map.addSource('img-route', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } } });
  map.addSource('img-ends', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { kind: 'start' }, geometry: { type: 'Point', coordinates: coords[0] } },
      { type: 'Feature', properties: { kind: 'end' }, geometry: { type: 'Point', coordinates: coords[coords.length - 1] } },
    ] },
  });
  map.addLayer({ id: 'img-glow', type: 'line', source: 'img-route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': color, 'line-width': 18, 'line-opacity': 0.3, 'line-blur': 9 } });
  map.addLayer({ id: 'img-casing', type: 'line', source: 'img-route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': 9 } });
  map.addLayer({ id: 'img-line', type: 'line', source: 'img-route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': color, 'line-width': 5.5 } });
  map.addLayer({ id: 'img-ends', type: 'circle', source: 'img-ends', paint: { 'circle-radius': 9, 'circle-color': ['match', ['get', 'kind'], 'start', '#22c55e', '#111'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 4, 'circle-pitch-alignment': 'viewport' } });
}

export async function exportStatusImage(activity: Activity, track: Track, cfg: OverlayConfig, units: Units, view: '3d' | '2d' = '3d'): Promise<Blob> {
  const { width, height } = outputSize(cfg.quality);
  const plan = buildFlyoverPlan(track.points);
  const off = await createOffscreenMap(cfg.mapStyle, width, { terrain: view === '3d', exaggeration: cfg.exaggeration });
  try {
    addStaticRoute(off.map, plan.coords, cfg.routeColor);
    const b = activity.bbox;
    // Leave room for header (top) and stats (bottom): fit the route into the middle band.
    const zoom = fitZoom(b, REF_W, REF_H * 0.5, 30);
    off.map.jumpTo({
      center: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2],
      zoom: view === '3d' ? zoom - 0.1 : zoom,
      pitch: view === '3d' ? 52 : 0,
      bearing: view === '3d' ? plan.overview.bearing : 0,
      padding: { top: REF_H * 0.05, bottom: REF_H * 0.3, left: 0, right: 0 },
    });
    await waitForRender(off.map, 20000);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(off.map.getCanvas(), 0, 0, width, height);
    const s = activity.stats;
    drawOverlay(ctx, width, height, cfg, {
      title: cfg.title || activity.name, dateMs: activity.startedAt, units,
      totals: { distanceM: s.distanceM, movingS: s.movingS, paceSPerKm: s.avgPaceSPerKm, elevGainM: s.elevGainM, steps: s.estSteps },
      progress: 1, profile: plan.profile, attribution: attributionFor(off.styleId),
    });
    // JPEG: WhatsApp re-encodes PNGs to JPEG anyway; this keeps quality predictable.
    return await new Promise<Blob>((res, rej) => canvas.toBlob((bl) => (bl ? res(bl) : rej(new Error('Image encoding failed'))), 'image/jpeg', 0.93));
  } finally {
    off.destroy();
  }
}
