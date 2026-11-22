/**
 * Deterministic flyover → MP4 export.
 *
 * Instead of screen-recording in real time (MediaRecorder: dropped frames,
 * WebM on many browsers), we render frame-by-frame: position camera, wait
 * until every tile is loaded, composite map + overlay onto a 1080×1920
 * canvas, and hand the frame to the hardware H.264 encoder via WebCodecs.
 * mp4-muxer writes a fast-start MP4 — the format WhatsApp Status expects.
 *
 * Result: perfectly smooth 30 fps regardless of device speed (slow devices
 * just take longer to export).
 */
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { buildFlyoverPlan, liveStatsAt, OUTRO } from '../flyover/plan';
import { FlyoverScene } from '../flyover/scene';
import { attributionFor, drawOverlay, type OverlayData } from './overlay';
import { createOffscreenMap, renderStats, waitForRender } from './offscreenMap';
import type { Activity, OverlayConfig, Track, Units } from '../types';

export interface ExportProgress { frame: number; frames: number; phase: 'loading' | 'rendering' | 'finalizing' }

export const FPS = 30;
/** Keep files under WhatsApp's ~16 MB media limit. */
const MAX_BYTES = 15 * 1024 * 1024;

const H264_CODECS = ['avc1.640034', 'avc1.64002A', 'avc1.640028', 'avc1.4D4028', 'avc1.42E01F'];

export function outputSize(quality: OverlayConfig['quality']) {
  return quality === '720p' ? { width: 720, height: 1280 } : { width: 1080, height: 1920 };
}

async function pickCodec(width: number, height: number, bitrate: number): Promise<{ config: VideoEncoderConfig; muxCodec: 'avc' | 'vp9' } | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const codec of H264_CODECS) {
    const config: VideoEncoderConfig = { codec, width, height, bitrate, framerate: FPS, avc: { format: 'avc' }, latencyMode: 'quality' };
    try { if ((await VideoEncoder.isConfigSupported(config)).supported) return { config, muxCodec: 'avc' }; } catch { /* try next */ }
  }
  // Last resort (no H.264 encoder, e.g. some Linux Chromium builds): VP9-in-MP4.
  const vp9: VideoEncoderConfig = { codec: 'vp09.00.40.08', width, height, bitrate, framerate: FPS, latencyMode: 'quality' };
  try { if ((await VideoEncoder.isConfigSupported(vp9)).supported) return { config: vp9, muxCodec: 'vp9' }; } catch { /* none */ }
  return null;
}

export function videoExportSupported(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

export interface VideoResult { blob: Blob; codec: string; width: number; height: number; seconds: number; whatsappReady: boolean }

export async function exportFlyoverVideo(
  activity: Activity, track: Track, cfg: OverlayConfig, units: Units,
  onProgress: (p: ExportProgress) => void, signal?: AbortSignal,
): Promise<VideoResult> {
  const { width, height } = outputSize(cfg.quality);
  const seconds = cfg.videoSeconds;
  const frames = seconds * FPS;
  const bitrate = Math.min(cfg.quality === '720p' ? 5_000_000 : 8_000_000, Math.floor((MAX_BYTES * 8 * 0.92) / seconds));
  const picked = await pickCodec(width, height, bitrate);
  if (!picked) throw new Error('This browser cannot encode video (WebCodecs missing). Use a recent Chrome, Edge or Safari, or export a still image.');

  onProgress({ frame: 0, frames, phase: 'loading' });
  const plan = buildFlyoverPlan(track.points);
  const off = await createOffscreenMap(cfg.mapStyle, width, { terrain: true, exaggeration: cfg.exaggeration });
  const scene = new FlyoverScene(off.map, plan, cfg.routeColor, cfg.exaggeration);
  scene.install();

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: picked.muxCodec, width, height, frameRate: FPS }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
  let encodeError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e as Error; },
  });
  encoder.configure(picked.config);

  const s = activity.stats;
  const base: Omit<OverlayData, 'progress' | 'live'> = {
    title: cfg.title || activity.name, dateMs: activity.startedAt, units,
    totals: { distanceM: s.distanceM, movingS: s.movingS, paceSPerKm: s.avgPaceSPerKm, elevGainM: s.elevGainM, steps: s.estSteps },
    profile: plan.profile, attribution: attributionFor(off.styleId),
  };

  Object.assign(renderStats, { frames: 0, timeouts: 0, totalMs: 0 });
  const prof = { camera: 0, wait: 0, draw: 0, overlay: 0, encode: 0 };
  try {
    // Warm-up: load tiles for the opening shot before frame 0.
    scene.setFrame(0);
    await waitForRender(off.map, 15000);
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (encodeError) throw encodeError;
      const u = i / (frames - 1);
      let ts = performance.now();
      const cam = scene.setFrame(u, (i / FPS) % 1);
      prof.camera += performance.now() - ts; ts = performance.now();
      await waitForRender(off.map);
      prof.wait += performance.now() - ts; ts = performance.now();
      ctx.drawImage(off.map.getCanvas(), 0, 0, width, height);
      prof.draw += performance.now() - ts; ts = performance.now();
      const live = liveStatsAt(plan, cam.distance);
      const progress = cam.distance / plan.total;
      drawOverlay(ctx, width, height, cfg, {
        ...base, progress,
        // Live stats while walking; final totals once the outro starts.
        live: u < OUTRO ? { distanceM: live.distanceM, movingS: live.movingS, eleM: live.eleM } : undefined,
        alpha: Math.min(1, u / 0.04 + 0.15),
      });
      prof.overlay += performance.now() - ts; ts = performance.now();
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
      encoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
      frame.close();
      // Back-pressure: don't let the encoder queue grow unbounded on slow devices.
      while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 5));
      prof.encode += performance.now() - ts;
      if (i % 30 === 29) console.info(`[export] frame ${i + 1}: avg ms ` + Object.entries(prof).map(([k, v]) => `${k}=${(v / (i + 1)).toFixed(0)}`).join(' '));
      onProgress({ frame: i + 1, frames, phase: 'rendering' });
    }
    console.info(`[export] ${frames} frames, avg render wait ${(renderStats.totalMs / Math.max(1, renderStats.frames)).toFixed(0)} ms, ${renderStats.timeouts} tile timeouts`);
    onProgress({ frame: frames, frames, phase: 'finalizing' });
    await encoder.flush();
    muxer.finalize();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    off.destroy();
  }
  const blob = new Blob([target.buffer], { type: 'video/mp4' });
  return { blob, codec: picked.config.codec, width, height, seconds, whatsappReady: picked.muxCodec === 'avc' };
}
