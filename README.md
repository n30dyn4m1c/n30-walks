# Stride: a personal walking tracker

Stride records your walks with GPS, shows them on a 3D terrain map, plays a 3D flyover video of the route, and exports 9:16 images and MP4s ready for **WhatsApp Status**. It is personal only: there are no feeds, followers, kudos, clubs or leaderboards. Your data stays on your device.

```
npm install && npm run dev        # web (desktop + phone on the same Wi-Fi)
npm run mobile:android            # native Android build (Android Studio)
npm run mobile:ios                # native iOS build (Xcode, macOS only)
```

---

## 1. Architecture overview and tech stack

```
┌──────────────────────── React 19 + TypeScript (one codebase) ────────────────────────┐
│ pages/      Today · Record · History · Activity · Studio · Routes · Progress · Settings│
│ components/ MapView (MapLibre) · Charts (SVG) · UI primitives                         │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ tracking/   recorder (state machine + crash-safe draft) ← LocationProvider interface  │
│             ├─ WebProvider        W3C Geolocation (browser / PWA)                     │
│             ├─ NativeProvider     Capacitor background-geolocation (foreground svc)   │
│             └─ SimulatedProvider  accelerated noisy replay for desk testing           │
│ lib/        gpsFilter (constant-velocity Kalman) · stats · records · elevation (DEM)  │
│             routing (OSRM foot) · gpx · geo · mapStyles · mapLayers · format · demo   │
│ flyover/    plan.ts (pure camera math, tested) · scene.ts (binds the plan to MapLibre) │
│ media/      overlay (shared canvas renderer) · videoExport (WebCodecs → H.264 MP4)    │
│             imageExport (JPEG) · share (Web Share / Capacitor Share / download)       │
│ db/         Dexie / IndexedDB: activities · tracks · routes · goals · settings · draft│
└───────────────────────────────────────────────────────────────────────────────────────┘
        Web: Vite PWA                       Mobile: Capacitor 8 shell (Android / iOS)
```

### Why this stack

| Decision | Choice | Why |
|---|---|---|
| App framework | **React + Vite + TypeScript web app, wrapped with Capacitor** for Android and iOS | One codebase covers web and mobile. MapLibre GL JS is the most capable open 3D terrain engine, and it runs natively in the browser and in a WebView. A WebView also gives **WebCodecs** (hardware H.264 encoding) and canvas compositing, which the video export depends on. Flutter and React Native have no mature, free 3D-terrain flyover map that can also be captured frame by frame into an MP4. |
| Maps / 3D | **MapLibre GL JS 5** with `raster-dem` terrain, sky/fog, hillshade and `color-relief` | Open source and needs no API key. It supports true 3D terrain with pitch up to 85°. Route, marker and halo are all drawn in WebGL, so the exported frames contain exactly what you see in the player. |
| Tiles | OpenFreeMap (Outdoor, Light), CARTO (Dark), Esri (Satellite), **self-built "Relief" style** from AWS Terrarium DEM | None need a key. Relief needs only DEM tiles, so it is also the **automatic fallback** when a basemap provider can't be reached. |
| Background GPS | `@capacitor-community/background-geolocation` | Runs an Android foreground service and uses iOS background location mode, so tracking continues with the screen off. Browsers can't do this, and the app says so on screen. |
| Video | **Frame-by-frame rendering → WebCodecs `VideoEncoder` (H.264) → `mp4-muxer`** | This gives a deterministic, perfectly smooth 30 fps MP4 at 1080×1920 with fast-start, on any device speed. A slow phone just takes longer to export. MediaRecorder screen capture drops frames and produces WebM on Chrome, which WhatsApp doesn't accept. |
| Storage | **IndexedDB via Dexie** | Local-first and works offline. It is identical in the browser and in the native WebView. Tracks are stored separately from summaries, so list and analytics screens stay fast. |
| Routing | OSRM `foot` profile (FOSSGIS public instance), with a straight-line fallback | No key needed. Override it with `VITE_ROUTING_URL` to self-host. |

---

## 2. Data model

