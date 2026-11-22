/**
 * Route planning & discovery.
 *
 * Path snapping uses the public FOSSGIS OSRM "foot" instance (OpenStreetMap
 * data, no API key). It is a free community service with a fair-use policy,
 * so we debounce requests and ALWAYS fall back to straight segments when it
 * is unreachable — planning never breaks, it just becomes less precise.
 * The endpoint is configurable via VITE_ROUTING_URL for self-hosting.
 */
import { destination, pathLength, haversine, type LngLat } from './geo';

const BASE = (import.meta.env?.VITE_ROUTING_URL as string | undefined) ?? 'https://routing.openstreetmap.de/routed-foot/route/v1/foot';

export interface RouteResult {
  geometry: LngLat[];
  distanceM: number;
  snapped: boolean;
}

export async function routeThrough(waypoints: LngLat[], signal?: AbortSignal): Promise<RouteResult> {
  if (waypoints.length < 2) return { geometry: waypoints.slice(), distanceM: 0, snapped: false };
  try {
    const coords = waypoints.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(';');
    const url = `${BASE}/${coords}?overview=full&geometries=geojson&steps=false`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    signal?.addEventListener('abort', () => ctl.abort());
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`routing ${res.status}`);
    const json = await res.json();
    const r = json.routes?.[0];
    if (!r?.geometry?.coordinates?.length) throw new Error('no route');
    return { geometry: r.geometry.coordinates as LngLat[], distanceM: r.distance, snapped: true };
  } catch (e) {
    if (signal?.aborted) throw e;
    return straightRoute(waypoints);
  }
}

export function straightRoute(waypoints: LngLat[]): RouteResult {
  return { geometry: waypoints.slice(), distanceM: pathLength(waypoints), snapped: false };
}

/**
 * Generate a round-trip loop of roughly `targetM` meters starting at `start`.
 * We place 3 waypoints on a circle whose circumference ≈ target (shrunk to
 * account for street-network detours), rotated by `seed` so each suggestion
 * heads in a different direction, then route through them back to the start.
 * If the routed length misses by >25 % we rescale the circle once and retry.
 */
export async function generateLoop(start: LngLat, targetM: number, seed: number, signal?: AbortSignal): Promise<RouteResult & { waypoints: LngLat[] }> {
  let radius = (targetM / (2 * Math.PI)) * 0.8;
  let best: (RouteResult & { waypoints: LngLat[] }) | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const baseBearing = (seed * 137.5) % 360; // golden-angle spread between suggestions
    // Circle centre lies `radius` away from start; waypoints are on the circle.
    const centre = destination(start, radius, baseBearing);
    const wps: LngLat[] = [start];
    for (const k of [1, 2, 3]) wps.push(destination(centre, radius, (baseBearing + 180 + k * 90) % 360));
    wps.push(start);
    const r = await routeThrough(wps, signal);
    const candidate = { ...r, waypoints: wps };
    if (!best || Math.abs(r.distanceM - targetM) < Math.abs(best.distanceM - targetM)) best = candidate;
    const ratio = r.distanceM / targetM;
    if (ratio > 0.75 && ratio < 1.25) break;
    radius = radius / ratio;
  }
  return best!;
}

/** Remove waypoint-adjacent "spikes" (out-and-back stubs) common when snapping loops. */
export function trimSpikes(coords: LngLat[], maxSpikeM = 60): LngLat[] {
  const out: LngLat[] = [];
  for (const c of coords) {
    if (out.length >= 2 && haversine(out[out.length - 2], c) < 1 && haversine(out[out.length - 1], c) < maxSpikeM) {
      out.pop();
      continue;
    }
    out.push(c);
  }
  return out;
}
