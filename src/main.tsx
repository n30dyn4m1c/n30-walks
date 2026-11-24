import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles/global.css';
import { App } from './App';
import { migrateStats } from './lib/activityBuilder';

// Recompute stored stats once after an algorithm fix (derived data only; walks are untouched).
migrateStats().catch((e) => console.warn('[stats] migration failed', e));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// A tab opened before a deploy can ask for a lazy chunk (e.g. Studio) that no longer
// exists. Reload once to pick up the new build instead of showing a broken page.
window.addEventListener('vite:preloadError', (e) => {
  try {
    const last = Number(sessionStorage.getItem('stride-chunk-reload') || 0);
    if (Date.now() - last < 10_000) return; // already tried: let the error surface
    sessionStorage.setItem('stride-chunk-reload', String(Date.now()));
  } catch { /* storage blocked: still reload once per page load */ }
  e.preventDefault();
  window.location.reload();
});

// Offline app shell for the installed PWA (skipped in dev and inside the native shell).
if ('serviceWorker' in navigator && import.meta.env.PROD && !(window as any).Capacitor?.isNativePlatform?.()) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