Types are in `src/types.ts`. Storage is in `src/db/db.ts`.

| Table | Key | Contents |
|---|---|---|
| `activities` | `id`, indexed `startedAt` | Name, type (`walk`/`hike`), start and end times, `source` (`gps`, `simulated`, `gpx`, `demo`), **`stats`** (distance, elapsed and moving time, average pace and speed, elevation gain/loss/min/max, estimated steps and kcal, **`bestEfforts`** for 1 km / mile / 5 km / 10 km / half marathon, `splits[]`, `elevationSource`), `bbox`, an 80-point `preview` path for thumbnails, optional `routeId` and `notes` |
| `tracks` | `activityId` | Full filtered `TrackPoint[]` (`lat`, `lon`, `t`, `ele`, `acc`) and manual `pauses[]` |
| `routes` | `id`, indexed `updatedAt` | Waypoints, routed geometry, distance, elevation gain, `source` (`planned`, `discovered`, `gpx`, `activity`), and whether it was `snapped` to paths |
| `goals` | `id` | `metric` (distance, duration, count, elevation, steps), `period` (day, week, month, year), `target` in base units |
| `settings` | `'settings'` | Units, weight, stride, default map, GPS accuracy threshold, wake lock, and the **default `OverlayConfig`** (template, colours, map style, which stats to show, video length and quality, terrain exaggeration) |
| `drafts` | `'draft'` | The in-progress recording. It is saved every 5 s and on every state change, so a crash or reload can be resumed. |

**Personal records are derived, not stored.** `computeRecords()` takes the minimum or maximum over each activity's `bestEfforts` and totals. Deleting or editing a walk can therefore never leave a stale record behind. Goals, streaks and trends are derived from activity summaries the same way.

---

## 3. Feature plan (prioritised) and status

| P | Feature | Status |
|---|---|---|
| P0 | GPS recording: filtering, pause/resume, auto-pause indicator, wake lock, crash recovery, hold-to-finish | ✅ |
| P0 | Activity map (pace-coloured route, 3D terrain, style switcher) with full stats, DEM elevation profile linked to the map, and splits | ✅ |
| P0 | 3D flyover player: intro swoop, chase cam, outro orbit; progressive path; moving marker; live stats overlay; elevation progress chart | ✅ |
| P0 | WhatsApp Status export: 1080×1920 (or 720p) H.264 MP4 under 16 MB, and a 1080×1920 JPEG; share sheet or download | ✅ |
| P0 | GPS simulator (5×/10×/30×) and demo data, so everything can be tested at a desk | ✅ |
| P1 | Customisable overlays: 3 templates, 5 map styles, accent and route colours, stat toggles, title, length, quality, terrain exaggeration | ✅ |
| P1 | Personal records, goals (any metric and period), streaks, weekly/monthly trends, all-time totals | ✅ |
| P1 | Route planning (tap waypoints, snapped to footpaths, loop back to start, elevation profile) and discovery (3 generated round-trip loops of a target length) | ✅ |
| P1 | Follow a saved route while recording; simulate walking a saved route | ✅ |
| P2 | GPX import (timed → activity, untimed → route) and export; JSON backup and restore; unit and weight recompute | ✅ |
| P2 | PWA install and offline shell | ✅ |
| Next | Offline map tile packs; native H.264 fallback encoder; Health Connect / HealthKit step counts; audio cues; widget | ⏳ open |

---

## 4. Code layout

