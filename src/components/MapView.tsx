/**
 * Reusable MapLibre map with style switching, optional 3D terrain and an
 * `onReady` hook that re-runs after every style change (custom layers are
 * wiped when the style changes, so callers re-add them there).
 */
import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { applyTerrain, MAP_STYLES, styleReady } from '../lib/mapStyles';
import type { MapStyleId } from '../types';

export interface MapViewProps {
  styleId: MapStyleId;
  terrain?: boolean;
  exaggeration?: number;
  initial?: { center: [number, number]; zoom: number; pitch?: number; bearing?: number };
  bounds?: [number, number, number, number];
  boundsPadding?: maplibregl.PaddingOptions | number;
  interactive?: boolean;
  /** Called after the map and every subsequent style is loaded. */
  onReady?: (map: maplibregl.Map) => void;
  onClick?: (e: maplibregl.MapMouseEvent) => void;
  preserveDrawingBuffer?: boolean;
  /** Show MapLibre's attribution control (off when the caller draws attribution itself, e.g. Studio overlay). */
  attribution?: boolean;
  className?: string;
  children?: React.ReactNode;
  /** Notifies when the requested style failed and we fell back to Relief. */
  onFallback?: (failed: MapStyleId) => void;
}

export function MapView(props: MapViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [activeStyle, setActiveStyle] = useState<MapStyleId>(props.styleId);
  const activeRef = useRef(activeStyle);
  activeRef.current = activeStyle;

  // Create once.
  useEffect(() => {
    const p = propsRef.current;
    const map = new maplibregl.Map({
      container: el.current!,
      style: MAP_STYLES[p.styleId].style,
      center: p.initial?.center ?? [0, 20],
      zoom: p.initial?.zoom ?? 1.5,
      pitch: p.initial?.pitch ?? 0,
      bearing: p.initial?.bearing ?? 0,
      interactive: p.interactive ?? true,
      attributionControl: p.attribution === false ? false : { compact: true },
      maxPitch: 85,
      canvasContextAttributes: { preserveDrawingBuffer: !!p.preserveDrawingBuffer, antialias: true },
    });
    mapRef.current = map;
    if (p.bounds) map.fitBounds(p.bounds, { padding: p.boundsPadding ?? 40, duration: 0 });
    map.on('style.load', () => {
      const cur = propsRef.current;
      applyTerrain(map, activeRef.current, { terrain: !!cur.terrain, exaggeration: cur.exaggeration });
      cur.onReady?.(map);
    });
    map.on('error', (e) => {
      // If a remote basemap can't load (offline / provider down), fall back to the DEM-only style.
      if (!styleReady(map) && activeRef.current !== 'relief') {
        const failed = activeRef.current;
        console.warn('[map] style failed, falling back to relief', e.error?.message);
        setActiveStyle('relief');
        activeRef.current = 'relief';
        map.setStyle(MAP_STYLES.relief.style);
        propsRef.current.onFallback?.(failed);
      }
    });
    map.on('click', (e) => propsRef.current.onClick?.(e));
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(el.current!);
    return () => { ro.disconnect(); map.remove(); mapRef.current = null; };
  }, []);

  // Style changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || props.styleId === activeRef.current) return;
    setActiveStyle(props.styleId);
    activeRef.current = props.styleId;
    map.setStyle(MAP_STYLES[props.styleId].style);
  }, [props.styleId]);

  // Terrain toggle / exaggeration.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady(map)) return;
    applyTerrain(map, activeRef.current, { terrain: !!props.terrain, exaggeration: props.exaggeration });
    if (props.terrain && map.getPitch() < 30) map.easeTo({ pitch: 55, duration: 800 });
    if (!props.terrain && map.getPitch() > 0) map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
  }, [props.terrain, props.exaggeration]);

  return (
    <div className={props.className ?? 'map'}>
      <div ref={el} style={{ position: 'absolute', inset: 0 }} />
      {props.children}
    </div>
  );
}

export function useMapStyleState(initial: MapStyleId) {
  return useState<MapStyleId>(initial);
}
