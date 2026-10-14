import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteLedgerHarness, type PgliteLedgerHarness } from './pglite-pay-harness';
import { transactions } from '@/src/db/schemas/pay';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const h = vi.hoisted(() => ({ db: undefined as unknown, nodeDid: vi.fn() }));
vi.mock('@/src/db', async () => ({
  get db() { return h.db; },
  ...await import('@/src/db/schemas/pay'),
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDidFromConfig: h.nodeDid }));
import { settleNodeTopupFromStripe } from '../node-topup-settlement';

const NODE = 'did:imajin:node';
const BUYER = 'did:imajin:buyer';
const INPUT = { ownerDid: NODE, transactionId: 'tx_topup', paymentIntentId: 'pi_topup', amount: 2600, currency: 'CAD' };
let harness: PgliteLedgerHarness;

async function seed(overrides: Partial<typeof transactions.$inferInsert> = {}) {
  await harness.connA.insert(transactions).values({
    id: 'tx_topup', service: 'topup', type: 'topup', fromDid: BUYER, toDid: BUYER,
    amount: '25', currency: 'CAD', status: 'pending', rail: 'stripe', externalRef: 'cs_topup',
    metadata: { nodeDid: NODE, chargeAmountCents: '2600' }, ...overrides,
  });
}
async function row() {
  const [result] = await harness.connA.select().from(transactions).where(eq(transactions.id, 'tx_topup'));
  return result;
}

beforeAll(async () => {
  harness = await createPgliteLedgerHarness();
  // The reusable ledger harness predates these columns from existing migration 0170.
  await harness.client.exec(`ALTER TABLE pay.transactions
    ADD COLUMN emission_config_id TEXT,
    ADD COLUMN emission_config_version INTEGER,
    ADD COLUMN idempotency_key TEXT`);
  h.db = harness.connA;
});
afterAll(async () => { await harness.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  h.nodeDid.mockResolvedValue(NODE);
  await harness.client.exec('TRUNCATE pay.transactions, pay.balances');
});

describe('node-owned Stripe topup receipt', () => {
  it('atomically completes the pending transaction and credits the recorded amount, not the gross charge', async () => {
    await seed();
    expect(await settleNodeTopupFromStripe(INPUT)).toBe(true);
    expect(await row()).toMatchObject({ status: 'completed', unit: 'MJN', sourceKind: 'receipt', metadata: { paymentIntentId: 'pi_topup' } });
    expect(await harness.readBalance(harness.connA, BUYER, 'MJN')).toBe(25);
    expect(await harness.readBalance(harness.connA, BUYER, 'MJNx')).toBe(0);
  });

  it('credits only once when the same paid intent is delivered twice', async () => {
    await seed();
    expect(await settleNodeTopupFromStripe(INPUT)).toBe(true);
    expect(await settleNodeTopupFromStripe(INPUT)).toBe(false);
    expect(await harness.readBalance(harness.connA, BUYER, 'MJN')).toBe(25);
  });

  it('credits only once for competing receipt handlers', async () => {
    await seed();
    const results = await Promise.all([settleNodeTopupFromStripe(INPUT), settleNodeTopupFromStripe(INPUT)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await harness.readBalance(harness.connA, BUYER, 'MJN')).toBe(25);
  });

  it('rolls back completion if the balance credit fails so a retry can succeed', async () => {
    await seed();
    await harness.client.exec('ALTER TABLE pay.balances ADD CONSTRAINT test_reject_credit CHECK (amount < 1)');
    try {
      await expect(settleNodeTopupFromStripe(INPUT)).rejects.toThrow();
      expect((await row()).status).toBe('pending');
      expect(await harness.readBalance(harness.connA, BUYER, 'MJN')).toBe(0);
    } finally {
      await harness.client.exec('ALTER TABLE pay.balances DROP CONSTRAINT test_reject_credit');
    }
    expect(await settleNodeTopupFromStripe(INPUT)).toBe(true);
    expect(await harness.readBalance(harness.connA, BUYER, 'MJN')).toBe(25);
  });

  it.each(['did:imajin:seller', ''])('never accepts another owner or an absent node identity (%s)', async (did) => {
    await seed();
    h.nodeDid.mockResolvedValue(did);
    expect(await settleNodeTopupFromStripe(INPUT)).toBe(false);
    expect((await row()).status).toBe('pending');
    expect(await harness.readBalance(harness.connA, BUYER, 'MJN')).toBe(0);
  });

  it.each([
    { amount: 2500 }, { currency: 'USD' }, { transactionId: 'tx_unknown' },
    { ownerDid: 'did:imajin:seller' },
  ])('refuses a receipt that does not match checkout: %j', async (overrides) => {
    await seed();
    expect(await settleNodeTopupFromStripe({ ...INPUT, ...overrides })).toBe(false);
    expect((await row()).status).toBe('pending');
    expect(await harness.readBalance(harness.connA, BUYER, 'MJN')).toBe(0);
  });

  it.each([
    { service: 'market' }, { type: 'ticket' }, { rail: 'stripe-byo' }, { status: 'failed' },
    { metadata: null }, { metadata: { nodeDid: 'did:imajin:other', chargeAmountCents: '2600' } },
    { metadata: { nodeDid: NODE, chargeAmountCents: 'NaN' } },
    { metadata: { nodeDid: NODE, chargeAmountCents: '100' } },
    { metadata: { nodeDid: NODE, chargeAmountCents: '2600.5' } },
    { amount: '0' }, { amount: '-25' }, { amount: 'NaN' }, { fromDid: 'did:imajin:other' },
  ])('refuses a non-topup or inconsistent pending row: %j', async (overrides) => {
    await seed(overrides);
    expect(await settleNodeTopupFromStripe(INPUT)).toBe(false);
    expect(await harness.readBalance(harness.connA, BUYER, 'MJN')).toBe(0);
  });
});
