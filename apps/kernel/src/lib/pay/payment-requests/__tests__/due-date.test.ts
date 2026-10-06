import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { calendarDateToDueAt, formatDueDate } from '../due-date';

// #2651 — the bug only reproduces west of UTC. Pin the process zone so these
// tests exercise it regardless of where CI runs (also verified with
// `TZ=America/Toronto vitest run`).
beforeAll(() => {
  vi.stubEnv('TZ', 'America/Toronto');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

describe('test environment', () => {
  it('runs in a negative-UTC-offset zone', () => {
    // Toronto is UTC-4 / UTC-5; getTimezoneOffset is positive west of UTC.
    expect(new Date('2026-10-06T12:00:00Z').getTimezoneOffset()).toBeGreaterThan(0);
  });
});

describe('formatDueDate', () => {
  it('shows the entered date for a due date stored as UTC midnight', () => {
    // The exact stored value from the bug report: entered 10/6, stored 2026-10-06T00:00Z.
    const stored = '2026-10-06T00:00:00.000Z';
    expect(formatDueDate(stored, 'en-US')).toBe('10/6/2026');
    // Regression guard: the old rendering path really is a day early in this zone.
    expect(new Date(stored).toLocaleDateString('en-US')).toBe('10/5/2026');
  });

  it('formats rows stored before the fix and rows stored after it identically', () => {
    expect(formatDueDate('2026-01-01T00:00:00.000Z', 'en-US')).toBe('1/1/2026');
    expect(formatDueDate(calendarDateToDueAt('2026-01-01')!, 'en-US')).toBe('1/1/2026');
  });

  it('keeps year/month boundaries', () => {
    expect(formatDueDate('2027-01-01T00:00:00.000Z', 'en-US')).toBe('1/1/2027');
    expect(formatDueDate('2026-03-01T00:00:00.000Z', 'en-US')).toBe('3/1/2026');
  });

  it('returns an empty string for an unparseable value instead of throwing', () => {
    expect(formatDueDate('not-a-date', 'en-US')).toBe('');
  });
});

describe('calendarDateToDueAt', () => {
  it('encodes a calendar date as UTC midnight of that day', () => {
    expect(calendarDateToDueAt('2026-10-06')).toBe('2026-10-06T00:00:00.000Z');
  });

  it('round-trips through formatDueDate in a negative-offset zone', () => {
    for (const date of ['2026-10-06', '2026-03-08', '2026-11-01', '2028-02-29']) {
      const [y, m, d] = date.split('-').map(Number);
      expect(formatDueDate(calendarDateToDueAt(date)!, 'en-US')).toBe(`${m}/${d}/${y}`);
    }
  });

  it.each(['', '2026-10', '10/06/2026', '2026-10-06T00:00:00Z', '2026-02-31', '2026-13-01', '2027-02-29'])(
    'rejects %j',
    (value) => {
      expect(calendarDateToDueAt(value)).toBeNull();
    },
  );
});
