/** Minimal inline icon set (stroke icons, 24×24). */
const paths: Record<string, string> = {
  home: 'M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  routes: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm12-10a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM6 15V9a3 3 0 0 1 3-3h3m6 3v6a3 3 0 0 1-3 3h-3',
  history: 'M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5M3.5 4v4.5H8',
  progress: 'M4 20V10m6 10V4m6 16v-7m6 7H2',
  walk: 'M13 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM10 22l2-6 3 3v3m-5-12 3-2 3 4 3 1M10 8l-2 5 3 1',
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M8 5v14M16 5v14',
  stop: 'M6 6h12v12H6z',
  layers: 'm12 3 9 5-9 5-9-5zM3 13l9 5 9-5',
  locate: 'M12 2v3m0 14v3M2 12h3m14 0h3M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z',
  cube: 'm12 2 9 5v10l-9 5-9-5V7zm0 0v10m0 0 9-5m-9 5-9-5',
  share: 'M12 3v12m0-12L8 7m4-4 4 4M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6',
  download: 'M12 3v12m0 0-4-4m4 4 4-4M5 21h14',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5a1 1 0 1 0 0-.01',
  video: 'M3 6h12v12H3zM15 10l6-3v10l-6-3',
  back: 'M15 5 8 12l7 7',
  close: 'M6 6l12 12M18 6 6 18',
  trash: 'M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  plus: 'M12 5v14M5 12h14',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-4l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1c.6.5 1.3.9 2 1.2l.4 2.6h4l.4-2.6c.7-.3 1.4-.7 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',
  trophy: 'M8 21h8m-4-4v4m-5-17h10v5a5 5 0 0 1-10 0zM7 6H4v2a3 3 0 0 0 3 3m10-5h3v2a3 3 0 0 1-3 3',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-4a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-4a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  flame: 'M12 22c4 0 7-2.7 7-7 0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-2 2-5 5-5 8 0 4.3 3 7 7 7Z',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  shuffle: 'M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5',
  upload: 'M12 21V9m0 0-4 4m4-4 4 4M5 3h14',
  mountain: 'm3 20 6-10 4 6 3-4 5 8z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v4l3 2',
  check: 'M5 12.5 10 17l9-10',
  sim: 'M12 3a9 9 0 1 0 9 9M12 7v5l3 3M17 3h4v4',
  flag: 'M5 21V4m0 0h11l-2 4 2 4H5',
  run: 'M15 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM4 21l4-4.5 3 2 2-4.5 4 2.5M6.5 11l3.5-3 4 1 2 3.5 3 .5',
  bus: 'M6 17V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v11zm0 0v2.5m12-2.5v2.5M6 11h12M9 14.5h.01M15 14.5h.01',
};

export function Icon({ name, size = 22, stroke = 2, className, fill }: { name: keyof typeof paths | string; size?: number; stroke?: number; className?: string; fill?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={paths[name] ?? ''} />
    </svg>
  );
}
