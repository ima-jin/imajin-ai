/**
 * Core invariant tests for the funded vs non-funded settlement paths (#325).
 *
 * Feeds the REAL `resolveSettlementChain` output (including its penny-drift
 * correction) into the REAL `settlePayment` and checks that, on both paths,
 * every cent the buyer pays is accounted for:
 *
 *   non-funded (internal ledger move)
 *     — the sender is debited exactly `total_amount`, and every chain
 *       recipient is credited, so debit == Σcredits.
 *   funded (externally paid, e.g. Stripe)
 *     — nothing is debited; seller-role recipients already got their money via
 *       Stripe Connect so their ledger credit is skipped, everyone else is
 *       credited, and the audit rows still sum to `total_amount`.
 *
 * `../ledger` is mocked at its credit/debit edge so assertions read call
 * arguments instead of re-implementing drizzle's query builder.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  insertedRows: [] as Array<Record<string, unknown>>,
  creditUnitMock: vi.fn().mockResolvedValue(undefined),
  debitUnitMock: vi.fn().mockResolvedValue(undefined),
  senderBalance: 0,
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
// Keep the real settlement math; only stub manifest signature verification.
vi.mock('@imajin/fair', async () => ({
  ...(await vi.importActual<typeof import('@imajin/fair')>('@imajin/fair')),
  verifyManifest: vi.fn().mockResolvedValue({ valid: true }),
}));
vi.mock('@imajin/auth/resolve-db', () => ({ createDbResolver: () => async () => 'fake-public-key' }));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_${state.insertedRows.length}` }));
vi.mock('@/src/lib/fair/intro-attribution', () => ({
  verifyIntroAttributionManifestForSettlement: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../ledger', () => ({
  MJN: 'MJN',
  MJNX: 'MJNx',
  ACCEPTED_UNITS_DEFAULT: ['MJN'],
  assertUnitAccepted: (unit: string) => ({ unit }),
  getBalanceRow: vi.fn().mockResolvedValue(undefined),
  amountOf: () => state.senderBalance,
  creditUnit: state.creditUnitMock,
  debitUnit: state.debitUnitMock,
}));

import { resolveSettlementChain, type FairSettlementEntry } from '@imajin/fair';
import { settlePayment } from '../settle-core';

const BUYER_DID = 'did:imajin:buyer';
const NODE_DID = 'did:imajin:node';

// 33.33% / 33.33% / 33.34% plus a node fee: shares chosen so per-entry rounding drifts.
const CHAIN: FairSettlementEntry[] = [
  { did: 'NODE_PLACEHOLDER', role: 'node', share: 0.0137 },
  { did: 'did:imajin:creator', role: 'creator', share: 0.3333 },
  { did: 'did:imajin:seller', role: 'seller', share: 0.3333 },
  { did: 'did:imajin:platform', role: 'platform', share: 0.3197 },
];
const SELLER_DIDS = ['did:imajin:creator', 'did:imajin:seller'];

const toCents = (dollars: number): number => Math.round(dollars * 100);

function resolveFor(amountCents: number) {
  return resolveSettlementChain({
    amountCents,
    chain: CHAIN,
    fees: [{ role: 'processor', rateBps: 290, fixedCents: 30 }],
    buyerDid: BUYER_DID,
    nodeDid: NODE_DID,
  });
}

function txRows() {
  return state.insertedRows.filter((r) => 'toDid' in r);
}

function creditedTo(did: string): number {
  return state.creditUnitMock.mock.calls
    .filter((call) => call[1] === did)
    .reduce((sum, call) => sum + toCents(call[3] as number), 0);
}

beforeEach(() => {
  state.insertedRows.length = 0;
  state.creditUnitMock.mockClear();
  state.debitUnitMock.mockClear();
  state.senderBalance = 0;
});

// Odd-cent totals chosen to trigger drift.
const AMOUNTS_CENTS = [9999, 10_001, 12_345, 33_333];

describe('settlement invariant: non-funded path debits exactly what it credits', () => {
  it.each(AMOUNTS_CENTS)('amount %i¢: debit == Σ credits == Σ audit rows', async (amountCents) => {
    const { resolvedChain, expectedTotal } = resolveFor(amountCents);
    state.senderBalance = expectedTotal + 1000;

    const result = await settlePayment({
      from_did: BUYER_DID,
      total_amount: expectedTotal,
      service: 'market',
      type: 'sale',
      fair_manifest: { chain: resolvedChain },
    });

    expect('settled' in result && result.settled).toBe(true);

    expect(state.debitUnitMock).toHaveBeenCalledTimes(1);
    const debitedCents = toCents(state.debitUnitMock.mock.calls[0]![3] as number);
    const creditedCents = state.creditUnitMock.mock.calls.reduce((sum, call) => sum + toCents(call[3] as number), 0);
    const auditCents = txRows().reduce((sum, r) => sum + toCents(Number(r.amount)), 0);

    expect(debitedCents).toBe(toCents(expectedTotal));
    expect(creditedCents).toBe(debitedCents);
    expect(auditCents).toBe(debitedCents);
    expect(state.creditUnitMock).toHaveBeenCalledTimes(resolvedChain.length);
  });

  it('credits seller-role recipients too (no external payout happened)', async () => {
    const { resolvedChain, expectedTotal } = resolveFor(10_001);
    state.senderBalance = expectedTotal;

    await settlePayment({ from_did: BUYER_DID, total_amount: expectedTotal, service: 'market', type: 'sale', fair_manifest: { chain: resolvedChain } });

    for (const did of SELLER_DIDS) {
      expect(creditedTo(did), did).toBeGreaterThan(0);
    }
  });

  it('refuses an underfunded sender before touching the ledger', async () => {
    const { resolvedChain, expectedTotal } = resolveFor(10_001);
    state.senderBalance = expectedTotal - 0.01;

    const result = await settlePayment({ from_did: BUYER_DID, total_amount: expectedTotal, service: 'market', type: 'sale', fair_manifest: { chain: resolvedChain } });

    expect(result).toMatchObject({ status: 400 });
    expect(state.debitUnitMock).not.toHaveBeenCalled();
    expect(state.creditUnitMock).not.toHaveBeenCalled();
    expect(state.insertedRows).toHaveLength(0);
  });
});

describe('settlement invariant: funded path never double-pays sellers', () => {
  it.each(AMOUNTS_CENTS)('amount %i¢: no debit; sellers skipped; others credited; audit rows still sum to total', async (amountCents) => {
    const { resolvedChain, expectedTotal } = resolveFor(amountCents);

    const result = await settlePayment({
      from_did: BUYER_DID,
      total_amount: expectedTotal,
      service: 'market',
      type: 'sale',
      funded: true,
      funded_provider: 'stripe',
      fair_manifest: { chain: resolvedChain },
    });

    expect('settled' in result && result.settled).toBe(true);
    expect(state.debitUnitMock).not.toHaveBeenCalled();

    // Seller-role recipients (already paid via Stripe Connect) get no internal credit.
    for (const did of SELLER_DIDS) {
      expect(creditedTo(did), did).toBe(0);
    }

    // Everyone else is credited exactly their resolved amount.
    const nonSellers = resolvedChain.filter((e) => !SELLER_DIDS.includes(e.did));
    const expectedCreditedCents = nonSellers.reduce((sum, e) => sum + toCents(e.amount), 0);
    const creditedCents = state.creditUnitMock.mock.calls.reduce((sum, call) => sum + toCents(call[3] as number), 0);
    expect(creditedCents).toBe(expectedCreditedCents);

    // The audit trail still records every recipient, so it reconciles to the total.
    expect(txRows()).toHaveLength(resolvedChain.length);
    expect(txRows().reduce((sum, r) => sum + toCents(Number(r.amount)), 0)).toBe(toCents(expectedTotal));
  });

  it('marks each skipped seller row as externally funded', async () => {
    const { resolvedChain, expectedTotal } = resolveFor(10_001);

    await settlePayment({ from_did: BUYER_DID, total_amount: expectedTotal, service: 'market', type: 'sale', funded: true, funded_provider: 'stripe', fair_manifest: { chain: resolvedChain } });

    const skipped = txRows().filter((r) => (r.metadata as Record<string, unknown>).balance_skipped === true);
    expect(skipped.map((r) => r.toDid).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([...SELLER_DIDS].sort((a, b) => a.localeCompare(b)));
    for (const row of skipped) {
      expect(row.metadata).toMatchObject({ funded: true, funded_provider: 'stripe', reason: 'externally_funded_seller' });
    }
  });

  it('refuses a funded settlement in any unit other than MJN (no external MJNx mint)', async () => {
    const { resolvedChain, expectedTotal } = resolveFor(10_001);

    const result = await settlePayment({
      from_did: BUYER_DID,
      total_amount: expectedTotal,
      service: 'market',
      type: 'sale',
      funded: true,
      unit: 'MJNx',
      acceptedUnits: ['MJN', 'MJNx'],
      fair_manifest: { chain: resolvedChain },
    });

    expect(result).toMatchObject({ status: 400 });
    expect(state.creditUnitMock).not.toHaveBeenCalled();
    expect(state.insertedRows).toHaveLength(0);
  });
});

describe('settlement invariant: chain must reconcile to total_amount', () => {
  it('rejects a chain that is a penny short of the total (drift left uncorrected)', async () => {
    const { resolvedChain, expectedTotal } = resolveFor(10_001);
    const shortChain = resolvedChain.map((e, i) => (i === 1 ? { ...e, amount: Number.parseFloat((e.amount - 0.02).toFixed(2)) } : e));
    state.senderBalance = expectedTotal;

    const result = await settlePayment({ from_did: BUYER_DID, total_amount: expectedTotal, service: 'market', type: 'sale', fair_manifest: { chain: shortChain } });

    expect(result).toMatchObject({ status: 400 });
    expect(state.debitUnitMock).not.toHaveBeenCalled();
    expect(state.insertedRows).toHaveLength(0);
  });
});
