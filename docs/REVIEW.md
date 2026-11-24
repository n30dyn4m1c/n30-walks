# Stride code review and fix tracker

A full review of the app: bugs, reliability risks, best-practice gaps and UI/UX.
Each item has a status so work can continue across sessions.

**Status key:** ✅ done · 🟡 partly done · ⬜ open

- **Reviewed at:** `4f7b596`.
- **First fix round:** PR #5, merged as `4182674`.
- **Second fix round:** action-plan steps 1–4 (M2, M3, M4, M8, M9, M10, the accessibility batch and the recording UX).
- **How to continue:** pick the next ⬜ item from the [action plan](#action-plan) and change its status here in the same PR as the fix.

---

## Overall health

The structure is clean: pure, unit-tested modules for the GPS filter, stats and flyover camera plan; a small observable recorder; and one overlay renderer shared by preview, MP4 and JPEG. TypeScript runs in strict mode. The frame-by-frame WebCodecs export is the right design.

The weak spots were where the layers meet (recorder ↔ stats, recording ↔ storage, web ↔ native). The worst of those are fixed (round 1). What remains is mostly medium-priority robustness, accessibility and UX polish.

---

## Critical

| ID | Issue | Status |
|---|---|---|
| C1 | **GPS gaps created fake PRs and wrong pace.** A segment with `dt > MAX_GAP_S` added distance but no moving time, giving e.g. a "fastest 1 km" of 2:23. | ✅ Gap segments now credit at most `d / MOVING_SPEED_MPS` seconds (`segmentContribution()` in `src/lib/stats.ts`). `STATS_VERSION = 2` plus `migrateStats()` recompute stored walks once on launch. |
| C2 | **Saving could lose the walk.** `finish()` deleted the draft in `finally`, even when the save failed. | ✅ The draft is deleted in the same Dexie transaction as the save (`saveActivity(…, { clearDraft })`). On failure the walk stays paused with GPS on, ready to retry. |
| C3 | **Starting a walk overwrote an unfinished draft.** | ✅ `recorder.start()` refuses while a draft exists. Record shows the shared `DraftCard` (Resume / Save / Discard). |

## High

| ID | Issue | Status |
|---|---|---|
| H1 | **Live stats disagreed with saved stats.** Movement while paused counted live only; `resumeDraft` reset moving time and ignored `pausedAt`; finishing while paused made elapsed time shorter than moving time. | ✅ One shared `segmentContribution()` rule; `trackTotals()` restores drafts; pauses are clipped to the track (`pausedWithin`); paused drafts resume paused. |
| H2 | **Elevation fetch had no timeout, and failed tiles were cached for the whole session.** | ✅ 8 s per-tile timeout in `src/lib/elevation.ts`; failures are evicted from the cache; `enrichElevation()` fills elevation in later. |
| H3 | **Studio's elevation backfill updated the track but not the stats.** | ✅ Studio and the Activity page both call `enrichElevation()`, which recomputes stats in a transaction. |
| H4 | **Download buttons did nothing in the native WebView; share errors were hidden.** | ✅ `saveBlob()` in `src/media/share.ts` uses the share sheet on native. Real share errors are now thrown instead of being reported as "cancelled". |
| H5 | **Web storage could be evicted** (no `storage.persist()`). | ✅ Persistence is requested after the first save. Settings shows the protection status, a Protect button and the last backup date. |
| H6 | **Export reliability:** no wake lock, export kept running after leaving Studio, no file-size check, offscreen-map WebGL leak on timeout, 20 MB base64 string over the native bridge. | ✅ `keepAwake()` (`src/lib/wakeLock.ts`); abort on unmount; re-encode once if the file is over 16 MB, plus a size badge; map destroyed on style timeout; native writes in 768 KB chunks into a cleared `exports/` cache dir. |
| H7 | **The recorder had no integration tests.** | ✅ `src/tracking/recorder.test.ts` (fake-indexeddb, hand-driven GPS). Running e2e in CI is still open: see T2. |

## Medium

| ID | Issue | Where | Fix | Status |
|---|---|---|---|---|
| M1 | Overlapping `acquire()` calls leaked GPS watchers. | `recorder.ts` | Generation token. | ✅ |
| M2 | **"Default map" setting is ignored.** `useState(settings.defaultMapStyle)` captures `DEFAULT_SETTINGS` before the live query resolves. | `Record.tsx`, `Activity.tsx`, `Routes.tsx` | Adopt the setting once it loads, like Studio's `hydrated` ref, or load settings before the first render. | ✅ `useMapStyle(settings)` in `ui.tsx` adopts the saved default once loaded, unless the user already picked a style. |
| M3 | **Studio `patch()` writes settings from inside a `setCfg` updater**, on every slider `input` event. | `Studio.tsx` | Debounce the save (~300 ms) outside the updater. `updateSettings` is already transactional. | ✅ Debounced 300 ms outside the updater; a pending save is flushed when leaving Studio. |
| M4 | **Routes page redraws the map on every render**, including each keystroke in the name field. `useEffect(() => draw(...))` has no dependency array. | `Routes.tsx` | Add real dependencies. | ✅ |
| M5 | **Map fallback is incomplete:** it only triggers before the style loads; Relief is blank offline; `styleReady()` reads the private `style._loaded`. | `MapView.tsx`, `mapStyles.ts` | Handle later tile errors; show an "offline, recording unaffected" hint; pin `maplibre-gl` to `~5.24`. | ⬜ |
| M6 | **Service worker:** fixed cache name means old chunks pile up; nothing is precached, so the lazy Studio chunk fails offline. | `public/sw.js` | Build-time precache manifest (e.g. `vite-plugin-pwa` / Workbox `injectManifest`) with a hashed cache name. | ⬜ |
| M7 | **Backup import isn't validated**; a malformed file crashes pages later. | `db.ts` `importBackup` | Check version and shape; only import tracks for activities that exist. | ⬜ |
| M8 | **Demo and simulated walks count toward PRs, goals and streaks**; there is no way to remove only demo walks. | `records.ts`, `Home.tsx`, `Settings.tsx` | Exclude `demo`/`simulated` sources by default; add a "Remove demo walks" button. | ✅ `countedWalks()` drops demo and simulated walks from records, goals, streaks and totals once a real walk exists (until then they stand in, so demo data still shows). Progress says how many were left out. Settings has "Remove demo walks". |
| M9 | **The privacy claim is broader than the behaviour.** Route planning sends waypoints to `routing.openstreetmap.de`; map tiles reveal the area to OpenFreeMap, CARTO, Esri and AWS. | README, Settings | One line in Settings → Your data listing these services. | ✅ |
| M10 | **CI publishes `apk-latest` from every branch.** | `.github/workflows/android-apk.yml` | Publish only from the default branch; upload an artifact elsewhere. | ✅ Every build uploads an artifact; only the default branch publishes `apk-latest`. |

## Lower

| Issue | Status |
|---|---|
| Split elevation delta used `?? 0`, giving ±1000 m deltas when elevation was partly missing. | ✅ |
| Draft write errors were unhandled rejections. | ✅ Now shown as a banner (`draftError`). |
| Wake lock was re-requested without checking the old one. | ✅ |
| JPEG result label always said 1080×1920. | ✅ |
| `keepScreenOn: true` is the default on native too, where it isn't needed. Default it to off when `isNative()`. | ✅ |
| Importing the same GPX twice creates duplicates. Dedupe on `startedAt` plus distance. | ⬜ |
| `NativeProvider` calls `window.confirm` inside the location callback; it can fire repeatedly. | ✅ Removed; the Record screen's denied card has "Open settings" (`openLocationSettings()`). |
| A gap segment can still make a split with tiny duration; guard `fastest / sp.paceSPerKm` in `Activity.tsx` against 0/NaN. | ⬜ |

---

## Best-practice gaps

| ID | Area | Recommendation | Status |
|---|---|---|---|
| T1 | One source of truth for stats | Shared segment rule between recorder and `computeStats`. | ✅ |
| T2 | Tests in CI | Add `npm run e2e` to CI. It works headless but needs tile hosts reachable; it is very slow when they're blocked. | ⬜ |
| T3 | Write path | Save + draft delete is transactional; `recomputeAllActivities` uses one transaction. | ✅ |
| T4 | Schema evolution | `STATS_VERSION` / `migrateStats` added. Backup `version` still isn't checked (see M7). | 🟡 |
| T5 | Diagnostics | Many `catch {}` blocks hide failures. Add a small IndexedDB log ring buffer and a "Copy diagnostics" button in Settings, for device testing. | ⬜ |
| T6 | Lint | There's no ESLint config, although `eslint-disable` comments exist. Add `eslint` with `react-hooks`; it would catch M2, M4 and stale closures. | ⬜ |
| T7 | Dependencies | `mp4-muxer` is deprecated (migrate to `mediabunny`). Pin `maplibre-gl` to `~5.24` (see M5). | ⬜ |
| T8 | Platform layer | Platform checks are scattered (`isNative()`, `Capacitor.isNativePlatform()`, `window.Capacitor`). Create one `platform.ts` (saveFile, shareFile, keepAwake, openSettings). `saveBlob` and `keepAwake` are a start. | 🟡 |
| T9 | Performance | The recorder ticker re-renders the whole Record page 4×/s. `drawLive` re-uploads the full path on every fix. Split `now` into its own store; append to the GeoJSON source in batches. | ⬜ |
| T10 | Tile licensing | Check Esri World Imagery and CARTO terms before any public release. | ⬜ |

---

## UI/UX improvements

### Recording (highest leverage)
- ✅ **Location denied or unavailable:** show a card with "Open settings" and "Try again" instead of a spinner that never ends.
- ✅ **GPS signal meter** (Searching → Weak → Ready) and an option to "Start anyway".
- ✅ **Hold-to-finish** (~0.8 s) so a pocket tap can't open Finish (`HoldButton`; a tap shows a hint, keyboard opens it directly).
- 🟡 Replace `confirm()` for Discard with an Undo toast. `confirm()` is gone: Discard now needs a second tap in the sheet. A true Undo would need the draft kept until the toast expires.
- ✅ **Stats layout:** make Distance and Time the largest; label current pace "Now" or put it behind a tap.
- ✅ **Auto-pause wording:** change to "Stopped · moving time paused".
- ✅ **Web lock-screen banner:** show it once as a tip, then a "GPS was off for N min" notice after returning.
- ✅ **Following a route:** show "x km to go" and an "Off route" chip when more than 40 m from the line.
- ✅ **Haptics** on pause and resume (`navigator.vibrate`, so Android only), on going off route, and when a hold completes.
- ✅ **Recording pill** on other screens (time · distance) while a walk is in progress.
- ✅ Unfinished-walk card on Today and Record, with distance, duration and paused state.
- ✅ Save failure message says the walk is safe and paused.

### Activity page
- ⬜ First-open summary: new PRs, and how much this walk moved goal progress.
- ⬜ Colour-blind-safe pace ramp; legend with real pace values.
- ⬜ Show the elevation profile with gaps instead of hiding it when any point lacks elevation.
- ⬜ Replace "N GPS points · source" with a GPS quality line (accuracy, number of gaps).
- ⬜ Delete through a sheet with Undo.

### Studio
- ⬜ Sticky bottom export bar (Image / Video → progress → Share / Save).
- ⬜ Start paused when `prefers-reduced-motion` is set.
- ✅ Size badge (WhatsApp-ready / Over 16 MB / Not H.264) and "keep this screen open" hint.
- ⬜ Estimate export time from the first 30 frames and show it before starting.
- ⬜ Hide stat toggles that have no data.

### Navigation, Home, Settings
- ⬜ Home goal: a carousel or "primary goal" when there are several; label the implicit 20 km/week goal as a suggestion.
- ✅ Settings: last backup date, storage protection, "Saved · recalculated N walks".
- ✅ Settings: "Remove demo walks" (M8), privacy note (M9).
- ⬜ Settings: GPS accuracy as Strict / Balanced / Lenient.

### Accessibility
- ✅ Remove `user-scalable=no` from `index.html` (blocks zoom, WCAG 1.4.4).
- ✅ `--text-3: #6f7c75` is ~4.1:1 on `--bg-elev`. Raise it to ~`#8a978f` for AA contrast.
- ✅ `Sheet`: move focus into the dialog, trap focus, return focus on close, add `aria-labelledby`. Or use `<dialog>`.
- ✅ Clickable `div` cards (route cards in `Routes.tsx`, goal cards in `Progress.tsx`) should be `<button>` elements. Also added a global `:focus-visible` ring.
- ✅ `Switch` without `label` in Settings and Routes: associate the visible text.
- ✅ `Segmented` uses `role="tab"` without tab panels: use `radiogroup`/`radio` or `aria-pressed`. `StylePicker` swatches need `aria-pressed`.
- ✅ Screen-reader announcement every km (or mile) while recording.

---

## Action plan

Next suggested order (all ⬜ items above):

1. ~~M2 default map style, M4 Routes deps, M3 debounce.~~ Done.
2. ~~Accessibility batch (viewport, contrast, Sheet focus, buttons, labels).~~ Done; km announcements still open.
3. ~~M8 demo exclusion + "Remove demo walks"; M9 privacy note; M10 CI branch gating.~~ Done.
4. ~~Recording UX: GPS-denied card, hold-to-finish, recording pill, route remaining / off-route.~~ Done (Discard Undo toast still partial).
5. M7 import validation; M6 precaching service worker.
6. T6 ESLint; T5 diagnostics log; T7 Mediabunny migration.
7. Studio sticky export bar and remaining polish.

---

## Testing notes

### Verified
- `npm test` passes: 42 tests (round 2 added the demo/simulated exclusion test), including the recorder integration tests and the gap, pause and parity stats tests.
- `npm run build` passes.
- `npm run e2e` passes end to end (all checks), run in a sandbox with map and terrain hosts blocked:
  - home; web-GPS record → save; simulated 1.6 km loop (recorded 1.67 km); splits; elevation profile.
  - JPEG export (720×1280).
  - MP4 export: H.264, 720×1280, 30 fps, 300 frames, exactly 10 s, 5.9 MB.
  - Fastest-1 km PR computed; history persists across reload; planned route saved.
  - The video took ~56 min here (software WebGL, ~11 s per frame); on a phone or desktop it is minutes.
- ⬜ The same run logged two non-fatal console errors: `Failed to load module script … MIME type "text/html"`. A JS chunk request got the HTML fallback instead. This is probably a stale-chunk/service-worker issue (see M6). Unconfirmed; reproduce by reloading after a rebuild.

- Round 2 browser smoke test (headless Chromium): default map adopted on Routes, `Segmented` exposes radios, switches are labelled, `Sheet` takes, traps and returns focus, demo walks stand in then are removed by "Remove demo walks", zoom allowed, no page errors. The full `npm run e2e` was not re-run (the video export takes ~1 h here); its selectors were updated for `role="radio"` and its PR check now expects the simulated walk to be excluded.

- Round 2 recording smoke test (headless Chromium): denied-location card with Try again; signal meter; following a planned route shows "to go" and an "Off route" warning after moving 300 m away; a tap on Finish only hints, a 1 s hold opens it; the recording pill shows on History and leads back to Record; Discard needs two taps. The e2e `finishWalk` now opens Finish with the keyboard.

### Needs a real device
1. Native share-sheet save of backup, GPX and MP4 on Android and iOS, including the chunked `appendFile` writes on Android.
2. Android background tracking over 30+ minutes with the screen off (Doze, aggressive vendor ROMs). This may need a battery-optimisation prompt.
3. iOS: background-geolocation callbacks reaching WKWebView JS while locked; WebCodecs H.264 encoding in the Capacitor WKWebView; memory during a 1080p export.
4. MP4 re-encode path on a phone whose hardware encoder overshoots the bitrate. Confirm the output is under 16 MB and posts to WhatsApp Status unchanged.
5. Wake lock during a long 1080p export.
6. Finishing a walk offline (airplane mode): saves quickly; elevation fills in later when online.
7. Safari on iOS without home-screen install: storage protection status.
8. Hold-to-finish with a gloved or wet finger, and the off-route vibration, on a real walk. Check that 40 m is a sensible off-route threshold in town.

### Assumptions
- `android/` and `ios/` are generated by `scripts/mobile.mjs`, so the plugin's merged manifest wasn't inspected. The review assumes it declares `foregroundServiceType="location"`.
- The app is personal-use only: no multi-user or server scope.

### Open questions for the owner
- **Gap policy:** implemented as "count the distance, credit time at the slowest moving speed". Change this if you'd rather exclude gap distance entirely.
- M8 is implemented as "demo/simulated walks count only until the first real walk". Say if you'd rather they never count.
- Is the web/PWA build a real target for pocket tracking, or a demo? This decides how much effort goes into the web lock-screen UX.
