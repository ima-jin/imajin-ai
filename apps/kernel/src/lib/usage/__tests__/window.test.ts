import { describe, it, expect } from 'vitest';
import { currentMonthLabel, parseUsageWindow } from '../window';

describe('currentMonthLabel', () => {
  it('formats the UTC year/month as YYYY-MM, zero-padded', () => {
    expect(currentMonthLabel(new Date('2026-01-05T00:00:00.000Z'))).toBe('2026-01');
    expect(currentMonthLabel(new Date('2026-11-30T23:59:59.000Z'))).toBe('2026-11');
  });
});

describe('parseUsageWindow', () => {
  it('defaults to the current UTC month when no window is given', () => {
    const result = parseUsageWindow(null, new Date('2026-08-15T12:00:00.000Z'));
    expect(result).toEqual({
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-09-01T00:00:00.000Z'),
      label: '2026-08',
    });
  });

  it('parses a YYYY-MM month into a [start, next-month) interval', () => {
    const result = parseUsageWindow('2026-02');
    expect(result).toEqual({
      from: new Date('2026-02-01T00:00:00.000Z'),
      to: new Date('2026-03-01T00:00:00.000Z'),
      label: '2026-02',
    });
  });

  it('rolls a December month window into January of the next year', () => {
    const result = parseUsageWindow('2026-12');
    expect(result?.to).toEqual(new Date('2027-01-01T00:00:00.000Z'));
  });

  it('rejects a month outside 01-12', () => {
    expect(parseUsageWindow('2026-13')).toBeNull();
    expect(parseUsageWindow('2026-00')).toBeNull();
  });

  it('parses an explicit inclusive date range into a half-open interval', () => {
    const result = parseUsageWindow('2026-08-01..2026-08-15');
    expect(result).toEqual({
      from: new Date('2026-08-01T00:00:00.000Z'),
      // Inclusive of 2026-08-15 → exclusive upper bound is the next day.
      to: new Date('2026-08-16T00:00:00.000Z'),
      label: '2026-08-01..2026-08-15',
    });
  });

  it('accepts a single-day range (from === to)', () => {
    const result = parseUsageWindow('2026-08-01..2026-08-01');
    expect(result?.from).toEqual(new Date('2026-08-01T00:00:00.000Z'));
    expect(result?.to).toEqual(new Date('2026-08-02T00:00:00.000Z'));
  });

  it('rejects a range where the end date precedes the start date', () => {
    expect(parseUsageWindow('2026-08-15..2026-08-01')).toBeNull();
  });

  it('rejects malformed window strings', () => {
    for (const bad of ['not-a-window', '2026', '2026-8', '2026/08', '2026-08-01', '2026-08-01..bad-date']) {
      expect(parseUsageWindow(bad), bad).toBeNull();
    }
  });
});
