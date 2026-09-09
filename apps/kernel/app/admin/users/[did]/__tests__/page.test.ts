/**
 * Characterization tests for the pure helpers extracted from
 * AdminUserDetailPage (#2119, cognitive complexity S3776). The page itself is
 * a DB-backed server component with no prior tests; these pin the formatting
 * behavior that used to live inline in the flagged function so the extraction
 * is provably value-equivalent.
 */
import { describe, it, expect, vi } from 'vitest';

// page.tsx calls getClient() at module scope; stub it out so importing the
// page for its pure helpers below never needs a real DATABASE_URL.
vi.mock('@imajin/db', () => ({ getClient: () => vi.fn() }));

import { computeShortKey, formatCreatedTimestamp } from '../page';

describe('computeShortKey', () => {
  it('returns an em dash when there is no public key', () => {
    expect(computeShortKey(null)).toBe('—');
    expect(computeShortKey(undefined)).toBe('—');
  });

  it('truncates a public key to its first 20 and last 8 characters', () => {
    const key = 'ed25519:abcdefghijklmnopqrstuvwxyz0123456789';
    expect(computeShortKey(key)).toBe(`${key.slice(0, 20)}…${key.slice(-8)}`);
  });

  it('returns short keys unchanged apart from the separator', () => {
    const key = 'short-key';
    expect(computeShortKey(key)).toBe(`${key.slice(0, 20)}…${key.slice(-8)}`);
  });
});

describe('formatCreatedTimestamp', () => {
  it('returns an em dash when there is no created date', () => {
    expect(formatCreatedTimestamp(null)).toBe('—');
    expect(formatCreatedTimestamp(undefined)).toBe('—');
  });

  it('formats a date the same way toLocaleString did inline, given the same options', () => {
    const createdAt = new Date('2026-01-15T18:30:00.000Z');
    const expected = new Date(createdAt).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
    expect(formatCreatedTimestamp(createdAt)).toBe(expected);
  });
});
