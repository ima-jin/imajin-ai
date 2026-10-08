/**
 * Tests for apps/market/src/lib/pending-checkout.ts (#2740) — the per-session
 * record of which kernel payment (and declared payee chain) a Stripe Checkout
 * session is, kept in the listing's jsonb metadata (no schema change).
 *
 * The two writers issue ONE atomic SQL statement each (no read-modify-write);
 * the SQL itself was exercised against an embedded Postgres while writing this,
 * so these tests pin the statement's shape and bound values.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const mocks = vi.hoisted(() => {
  const whereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn(() => ({ where: whereMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));
  return { whereMock, setMock, updateMock };
});

vi.mock('@/db', async () => ({
  db: { update: mocks.updateMock },
  listings: (await import('../../db/schema')).listings,
}));

import { readPendingCheckout, recordPendingCheckout, saveSettlementSnapshot } from '../pending-checkout';

const CHAIN = [
  { did: 'did:imajin:seller', role: 'seller', amount: 9.85 },
  { did: 'did:imajin:node', role: 'node', amount: 0.15 },
];

const renderSet = () => {
  const [setArg] = mocks.setMock.mock.calls[0] as unknown as [{ metadata: SQL }];
  return new PgDialect().sqlToQuery(setArg.metadata);
};

describe('recordPendingCheckout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.whereMock.mockResolvedValue(undefined);
  });

  it('writes the entry under metadata.pendingCheckouts[sessionId] in one atomic UPDATE', async () => {
    await recordPendingCheckout('lst_1', 'cs_test_1', { transactionId: 'tx_abc', amountCents: 1000, chain: CHAIN });

    expect(mocks.updateMock).toHaveBeenCalledTimes(1);
    expect(mocks.whereMock).toHaveBeenCalledTimes(1);

    const { sql, params } = renderSet();
    // Merge + prune inside the statement — never a read-modify-write that could clobber a concurrent buyer.
    expect(sql).toContain("jsonb_set(");
    expect(sql).toContain("'{pendingCheckouts}'");
    expect(sql).toContain('jsonb_object_agg');
    expect(sql).toContain('jsonb_build_object(');
    expect(params).toContain('cs_test_1');
    expect(params).toContain('2 days');

    const stored = JSON.parse(params.find((p) => typeof p === 'string' && p.startsWith('{')) as string);
    expect(stored).toMatchObject({ transactionId: 'tx_abc', amountCents: 1000, chain: CHAIN });
    expect(Number.isNaN(Date.parse(stored.at))).toBe(false);
  });

  it('propagates a database failure to the caller', async () => {
    mocks.whereMock.mockRejectedValue(new Error('db down'));
    await expect(recordPendingCheckout('lst_1', 'cs_1', { transactionId: 'tx', amountCents: 1, chain: CHAIN })).rejects.toThrow('db down');
  });
});

describe('saveSettlementSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.whereMock.mockResolvedValue(undefined);
  });

  it('merges the receipt and deletes the settled entry in one atomic UPDATE', async () => {
    await saveSettlementSnapshot('lst_1', 'cs_test_1', { totalAmount: 10, chain: CHAIN });

    const { sql, params } = renderSet();
    expect(sql).toContain("jsonb_build_object('fairSettlement'");
    expect(sql).toContain("#- array['pendingCheckouts'");
    expect(params).toContain('cs_test_1');
    expect(JSON.parse(params.find((p) => typeof p === 'string' && p.startsWith('{')) as string)).toEqual({ totalAmount: 10, chain: CHAIN });
    expect(mocks.whereMock).toHaveBeenCalledTimes(1);
  });
});

describe('readPendingCheckout', () => {
  const entry = { transactionId: 'tx_abc', amountCents: 1000, chain: CHAIN, at: '2026-10-08T12:00:00.000Z' };
  const metadata = { tags: ['x'], pendingCheckouts: { cs_1: entry } };

  it('returns the entry recorded for the session', () => {
    expect(readPendingCheckout(metadata, 'cs_1')).toEqual(entry);
  });

  it('returns null for an unknown session or a session whose entry was cleared', () => {
    expect(readPendingCheckout(metadata, 'cs_other')).toBeNull();
    expect(readPendingCheckout({ pendingCheckouts: {} }, 'cs_1')).toBeNull();
  });

  it('returns null when there is no usable metadata', () => {
    expect(readPendingCheckout(null, 'cs_1')).toBeNull();
    expect(readPendingCheckout(undefined, 'cs_1')).toBeNull();
    expect(readPendingCheckout('nope', 'cs_1')).toBeNull();
    expect(readPendingCheckout({}, 'cs_1')).toBeNull();
    expect(readPendingCheckout({ pendingCheckouts: null }, 'cs_1')).toBeNull();
    expect(readPendingCheckout({ pendingCheckouts: { cs_1: null } }, 'cs_1')).toBeNull();
  });

  it('does not resolve inherited object keys as sessions', () => {
    expect(readPendingCheckout(metadata, 'constructor')).toBeNull();
    expect(readPendingCheckout(metadata, '__proto__')).toBeNull();
  });

  it.each([
    ['a missing transactionId', { ...entry, transactionId: undefined }],
    ['an empty transactionId', { ...entry, transactionId: '' }],
    ['a non-numeric amountCents', { ...entry, amountCents: '1000' }],
    ['a non-array chain', { ...entry, chain: 'seller' }],
    ['an empty chain', { ...entry, chain: [] }],
    ['a chain entry without an amount', { ...entry, chain: [{ did: 'did:a', role: 'seller' }] }],
    ['a null chain entry', { ...entry, chain: [null] }],
  ])('rejects an entry with %s (never settles from a malformed record)', (_label, bad) => {
    expect(readPendingCheckout({ pendingCheckouts: { cs_1: bad } }, 'cs_1')).toBeNull();
  });

  it('tolerates a missing recorded-at timestamp', () => {
    const withoutAt = { transactionId: entry.transactionId, amountCents: entry.amountCents, chain: entry.chain };
    expect(readPendingCheckout({ pendingCheckouts: { cs_1: withoutAt } }, 'cs_1')).toEqual({ ...withoutAt, at: '' });
  });
});
