/** Small shared UI primitives + app-wide hooks. */
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, DEFAULT_SETTINGS, getSettings } from '../db/db';
import type { Settings } from '../types';
import { MAP_STYLE_LIST } from '../lib/mapStyles';
import type { MapStyleId } from '../types';

/** Live settings (re-renders on change). Falls back to defaults while loading. */
export function useSettings(): Settings {
  const s = useLiveQuery(() => getSettings(), [], DEFAULT_SETTINGS);
  return s ?? DEFAULT_SETTINGS;
}

/**
 * Map style for a page's map: starts at the "Default map" setting and adopts the
 * saved value once settings finish loading, unless the user already picked one.
 */
export function useMapStyle(settings: Settings): [MapStyleId, (s: MapStyleId) => void] {
  const [styleId, setStyleId] = useState<MapStyleId>(settings.defaultMapStyle);
  const touched = useRef(false);
  const adopted = useRef(settings !== DEFAULT_SETTINGS);
  useEffect(() => {
    if (adopted.current || settings === DEFAULT_SETTINGS) return;
    adopted.current = true;
    if (!touched.current) setStyleId(settings.defaultMapStyle);
  }, [settings]);
  const pick = useCallback((s: MapStyleId) => { touched.current = true; setStyleId(s); }, []);
  return [styleId, pick];
}

export function useActivities() {
  return useLiveQuery(() => db.activities.orderBy('startedAt').reverse().toArray(), []);
}

export function Stat({ label, value, unit, size }: { label: string; value: string; unit?: string; size?: 'lg' | 'xl' }) {
  return (
    <div className={`stat ${size ?? ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}{unit && <small>{unit}</small>}</div>
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    // Move focus into the dialog, keep Tab inside it, and give focus back on close.
    const opener = document.activeElement as HTMLElement | null;
    const box = ref.current;
    (box?.querySelector<HTMLElement>(FOCUSABLE) ?? box)?.focus();
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCloseRef.current(); return; }
      if (e.key !== 'Tab' || !box) return;
      const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('keydown', k); if (opener?.isConnected) opener.focus(); };
  }, [open]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div ref={ref} tabIndex={-1} className="sheet" role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} onClick={(e) => e.stopPropagation()}>
        {title && <h2 id={titleId} style={{ marginBottom: 16 }}>{title}</h2>}
        {children}
      </div>
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="switch" aria-label={label}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)} role="radio" aria-checked={o.value === value}>{o.label}</button>
      ))}
    </div>
  );
}

export function StylePicker({ value, onChange }: { value: MapStyleId; onChange: (v: MapStyleId) => void }) {
  return (
    <div className="map-style-picker" role="group" aria-label="Map style">
      {MAP_STYLE_LIST.map((s) => (
        <button key={s.id} title={s.label} aria-label={`${s.label} map`} aria-pressed={s.id === value} className={`style-swatch ${s.id === value ? 'on' : ''}`} style={{ background: s.swatch }} onClick={() => onChange(s.id)} />
      ))}
    </div>
  );
}

// ---------- toast ----------
const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const show = useCallback((m: string) => {
    setMsg(m);
    window.setTimeout(() => setMsg((cur) => (cur === m ? null : cur)), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && <div className="toast" role="status">{msg}</div>}
    </ToastCtx.Provider>
  );
}
