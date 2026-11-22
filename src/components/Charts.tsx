/** Lightweight SVG charts: route thumbnail, elevation profile, bars, progress ring. */
import { useMemo, useRef, useState } from 'react';

/** Route silhouette from an activity's simplified preview path. */
export function RouteThumb({ coords, size = 64, color = 'var(--accent)', stroke = 3 }: { coords: [number, number][]; size?: number; color?: string; stroke?: number }) {
  const d = useMemo(() => {
    if (coords.length < 2) return '';
    const lat0 = coords[0][1];
    const k = Math.cos((lat0 * Math.PI) / 180);
    const xs = coords.map((c) => c[0] * k), ys = coords.map((c) => -c[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const span = Math.max(maxX - minX, maxY - minY) || 1;
    const pad = size * 0.14;
    const s = (size - 2 * pad) / span;
    const ox = pad + (size - 2 * pad - (maxX - minX) * s) / 2;
    const oy = pad + (size - 2 * pad - (maxY - minY) * s) / 2;
    return xs.map((x, i) => `${i ? 'L' : 'M'}${(ox + (x - minX) * s).toFixed(1)},${(oy + (ys[i] - minY) * s).toFixed(1)}`).join('');
  }, [coords, size]);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="thumb" aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Interactive elevation profile. `distances` & `elevations` are parallel
 * arrays; hovering/scrubbing reports the index so the map can show a marker.
 */
export function ElevationChart({ distances, elevations, height = 120, onHover, formatX, formatY }: {
  distances: number[]; elevations: number[]; height?: number;
  onHover?: (index: number | null) => void; formatX: (m: number) => string; formatY: (m: number) => string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 600, H = height, padB = 18, padT = 8;
  const { path, area, min, max, total } = useMemo(() => {
    const total = distances[distances.length - 1] || 1;
    let min = Math.min(...elevations), max = Math.max(...elevations);
    if (max - min < 10) { min -= 5; max += 5; }
    const x = (d: number) => (d / total) * W;
    const y = (e: number) => padT + (1 - (e - min) / (max - min)) * (H - padB - padT);
    // Downsample for rendering
    const step = Math.max(1, Math.floor(elevations.length / 300));
    let p = '';
    for (let i = 0; i < elevations.length; i += step) p += `${p ? 'L' : 'M'}${x(distances[i]).toFixed(1)},${y(elevations[i]).toFixed(1)}`;
    p += `L${W},${y(elevations[elevations.length - 1]).toFixed(1)}`;
    return { path: p, area: `${p}L${W},${H - padB}L0,${H - padB}Z`, min, max, total };
  }, [distances, elevations, H]);

  const move = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const d = ((clientX - r.left) / r.width) * total;
    let lo = 0, hi = distances.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (distances[m] < d) lo = m; else hi = m; }
    setHover(lo);
    onHover?.(lo);
  };
  const leave = () => { setHover(null); onHover?.(null); };
  const hx = hover != null ? (distances[hover] / total) * W : 0;
  const hy = hover != null ? padT + (1 - (elevations[hover] - min) / (max - min)) * (H - padB - padT) : 0;

  return (
    <div style={{ position: 'relative' }}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: 'block', touchAction: 'none' }}
        onPointerMove={(e) => move(e.clientX)} onPointerDown={(e) => move(e.clientX)} onPointerLeave={leave}>
        <defs>
          <linearGradient id="elev" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.45" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#elev)" />
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {hover != null && <line x1={hx} x2={hx} y1={0} y2={H - padB} stroke="#fff" strokeOpacity="0.5" vectorEffect="non-scaling-stroke" />}
        {hover != null && <circle cx={hx} cy={hy} r="4" fill="#fff" />}
      </svg>
      <div className="row between faint small" style={{ marginTop: -14 }}>
        <span>{formatY(min)}–{formatY(max)}</span>
        {hover != null ? <span className="muted">{formatX(distances[hover])} · {formatY(elevations[hover])}</span> : <span>{formatX(total)}</span>}
      </div>
    </div>
  );
}

export function BarChart({ data, height = 140, format, highlightLast = true }: { data: { label: string; value: number }[]; height?: number; format: (v: number) => string; highlightLast?: boolean }) {
  const max = Math.max(1e-9, ...data.map((d) => d.value));
  const [sel, setSel] = useState<number | null>(null);
  const shown = sel ?? data.length - 1;
  return (
    <div>
      <div className="row between small" style={{ marginBottom: 8 }}>
        <span className="muted">{data[shown]?.label}</span>
        <strong className="tnum">{format(data[shown]?.value ?? 0)}</strong>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height }}>
        {data.map((d, i) => (
          <div key={i} onPointerEnter={() => setSel(i)} onPointerLeave={() => setSel(null)} onClick={() => setSel(i)}
            style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end', cursor: 'pointer' }}>
            <div style={{
              width: '100%', height: `${Math.max(2, (d.value / max) * 100)}%`, borderRadius: 6,
              background: i === shown || (highlightLast && sel == null && i === data.length - 1) ? 'var(--accent)' : 'var(--bg-elev-2)',
              transition: 'height .3s',
            }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        {data.map((d, i) => <div key={i} className="faint" style={{ flex: 1, fontSize: 10, textAlign: 'center', overflow: 'hidden', whiteSpace: 'nowrap' }}>{i % Math.ceil(data.length / 6) === 0 ? d.label : ''}</div>)}
      </div>
    </div>
  );
}

export function ProgressRing({ fraction, size = 120, stroke = 12, expected, children }: { fraction: number; size?: number; stroke?: number; expected?: number; children?: React.ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, fraction));
  const e = expected != null ? Math.max(0, Math.min(1, expected)) : null;
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--bg-elev-2)" strokeWidth={stroke} fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--accent)" strokeWidth={stroke} fill="none" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - f)} style={{ transition: 'stroke-dashoffset .6s ease' }} />
        {e != null && e > 0.01 && e < 0.99 && (
          <circle cx={size / 2 + r * Math.cos(e * 2 * Math.PI)} cy={size / 2 + r * Math.sin(e * 2 * Math.PI)} r={stroke / 4} fill="#fff" opacity={0.7} />
        )}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>{children}</div>
    </div>
  );
}
