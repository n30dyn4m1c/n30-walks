/**
 * A hidden, fixed-size MapLibre instance used to render export frames.
 *
 * The map is laid out at the reference size (540×960 CSS px) and rendered
 * with pixelRatio = outputWidth / 540, so 1080p and 720p exports have exactly
 * the same framing as the on-screen preview.
 */
import maplibregl from 'maplibre-gl';
import { applyTerrain, MAP_STYLES, styleReady } from '../lib/mapStyles';
import { REF_H, REF_W } from '../flyover/plan';
import type { MapStyleId } from '../types';

export interface OffscreenMap {
  map: maplibregl.Map;
  /** Style actually rendered (may be 'relief' if the requested basemap was unreachable). */
  styleId: MapStyleId;
  destroy(): void;
}

export async function createOffscreenMap(styleId: MapStyleId, outW: number, opts: { terrain: boolean; exaggeration: number }): Promise<OffscreenMap> {
  const el = document.createElement('div');
  // Must stay in the layout (not display:none) for WebGL to render; park it off-screen.
  Object.assign(el.style, { position: 'fixed', left: '-20000px', top: '0', width: `${REF_W}px`, height: `${REF_H}px`, pointerEvents: 'none' });
  document.body.appendChild(el);
  let styleIdUsed = styleId;
  const map = new maplibregl.Map({
    container: el,
    style: MAP_STYLES[styleId].style,
    pixelRatio: outW / REF_W,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    maxPitch: 85,
    canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Map style took too long to load. Check your connection or pick the Relief style.')), 20000);
    map.once('style.load', () => { clearTimeout(timer); resolve(); });
    map.on('error', (e) => {
      // Basemap unreachable → fall back to the DEM-only relief style rather than failing the export.
      if (!styleReady(map) && styleIdUsed !== 'relief') {
        styleIdUsed = 'relief';
        map.setStyle(MAP_STYLES.relief.style);
      }
      console.warn('[offscreen map]', e.error?.message ?? e);
    });
  });
  applyTerrain(map, styleIdUsed, opts);
  return {
    map,
    styleId: styleIdUsed,
    destroy() { map.remove(); el.remove(); },
  };
}

/** Wait until the current camera is fully rendered (tiles + terrain loaded), with a safety timeout. */
export const renderStats = { frames: 0, timeouts: 0, totalMs: 0 };

export function waitForRender(map: maplibregl.Map, timeoutMs = 6000): Promise<void> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (timedOut = false) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      renderStats.frames++;
      renderStats.totalMs += performance.now() - t0;
      if (timedOut) renderStats.timeouts++;
      resolve();
    };
    const t = setTimeout(() => finish(true), timeoutMs);
    // After 'idle', render once more: guarantees the drawing buffer holds a complete
    // frame for the final camera (the very first capture was otherwise blank).
    map.once('idle', () => { map.once('render', () => finish()); map.triggerRepaint(); });
    map.triggerRepaint();
  });
}
