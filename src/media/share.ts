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
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

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

export async function shareBlob(blob: Blob, filename: string, text = 'My walk'): Promise<ShareOutcome> {
  if (Capacitor.isNativePlatform()) {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
    const res = await Filesystem.writeFile({ path: filename, data: await blobToBase64(blob), directory: Directory.Cache });
    try {
      await Share.share({ title: text, files: [res.uri], dialogTitle: 'Share to WhatsApp Status' });
      return 'shared';
    } catch {
      return 'cancelled';
    }
  }
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      // Note: sending `text` alongside a file makes some targets (incl. WhatsApp) drop the file.
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'cancelled';
    }
  }
  downloadBlob(blob, filename);
  return 'downloaded';
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'walk';
}
