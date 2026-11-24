import { lazy, Suspense } from 'react';
import { BrowserRouter, HashRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { Icon } from './components/Icon';
import { ToastProvider } from './components/ui';
import { useRecorder } from './tracking/recorder';
import { HomePage } from './pages/Home';
import { RecordPage } from './pages/Record';
import { HistoryPage } from './pages/History';
import { ActivityPage } from './pages/Activity';
import { ProgressPage } from './pages/Progress';
import { RoutesPage } from './pages/Routes';
import { SettingsPage } from './pages/Settings';

// The studio pulls in the encoder/muxer — load it on demand.
const StudioPage = lazy(() => import('./pages/Studio').then((m) => ({ default: m.StudioPage })));

function Nav() {
  const rec = useRecorder();
  const loc = useLocation();
  if (loc.pathname.startsWith('/studio')) return null;
  const live = rec.status === 'recording' || rec.status === 'paused';
  return (
    <nav className="nav" aria-label="Main">
      <NavLink to="/" end><Icon name="home" />Today</NavLink>
      <NavLink to="/routes"><Icon name="routes" />Routes</NavLink>
      <NavLink to="/record"><div className={`rec ${live ? 'live' : ''}`}><Icon name="walk" size={26} stroke={2.2} /></div>{live ? 'Walking' : 'Record'}</NavLink>
      <NavLink to="/history"><Icon name="history" />History</NavLink>
      <NavLink to="/progress"><Icon name="progress" />Progress</NavLink>
    </nav>
  );
}

export function App() {
  // File-based native shells and some static hosts can't rewrite deep links: use hash routing there.
  const Router = Capacitor.isNativePlatform() || location.protocol === 'file:' ? HashRouter : BrowserRouter;
  return (
    <ToastProvider>
      <Router basename={Router === BrowserRouter ? import.meta.env.BASE_URL.replace(/^\.\/?$/, '/') : undefined}>
        <div className="app">
          <Suspense fallback={<div className="page"><span className="spinner" /></div>}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/record" element={<RecordPage />} />
              <Route path="/history" element={<HistoryPage />} />
              <Route path="/activity/:id" element={<ActivityPage />} />
              <Route path="/studio/:id" element={<StudioPage />} />
              <Route path="/progress" element={<ProgressPage />} />
              <Route path="/routes" element={<RoutesPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<HomePage />} />
            </Routes>
          </Suspense>
          <Nav />
        </div>
      </Router>
    </ToastProvider>
  );
}
