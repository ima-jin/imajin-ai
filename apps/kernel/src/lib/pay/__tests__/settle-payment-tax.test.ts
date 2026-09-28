/**
 * Tests for `settlePayment()`'s trust-liability tax-credit handling
 * (#2419): one extra `transactions` row + ledger credit per
 * `fair_manifest.taxCredits` entry, tagged with the right metadata, and
 * excluded from fee math. `../ledger`'s `creditUnit`/`debitUnit` are
 * mocked so this asserts against call arguments rather than reimplementing
 * drizzle's `.insert().values().onConflictDoUpdate()` chain.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  insertedRows: [] as Array<Record<string, unknown>>,
  creditUnitMock: vi.fn().mockResolvedValue(undefined),
  debitUnitMock: vi.fn().mockResolvedValue(undefined),
}));

function insertValues(vals: Record<string, unknown>) {
  state.insertedRows.push(vals);
  return Promise.resolve(undefined);
}
function insertClause() {
  return { values: insertValues };
}
function updateWhere() {
  return Promise.resolve(undefined);
}
function updateSet() {
  return { where: updateWhere };
}
function updateClause() {
  return { set: updateSet };
}
function limitEmpty() {
  return Promise.resolve([]);
}
function whereClause() {
  return { limit: limitEmpty };
}
function fromClause() {
  return { where: whereClause };
}
function selectClause() {
  return { from: fromClause };
}
function txMock() {
  return { insert: insertClause, update: updateClause, select: selectClause };
}
async function dbTransaction(cb: (tx: ReturnType<typeof txMock>) => Promise<void>) {
  return cb(txMock());
}

vi.mock('@/src/db', () => ({
  db: { transaction: dbTransaction, select: selectClause, update: updateClause },
  balances: {},
  transactions: {},
  identities: {},
  identityChains: {},
}));
vi.mock('@imajin/fair', () => ({ verifyManifest: vi.fn().mockResolvedValue({ valid: true }) }));
vi.mock('@imajin/auth/resolve-db', () => ({ createDbResolver: () => async () => 'fake-public-key' }));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2)}` }));
vi.mock('@/src/lib/fair/intro-attribution', () => ({
  verifyIntroAttributionManifestForSettlement: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../ledger', () => ({
  MJN: 'MJN',
  MJNX: 'MJNx',
  ACCEPTED_UNITS_DEFAULT: ['MJN'],
  assertUnitAccepted: (unit: string) => ({ unit }),
  getBalanceRow: vi.fn().mockResolvedValue(undefined),
  amountOf: () => 0,
  creditUnit: state.creditUnitMock,
  debitUnit: state.debitUnitMock,
}));

import { settlePayment } from '../settle-core';

const SELLER_DID = 'did:imajin:seller';
const BUYER_DID = 'did:imajin:buyer';

beforeEach(() => {
  state.insertedRows.length = 0;
  state.creditUnitMock.mockClear();
  state.debitUnitMock.mockClear();
});

describe('settlePayment — #2419 tax credits', () => {
  it('inserts one extra transactions row per tax credit, tagged with trust-liability metadata', async () => {
    const result = await settlePayment({
      from_did: BUYER_DID,
      total_amount: 113,
      service: 'market',
      type: 'sale',
      funded: true,
      funded_provider: 'stripe',
      fair_manifest: {
        chain: [{ did: SELLER_DID, amount: 100, role: 'seller' }],
        taxCredits: [
          {
            did: SELLER_DID,
            amount: 13,
            jurisdiction: 'CA-ON',
            kind: 'GST/HST',
            rateBps: 1300,
            remitTo: 'did:imajin:authority:ca-cra',
          },
        ],
      },
    });

    expect('settled' in result && result.settled).toBe(true);

    const taxRow = state.insertedRows.find((r) => (r.metadata as Record<string, unknown>)?.tax === true);
    expect(taxRow).toBeDefined();
    expect(taxRow).toMatchObject({ toDid: SELLER_DID, amount: '13' });
    expect(taxRow!.metadata).toMatchObject({
      tax: true,
      jurisdiction: 'CA-ON',
      kind: 'GST/HST',
      rateBps: 1300,
      remitTo: 'did:imajin:authority:ca-cra',
      trustLiability: true,
      remitted: null,
    });
  });

  it('skips the internal balance credit for a tax row whose collector is also a funded chain seller (money already moved via Stripe Connect)', async () => {
    await settlePayment({
      from_did: BUYER_DID,
      total_amount: 113,
      service: 'market',
      type: 'sale',
      funded: true,
      funded_provider: 'stripe',
      fair_manifest: {
        chain: [{ did: SELLER_DID, amount: 100, role: 'seller' }],
        taxCredits: [{ did: SELLER_DID, amount: 13, jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, remitTo: 'did:imajin:authority:ca-cra' }],
      },
    });

    // Neither the seller's own credit nor the tax credit to the same DID
    // should hit the internal ledger for a funded settlement.
    expect(state.creditUnitMock).not.toHaveBeenCalled();
    const taxRow = state.insertedRows.find((r) => (r.metadata as Record<string, unknown>)?.tax === true);
    expect(taxRow!.metadata).toMatchObject({ balance_skipped: true, reason: 'externally_funded_seller' });
  });

  it('credits the internal ledger for a tax row whose collector is NOT one of the funded chain sellers', async () => {
    await settlePayment({
      from_did: BUYER_DID,
      total_amount: 113,
      service: 'market',
      type: 'sale',
      funded: true,
      funded_provider: 'stripe',
      fair_manifest: {
        chain: [{ did: SELLER_DID, amount: 100, role: 'seller' }],
        taxCredits: [{ did: 'did:imajin:third-party-collector', amount: 13, jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, remitTo: 'did:imajin:authority:ca-cra' }],
      },
    });

    expect(state.creditUnitMock).toHaveBeenCalledWith(expect.anything(), 'did:imajin:third-party-collector', 'MJN', 13, expect.anything());
  });

  it('a manifest without taxCredits behaves exactly as before (no extra rows, no tax metadata)', async () => {
    await settlePayment({
      from_did: BUYER_DID,
      total_amount: 100,
      service: 'market',
      type: 'sale',
      funded: true,
      funded_provider: 'stripe',
      fair_manifest: { chain: [{ did: SELLER_DID, amount: 100, role: 'seller' }] },
    });

    expect(state.insertedRows).toHaveLength(1);
    expect((state.insertedRows[0].metadata as Record<string, unknown>).tax).toBeUndefined();
  });
});
