/**
 * Getting media into WhatsApp Status.
 *
 *  - Native (Capacitor): write to the cache dir, open the OS share sheet → WhatsApp → "My status".
 *  - Mobile web: Web Share API Level 2 (files) → same share sheet.
 *  - Desktop web: download the file (WhatsApp Status can't be posted from desktop
 *    web, so the user AirDrops/transfers it or uses the phone build).
 */
import { Capacitor } from '@capacitor/core';

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] ?? '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

/** Browser download. Does nothing inside the native WebView, so callers should use saveBlob(). */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function canShareFiles(): boolean {
  if (Capacitor.isNativePlatform()) return true;
  try {
    const probe = new File([new Blob(['x'], { type: 'image/jpeg' })], 'x.jpg', { type: 'image/jpeg' });
    return !!navigator.canShare?.({ files: [probe] });
  } catch {
    return false;
  }
}

const EXPORT_DIR = 'exports';
/** Bytes per write. A multiple of 3 so each base64 chunk decodes on its own. */
const CHUNK = 3 * 256 * 1024;

/**
 * Write a blob to the app cache in chunks and return its native URI.
 * Passing a 15 MB video as one base64 string over the Capacitor bridge needs
 * several copies of ~20 MB strings at once, enough to crash low-end phones.
 * Older exports are removed first so the cache doesn't grow forever.
 */
async function writeNativeFile(blob: Blob, filename: string): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  await Filesystem.rmdir({ path: EXPORT_DIR, directory: Directory.Cache, recursive: true }).catch(() => {});
  const path = `${EXPORT_DIR}/${filename}`;
  const first = await Filesystem.writeFile({ path, data: await blobToBase64(blob.slice(0, CHUNK)), directory: Directory.Cache, recursive: true });
  for (let off = CHUNK; off < blob.size; off += CHUNK) {
    await Filesystem.appendFile({ path, data: await blobToBase64(blob.slice(off, off + CHUNK)), directory: Directory.Cache });
  }
  return first.uri;
}

const isCancel = (e: unknown) => /cancel|abort/i.test(`${(e as Error)?.name ?? ''} ${(e as Error)?.message ?? e}`);

/** Native share sheet for a file. Throws on real errors; returns 'cancelled' if the user backs out. */
async function shareNative(blob: Blob, filename: string, title: string, dialogTitle: string): Promise<ShareOutcome> {
  const uri = await writeNativeFile(blob, filename);
  const { Share } = await import('@capacitor/share');
  try {
    await Share.share({ title, files: [uri], dialogTitle });
    return 'shared';
  } catch (e) {
    if (isCancel(e)) return 'cancelled';
    throw e;
  }
}

export async function shareBlob(blob: Blob, filename: string, text = 'My walk'): Promise<ShareOutcome> {
  if (Capacitor.isNativePlatform()) return shareNative(blob, filename, text, 'Share to WhatsApp Status');
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      // Note: sending `text` alongside a file makes some targets (incl. WhatsApp) drop the file.
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'cancelled';
      // e.g. NotAllowedError: fall through to a plain download.
    }
  }
  downloadBlob(blob, filename);
  return 'downloaded';
}

/**
 * Save a file for the user (backup, GPX, exported media). On the web this is a
 * download. The Android/iOS WebView ignores download links, so natively we open
 * the share sheet, where "Save to Files", Drive, email etc. are all offered.
 */
export async function saveBlob(blob: Blob, filename: string): Promise<ShareOutcome> {
  if (Capacitor.isNativePlatform()) return shareNative(blob, filename, filename, 'Save or send');
  downloadBlob(blob, filename);
  return 'downloaded';
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'walk';
}
