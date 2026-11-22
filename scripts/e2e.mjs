#!/usr/bin/env node
/**
 * End-to-end smoke test in headless Chromium (Playwright).
 *
 *   npm run build && npm run e2e
 *
 * Exercises the full highest-value path:
 *   1. Real Web Geolocation path (mocked coordinates moving over time) → record → save
 *   2. Simulated GPS walk (accelerated) → finish → activity map + stats
 *   3. 3D flyover studio preview
 *   4. WhatsApp Status JPEG + MP4 export → files validated (dimensions, codec, duration)
 *   5. Progress / History / Routes screens render; data persists after reload
 *
 * Screenshots and exported media land in ./e2e-output/.
 * Env: E2E_URL (default: starts `vite preview` itself), E2E_QUALITY=720p|1080p, E2E_SECONDS=10
 */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const OUT = path.resolve('e2e-output');
fs.mkdirSync(OUT, { recursive: true });
const QUALITY = process.env.E2E_QUALITY ?? '720p';
const SECONDS = process.env.E2E_SECONDS ?? '10';
const START = { latitude: 46.6243, longitude: 8.0337 };

const log = (...a) => console.log('[e2e]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { if (cond) log('✓', msg); else { failures++; console.error('[e2e] ✗', msg); } };

async function startServer() {
  if (process.env.E2E_URL) return { url: process.env.E2E_URL, stop() {} };
  const proc = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '4319', '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('preview server did not start')), 20000);
    proc.stdout.on('data', (d) => { if (String(d).includes('4319')) { clearTimeout(t); resolve(); } });
    proc.on('exit', (c) => reject(new Error(`preview exited ${c}`)));
  });
  return { url: 'http://localhost:4319', stop: () => proc.kill() };
}

async function holdFinish(page) {
  const btn = page.getByRole('button', { name: 'Hold to finish' });
  const box = await btn.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await sleep(1200);
  await page.mouse.up();
}

const server = await startServer();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({
  viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, isMobile: true, hasTouch: false,
  geolocation: { ...START, accuracy: 6 }, permissions: ['geolocation'], acceptDownloads: true,
});
const page = await context.newPage();
page.on('pageerror', (e) => console.error('[page error]', e.message));
page.on('console', (m) => { if (m.text().startsWith('[export]')) log(m.text()); if (m.type() === 'error' && !/Failed to load resource|ERR_|AJAXError|tiles|style/i.test(m.text())) console.error('[console]', m.text()); });