```
src/
  types.ts                 domain types
  db/db.ts                 Dexie schema, settings, backup/restore
  lib/geo.ts               haversine, bearing, interpolation, Douglas–Peucker, resample, fit zoom
  lib/gpsFilter.ts         accuracy + glitch rejection, constant-velocity Kalman, stationary suppression
  lib/stats.ts             distance, moving time, splits, elevation hysteresis, sliding-window best efforts, MET kcal
  lib/records.ts           PRs, goal progress, periods, buckets, streaks
  lib/elevation.ts         Terrarium DEM sampling (bilinear) → elevation that matches the 3D terrain
  lib/activityBuilder.ts   points → DEM-corrected stats → saved Activity; demo seeding
  lib/routing.ts           OSRM foot routing, loop generator, fallback
  lib/mapStyles.ts         styles, terrain, sky, relief style
  lib/mapLayers.ts         route/pace-gradient/endpoint/position layers
  lib/gpx.ts, format.ts, demo.ts
  tracking/providers.ts    Web / Native / Simulated location providers
  tracking/recorder.ts     recording state machine + React hook
  flyover/plan.ts          camera timeline (intro → follow → outro), bearing smoothing, live stats
  flyover/scene.ts         MapLibre layers + per-frame camera
  media/overlay.ts         canvas overlay (classic / minimal / bold), shared by preview, MP4 and JPEG
  media/offscreenMap.ts    fixed-size hidden map used for export frames
  media/videoExport.ts     WebCodecs + mp4-muxer pipeline
  media/imageExport.ts     hero still
  media/share.ts           native share / Web Share / download
  components/, pages/      UI
scripts/e2e.mjs            Playwright end-to-end check (records, exports, ffprobe-validates)
scripts/mobile.mjs         one-command Capacitor setup with permission patching
```

Unit tests sit next to the code (`*.test.ts`) and cover geo math, the GPS filter (noise and accuracy budgets), stats, PRs and goals, and flyover camera smoothness and continuity.

---

## 5. Setup and run

**You need** Node 20+ and npm. Mobile builds also need Android Studio (SDK 35+) or Xcode 16+.

```bash
npm install
npm run dev          # http://localhost:5173, also on your LAN for phones
npm test             # unit tests (vitest)
npm run build        # type-check + production build into dist/
npm run preview      # serve the production build
npm run e2e          # after build: headless end-to-end run, artifacts in e2e-output/
```

