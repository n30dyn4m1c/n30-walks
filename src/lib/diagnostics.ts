/**
 * A small diagnostics log for device testing: a ring buffer of the last
 * MAX_ENTRIES events, kept in its own IndexedDB database ("stride-logs") so a
 * logging problem can never touch the walks database.
 *
 * Privacy: log messages must never contain coordinates or walk names. The log
 * stays on the device; it leaves only when the user taps "Copy diagnostics".
 */
import Dexie, { type Table } from 'dexie';

declare const __APP_VERSION__: string;
/** Package version plus the CI commit (or "local"). */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  id?: number;
  t: number;
  level: LogLevel;
  area: string;
  message: string;
}

export const MAX_ENTRIES = 300;
const MAX_MESSAGE = 500;

class LogDB extends Dexie {
  logs!: Table<LogEntry, number>;
  constructor() {
    super('stride-logs');
    this.version(1).stores({ logs: '++id, t' });
  }
}

let logDb: LogDB | null = null;
function getDb(): LogDB | null {
  if (logDb) return logDb;
  try { logDb = new LogDB(); } catch { logDb = null; }
  return logDb;
}

/** Turn anything thrown into a short, single-line description. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e) ?? String(e); } catch { return String(e); }
}

let writes = 0;

/**
 * Record an event. Never throws and never awaits in the caller's path: safe to
 * call from any catch block.
 */
export function logEvent(level: LogLevel, area: string, message: string, err?: unknown): void {
  const text = (err === undefined ? message : `${message}: ${describeError(err)}`).replace(/\s+/g, ' ').slice(0, MAX_MESSAGE);
  const entry: LogEntry = { t: Date.now(), level, area, message: text };
  if (level === 'error') console.error(`[${area}]`, text);
  else if (level === 'warn') console.warn(`[${area}]`, text);
  const d = getDb();
  if (!d) return;
  d.logs.add(entry).then(() => {
    // Trim now and then rather than on every write.
    if (++writes % 25 === 0) return trimLog();
  }).catch(() => { /* logging must never fail the app */ });
}

export const logWarn = (area: string, message: string, err?: unknown) => logEvent('warn', area, message, err);
export const logError = (area: string, message: string, err?: unknown) => logEvent('error', area, message, err);

/** Delete everything but the newest MAX_ENTRIES entries. */
export async function trimLog(max = MAX_ENTRIES): Promise<void> {
  const d = getDb();
  if (!d) return;
  const count = await d.logs.count();
  if (count <= max) return;
  const keys = await d.logs.orderBy('id').limit(count - max).primaryKeys();
  await d.logs.bulkDelete(keys);
}

export async function readLog(): Promise<LogEntry[]> {
  const d = getDb();
  if (!d) return [];
  await trimLog();
  return d.logs.orderBy('id').toArray();
}

export async function clearLog(): Promise<void> {
  await getDb()?.logs.clear();
}

/** Catch errors that nothing else handles. Call once at startup. */
export function installGlobalHandlers(): void {
  window.addEventListener('error', (e) => logError('window', e.message || 'error', e.error ?? undefined));
  window.addEventListener('unhandledrejection', (e) => logError('promise', 'unhandled rejection', e.reason));
}

export interface DiagnosticsContext {
  appVersion: string;
  platform: string;
  facts: Record<string, string | number | boolean | null | undefined>;
}

/** Plain-text report for pasting into a bug report or chat. */
export function formatDiagnostics(ctx: DiagnosticsContext, entries: LogEntry[], now = Date.now()): string {
  const lines = [
    'Stride diagnostics',
    `Generated: ${new Date(now).toISOString()}`,
    `App: ${ctx.appVersion} · ${ctx.platform}`,
    `Agent: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a'}`,
    '',
    ...Object.entries(ctx.facts).map(([k, v]) => `${k}: ${v ?? 'n/a'}`),
    '',
    `Log (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, oldest first):`,
    ...(entries.length
      ? entries.map((e) => `${new Date(e.t).toISOString()} ${e.level.toUpperCase().padEnd(5)} [${e.area}] ${e.message}`)
      : ['(empty)']),
  ];
  return lines.join('\n');
}
