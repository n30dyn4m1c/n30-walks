/**
 * Location providers behind one interface:
 *  - WebProvider:      W3C Geolocation (browsers / PWA). Foreground only.
 *  - NativeProvider:   Capacitor background-geolocation plugin (Android/iOS),
 *                      runs a foreground service so tracking continues with
 *                      the screen off / phone in pocket.
 *  - SimulatedProvider: replays a path with realistic noise and glitches at
 *                      an accelerated clock — lets you test the full pipeline
 *                      at a desk.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation';
import type { RawFix } from '../lib/gpsFilter';
import { cumulativeDistances, pointAtDistance, type LngLat } from '../lib/geo';
import { gaussian, rng } from '../lib/demo';

export type ProviderError = { code: 'denied' | 'unavailable' | 'timeout' | 'unsupported'; message: string };

export interface LocationProvider {
  readonly kind: 'web' | 'native' | 'simulated';
  start(onFix: (f: RawFix) => void, onError: (e: ProviderError) => void): Promise<void>;
  stop(): Promise<void>;
  /** Clock used for timestamps & timers (simulated provider runs faster than real time). */
  now(): number;
}

export class WebProvider implements LocationProvider {
  readonly kind = 'web' as const;
  private watchId: number | null = null;
  now() { return Date.now(); }

  async start(onFix: (f: RawFix) => void, onError: (e: ProviderError) => void) {
    if (!('geolocation' in navigator)) {
      onError({ code: 'unsupported', message: 'This browser has no GPS / Geolocation support.' });
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => onFix({
        lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy,
        alt: pos.coords.altitude, speed: pos.coords.speed,
        // Some browsers deliver cached fixes with old timestamps; clamp to now.
        t: Math.min(Date.now(), pos.timestamp || Date.now()),
      }),
      (err) => onError({
        code: err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable',
        message: err.code === 1 ? 'Location permission denied. Enable it in your browser settings.' : err.message || 'Location unavailable',
      }),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
  }

  async stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }
}

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

export class NativeProvider implements LocationProvider {
  readonly kind = 'native' as const;
  private id: string | null = null;
  now() { return Date.now(); }

  async start(onFix: (f: RawFix) => void, onError: (e: ProviderError) => void) {
    this.id = await BackgroundGeolocation.addWatcher(
      {
        backgroundTitle: 'Stride is recording your walk',
        backgroundMessage: 'GPS stays on while you walk. Tap to return.',
        requestPermissions: true,
        stale: false,
        distanceFilter: 0, // we filter ourselves (see gpsFilter.ts)
      },
      (location, error) => {
        if (error) {
          if (error.code === 'NOT_AUTHORIZED') {
            onError({ code: 'denied', message: 'Location permission denied. Open settings to allow “Always” / “While using”.' });
            if (window.confirm('Stride needs location access to record walks. Open settings?')) BackgroundGeolocation.openSettings();
          } else onError({ code: 'unavailable', message: error.message });
          return;
        }
        if (!location) return;
        onFix({ lat: location.latitude, lon: location.longitude, acc: location.accuracy, alt: location.altitude, speed: location.speed, t: location.time ?? Date.now() });
      },
    );
  }

  async stop() {
    if (this.id) await BackgroundGeolocation.removeWatcher({ id: this.id });
    this.id = null;
  }
}

/**
 * Simulated walk. `speedup` multiplies the clock: at 10× a 30-minute walk
 * records in 3 minutes, with timestamps that look like a real 30-minute walk.
 */
export class SimulatedProvider implements LocationProvider {
  readonly kind = 'simulated' as const;
  private timer: ReturnType<typeof setInterval> | null = null;
  private simNow: number;
  private dist = 0;
  private readonly cum: number[];
  private readonly rand = rng(42);
  speedup: number;
  /** While true the simulated walker stands still (mirrors a paused recording). */
  holdPosition = false;

  constructor(private path: LngLat[], speedup = 10, private walkSpeedMps = 1.45) {
    this.cum = cumulativeDistances(path);
    this.simNow = Date.now();
    this.speedup = speedup;
  }

  now() { return this.simNow; }

  async start(onFix: (f: RawFix) => void) {
    const tickMs = 250; // real ms per tick
    const total = this.cum[this.cum.length - 1];
    let lastWall = Date.now();
    let sinceFix = 0;
    this.timer = setInterval(() => {
      const wall = Date.now();
      const dtSim = (wall - lastWall) * this.speedup;
      lastWall = wall;
      this.simNow += dtSim;
      sinceFix += dtSim;
      if (this.dist < total && !this.holdPosition) this.dist = Math.min(total, this.dist + (this.walkSpeedMps * (1 + 0.1 * Math.sin(this.dist / 250)) * dtSim) / 1000);
      // Emit one fix per simulated second, like a real GPS chipset.
      while (sinceFix >= 1000) {
        sinceFix -= 1000;
        const { p } = pointAtDistance(this.path, this.cum, this.dist);
        const r = this.rand;
        const glitch = r() < 0.01; // ~1 % wild fixes to exercise outlier rejection
        const noiseM = glitch ? 120 : 3.5;
        const acc = glitch ? 12 : 4 + r() * 6;
        const k = 111_320;
        onFix({
          lon: p[0] + (gaussian(r) * noiseM) / (k * Math.cos((p[1] * Math.PI) / 180)),
          lat: p[1] + (gaussian(r) * noiseM) / k,
          acc, alt: null, speed: this.walkSpeedMps, t: this.simNow - sinceFix,
        });
      }
    }, tickMs);
  }

  /** Has the simulated walker reached the end of the path? */
  get finished() { return this.dist >= this.cum[this.cum.length - 1]; }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const isNative = () => Capacitor.isNativePlatform();

export function createRealProvider(): LocationProvider {
  return isNative() ? new NativeProvider() : new WebProvider();
}
