/**
 * Characterization tests for the pure helpers extracted from HistoryPage
 * (#2119, cognitive complexity S3776). The page itself is a DB-backed server
 * component with no prior tests; these pin the filtering/grouping/formatting
 * behavior that used to live inline in the flagged function so the
 * extraction is provably value-equivalent.
 */
import { describe, it, expect, vi } from 'vitest';

// helpers.ts imports '@/src/db', whose index module calls getClient() at
// module scope; stub it out so importing it for its pure helpers below
// never needs a real DATABASE_URL.
vi.mock('@/src/db', () => ({ db: {}, transactions: {} }));

import {
  buildLoginRedirectTarget,
  parsePageNumber,
  buildDateRangeEnd,
  buildFilterParams,
  hasActiveFilters,
  serializeTransaction,
  groupIntoDisplayEntries,
} from '../helpers';
import type { Transaction } from '@/src/db';

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx_1',
    service: 'coffee',
    type: 'tip',
    fromDid: 'did:imajin:alice',
    toDid: 'did:imajin:bob',
    amount: '1.50',
    currency: 'CAD',
    status: 'completed',
    source: 'fiat',
    stripeId: null,
    metadata: {},
    fairManifest: null,
    batchId: null,
    credentialIssued: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as Transaction;
}

describe('parsePageNumber', () => {
  it('defaults to 1 when no page is given', () => {
    expect(parsePageNumber(undefined)).toBe(1);
  });

  it('parses a valid page number', () => {
    expect(parsePageNumber('3')).toBe(3);
  });

  it('clamps to 1 for non-positive input', () => {
    expect(parsePageNumber('0')).toBe(1);
    expect(parsePageNumber('-5')).toBe(1);
  });

  it('propagates NaN for non-numeric input (pre-existing behavior, unchanged by this refactor)', () => {
    expect(parsePageNumber('not-a-number')).toBeNaN();
  });
});

describe('buildDateRangeEnd', () => {
  it('sets the time to the last millisecond of the given day', () => {
    const end = buildDateRangeEnd('2026-01-15');
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(end.getSeconds()).toBe(59);
    expect(end.getMilliseconds()).toBe(999);
  });
});

describe('buildLoginRedirectTarget', () => {
  it('builds a login URL that redirects back to /history', () => {
    const target = buildLoginRedirectTarget();
    expect(target).toContain('/login?next=');
    expect(target).toContain(encodeURIComponent('/history'));
  });
});

describe('buildFilterParams', () => {
  it('omits absent filters', () => {
    expect(buildFilterParams({})).toEqual({});
  });

  it('includes only the filters that are set', () => {
    expect(buildFilterParams({ service: 'coffee', currency: undefined, from: '2026-01-01', to: undefined })).toEqual({
      service: 'coffee',
      from: '2026-01-01',
    });
  });
});

describe('hasActiveFilters', () => {
  it('is false when no filters are set', () => {
    expect(hasActiveFilters({})).toBe(false);
  });

  it('is true when any filter is set', () => {
    expect(hasActiveFilters({ currency: 'MJN' })).toBe(true);
  });
});

describe('serializeTransaction', () => {
  it('stringifies the amount and ISO-encodes the created date', () => {
    const tx = makeTx({ amount: '2.75', createdAt: new Date('2026-02-01T12:00:00.000Z') });
    expect(serializeTransaction(tx)).toMatchObject({
      amount: '2.75',
      createdAt: '2026-02-01T12:00:00.000Z',
    });
  });

  it('serializes a null created date as null', () => {
    const tx = makeTx({ createdAt: null });
    expect(serializeTransaction(tx).createdAt).toBeNull();
  });
});

describe('groupIntoDisplayEntries', () => {
  it('passes standalone (non-batched) transactions through unchanged, in order', () => {
    const txs = [makeTx({ id: 'tx_1' }), makeTx({ id: 'tx_2' })];
    const entries = groupIntoDisplayEntries(txs);
    expect(entries).toEqual([
      { kind: 'standalone', tx: serializeTransaction(txs[0]) },
      { kind: 'standalone', tx: serializeTransaction(txs[1]) },
    ]);
  });

  it('groups transactions sharing a batch_id, placed at the first member\'s position', () => {
    const txs = [
      makeTx({ id: 'tx_1', batchId: 'batch_a' }),
      makeTx({ id: 'tx_2', batchId: null }),
      makeTx({ id: 'tx_3', batchId: 'batch_a' }),
    ];
    const entries = groupIntoDisplayEntries(txs);
    expect(entries).toEqual([
      { kind: 'batch', batchId: 'batch_a', entries: [serializeTransaction(txs[0]), serializeTransaction(txs[2])] },
      { kind: 'standalone', tx: serializeTransaction(txs[1]) },
    ]);
  });
});