**On a phone over the web:** browsers only allow GPS on `https://` or `localhost`. Either deploy `dist/` to any static HTTPS host, or tunnel the dev server (for example `npx localtunnel --port 5173`, or Chrome's `chrome://inspect` port forwarding to `localhost`).

**Native Android:** run `npm run mobile:android`. This builds, creates `android/` on first run, adds the location, foreground-service and notification permissions, syncs, and opens Android Studio. Press ▶ to run on a device.

**Native iOS (macOS):** run `npm run mobile:ios`. It adds the location usage strings and the `location` background mode, then opens Xcode. Set your signing team and run.

Use `--no-open` (for example `node scripts/mobile.mjs android --no-open`) to skip opening the IDE.

---

## 6. Verification steps

1. **GPS recording (real).** Open **Record** on a phone, allow location, and wait for the green `GPS ±N m` pill. Tap **START** and walk. Time, distance and pace update live, and the route draws behind the blue dot. Pause and resume, then **hold ■** to finish. You land on the saved walk.
2. **GPS recording (desk).** On **Record**, tap the simulator button (right of START). Choose 2 km at 30× and start. The walk runs in about a minute with realistic noise and occasional glitches; the "noisy fixes filtered" counter shows rejections. When "Simulated route complete" appears, hold ■. Recorded distance should be within about 5% of 2 km. Reloading mid-walk shows "Unfinished walk found" on Today.
3. **Map display.** On the walk page, the route is coloured by pace (green is fast, red is slow) on 3D terrain. Switch map styles with the swatches. Drag over the elevation chart and a marker follows on the map. Check splits, stats and PR badges.
4. **3D flyover.** Tap **Play 3D flyover · Create Status**. The 9:16 preview plays: an overview swoops down to the start, the camera chases the marker as the path draws, live stats and the elevation cursor advance, then the camera pulls back to an orbit. Scrub with the slider and change template, colours, style and exaggeration live.
5. **WhatsApp export.** Tap **Image (JPEG)**, then **Video (MP4)**. The progress bar shows frames and ETA. The result card shows `1080×1920 · 15s · H.264 · N MB`. On a phone, **Share to WhatsApp** opens the share sheet; choose WhatsApp → *My status*. On desktop it downloads the file. To check a file: `ffprobe status.mp4` should report `h264`, `1080x1920`, `30 fps`, and a size under 16 MB.
6. **Persistence.** Reload the app, or kill and reopen it. Walks, routes, goals and studio preferences are still there. Settings → Export backup gives a JSON file of everything.
7. **Routes.** In **Routes → Plan**, tap 3+ points; the route snaps to footpaths. Toggle loop, see the elevation profile, and save. **Routes → Discover** at 5 km gives three loops. Save one, then **Walk it** to follow it on Record (dashed blue line); the simulator can walk it too.
8. **Automated:** run `npm run build && npm run e2e`.

### What was verified in this build environment

- `npm test`: 27 unit tests pass. They include the GPS-filter accuracy budgets and flyover camera smoothness: under 6° bearing change per frame, and continuity at phase boundaries.
- `npm run e2e` in headless Chromium with software WebGL: mocked web geolocation recording, a 30× simulated walk, the activity page, the flyover studio, JPEG and MP4 export validated with `ffprobe`, PRs, history persistence after reload, and route planning. Results are in the PR description.
- The container's network allowed only the AWS DEM host, so the e2e run used the automatic **Relief** fallback style and the straight-line routing fallback. OpenFreeMap, CARTO, Esri and OSRM were **not** reachable from the test environment.
- `scripts/mobile.mjs android --no-open` generates and patches the Android project and syncs it. Building an APK, and anything on iOS, needs Android Studio or Xcode on your machine and was **not** done here.

---

## 7. Assumptions and open questions

**Assumptions**
- **Free tile providers are fine for a personal prototype.** OpenFreeMap (free, no key), CARTO basemaps (free for non-commercial and low volume), Esri World Imagery (attribution required; check the terms before any public or commercial use), and the AWS Terrain Tiles open dataset. The attribution text is drawn into every exported image and video.
- **The public FOSSGIS OSRM foot router** is acceptable for occasional planning requests; it has a fair-use policy. Self-host or use a commercial router (GraphHopper, Valhalla, Stadia) for production by setting `VITE_ROUTING_URL`.
- **WhatsApp Status format:** 9:16 at 1080×1920, H.264 in MP4, no audio, under 60 s (we cap at 30 s), and **under 16 MB** so WhatsApp doesn't trim or heavily re-encode it. Key content stays clear of the top ~10% (WhatsApp progress bars) and the bottom ~10% (reply bar).
- **Elevation comes from the DEM**, not GPS altitude. The browser often has no altitude, and phone barometers aren't reachable from the web. Elevation is sampled once at save time at zoom 14 (~10 m/px), so profiles match the 3D terrain exactly. If offline, it falls back to GPS altitude when available.
- **Steps and calories are estimates** from distance ÷ stride and walking MET × weight. There is no pedometer or health-platform integration.
- **Web recording works only while the page is visible.** This is a browser restriction, mitigated with a wake lock and a warning. Pocket and screen-off tracking needs the native build.
- Pace colouring is relative to each walk's own 10th–90th percentile pace, not to absolute thresholds.

**Open questions and technical decisions**
1. **H.264 availability.** All mainstream Chrome, Edge, Safari and Android WebView builds have a WebCodecs H.264 encoder. Some Linux Chromium builds don't; the app then exports VP9-in-MP4 and warns that WhatsApp may reject it. Should we add an ffmpeg.wasm or native (MediaCodec / AVFoundation) encoder fallback?
2. **Offline maps.** Tiles are not cached by the service worker (size and provider terms). Do we want downloadable offline regions, for example PMTiles?
3. **Background GPS on iOS.** The plugin keeps tracking in the background, but iOS may still suspend apps under memory pressure. Is a fully native Swift tracker worth it?
4. **Audio and music** in exported videos (licensing), and audio cues per km while recording.
5. **Health platforms.** Should we write walks to Apple Health and Google Health Connect, and read real step counts from them?
6. **Cloud backup or sync** (still private, no social features)? Currently there is a manual JSON export and import.
7. **Export speed.** 1080p export renders every frame at full resolution and waits for tiles. Expect 1–3 minutes on mid-range phones for 15 s. 720p is offered as the fast option.