try {
  // ---------- 1. Home ----------
  await page.goto(server.url);
  await page.getByText('No walks yet').waitFor();
  await page.screenshot({ path: `${OUT}/01-home-empty.png` });
  check(true, 'home renders empty state');

  // ---------- 2. Real Geolocation path (Web provider) ----------
  await page.goto(`${server.url}/record`);
  await page.getByText(/GPS ±\d+ m/).waitFor({ timeout: 15000 });
  check(true, 'web geolocation fix acquired');
  await page.getByRole('button', { name: 'START' }).click();
  // Walk north ~3 m/s for 30 s via mocked geolocation updates.
  for (let i = 1; i <= 30; i++) {
    await context.setGeolocation({ latitude: START.latitude + (i * 3) / 111320, longitude: START.longitude, accuracy: 5 });
    await sleep(1000);
  }
  await page.screenshot({ path: `${OUT}/02-recording-web-gps.png` });
  const distText = await page.locator('.stat.lg .value').first().innerText();
  check(parseFloat(distText) > 0.05, `live distance from web GPS updated (${distText})`);
  await holdFinish(page);
  await page.waitForURL(/\/activity\//, { timeout: 30000 });
  check(true, 'web-GPS walk saved and opened');

  // ---------- 3. Simulated walk ----------
  await page.goto(`${server.url}/record`);
  await page.getByRole('button', { name: 'Simulate a walk' }).click();
  await page.locator('.sheet input').fill('1.6');
  await page.getByRole('tab', { name: '30×' }).click();
  await page.getByRole('button', { name: 'Start simulated walk' }).click();
  await page.getByText('Simulated route complete').waitFor({ timeout: 120000 });
  await page.screenshot({ path: `${OUT}/03-recording-simulated.png` });
  await holdFinish(page);
  await page.waitForURL(/\/activity\//, { timeout: 30000 });
  const activityUrl = page.url();
  await sleep(6000); // terrain + tiles
  await page.screenshot({ path: `${OUT}/04-activity.png`, fullPage: true });
  const kmText = await page.locator('.card .stat.lg .value').first().innerText();
  const km = parseFloat(kmText);
  check(km > 1.4 && km < 1.85, `simulated 1.6 km loop recorded as ${km} km (filter keeps error small)`);
  check(await page.getByText('Splits').isVisible(), 'splits table shown');
  check(await page.getByText('Elevation', { exact: true }).isVisible(), 'elevation profile from DEM shown');

  // ---------- 4. Studio (3D flyover) ----------
  await page.getByRole('link', { name: /Play 3D flyover/ }).click();
  await page.waitForURL(/\/studio\//);
  await sleep(5000);
  await page.screenshot({ path: `${OUT}/05-studio-intro.png` });
  await page.getByRole('button', { name: /^Pause$/ }).click();
  const scrub = page.getByLabel('Scrub flyover');
  await scrub.fill('500');
  await sleep(4000);
  await page.screenshot({ path: `${OUT}/06-studio-mid.png` });
  // Config for a fast export
  await page.getByRole('tab', { name: `${SECONDS}s` }).click();
  await page.getByRole('tab', { name: QUALITY === '720p' ? /720×1280/ : /^1080×1920$/ }).click();

  // Image export
  await page.getByRole('button', { name: /Image \(JPEG\)/ }).click();
  await page.locator('img[alt="Status image preview"]').waitFor({ timeout: 90000 });
  let dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  const img = await dl;
  const imgPath = `${OUT}/status.jpg`;
  await img.saveAs(imgPath);
  const probeImg = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_name', '-of', 'json', imgPath]).toString()).streams[0];
  const expW = QUALITY === '720p' ? 720 : 1080, expH = QUALITY === '720p' ? 1280 : 1920;
  check(probeImg.width === expW && probeImg.height === expH && probeImg.codec_name === 'mjpeg', `status image is ${probeImg.width}×${probeImg.height} JPEG`);

  // Video export
  const t0 = Date.now();
  await page.getByRole('button', { name: /Video \(MP4\)/ }).click();
  await page.locator('video').waitFor({ timeout: 3600000 }); // software WebGL in CI is slow; real devices take 1–3 min
  log(`video export took ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await page.screenshot({ path: `${OUT}/07-studio-exported.png`, fullPage: true });
  dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  const vid = await dl;
  const vidPath = `${OUT}/status.mp4`;
  await vid.saveAs(vidPath);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_name,avg_frame_rate,nb_frames:format=duration,size,format_name', '-of', 'json', vidPath]).toString());
  const vs = probe.streams[0];
  log('ffprobe:', JSON.stringify(probe));
  check(vs.width === expW && vs.height === expH, `video is ${vs.width}×${vs.height} (9:16)`);
  check(['h264', 'vp9'].includes(vs.codec_name), `video codec ${vs.codec_name}${vs.codec_name === 'h264' ? ' (WhatsApp-ready)' : ' (fallback: this Chromium lacks H.264 encoding)'}`);
  check(Math.abs(parseFloat(probe.format.duration) - Number(SECONDS)) < 0.5, `duration ${probe.format.duration}s`);
  check(Number(probe.format.size) < 16 * 1024 * 1024, `size ${(probe.format.size / 1048576).toFixed(1)} MB < 16 MB`);
  check(probe.format.format_name.includes('mp4'), 'container is MP4');
  // Extract frames for visual inspection
  for (const t of [1, Number(SECONDS) / 2, Number(SECONDS) - 0.5]) {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(t), '-i', vidPath, '-frames:v', '1', `${OUT}/frame-${t}.jpg`]);
  }

  // ---------- 5. Other screens + persistence ----------
  await page.goto(`${server.url}/progress`);
  await page.getByText('Personal records').waitFor();
  await page.screenshot({ path: `${OUT}/08-progress.png`, fullPage: true });
  check(await page.getByText('Fastest 1 km').isVisible(), 'PR: fastest 1 km computed');

  await page.goto(`${server.url}/history`);
  await page.reload();
  // IndexedDB queries resolve asynchronously after reload: wait for the list before counting.
  await page.locator('a.card.link').first().waitFor({ timeout: 15000 });
  const rows = await page.locator('a.card.link').count();
  check(rows === 2, `history persists across reload (${rows} walks)`);
  await page.screenshot({ path: `${OUT}/09-history.png` });

  await page.goto(`${server.url}/routes`);
  await page.getByRole('tab', { name: 'Plan' }).click();
  await sleep(2500);
  const map = await page.locator('.map-wrap').boundingBox();
  for (const [fx, fy] of [[0.3, 0.4], [0.6, 0.35], [0.65, 0.7]]) { await page.mouse.click(map.x + map.width * fx, map.y + map.height * fy); await sleep(400); }
  await sleep(9000); // routing service timeout → straight-line fallback
  await page.getByRole('button', { name: 'Save route' }).click();
  await page.getByText('Route saved').waitFor();
  await page.screenshot({ path: `${OUT}/10-routes.png` });
  check(await page.locator('.card h3', { hasText: 'Planned route' }).count() === 1, 'planned route saved');

  await page.goto(`${server.url}/`);
  await page.screenshot({ path: `${OUT}/11-home.png` });
  await page.goto(activityUrl);
} catch (e) {
  failures++;
  console.error('[e2e] FAILED:', e);
  await page.screenshot({ path: `${OUT}/error.png` }).catch(() => {});
} finally {
  await browser.close();
  server.stop();
}
log(failures ? `${failures} check(s) failed` : 'all checks passed', `— artifacts in ${OUT}`);
process.exit(failures ? 1 : 0);
