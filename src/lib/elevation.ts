/**
 * Elevation from a digital elevation model (DEM).
 *
 * Phone GPS altitude is typically ±10–30 m and the browser Geolocation API
 * often returns none at all. Instead, after a walk finishes (or a route is
 * planned) we sample the same open Terrarium DEM tiles the 3D map uses.
 * Result: consistent elevation profiles that match the 3D terrain exactly.
 *
 * Terrarium encoding: elevation = R*256 + G + B/256 − 32768 (meters).
 */
import type { LngLat } from './geo';

export const TERRARIUM_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png';
const TILE = 256;
const SAMPLE_ZOOM = 14; // ≈ 9.5 m/px at the equator — plenty for walking

/** Fractional tile coordinates of a lon/lat at zoom z (Web Mercator). */
export function lngLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latR = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
  return { x, y };
}

export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

const tileCache = new Map<string, Promise<Float32Array | null>>();

async function loadTile(z: number, x: number, y: number): Promise<Float32Array | null> {
  const key = `${z}/${x}/${y}`;
  let p = tileCache.get(key);
  if (!p) {
    p = (async () => {
      try {
        const url = TERRARIUM_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
        const res = await fetch(url, { mode: 'cors' });
        if (!res.ok) return null;
        const bmp = await createImageBitmap(await res.blob());
        const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(TILE, TILE) : Object.assign(document.createElement('canvas'), { width: TILE, height: TILE });
        const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
        ctx.drawImage(bmp, 0, 0);
        const { data } = ctx.getImageData(0, 0, TILE, TILE);
        const out = new Float32Array(TILE * TILE);
        for (let i = 0; i < out.length; i++) out[i] = decodeTerrarium(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
        return out;
      } catch {
        return null;
      }
    })();
    tileCache.set(key, p);
    if (tileCache.size > 200) tileCache.delete(tileCache.keys().next().value!);
  }
  return p;
}

/**
 * Sample DEM elevations for each coordinate (bilinear). Returns null if any
 * required tile could not be fetched (e.g. offline) — callers fall back to GPS.
 */
export async function sampleElevations(coords: LngLat[], z = SAMPLE_ZOOM): Promise<number[] | null> {
  if (!coords.length) return [];
  const pts = coords.map(([lon, lat]) => lngLatToTile(lon, lat, z));
  const needed = new Set(pts.map((p) => `${Math.floor(p.x)}/${Math.floor(p.y)}`));
  if (needed.size > 120) return null; // absurdly large area; skip
  const tiles = new Map<string, Float32Array | null>();
  await Promise.all([...needed].map(async (k) => {
    const [x, y] = k.split('/').map(Number);
    tiles.set(k, await loadTile(z, x, y));
  }));
  const out: number[] = [];
  for (const p of pts) {
    const tx = Math.floor(p.x), ty = Math.floor(p.y);
    const tile = tiles.get(`${tx}/${ty}`);
    if (!tile) return null;
    // Pixel-centre bilinear sampling, clamped inside the tile (edge error < 1 px).
    const px = Math.min(TILE - 1.001, Math.max(0, (p.x - tx) * TILE - 0.5));
    const py = Math.min(TILE - 1.001, Math.max(0, (p.y - ty) * TILE - 0.5));
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const fx = px - x0, fy = py - y0;
    const v = (xx: number, yy: number) => tile[yy * TILE + xx];
    const e = v(x0, y0) * (1 - fx) * (1 - fy) + v(x0 + 1, y0) * fx * (1 - fy) + v(x0, y0 + 1) * (1 - fx) * fy + v(x0 + 1, y0 + 1) * fx * fy;
    out.push(Math.round(e * 10) / 10);
  }
  return out;
}
