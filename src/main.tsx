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

// Offline app shell for the installed PWA (skipped in dev and inside the native shell).
if ('serviceWorker' in navigator && import.meta.env.PROD && !(window as any).Capacitor?.isNativePlatform?.()) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
