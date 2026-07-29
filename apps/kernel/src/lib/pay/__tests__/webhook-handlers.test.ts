/**
 * Unit tests for apps/kernel/src/lib/pay/webhook-handlers.ts
 *
 * Coverage:
 *  - calculateEstimatedFee   — pure function, no mocks needed
 *  - reconcileStripeFee      — DB-touching; mocked via vi.mock
 *  - processChainDistribution — DB-touching; mocked via vi.mock
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mock wiring (must be hoisted so vi.mock factories can reference them)
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
  const insertValuesMock = vi.fn(() => ({ onConflictDoUpdate: onConflictDoUpdateMock }));
  const insertMock = vi.fn(() => ({ values: insertValuesMock }));
  const publishMock = vi.fn().mockResolvedValue(undefined);
  const generateIdMock = vi.fn((prefix: string) => `${prefix}_test`);

  return { onConflictDoUpdateMock, insertValuesMock, insertMock, publishMock, generateIdMock };
});

vi.mock('@/src/db', () => ({
  db: { insert: mocks.insertMock },
  feeLedger: { id: 'fl_col' },
  balances: { did: 'bal_did_col', creditAmount: 'bal_credit_col', cashAmount: 'bal_cash_col' },
  balanceRollups: {
    did: 'rollup_did_col',
    date: 'rollup_date_col',
    service: 'rollup_service_col',
    earned: 'rollup_earned_col',
    txCount: 'rollup_txcount_col',
  },
  transactions: {},
}));

vi.mock('drizzle-orm', () => ({
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ raw: strings.join('?'), values })),
  eq: vi.fn(),
}));

vi.mock('@/src/lib/kernel/id', () => ({ generateId: mocks.generateIdMock }));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
}));

vi.mock('@imajin/bus', () => ({ publish: mocks.publishMock }));

vi.mock('@imajin/fair', () => ({
  STRIPE_RATE_BPS: 290,   // 2.9%
  STRIPE_FIXED_CENTS: 30, // $0.30
}));

vi.mock('./stripe', () => ({ getStripe: vi.fn() }));

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import {
  calculateEstimatedFee,
  reconcileStripeFee,
  processChainDistribution,
  type FairManifest,
  type TxRow,
} from '../webhook-handlers';

// ---------------------------------------------------------------------------
// calculateEstimatedFee — pure function
// ---------------------------------------------------------------------------

describe('calculateEstimatedFee', () => {
  it('uses platform defaults when manifest has no fees array', () => {
    const manifest: FairManifest = { chain: [] };
    // 100 USD = 10000 cents → 2.9% + $0.30 = 290 + 30 = 320 cents
    expect(calculateEstimatedFee(manifest, 10000)).toBe(320);
  });

  it('uses platform defaults when manifest fees has no processor entry', () => {
    const manifest: FairManifest = {
      fees: [{ role: 'node', name: 'Node', rateBps: 100, fixedCents: 0 }],
    };
    expect(calculateEstimatedFee(manifest, 10000)).toBe(320);
  });

  it('uses manifest processor entry when present', () => {
    const manifest: FairManifest = {
      fees: [{ role: 'processor', name: 'Stripe', rateBps: 250, fixedCents: 25 }],
    };
    // 10000 * 250/10000 + 25 = 250 + 25 = 275
    expect(calculateEstimatedFee(manifest, 10000)).toBe(275);
  });

  it('handles zero amount', () => {
    const manifest: FairManifest = {};
    expect(calculateEstimatedFee(manifest, 0)).toBe(30); // 0% + $0.30 fixed
  });

  it('rounds fractional cents', () => {
    // 1999 * 290 / 10000 = 57.971 → 58; + 30 = 88
    const manifest: FairManifest = {};
    expect(calculateEstimatedFee(manifest, 1999)).toBe(88);
  });
});

// ---------------------------------------------------------------------------
// reconcileStripeFee
// ---------------------------------------------------------------------------

describe('reconcileStripeFee', () => {
  const tx: TxRow = { id: 'tx_123', service: 'market' };
  const currency = 'CAD';
  const manifestWithSeller: FairManifest = {
    chain: [
      { did: 'did:imajin:seller', role: 'seller', share: 0.8 },
      { did: 'did:imajin:node', role: 'node', share: 0.2 },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts processor_rebate and credits seller balance when actual < estimated', async () => {
    await reconcileStripeFee({
      tx,
      manifest: manifestWithSeller,
      actualFeeCents: 280,
      estimatedFeeCents: 320,
      currency,
    });

    // Should have inserted feeLedger row (rebate) + balance row = 2 insert calls
    expect(mocks.insertMock).toHaveBeenCalledTimes(2);

    const feeLedgerValues = mocks.insertValuesMock.mock.calls[0][0];
    expect(feeLedgerValues.role).toBe('processor_rebate');
    expect(feeLedgerValues.amountCents).toBe(40); // |320 - 280|
    expect(feeLedgerValues.recipientDid).toBe('did:imajin:seller');
    expect(feeLedgerValues.status).toBe('accrued');
  });

  it('inserts processor_surcharge and debits seller balance when actual > estimated', async () => {
    await reconcileStripeFee({
      tx,
      manifest: manifestWithSeller,
      actualFeeCents: 360,
      estimatedFeeCents: 320,
      currency,
    });

    expect(mocks.insertMock).toHaveBeenCalledTimes(2);

    const feeLedgerValues = mocks.insertValuesMock.mock.calls[0][0];
    expect(feeLedgerValues.role).toBe('processor_surcharge');
    expect(feeLedgerValues.amountCents).toBe(40);
  });

  it('does nothing when manifest has no seller entry', async () => {
    const noSellerManifest: FairManifest = {
      chain: [{ did: 'did:imajin:node', role: 'node', share: 1.0 }],
    };
    await reconcileStripeFee({
      tx,
      manifest: noSellerManifest,
      actualFeeCents: 280,
      estimatedFeeCents: 320,
      currency,
    });
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it('does nothing when seller DID is NODE_PLACEHOLDER', async () => {
    const placeholderManifest: FairManifest = {
      chain: [{ did: 'NODE_PLACEHOLDER', role: 'seller', share: 1.0 }],
    };
    await reconcileStripeFee({
      tx,
      manifest: placeholderManifest,
      actualFeeCents: 280,
      estimatedFeeCents: 320,
      currency,
    });
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it('publishes fee.rebate event when rebating', async () => {
    mocks.publishMock.mockResolvedValue(undefined);
    await reconcileStripeFee({
      tx,
      manifest: manifestWithSeller,
      actualFeeCents: 280,
      estimatedFeeCents: 320,
      currency,
    });
    expect(mocks.publishMock).toHaveBeenCalledWith('fee.rebate', expect.objectContaining({
      subject: 'did:imajin:seller',
    }));
  });

  it('publishes fee.surcharge event when surcharging', async () => {
    mocks.publishMock.mockResolvedValue(undefined);
    await reconcileStripeFee({
      tx,
      manifest: manifestWithSeller,
      actualFeeCents: 360,
      estimatedFeeCents: 320,
      currency,
    });
    expect(mocks.publishMock).toHaveBeenCalledWith('fee.surcharge', expect.objectContaining({
      subject: 'did:imajin:seller',
    }));
  });
});

// ---------------------------------------------------------------------------
// processChainDistribution
// ---------------------------------------------------------------------------

describe('processChainDistribution', () => {
  const tx: TxRow = { id: 'tx_456', service: 'market' };
  const currency = 'USD';

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insertValuesMock.mockImplementation(() => ({ onConflictDoUpdate: mocks.onConflictDoUpdateMock }));
  });

  it('skips entries with amountCents <= 0', async () => {
    const chain = [{ did: 'did:imajin:node', role: 'node', share: 0 }];
    await processChainDistribution({ tx, totalAmountCents: 1000, currency, buyerDid: null, chain });
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it('resolves BUYER_PLACEHOLDER to buyerDid', async () => {
    const chain = [{ did: 'BUYER_PLACEHOLDER', role: 'buyer_credit', share: 0.05 }];
    await processChainDistribution({
      tx,
      totalAmountCents: 10000,
      currency,
      buyerDid: 'did:imajin:buyer',
      chain,
    });

    const feeLedgerRow = mocks.insertValuesMock.mock.calls[0][0];
    expect(feeLedgerRow.recipientDid).toBe('did:imajin:buyer');
    expect(feeLedgerRow.role).toBe('buyer_credit');
    expect(feeLedgerRow.amountCents).toBe(500); // 10000 * 0.05
  });

  it('resolves BUYER_PLACEHOLDER to "unresolved" when buyerDid is null', async () => {
    const chain = [{ did: 'BUYER_PLACEHOLDER', role: 'buyer_credit', share: 0.05 }];
    await processChainDistribution({
      tx,
      totalAmountCents: 10000,
      currency,
      buyerDid: null,
      chain,
    });

    const feeLedgerRow = mocks.insertValuesMock.mock.calls[0][0];
    expect(feeLedgerRow.recipientDid).toBe('unresolved');
    // No balance update for unresolved
    expect(mocks.insertMock).toHaveBeenCalledTimes(1); // only feeLedger
  });

  it('sets seller status to paid_out and does not write balance', async () => {
    const chain = [{ did: 'did:imajin:seller', role: 'seller', share: 0.85 }];
    await processChainDistribution({ tx, totalAmountCents: 10000, currency, buyerDid: null, chain });

    const feeLedgerRow = mocks.insertValuesMock.mock.calls[0][0];
    expect(feeLedgerRow.status).toBe('paid_out');
    // Only feeLedger inserted — no balance or rollup writes for seller
    expect(mocks.insertMock).toHaveBeenCalledTimes(1);
  });

  it('writes creditAmount for buyer_credit role', async () => {
    const chain = [{ did: 'did:imajin:buyer', role: 'buyer_credit', share: 0.02 }];
    await processChainDistribution({ tx, totalAmountCents: 10000, currency, buyerDid: null, chain });

    // feeLedger + balances + balanceRollups = 3 inserts
    expect(mocks.insertMock).toHaveBeenCalledTimes(3);

    const balanceRow = mocks.insertValuesMock.mock.calls[1][0];
    // 10000 * 0.02 = 200 cents → 200/100 = 2.0
    expect(balanceRow.creditAmount).toBe('2.00000000');
    expect(balanceRow.cashAmount).toBe('0');
  });

  it('writes cashAmount for non-buyer_credit fee beneficiary', async () => {
    const chain = [{ did: 'did:imajin:node', role: 'node', share: 0.03 }];
    await processChainDistribution({ tx, totalAmountCents: 10000, currency, buyerDid: null, chain });

    expect(mocks.insertMock).toHaveBeenCalledTimes(3);

    const balanceRow = mocks.insertValuesMock.mock.calls[1][0];
    // 10000 * 0.03 = 300 cents → 300/100 = 3.0
    expect(balanceRow.cashAmount).toBe('3.00000000');
    expect(balanceRow.creditAmount).toBe('0');
  });

  it('publishes fee.record for every chain entry', async () => {
    const chain = [
      { did: 'did:imajin:node', role: 'node', share: 0.03 },
      { did: 'did:imajin:scope', role: 'scope', share: 0.02 },
    ];
    await processChainDistribution({ tx, totalAmountCents: 10000, currency, buyerDid: null, chain });

    expect(mocks.publishMock).toHaveBeenCalledTimes(2);
    expect(mocks.publishMock).toHaveBeenCalledWith('fee.record', expect.objectContaining({ subject: 'did:imajin:node' }));
    expect(mocks.publishMock).toHaveBeenCalledWith('fee.record', expect.objectContaining({ subject: 'did:imajin:scope' }));
  });
});
