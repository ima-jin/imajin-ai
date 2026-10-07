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
  // db.transaction(cb) runs cb against a tx handle sharing the same insert mock.
  const transactionMock = vi.fn(async (cb: (tx: { insert: typeof insertMock }) => Promise<unknown>) =>
    cb({ insert: insertMock }),
  );

  return { onConflictDoUpdateMock, insertValuesMock, insertMock, publishMock, generateIdMock, transactionMock };
});

vi.mock('@/src/db', () => ({
  db: { insert: mocks.insertMock, transaction: mocks.transactionMock },
  feeLedger: { id: 'fl_col' },
  balances: { did: 'bal_did_col', unit: 'bal_unit_col', amount: 'bal_amount_col' },
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
  // Rail fee schedule under test: 2.9% + $0.30 (#2177 — was STRIPE_RATE_BPS / STRIPE_FIXED_CENTS).
  processorFeeCents: (_rail: string, amountCents: number) => Math.round((amountCents * 290) / 10000) + 30,
}));

vi.mock('../providers/stripe-webhook', () => ({ fetchActualFee: vi.fn() }));

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import {
  calculateEstimatedFee,
  reconcileStripeFee,
  processChainDistribution,
  sumTaxCents,
  type FairManifest,
  type FairManifestTax,
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

  it('writes an MJNx balance row for buyer_credit role (#2016)', async () => {
    const chain = [{ did: 'did:imajin:buyer', role: 'buyer_credit', share: 0.02 }];
    await processChainDistribution({ tx, totalAmountCents: 10000, currency, buyerDid: null, chain });

    // feeLedger + balances + balanceRollups = 3 inserts
    expect(mocks.insertMock).toHaveBeenCalledTimes(3);

    const balanceRow = mocks.insertValuesMock.mock.calls[1][0];
    // 10000 * 0.02 = 200 cents → 200/100 = 2.0
    expect(balanceRow.unit).toBe('MJNx');
    expect(balanceRow.amount).toBe('2.00000000');
  });

  it('writes an MJN balance row for non-buyer_credit fee beneficiary (#2016)', async () => {
    const chain = [{ did: 'did:imajin:node', role: 'node', share: 0.03 }];
    await processChainDistribution({ tx, totalAmountCents: 10000, currency, buyerDid: null, chain });

    expect(mocks.insertMock).toHaveBeenCalledTimes(3);

    const balanceRow = mocks.insertValuesMock.mock.calls[1][0];
    // 10000 * 0.03 = 300 cents → 300/100 = 3.0
    expect(balanceRow.unit).toBe('MJN');
    expect(balanceRow.amount).toBe('3.00000000');
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

// ---------------------------------------------------------------------------
// processChainDistribution — taxes[] (#2435)
// ---------------------------------------------------------------------------

describe('sumTaxCents', () => {
  it('is 0 for absent or empty taxes', () => {
    expect(sumTaxCents(undefined)).toBe(0);
    expect(sumTaxCents([])).toBe(0);
  });

  it('sums every row\'s amount', () => {
    expect(sumTaxCents([taxRow({ amount: 500 }), taxRow({ amount: 998 })])).toBe(1498);
  });
});

function taxRow(overrides: Partial<FairManifestTax> = {}): FairManifestTax {
  return {
    jurisdiction: 'CA-ON',
    kind: 'GST/HST',
    rateBps: 1300,
    basisAmount: 10000,
    amount: 1300,
    collectorDid: 'did:imajin:seller',
    remitTo: 'did:imajin:authority:ca-cra',
    registrationNumber: '123456789RT0001',
    ...overrides,
  };
}

describe('processChainDistribution with taxes[] (#2435)', () => {
  const tx: TxRow = { id: 'tx_tax', service: 'market' };
  const currency = 'CAD';
  const chain = [
    { did: 'did:imajin:node', role: 'node', share: 0.03 },
    { did: 'did:imajin:scope', role: 'scope', share: 0.02 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insertValuesMock.mockImplementation(() => ({ onConflictDoUpdate: mocks.onConflictDoUpdateMock }));
  });

  // Insert payloads, flattened: a multi-row `.values([...])` yields one entry per row.
  function insertedRows(): Array<Record<string, unknown>> {
    return mocks.insertValuesMock.mock.calls.flatMap((call) => {
      const arg = (call as unknown[])[0];
      return (Array.isArray(arg) ? arg : [arg]) as Array<Record<string, unknown>>;
    });
  }

  function feeLedgerRows(): Array<Record<string, unknown>> {
    return insertedRows().filter((row) => typeof row.role === 'string' && 'amountCents' in row);
  }

  it('computes every share on totalAmountCents minus tax, never on the gross', async () => {
    await processChainDistribution({
      tx, totalAmountCents: 11300, currency, buyerDid: null, chain, taxes: [taxRow()],
    });

    const byRole = Object.fromEntries(feeLedgerRows().map((row) => [row.role, row]));
    expect(byRole.node).toMatchObject({ amountCents: 300 }); // 3% of 10000, not 339 (3% of 11300)
    expect(byRole.scope).toMatchObject({ amountCents: 200 });
  });

  it('books each tax row as a held_in_trust fee-ledger row for the collector', async () => {
    await processChainDistribution({
      tx, totalAmountCents: 11300, currency, buyerDid: null, chain: [], taxes: [taxRow()],
    });

    expect(feeLedgerRows()).toEqual([
      expect.objectContaining({
        transactionId: 'tx_tax', recipientDid: 'did:imajin:seller', role: 'tax', amountCents: 1300, status: 'held_in_trust',
      }),
    ]);
  });

  it('writes the trust-liability transactions row getTaxRemittanceOwed reads, with no balance credit', async () => {
    await processChainDistribution({
      tx, totalAmountCents: 11300, currency, buyerDid: 'did:imajin:buyer', chain: [], taxes: [taxRow()],
    });

    const taxTx = insertedRows().find((row) => row.type === 'tax')!;
    expect(taxTx).toMatchObject({
      toDid: 'did:imajin:seller', fromDid: 'did:imajin:buyer', amount: '13.00', currency, status: 'completed',
    });
    expect(taxTx).not.toHaveProperty('stripeId');
    expect(taxTx).not.toHaveProperty('externalRef');
    expect(taxTx.metadata).toMatchObject({
      tax: true,
      jurisdiction: 'CA-ON',
      kind: 'GST/HST',
      rateBps: 1300,
      remitTo: 'did:imajin:authority:ca-cra',
      registrationNumber: '123456789RT0001',
      trustLiability: true,
      remitted: null,
      balance_skipped: true,
    });
    // fee-ledger row + transactions row only — no balances / balanceRollups insert for the tax
    expect(mocks.insertMock).toHaveBeenCalledTimes(2);
  });

  it('books every row of a multi-tax manifest (GST + PST) in one transaction with two multi-row inserts', async () => {
    const gst = taxRow({ jurisdiction: 'CA-BC', kind: 'GST', rateBps: 500, amount: 500, remitTo: 'did:imajin:authority:ca-cra' });
    const pst = taxRow({ jurisdiction: 'CA-BC', kind: 'PST', rateBps: 700, amount: 700, remitTo: 'did:imajin:authority:ca-bc' });
    await processChainDistribution({
      tx, totalAmountCents: 11200, currency, buyerDid: 'did:imajin:buyer', chain: [], taxes: [gst, pst],
    });

    expect(mocks.transactionMock).toHaveBeenCalledTimes(1);
    expect(mocks.insertMock).toHaveBeenCalledTimes(2); // one feeLedger insert + one transactions insert
    expect(feeLedgerRows()).toEqual([
      expect.objectContaining({ role: 'tax', amountCents: 500, status: 'held_in_trust' }),
      expect.objectContaining({ role: 'tax', amountCents: 700, status: 'held_in_trust' }),
    ]);
    const taxTxRows = insertedRows().filter((row) => row.type === 'tax');
    expect(taxTxRows.map((row) => (row.metadata as Record<string, unknown>).kind)).toEqual(['GST', 'PST']);
    expect(taxTxRows.map((row) => row.amount)).toEqual(['5.00', '7.00']);
    expect(mocks.publishMock).toHaveBeenCalledTimes(2);
  });

  it('does not book a zero-amount tax row', async () => {
    await processChainDistribution({
      tx, totalAmountCents: 10000, currency, buyerDid: null, chain: [], taxes: [taxRow({ rateBps: 0, amount: 0 })],
    });
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it('fails closed (no ledger writes) when the Stripe total does not exceed the claimed tax', async () => {
    await processChainDistribution({
      tx, totalAmountCents: 1300, currency, buyerDid: null, chain, taxes: [taxRow()],
    });
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it('is unchanged when taxes is omitted (basis equals total)', async () => {
    await processChainDistribution({ tx, totalAmountCents: 10000, currency, buyerDid: null, chain });
    const byRole = Object.fromEntries(feeLedgerRows().map((row) => [row.role, row]));
    expect(byRole.node).toMatchObject({ amountCents: 300 });
    expect(feeLedgerRows().some((row) => row.role === 'tax')).toBe(false);
  });
});
