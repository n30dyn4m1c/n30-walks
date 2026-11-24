/**
 * Keep the screen on for the duration of a long task (e.g. a video export).
 * The browser drops a wake lock whenever the page is hidden, so it is
 * re-acquired on return. Returns a function that releases it. Never throws.
 */
export async function keepAwake(): Promise<() => void> {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return () => {};
  let sentinel: WakeLockSentinel | null = null;
  let active = true;
  const acquire = async () => {
    try {
      if (active && document.visibilityState === 'visible' && (!sentinel || sentinel.released)) sentinel = await navigator.wakeLock.request('screen');
    } catch { /* battery saver or not allowed: not fatal */ }
  };
  const onVisible = () => { if (document.visibilityState === 'visible') void acquire(); };
  document.addEventListener('visibilitychange', onVisible);
  await acquire();
  return () => {
    active = false;
    document.removeEventListener('visibilitychange', onVisible);
    sentinel?.release().catch(() => {});
    sentinel = null;
  };
}
