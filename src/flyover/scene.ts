/**
 * Binds a FlyoverPlan to a MapLibre map: route layers, moving head marker,
 * and per-frame camera. Everything is drawn in WebGL (no DOM markers), so
 * what you see in the player is exactly what the video exporter captures.
 */
import type maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { sliceToDistance, pointAtDistance, type LngLat } from '../lib/geo';
import { cameraAt, REF_W, type CameraState, type FlyoverPlan } from './plan';

const SRC_FULL = 'fly-full';
const SRC_DONE = 'fly-done';
const SRC_HEAD = 'fly-head';

const line = (coords: LngLat[]): GeoJSON.Feature<GeoJSON.LineString> => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords.length > 1 ? coords : [coords[0] ?? [0, 0], coords[0] ?? [0, 0]] } });
const point = (c: LngLat): GeoJSON.Feature<GeoJSON.Point> => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } });

export class FlyoverScene {
  constructor(private map: maplibregl.Map, private plan: FlyoverPlan, private color: string, private exaggeration = 1.5) {}

  setExaggeration(x: number) { this.exaggeration = x; }

  /** (Re-)add sources and layers. Call after every style load. */
  install() {
    const m = this.map;
    // We supply the centre altitude ourselves (see FlyoverPlan.centerEle) for a jump-free camera.
    // MapLibre's own clamping samples whichever terrain tile is loaded at the current zoom and
    // flips between 0 m and the real altitude during zoom changes (visible flicker).
    m.setCenterClampedToGround(false);
    const start = this.plan.coords[0];
    if (!m.getSource(SRC_FULL)) m.addSource(SRC_FULL, { type: 'geojson', data: line(this.plan.coords) });
    if (!m.getSource(SRC_DONE)) m.addSource(SRC_DONE, { type: 'geojson', data: line([start]) });
    if (!m.getSource(SRC_HEAD)) m.addSource(SRC_HEAD, { type: 'geojson', data: point(start) });
    const add = (l: maplibregl.LayerSpecification) => { if (!m.getLayer(l.id)) m.addLayer(l); };
    add({ id: 'fly-ghost-casing', type: 'line', source: SRC_FULL, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#000', 'line-width': 7, 'line-opacity': 0.18 } });
    add({ id: 'fly-ghost', type: 'line', source: SRC_FULL, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 3.5, 'line-opacity': 0.75, 'line-dasharray': [1.5, 1.5] } });
    add({ id: 'fly-glow', type: 'line', source: SRC_DONE, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': this.color, 'line-width': 16, 'line-opacity': 0.35, 'line-blur': 8 } });
    add({ id: 'fly-casing', type: 'line', source: SRC_DONE, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 8.5 } });
    add({ id: 'fly-line', type: 'line', source: SRC_DONE, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': this.color, 'line-width': 5.5 } });
    add({ id: 'fly-head-halo', type: 'circle', source: SRC_HEAD, paint: { 'circle-radius': 22, 'circle-color': this.color, 'circle-opacity': 0.25, 'circle-pitch-alignment': 'map', 'circle-blur': 0.4 } });
    add({ id: 'fly-head', type: 'circle', source: SRC_HEAD, paint: { 'circle-radius': 9, 'circle-color': this.color, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 4, 'circle-pitch-alignment': 'viewport' } });
  }

  setColor(color: string) {
    this.color = color;
    for (const id of ['fly-glow', 'fly-line', 'fly-head-halo', 'fly-head']) {
      if (!this.map.getLayer(id)) continue;
      this.map.setPaintProperty(id, id.startsWith('fly-head') ? 'circle-color' : 'line-color', color);
    }
  }

  /** Position camera + route reveal for normalised time u. Returns the camera state used. */
  setFrame(u: number, pulse = 0): CameraState {
    const m = this.map;
    const cam = cameraAt(this.plan, u);
    const { clientWidth: w, clientHeight: h } = m.getContainer();
    // Plan zooms are for a 540 px wide viewport; keep identical framing at any size.
    const zoomAdj = Math.log2(Math.max(1, w) / REF_W);
    // Terrain is rendered exaggerated, so the centre altitude must be too.
    const terrainOn = !!m.getTerrain();
    m.jumpTo({
      center: cam.center, zoom: cam.zoom + zoomAdj, pitch: cam.pitch, bearing: cam.bearing,
      elevation: terrainOn && cam.elevation != null ? cam.elevation * this.exaggeration : 0,
      padding: { top: h * cam.focusOffset, bottom: 0, left: 0, right: 0 },
    });
    const head = pointAtDistance(this.plan.coords, this.plan.cum, cam.distance).p;
    (m.getSource(SRC_DONE) as GeoJSONSource | undefined)?.setData(line(sliceToDistance(this.plan.coords, this.plan.cum, cam.distance)));
    (m.getSource(SRC_HEAD) as GeoJSONSource | undefined)?.setData(point(head));
    if (m.getLayer('fly-head-halo')) m.setPaintProperty('fly-head-halo', 'circle-radius', 18 + 8 * Math.sin(pulse * Math.PI * 2));
    return cam;
  }
}
