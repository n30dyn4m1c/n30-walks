import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach } from 'vitest';
import { clearLog, describeError, formatDiagnostics, logEvent, readLog, trimLog } from './diagnostics';

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('diagnostics log', () => {
  beforeEach(async () => { await clearLog(); });

  it('stores entries with the error folded into one line', async () => {
    logEvent('error', 'recorder', 'save failed', new Error('QuotaExceeded\n  at foo'));
    await settle();
    const log = await readLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ level: 'error', area: 'recorder', message: 'save failed: Error: QuotaExceeded at foo' });
  });

  it('keeps only the newest entries', async () => {
    for (let i = 0; i < 30; i++) logEvent('info', 't', `m${i}`);
    await settle();
    await trimLog(10);
    const log = await readLog();
    expect(log.map((e) => e.message)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 20}`));
  });

  it('describes non-Error values', () => {
    expect(describeError('boom')).toBe('boom');
    expect(describeError({ code: 3 })).toBe('{"code":3}');
  });

  it('formats a readable report', () => {
    const text = formatDiagnostics(
      { appVersion: '0.1.0+abc', platform: 'web', facts: { Walks: 3, Online: true, Missing: undefined } },
      [{ t: 0, level: 'warn', area: 'gps', message: 'provider error: timeout' }],
      0,
    );
    expect(text).toContain('App: 0.1.0+abc · web');
    expect(text).toContain('Walks: 3');
    expect(text).toContain('Missing: n/a');
    expect(text).toContain('1970-01-01T00:00:00.000Z WARN  [gps] provider error: timeout');
  });
});
