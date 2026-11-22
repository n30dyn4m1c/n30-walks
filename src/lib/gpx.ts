/** GPX 1.1 import / export (tracks and routes). */
import type { TrackPoint } from '../types';

const esc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));

export function trackToGpx(name: string, points: TrackPoint[]): string {
  const pts = points
    .map((p) => `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${p.ele != null ? `<ele>${p.ele.toFixed(1)}</ele>` : ''}<time>${new Date(p.t).toISOString()}</time></trkpt>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Stride" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name></metadata>
  <trk><name>${esc(name)}</name><type>walking</type>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>`;
}

export function routeToGpx(name: string, coords: [number, number][]): string {
  const pts = coords.map(([lon, lat]) => `    <rtept lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Stride" xmlns="http://www.topografix.com/GPX/1/1">
  <rte><name>${esc(name)}</name>
${pts}
  </rte>
</gpx>`;
}

export interface ParsedGpx {
  name: string;
  /** Points with timestamps (track) — empty if the file has no times */
  points: TrackPoint[];
  /** Plain geometry [lon, lat] (track or route) */
  coords: [number, number][];
  hasTime: boolean;
}

/** Parse GPX using DOMParser (browser). Accepts trk/trkseg/trkpt, rte/rtept, or wpt. */
export function parseGpx(xml: string): ParsedGpx {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Not a valid GPX file');
  const name = doc.querySelector('trk > name, rte > name, metadata > name')?.textContent?.trim() || 'Imported route';
  let nodes = Array.from(doc.getElementsByTagName('trkpt'));
  if (!nodes.length) nodes = Array.from(doc.getElementsByTagName('rtept'));
  if (!nodes.length) nodes = Array.from(doc.getElementsByTagName('wpt'));
  const points: TrackPoint[] = [];
  const coords: [number, number][] = [];
  let hasTime = nodes.length > 0;
  for (const n of nodes) {
    const lat = parseFloat(n.getAttribute('lat') || '');
    const lon = parseFloat(n.getAttribute('lon') || '');
    if (!isFinite(lat) || !isFinite(lon)) continue;
    coords.push([lon, lat]);
    const ele = parseFloat(n.getElementsByTagName('ele')[0]?.textContent || '');
    const timeStr = n.getElementsByTagName('time')[0]?.textContent;
    const t = timeStr ? Date.parse(timeStr) : NaN;
    if (!isFinite(t)) hasTime = false;
    points.push({ lat, lon, t: isFinite(t) ? t : 0, ...(isFinite(ele) ? { ele } : {}) });
  }
  if (coords.length < 2) throw new Error('GPX file contains fewer than 2 points');
  return { name, points: hasTime ? points : [], coords, hasTime };
}
