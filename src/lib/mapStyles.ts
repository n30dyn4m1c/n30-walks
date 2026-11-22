/**
 * Map styles and 3D terrain setup for MapLibre GL.
 *
 * All providers are key-free so the prototype runs with zero configuration:
 *  - OpenFreeMap (OpenStreetMap vector tiles) for Outdoor & Light
 *  - CARTO Dark Matter for Dark
 *  - Esri World Imagery for Satellite
 *  - "Relief": a fully self-built style rendered only from open DEM tiles
 *    (colour-relief + hillshade). It needs no vector tiles, so it's also the
 *    automatic fallback if a basemap provider is unreachable.
 * 3D terrain everywhere comes from the AWS Open Data Terrarium DEM.
 */
import type maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import type { MapStyleId } from '../types';
import { TERRARIUM_URL } from './elevation';

export const DEM_SOURCE = 'stride-dem';
export const HILLSHADE_SOURCE = 'stride-dem-hs';

export interface MapStyleDef {
  id: MapStyleId;
  label: string;
  /** Style URL or inline style */
  style: string | StyleSpecification;
  dark: boolean;
  /** Add our own hillshade layer on top of the basemap's land layers */
  hillshade: boolean;
  sky: { sky: string; horizon: string; fog: string };
  swatch: string;
}

const demSource = {
  type: 'raster-dem' as const,
  tiles: [TERRARIUM_URL],
  encoding: 'terrarium' as const,
  tileSize: 256,
  maxzoom: 15,
  attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">Mapzen/AWS Terrain Tiles</a>',
};

export const reliefStyle: StyleSpecification = {
  version: 8,
  name: 'Stride Relief',
  sources: { [HILLSHADE_SOURCE]: demSource },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#e9e5da' } },
    {
      id: 'relief', type: 'color-relief', source: HILLSHADE_SOURCE,
      paint: {
        'color-relief-opacity': 1,
        'color-relief-color': [
          'interpolate', ['linear'], ['elevation'],
          -50, '#7fb3c9', 0, '#a9cfa2', 150, '#c9dca6', 400, '#e7e2b4', 800, '#e3c99a',
          1400, '#c9a37a', 2200, '#b59a8a', 3000, '#e8e4e0', 4500, '#ffffff',
        ],
      },
    },
    {
      id: 'relief-hillshade', type: 'hillshade', source: HILLSHADE_SOURCE,
      paint: { 'hillshade-exaggeration': 0.8, 'hillshade-shadow-color': '#2e271c', 'hillshade-highlight-color': '#fffdf5', 'hillshade-accent-color': '#5b4f3c' },
    },
  ],
};

const satelliteStyle: StyleSpecification = {
  version: 8,
  name: 'Stride Satellite',
  sources: {
    esri: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    },
  },
  layers: [{ id: 'sat', type: 'raster', source: 'esri', paint: { 'raster-saturation': 0.05, 'raster-contrast': 0.08 } }],
};

export const MAP_STYLES: Record<MapStyleId, MapStyleDef> = {
  outdoor: { id: 'outdoor', label: 'Outdoor', style: 'https://tiles.openfreemap.org/styles/liberty', dark: false, hillshade: true, sky: { sky: '#8cc6f0', horizon: '#e6f0f5', fog: '#e6eef2' }, swatch: '#a8d08d' },
  light: { id: 'light', label: 'Light', style: 'https://tiles.openfreemap.org/styles/positron', dark: false, hillshade: true, sky: { sky: '#c8dcec', horizon: '#f3f5f7', fog: '#f1f3f5' }, swatch: '#eceeef' },
  dark: { id: 'dark', label: 'Dark', style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json', dark: true, hillshade: true, sky: { sky: '#0a1020', horizon: '#1c2433', fog: '#141a24' }, swatch: '#20242b' },
  satellite: { id: 'satellite', label: 'Satellite', style: satelliteStyle, dark: true, hillshade: false, sky: { sky: '#6fa8dc', horizon: '#d9e6ef', fog: '#c9d6df' }, swatch: '#3f5a3a' },
  relief: { id: 'relief', label: 'Relief', style: reliefStyle, dark: false, hillshade: false, sky: { sky: '#9cc9ea', horizon: '#f1ede4', fog: '#ece7dc' }, swatch: '#d9c59a' },
};

export const MAP_STYLE_LIST = Object.values(MAP_STYLES);

/** First symbol (label) layer — we insert hillshade & routes beneath labels where sensible. */
export function firstSymbolLayer(map: maplibregl.Map): string | undefined {
  return map.getStyle().layers?.find((l) => l.type === 'symbol')?.id;
}

/**
 * Add DEM, optional hillshade, 3D terrain and sky to a loaded style.
 * Idempotent: safe to call again after every `style.load`.
 */
export function applyTerrain(map: maplibregl.Map, styleId: MapStyleId, opts: { terrain: boolean; exaggeration?: number }) {
  const def = MAP_STYLES[styleId];
  if (!map.getSource(DEM_SOURCE)) map.addSource(DEM_SOURCE, demSource);
  if (def.hillshade && !map.getLayer('stride-hillshade')) {
    if (!map.getSource(HILLSHADE_SOURCE)) map.addSource(HILLSHADE_SOURCE, demSource);
    map.addLayer(
      {
        id: 'stride-hillshade', type: 'hillshade', source: HILLSHADE_SOURCE,
        paint: def.dark
          ? { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': '#3a4150' }
          : { 'hillshade-exaggeration': 0.3, 'hillshade-shadow-color': '#473b24', 'hillshade-highlight-color': '#ffffff' },
      },
      firstSymbolLayer(map),
    );
  }
  map.setTerrain(opts.terrain ? { source: DEM_SOURCE, exaggeration: opts.exaggeration ?? 1.4 } : null);
  map.setSky({
    'sky-color': def.sky.sky,
    'horizon-color': def.sky.horizon,
    'fog-color': def.sky.fog,
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.25,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 10, 1, 12, 0],
  });
}

/**
 * True once the style JSON has been parsed and layers can be added.
 * Unlike `map.isStyleLoaded()`, this does not wait for every source's tiles,
 * which would be false for long stretches while terrain/tiles stream in.
 */
export function styleReady(map: maplibregl.Map): boolean {
  return !!(map as unknown as { style?: { _loaded?: boolean } }).style?._loaded;
}
