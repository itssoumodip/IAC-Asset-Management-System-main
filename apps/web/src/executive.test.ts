import { describe, expect, it } from 'vitest';
import {
  fillWeeks,
  firstName,
  formatHours,
  greeting,
  pieSlices,
  statusTotals,
  summaryLine,
  teamTotals,
  weekStarts,
} from './executive';

describe('greeting', () => {
  const at = (iso: string) => new Date(iso);
  it('uses the Asia/Kolkata hour: before 12 morning, before 17 afternoon, else evening', () => {
    expect(greeting(at('2026-10-29T05:29:00Z'), 'Asha Rao')).toBe('Good morning, Asha'); // 10:59 IST
    expect(greeting(at('2026-10-29T06:30:00Z'), 'Asha Rao')).toBe('Good afternoon, Asha'); // 12:00 IST
    expect(greeting(at('2026-10-29T11:29:00Z'), 'Asha Rao')).toBe('Good afternoon, Asha'); // 16:59
    expect(greeting(at('2026-10-29T11:30:00Z'), 'Asha Rao')).toBe('Good evening, Asha'); // 17:00
    expect(greeting(at('2026-10-29T15:00:00Z'), 'Asha')).toBe('Good evening, Asha'); // 20:30 IST
    expect(greeting(at('2026-10-29T20:00:00Z'), 'Asha')).toBe('Good morning, Asha'); // 01:30 IST
  });
  it('falls back without a name and extracts first names', () => {
    expect(greeting(at('2026-10-29T05:00:00Z'), '')).toBe('Good morning');
    expect(firstName('  Soumodip   Das ')).toBe('Soumodip');
  });
});

describe('aggregation helpers', () => {
  const rows = [
    { teamId: 't1', teamName: 'IT', status: 'In Store', count: 2, value: 100 },
    { teamId: 't1', teamName: 'IT', status: 'Assigned', count: 3, value: 50 },
    { teamId: 't2', teamName: 'Admin', status: 'Assigned', count: 1, value: 10 },
  ];
  it('totals by team and status', () => {
    expect(teamTotals(rows)).toEqual([
      { teamId: 't1', label: 'IT', count: 5, value: 150 },
      { teamId: 't2', label: 'Admin', count: 1, value: 10 },
    ]);
    expect(statusTotals(rows)).toEqual([
      { label: 'Assigned', count: 4, value: 60 },
      { label: 'In Store', count: 2, value: 100 },
    ]);
  });
  it('fills missing weeks with zeros', () => {
    const weeks = ['2026-10-12', '2026-10-19'];
    expect(
      fillWeeks(
        [{ teamId: 't1', weekStart: '2026-10-19', opened: 2, completed: 1, medianHours: 3 }],
        't1',
        weeks,
      ),
    ).toEqual([
      { weekStart: '2026-10-12', opened: 0, completed: 0 },
      { weekStart: '2026-10-19', opened: 2, completed: 1 },
    ]);
  });
  it('builds pie slices that cover the circle', () => {
    const slices = pieSlices([
      { label: 'a', value: 3 },
      { label: 'b', value: 1 },
    ]);
    expect(slices.map((s) => Math.round(s.share * 100))).toEqual([75, 25]);
    expect(pieSlices([{ label: 'a', value: 0 }])).toEqual([]);
    expect(slices[0].path.startsWith('M')).toBe(true);
  });
  it('formats hours', () => {
    expect(formatHours(null)).toBe('—');
    expect(formatHours(0.5)).toBe('30 min');
    expect(formatHours(4)).toBe('4 h');
    expect(formatHours(52)).toBe('2.2 d');
  });
});

describe('week and summary helpers', () => {
  it('lists Monday starts in IST ending with the current week', () => {
    // Thursday 29 Oct 2026 -> Monday 26 Oct
    expect(weekStarts(new Date('2026-10-29T05:00:00Z'), 3)).toEqual([
      '2026-10-12',
      '2026-10-19',
      '2026-10-26',
    ]);
    // Sunday 18:30 UTC is already Monday 00:00 IST
    expect(weekStarts(new Date('2026-11-01T18:30:00Z'), 1)).toEqual(['2026-11-02']);
  });
  it('builds a one-line summary from non-zero counts', () => {
    expect(
      summaryLine([
        { label: 'to confirm', count: 2 },
        { label: 'open requests', count: 0 },
      ]),
    ).toBe('2 to confirm');
    expect(summaryLine([{ label: 'x', count: 0 }])).toBe('Nothing needs your attention right now.');
  });
});
