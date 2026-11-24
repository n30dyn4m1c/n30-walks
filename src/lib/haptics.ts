/** A short vibration where the device supports it (Android browsers and WebView). A no-op elsewhere. */
export function buzz(pattern: number | number[] = 30): void {
  try { navigator.vibrate?.(pattern); } catch { /* not supported */ }
}
