/** Small shared UI primitives + app-wide hooks. */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
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

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {title && <h2 style={{ marginBottom: 16 }}>{title}</h2>}
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

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)} role="tab" aria-selected={o.value === value}>{o.label}</button>
      ))}
    </div>
  );
}

export function StylePicker({ value, onChange }: { value: MapStyleId; onChange: (v: MapStyleId) => void }) {
  return (
    <div className="map-style-picker">
      {MAP_STYLE_LIST.map((s) => (
        <button key={s.id} title={s.label} aria-label={`${s.label} map`} className={`style-swatch ${s.id === value ? 'on' : ''}`} style={{ background: s.swatch }} onClick={() => onChange(s.id)} />
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
