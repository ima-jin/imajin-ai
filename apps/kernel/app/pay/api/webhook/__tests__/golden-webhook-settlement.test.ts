/**
 * Golden characterization tests for the Stripe webhook's
 * `checkout.session.completed` settlement path (#1073).
 *
 * These capture CURRENT behaviour of `handleCheckoutCompleted` →
 * `processFairManifest` → `recordProcessingFee` / `reconcileStripeFee` /
 * `processChainDistribution` across a fixture set (simple manifest,
 * multi-party split with rounding, zero-fee, fee rebate, fee surcharge)
 * before the #1073 refactor adds a manifest-signature-verification gate.
 *
 * Baseline fact this suite documents: before #1073, this path performed
 * **no signature check at all** on `tx.fairManifest` — there isn't even a
 * `signature` field in the share-based manifest shape it consumes. After
 * #1073, it attempts verification via the same `verifySettlementSignature`
 * the canonical `/api/settle` route uses, but — unlike that route — never
 * blocks on an absent/invalid signature. It only emits
 * `settlement.manifest.unverified` (this suite's one asserted delta); every
 * ledger write (`feeLedger`, `balances`, `balanceRollups`) stays identical
 * to the pre-refactor baseline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface TxFixture {
  id: string;
  service: string;
  status: string;
  fairManifest: unknown;
}

const state = vi.hoisted(() => ({
  txRow: undefined as TxFixture | undefined,
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  idCounter: 0,
  actualFeeCents: null as number | null,
}));

function resetState() {
  state.txRow = undefined;
  state.insertCalls = [];
  state.updateCalls = [];
  state.idCounter = 0;
  state.actualFeeCents = null;
}

vi.mock('@/src/db', () => {
  const transactions = { __table: 'transactions' };
  const feeLedger = { __table: 'feeLedger' };
  const balances = { __table: 'balances' };
  const balanceRollups = { __table: 'balanceRollups' };

  function tableName(t: unknown): string {
    return (t as { __table?: string } | undefined)?.__table ?? 'unknown';
  }

  function limitResultFor(table: unknown) {
    if (tableName(table) === 'transactions') {
      return Promise.resolve(state.txRow ? [state.txRow] : []);
    }
    return Promise.resolve([]);
  }
  function whereClauseFor(table: unknown) {
    return { limit: (_n: number) => limitResultFor(table) };
  }
  function fromClauseFor() {
    return (table: unknown) => ({ where: (_cond?: unknown) => whereClauseFor(table) });
  }
  function select(_proj?: unknown) {
    return { from: fromClauseFor() };
  }

  function update(table: unknown) {
    return {
      set(values: Record<string, unknown>) {
        return {
          where(_cond?: unknown) {
            state.updateCalls.push({ table: tableName(table), values });
            return Promise.resolve(undefined);
          },
        };
      },
    };
  }

  function insert(table: unknown) {
    return {
      values(values: Record<string, unknown>) {
        const record = { table: tableName(table), values } as { table: string; values: Record<string, unknown>; conflict?: unknown };
        state.insertCalls.push(record);
        const promise = Promise.resolve(undefined);
        return Object.assign(promise, {
          onConflictDoUpdate(conflict: unknown) {
            record.conflict = conflict;
            return Promise.resolve(undefined);
          },
        });
      },
    };
  }

  return {
    db: { select, update, insert },
    transactions,
    feeLedger,
    balances,
    balanceRollups,
  };
});

const { publishMock } = vi.hoisted(() => ({ publishMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@imajin/bus', () => ({ publish: publishMock }));

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_${state.idCounter++}`,
}));

const { constructEventMock, retrievePaymentIntentMock } = vi.hoisted(() => ({
  constructEventMock: vi.fn(),
  retrievePaymentIntentMock: vi.fn(),
}));
vi.mock('@/src/lib/pay/stripe', () => ({
  getStripe: () => ({
    webhooks: { constructEvent: constructEventMock },
    paymentIntents: { retrieve: retrievePaymentIntentMock },
  }),
}));

// #1073: settle-core.ts's verifySettlementSignature is unmocked (real module,
// same as the rest of this black-box suite) and always resolves
// `{ signatureVerified: false }` for these fixtures, since none carry a
// `fair_manifest.signature`. That is expected — see the suite docblock.

import { POST } from '../route';

type NextRequestLike = Parameters<typeof POST>[0];

function makeRequest(): NextRequestLike {
  return new Request('http://localhost:3000/pay/api/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'sig_test' },
    body: 'raw-body',
  }) as unknown as NextRequestLike;
}

function makeCheckoutEvent(session: Record<string, unknown>) {
  return {
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test', amount_total: 10000, currency: 'usd', metadata: {}, ...session } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.PLATFORM_DID = 'did:imajin:platform';
  retrievePaymentIntentMock.mockImplementation(() =>
    Promise.resolve({
      latest_charge: state.actualFeeCents === null ? null : { balance_transaction: { fee: state.actualFeeCents, fee_details: [] } },
    }),
  );
});

describe('Webhook checkout.session.completed — golden characterization (#1073)', () => {
  it('simple manifest: single seller, fallback fee rate, no payment_intent so no reconciliation', async () => {
    state.txRow = {
      id: 'tx_fixture',
      service: 'market',
      status: 'pending',
      fairManifest: { chain: [{ did: 'did:imajin:seller', role: 'seller', share: 1.0 }] },
    };
    constructEventMock.mockReturnValue(
      makeCheckoutEvent({ payment_intent: null, metadata: { service: 'market_test' } }),
    );

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    // No payment_intent -> fetchActualStripeFee short-circuits to null -> estimate used, no reconcile.
    const feeLedgerInserts = state.insertCalls.filter((c) => c.table === 'feeLedger');
    // 1 processor fee row + 1 seller distribution row
    expect(feeLedgerInserts).toHaveLength(2);
    expect(feeLedgerInserts[0].values).toMatchObject({ recipientDid: 'stripe:processor', amountCents: 400 }); // 3.7% of 10000 + 30
    expect(feeLedgerInserts[1].values).toMatchObject({ recipientDid: 'did:imajin:seller', role: 'seller', status: 'paid_out' });

    // Seller role -> no balance/rollup write (Stripe already paid them directly).
    expect(state.insertCalls.filter((c) => c.table === 'balances')).toHaveLength(0);
    expect(state.insertCalls.filter((c) => c.table === 'balanceRollups')).toHaveLength(0);

    // #1073 delta: the webhook now attempts verification and, since this
    // fixture's manifest is unsigned (as essentially all are today), emits
    // settlement.manifest.unverified — but never blocks; every ledger write
    // above is unchanged from the pre-refactor baseline.
    expect(publishMock).toHaveBeenCalledWith(
      'settlement.manifest.unverified',
      expect.objectContaining({ subject: 'unknown', payload: expect.objectContaining({ service: 'market' }) }),
    );
  });

  it('multi-party split with rounding: seller + node + buyer_credit shares', async () => {
    state.txRow = {
      id: 'tx_fixture',
      service: 'market',
      status: 'pending',
      fairManifest: {
        chain: [
          { did: 'did:imajin:seller', role: 'seller', share: 0.9 },
          { did: 'did:imajin:node', role: 'node', share: 0.07 },
          { did: 'BUYER_PLACEHOLDER', role: 'buyer_credit', share: 0.03 },
        ],
      },
    };
    constructEventMock.mockReturnValue(
      makeCheckoutEvent({ payment_intent: null, metadata: { service: 'market_test', buyerDid: 'did:imajin:buyer' } }),
    );

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    const feeLedgerInserts = state.insertCalls.filter((c) => c.table === 'feeLedger');
    // processor + seller + node + buyer_credit = 4
    expect(feeLedgerInserts).toHaveLength(4);
    const byRole = Object.fromEntries(feeLedgerInserts.map((c) => [c.values.role, c.values]));
    expect(byRole.seller).toMatchObject({ amountCents: 9000, status: 'paid_out' });
    expect(byRole.node).toMatchObject({ amountCents: 700, status: 'accrued' });
    expect(byRole.buyer_credit).toMatchObject({ amountCents: 300, recipientDid: 'did:imajin:buyer', status: 'accrued' });

    const balanceInserts = state.insertCalls.filter((c) => c.table === 'balances');
    expect(balanceInserts).toHaveLength(2); // node (cash) + buyer_credit (credit); seller skipped
    const nodeBalance = balanceInserts.find((c) => c.values.did === 'did:imajin:node')!;
    expect(nodeBalance.values).toMatchObject({ cashAmount: '7.00000000', creditAmount: '0' });
    const buyerBalance = balanceInserts.find((c) => c.values.did === 'did:imajin:buyer')!;
    expect(buyerBalance.values).toMatchObject({ creditAmount: '3.00000000', cashAmount: '0' });

    expect(state.insertCalls.filter((c) => c.table === 'balanceRollups')).toHaveLength(2);
  });

  it('zero-fee manifest: processor entry with rateBps=0, fixedCents=0', async () => {
    state.txRow = {
      id: 'tx_fixture',
      service: 'market',
      status: 'pending',
      fairManifest: {
        fees: [{ role: 'processor', name: 'Waived', rateBps: 0, fixedCents: 0 }],
        chain: [{ did: 'did:imajin:seller', role: 'seller', share: 1.0 }],
      },
    };
    constructEventMock.mockReturnValue(
      makeCheckoutEvent({ payment_intent: null, metadata: { service: 'market_test' } }),
    );

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    const processorRow = state.insertCalls.find((c) => c.table === 'feeLedger' && c.values.recipientDid === 'stripe:processor')!;
    expect(processorRow.values).toMatchObject({ amountCents: 0 });
  });

  it('estimate vs actual: actual fee lower than estimate triggers a rebate', async () => {
    state.txRow = {
      id: 'tx_fixture',
      service: 'market',
      status: 'pending',
      fairManifest: { chain: [{ did: 'did:imajin:seller', role: 'seller', share: 1.0 }] },
    };
    state.actualFeeCents = 350; // < fallback estimate (400)
    constructEventMock.mockReturnValue(
      makeCheckoutEvent({ payment_intent: 'pi_test', metadata: { service: 'market_test' } }),
    );

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    const rebateRow = state.insertCalls.find((c) => c.table === 'feeLedger' && c.values.role === 'processor_rebate')!;
    expect(rebateRow.values).toMatchObject({ recipientDid: 'did:imajin:seller', amountCents: 50 }); // |400-350|

    const rebateBalance = state.insertCalls.find(
      (c) => c.table === 'balances' && c.values.did === 'did:imajin:seller',
    )!;
    expect(rebateBalance.values.creditAmount).toBe('0.50000000');

    expect(publishMock).toHaveBeenCalledWith('fee.rebate', expect.objectContaining({ subject: 'did:imajin:seller' }));
  });

  it('estimate vs actual: actual fee higher than estimate triggers a surcharge', async () => {
    state.txRow = {
      id: 'tx_fixture',
      service: 'market',
      status: 'pending',
      fairManifest: { chain: [{ did: 'did:imajin:seller', role: 'seller', share: 1.0 }] },
    };
    state.actualFeeCents = 450; // > fallback estimate (400)
    constructEventMock.mockReturnValue(
      makeCheckoutEvent({ payment_intent: 'pi_test', metadata: { service: 'market_test' } }),
    );

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    const surchargeRow = state.insertCalls.find((c) => c.table === 'feeLedger' && c.values.role === 'processor_surcharge')!;
    expect(surchargeRow.values).toMatchObject({ recipientDid: 'did:imajin:seller', amountCents: 50 }); // |400-450|

    const surchargeBalance = state.insertCalls.find(
      (c) => c.table === 'balances' && c.values.did === 'did:imajin:seller',
    )!;
    expect(surchargeBalance.values.creditAmount).toBe('-0.50000000');

    expect(publishMock).toHaveBeenCalledWith('fee.surcharge', expect.objectContaining({ subject: 'did:imajin:seller' }));
  });

  it('estimate equals actual fee exactly: no reconciliation row written', async () => {
    state.txRow = {
      id: 'tx_fixture',
      service: 'market',
      status: 'pending',
      fairManifest: { chain: [{ did: 'did:imajin:seller', role: 'seller', share: 1.0 }] },
    };
    state.actualFeeCents = 400; // exactly the fallback estimate
    constructEventMock.mockReturnValue(
      makeCheckoutEvent({ payment_intent: 'pi_test', metadata: { service: 'market_test' } }),
    );

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    expect(state.insertCalls.some((c) => c.values.role === 'processor_rebate' || c.values.role === 'processor_surcharge')).toBe(false);
    expect(publishMock).not.toHaveBeenCalledWith('fee.rebate', expect.anything());
    expect(publishMock).not.toHaveBeenCalledWith('fee.surcharge', expect.anything());
  });
});
