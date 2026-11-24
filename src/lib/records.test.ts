import { describe, expect, it } from 'vitest';
import { bucketize, computeRecords, countedWalks, dayStreak, goalProgress, periodStart, recordsSetBy } from './records';
import type { Activity } from '../types';

const day = 86_400_000;
function act(id: string, startedAt: number, distanceM: number, best1k?: number): Activity {
  return {
    id, name: id, type: 'walk', startedAt, endedAt: startedAt + 1000, source: 'gps', bbox: [0, 0, 0, 0], preview: [], createdAt: 0, updatedAt: 0,
    stats: { distanceM, elapsedS: 0, movingS: distanceM, avgPaceSPerKm: 0, avgSpeedMps: 0, elevGainM: 0, elevLossM: 0, minEleM: null, maxEleM: null, estSteps: 0, estKcal: 0, bestEfforts: best1k ? { '1000': best1k } : {}, splits: [], elevationSource: 'none' },
  };
}

describe('records', () => {
  const now = new Date(2026, 10, 18, 12).getTime(); // Wed 18 Nov 2026
  const list = [act('a', now - 2 * day, 3000, 600), act('b', now - day, 8000, 560), act('c', now, 1000, 580)];

  it('picks lowest time and highest distance', () => {
    const r = computeRecords(list);
    expect(r.find((x) => x.key === 'effort:1000')?.activityId).toBe('b');
    expect(r.find((x) => x.key === 'longest-distance')?.activityId).toBe('b');
  });

  it('weeks start on Monday', () => {
    expect(new Date(periodStart(now, 'week')).getDay()).toBe(1);
  });

  it('goal progress sums current period only', () => {
    const g = goalProgress({ id: 'g', metric: 'distance', period: 'week', target: 20000, createdAt: 0 }, [...list, act('old', now - 30 * day, 50000)], now);
    expect(g.value).toBe(12000);
    expect(g.fraction).toBeCloseTo(0.6);
  });

  it('streak counts consecutive days', () => {
    expect(dayStreak(list, now)).toBe(3);
    expect(dayStreak([act('x', now - 3 * day, 1)], now)).toBe(0);
  });

  it('bucketize returns n buckets with totals', () => {
    const b = bucketize(list, 'distance', 'week', 4, now);
    expect(b).toHaveLength(4);
    expect(b[3].value).toBe(12000);
  });

  it('ignores demo and simulated walks once a real walk exists', () => {
    const demo = { ...act('d', now, 9000, 400), source: 'demo' as const };
    const sim = { ...act('s', now, 9000, 300), source: 'simulated' as const };
    expect(countedWalks([demo, sim]).map((a) => a.id)).toEqual(['d', 's']);
    expect(countedWalks([...list, demo, sim]).map((a) => a.id)).toEqual(['a', 'b', 'c']);
    expect(recordsSetBy('s', [...list, demo, sim])).toEqual([]);
  });
});
