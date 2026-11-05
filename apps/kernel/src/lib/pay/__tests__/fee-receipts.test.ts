import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalize, crypto } from '@imajin/auth';
import { eq } from 'drizzle-orm';
import type { BusEvent } from '@imajin/bus';
import { createFeeCreditHarness, feeMigration } from './fee-credit-harness';

const state = vi.hoisted(() => ({
  db: undefined as unknown as Awaited<ReturnType<typeof createFeeCreditHarness>>['db'],
  sql: vi.fn(), node: vi.fn(), resolve: vi.fn(), construct: vi.fn(), failPublish: false, actualFeeCents: 280,
}));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/pay'), identities: {},
  db: {
    select: (...args: Parameters<typeof state.db.select>) => state.db.select(...args),
    insert: (...args: Parameters<typeof state.db.insert>) => state.db.insert(...args),
    update: (...args: Parameters<typeof state.db.update>) => state.db.update(...args),
    transaction: (...args: Parameters<typeof state.db.transaction>) => state.db.transaction(...args),
  },
}));
vi.mock('@imajin/db', () => ({ getClient: () => state.sql }));
vi.mock('@imajin/auth/resolve-db', () => ({ createDbResolver: () => state.resolve }));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: state.node }));
vi.mock('@/src/lib/loops/authorize-publisher', () => ({ authorizeLoopPublisher: async () => ({ authorized: true }) }));
vi.mock('@imajin/bus', async () => {
  const { publish } = await import('../../../../../../packages/bus/src/publish');
  const registry = await import('../../../../../../packages/bus/src/registry');
  return {
    ...registry,
    publish: (type: string, event: Omit<BusEvent, 'type'>) => {
      if (state.failPublish && type.startsWith('fee.')) throw new Error('injected publish failure');
      return publish(type as Parameters<typeof publish>[0], event as Parameters<typeof publish>[1]);
    },
  };
});
vi.mock('../../../../../../packages/bus/src/subscriptions', () => ({ deliverToSubscribers: async () => {} }));
vi.mock('../../../../../../packages/bus/src/chain-observer', () => ({ observeChain: async () => {} }));
vi.mock('../settle-core', () => ({ verifySettlementSignature: async () => ({ signatureVerified: true }) }));
vi.mock('../payment-requests/checkout', () => ({ settlePaymentRequestFromStripeCheckout: vi.fn() }));
vi.mock('../providers/stripe-client', () => ({ getStripeClient: () => ({
  webhooks: { constructEvent: state.construct },
  paymentIntents: { retrieve: async () => ({ latest_charge: { balance_transaction: { fee: state.actualFeeCents } } }) },
}) }));

import { registerReactor } from '@imajin/bus';
import { loopProjectionReactor } from '../../../../../../packages/bus/src/reactors/loop-projection';
import { feeLedger, transactions, balances, balanceRollups } from '@/src/db/schemas/pay';
import { feeLedgerReactor } from '../fee-ledger-reactor';
import { publishFeeReceipt } from '../fee-receipts';
import { feeCreditKey } from '../fee-credits';
import { ingestLoopEvent } from '../../loops/ingest';
import { verifyStoredLoopReceipt } from '../../loops/verify-stored-receipt';
import { serializeLoopEvent, type RawLoopEventRow } from '../../loops/serialize';
import { validateFeeReceipt } from '../fee-receipt-payload';
import { parseLoopIngestRequest } from '../../loops/types';
import { __resetStripeWebhookDedupForTests } from '../providers/stripe-webhook';
import { POST } from '../../../../app/pay/api/webhook/__tests__/legacy-relay-fixture';

let harness: Awaited<ReturnType<typeof createFeeCreditHarness>>;
const key = crypto.generateKeypair();
const platform = 'did:imajin:platform';
const migration = readFileSync(new URL('../../../../../../migrations/0235_fee_ledger_projection.sql', import.meta.url), 'utf8');
const at = '2026-11-05T13:00:00.000Z';
const context = { stripeEventId: 'evt_fee', stripeEventAt: at };
const fact = { transactionId: 'tx_fee', recipientDid: 'did:imajin:node', role: 'node', amountCents: 300, currency: 'CAD', status: 'accrued' as const, chainIndex: 0 };

function tagged(executor: Pick<typeof harness.client, 'query'>) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '');
    return (await executor.query(query, values)).rows;
  };
}
async function receipts() {
  return (await harness.client.query('SELECT * FROM kernel.loop_events ORDER BY id')).rows
    .map(row => serializeLoopEvent(row as unknown as RawLoopEventRow));
}
function event(id: string) {
  return {
    id: `evt_${id}`, created: Date.parse(at) / 1000, type: 'checkout.session.completed',
    data: { object: {
      id: `cs_${id}`, amount_total: 11300, currency: 'cad', payment_intent: `pi_${id}`,
      metadata: { buyerDid: 'did:imajin:buyer', service: 'fixture' },
    } },
  };
}
async function deliver(id: string) {
  state.construct.mockReturnValue(event(id));
  return POST(new Request('https://test/pay/api/webhook', {
    method: 'POST', headers: { 'stripe-signature': 'test-signature' }, body: 'test',
  }) as Parameters<typeof POST>[0]);
}
async function checkout(id: string) {
  await state.db.insert(transactions).values({
    id: `tx_${id}`, rail: 'stripe', externalRef: `cs_${id}`, status: 'pending',
    service: 'fixture', type: 'sale', toDid: 'did:imajin:seller', amount: '113',
    fairManifest: {
      chain: [
        { did: 'did:imajin:seller', role: 'seller', share: 0.9 },
        { did: 'did:imajin:node', role: 'node', share: 0.06 },
        { did: 'did:imajin:node', role: 'node', share: 0.04 },
      ],
      taxes: [{
        jurisdiction: 'CA-ON', kind: 'HST', rateBps: 1300, basisAmount: 10000,
        amount: 1300, collectorDid: 'did:imajin:seller', remitTo: 'did:imajin:cra', registrationNumber: 'fixture',
      }],
    },
  });

}
beforeAll(async () => {
  harness = await createFeeCreditHarness();
  state.db = harness.db;
  await harness.client.exec(feeMigration);
  await harness.client.exec(`CREATE SCHEMA kernel;
    CREATE TABLE kernel.bus_chain_configs (
      event_type text, scope text, reactors jsonb, enabled boolean, updated_at timestamptz,
      UNIQUE NULLS NOT DISTINCT(event_type, scope)
    );`);
  for (const name of ['0157_loops_rail.sql', '0193_loop_output_artifacts.sql', '0194_surface_lease.sql']) {
    await harness.client.exec(readFileSync(new URL(`../../../../../../migrations/archive/pre-kernel-baseline/${name}`, import.meta.url), 'utf8'));
  }
  await harness.client.exec(readFileSync(new URL('../../../../../../migrations/0232_loop_event_signed_receipts.sql', import.meta.url), 'utf8'));
  await harness.client.exec(migration);
  state.sql.mockImplementation(tagged(harness.client));
  Object.assign(state.sql, { begin: (work: (tx: ReturnType<typeof tagged>) => Promise<unknown>) =>
    harness.client.transaction(tx => work(tagged(tx))) });
  registerReactor('loop-projection', loopProjectionReactor);
  registerReactor('emit', async () => {});
}, 30_000);
beforeEach(async () => {
  await harness.client.exec('TRUNCATE pay.fee_ledger, pay.transactions, pay.balances, pay.balance_rollups, kernel.loop_events, kernel.loops');
  state.db = harness.db;
  state.failPublish = false;
  state.actualFeeCents = 280;
  state.node.mockReturnValue({ senderDid: 'did:imajin:node', senderPubkey: key.publicKey, privateKeyHex: key.privateKey });
  state.resolve.mockImplementation(async (did: string) => did === platform ? { publicKey: key.publicKey } : null);
  vi.stubEnv('PLATFORM_DID', platform);
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'fixture');
  __resetStripeWebhookDedupForTests();
});
afterAll(async () => { vi.unstubAllEnvs(); await harness?.client.close(); });

describe('fee receipts through the real signed store and bus chain', () => {
  it('serializes competing signed facts for the same fee identity, and concurrent identical deliveries deduplicate', async () => {
    await Promise.all([publishFeeReceipt('fee.record', fact, context), publishFeeReceipt('fee.record', fact, context)]);
    expect(await receipts()).toHaveLength(1);
    const payload = {
      ...fact, amountCents: 999, stripeEventId: context.stripeEventId, loopId: feeCreditKey(fact),
      kind: 'pay.fee', principal: platform, state: 'recorded', summary: 'Fee', at,
    };
    const type = 'fee.record';
    const result = await ingestLoopEvent({ type, payload, publisherDid: platform,
      signature: { keyId: key.publicKey, alg: 'ed25519', sig: crypto.signSync(canonicalize({ type, payload }), key.privateKey) } });
    expect(result).toMatchObject({ status: 500 });
    expect(await receipts()).toHaveLength(1);
    expect(await state.db.select().from(feeLedger)).toEqual([expect.objectContaining({ amountCents: 300 })]);
  });
  it('rebuilds identical rows from re-verified PaymentIntent receipts without re-crediting wallets', async () => {
    await checkout('rebuild');
    expect((await deliver('rebuild')).status).toBe(200);
    const originals = await state.db.select().from(feeLedger).orderBy(feeLedger.id);
    expect(originals).toHaveLength(6); // processor, rebate, seller, two node positions, tax
    const stored = await receipts();
    expect(stored).toHaveLength(6);
    expect(stored.every(row => row.payload.stripeEventId === 'evt_rebuild')).toBe(true);
    for (const row of stored) expect(await verifyStoredLoopReceipt(row)).toEqual({ ok: true });
    const wallet = await harness.db.select().from(balances);
    const rollups = await harness.db.select().from(balanceRollups);
    const rebuilt = await createFeeCreditHarness();
    try {
      await rebuilt.client.exec('ALTER TABLE pay.fee_ledger ADD COLUMN receipt_id text UNIQUE');
      state.db = rebuilt.db;
      for (const row of stored) await feeLedgerReactor({ id: row.id, type: row.type, issuer: platform, subject: platform, scope: 'pay' }, {});
      expect(await rebuilt.db.select().from(feeLedger).orderBy(feeLedger.id)).toEqual(originals);
      expect(await rebuilt.db.select().from(transactions)).toEqual(
        (await harness.db.select().from(transactions)).filter(row => row.type === 'tax'),
      );
      expect(await rebuilt.db.select().from(balances)).toEqual([]);
      expect(await harness.db.select().from(balances)).toEqual(wallet);
      expect(await harness.db.select().from(balanceRollups)).toEqual(rollups);
    } finally { state.db = harness.db; await rebuilt.client.close(); }
  });

  it('double webhook delivery and receipt replay keep one row per receipt and one wallet/rollup effect per indexed key', async () => {
    await checkout('duplicate');
    expect((await deliver('duplicate')).status).toBe(200);
    __resetStripeWebhookDedupForTests(); // emulate a new process: durable completion guards
    expect((await deliver('duplicate')).status).toBe(200);
    const stored = await receipts();
    for (const row of [...stored, ...stored]) await feeLedgerReactor({ id: row.id, type: row.type, issuer: platform, subject: platform, scope: 'pay' }, {});
    expect(await state.db.select().from(feeLedger)).toHaveLength(6);
    expect(new Set((await state.db.select().from(feeLedger)).map(row => row.receiptId)).size).toBe(6);
    const claims = (await state.db.select().from(transactions)).filter(row => row.sourceKind === 'fee');
    expect(claims).toHaveLength(3);
    expect(claims.filter(row => row.toDid === 'did:imajin:node').map(row => row.idempotencyKey).sort()).toEqual([
      feeCreditKey({ transactionId: 'tx_duplicate', role: 'node', recipientDid: 'did:imajin:node', chainIndex: 1 }),
      feeCreditKey({ transactionId: 'tx_duplicate', role: 'node', recipientDid: 'did:imajin:node', chainIndex: 2 }),
    ]);
    expect((await state.db.select().from(balanceRollups))[0]).toMatchObject({ earned: '10.00000000', txCount: 2 });
  });

  it.each(['publish', 'receipt', 'projection'] as const)('%s failure leaves no fee row, returns 500, and Stripe retry finishes once', async failure => {
    await checkout(failure);
    if (failure === 'publish') state.failPublish = true;
    else await harness.client.exec(`CREATE FUNCTION pay.reject_fee() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'projection unavailable'; END $$;
      CREATE TRIGGER reject_fee BEFORE INSERT ON ${failure === 'receipt' ? 'kernel.loop_events' : 'pay.fee_ledger'} FOR EACH ROW EXECUTE FUNCTION pay.reject_fee();`);
    try {
      expect((await deliver(failure)).status).toBe(500);
      expect(await state.db.select().from(feeLedger)).toEqual([]);
      expect(await state.db.select().from(balances)).toEqual([]);
      expect((await state.db.select().from(transactions).where(eq(transactions.id, `tx_${failure}`)))[0].status).toBe('pending');
      expect(await receipts()).toHaveLength(failure === 'projection' ? 1 : 0);
    } finally {
      state.failPublish = false;
      if (failure !== 'publish') await harness.client.exec(`DROP TRIGGER reject_fee ON ${failure === 'receipt' ? 'kernel.loop_events' : 'pay.fee_ledger'}; DROP FUNCTION pay.reject_fee();`);
    }
    expect((await deliver(failure)).status).toBe(200);
    expect(await state.db.select().from(feeLedger)).toHaveLength(6);
    expect((await state.db.select().from(balanceRollups))[0].txCount).toBe(2);
  });

  it('tax transaction failure rolls back its fee twin and retries without repeating successful wallet effects', async () => {
    await checkout('taxfail');
    await harness.client.exec(`CREATE FUNCTION pay.reject_tax() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.type = 'tax' THEN RAISE EXCEPTION 'tax unavailable'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_tax BEFORE INSERT ON pay.transactions FOR EACH ROW EXECUTE FUNCTION pay.reject_tax();`);
    try {
      expect((await deliver('taxfail')).status).toBe(500);
      expect((await state.db.select().from(feeLedger)).some(row => row.role === 'tax')).toBe(false);
      expect((await state.db.select().from(transactions)).some(row => row.type === 'tax')).toBe(false);
    } finally { await harness.client.exec('DROP TRIGGER reject_tax ON pay.transactions; DROP FUNCTION pay.reject_tax();'); }
    state.actualFeeCents = 900; // Stripe's mutable lookup must not replace an already-signed fee.
    expect((await deliver('taxfail')).status).toBe(200);
    expect((await state.db.select().from(feeLedger)).filter(row => row.role === 'tax')).toHaveLength(1);
    expect((await state.db.select().from(transactions)).filter(row => row.type === 'tax')).toHaveLength(1);
    expect((await state.db.select().from(balanceRollups))[0]).toMatchObject({ earned: '10.00000000', txCount: 2 });
    expect((await state.db.select().from(feeLedger)).some(row => row.role === 'processor_surcharge')).toBe(false);
  });

  it('reuses the persisted receipt on retry instead of replacing a signed amount', async () => {
    await publishFeeReceipt('fee.record', fact, context);
    const first = await receipts();
    const result = await publishFeeReceipt('fee.record', { ...fact, amountCents: 999 }, context);
    expect(result.amountCents).toBe(300);
    expect(await receipts()).toEqual(first);
    expect((await state.db.select().from(feeLedger))[0].amountCents).toBe(300);
  });

  it('rejects missing context, unconfigured platform, missing receipts and stored tampering', async () => {
    await expect(publishFeeReceipt('fee.record', fact)).rejects.toThrow('context');
    vi.stubEnv('PLATFORM_DID', '');
    await expect(publishFeeReceipt('fee.record', fact, context)).rejects.toThrow('configured');
    vi.stubEnv('PLATFORM_DID', platform);
    await expect(feeLedgerReactor({ id: 'missing', type: 'fee.record', issuer: platform, subject: platform, scope: 'pay' }, {})).rejects.toThrow('persisted');
    await publishFeeReceipt('fee.record', fact, context);
    const [stored] = await receipts();
    await harness.client.query(`UPDATE kernel.loop_events SET payload = jsonb_set(payload, '{amountCents}', '999') WHERE id = $1`, [stored.id]);
    await expect(feeLedgerReactor({ id: stored.id, type: stored.type, issuer: platform, subject: platform, scope: 'pay' }, {})).rejects.toThrow('verification');
  });

  it.each([
    ['amountCents', -1], ['amountCents', 0.5], ['amountCents', 2147483648],
    ['currency', 'cad'], ['stripeEventId', 'pi_not_event'], ['at', 'invalid'],
    ['chainIndex', -1], ['chainIndex', 0.5], ['loopId', 'wrong'], ['kind', 'wrong'],
    ['state', 'wrong'], ['status', 'paid_out'], ['principal', 'did:imajin:other'],
    ['transactionId', ''], ['recipientDid', ''], ['role', ''], ['tax', {}],
  ])('rejects invalid fee fact %s=%s without persistence', async (field, value) => {
    const payload = {
      ...fact, stripeEventId: context.stripeEventId, loopId: feeCreditKey(fact),
      kind: 'pay.fee', principal: platform, state: 'recorded', summary: 'Fee', at, [field]: value,
    };
    expect(validateFeeReceipt('fee.record', payload, platform)).toBe(false);
    const request = { type: 'fee.record' as const, payload, publisherDid: platform,
      signature: { keyId: key.publicKey, alg: 'ed25519' as const, sig: crypto.signSync(canonicalize({ type: 'fee.record', payload }), key.privateKey) } };
    expect(await ingestLoopEvent(request)).toMatchObject({ ok: false });
    expect(await receipts()).toEqual([]);
  });

  it.each([
    ['jurisdiction', ''], ['kind', ''], ['remitTo', ''], ['registrationNumber', ''], ['service', ''],
    ['rateBps', -1], ['rateBps', 0.5], ['buyerDid', 42],
  ])('rejects invalid tax twin %s=%s', async (field, value) => {
    const taxFact = {
      ...fact, role: 'tax', status: 'held_in_trust' as const,
      tax: { jurisdiction: 'CA-ON', kind: 'HST', rateBps: 1300, remitTo: 'did:imajin:cra', registrationNumber: 'fixture', service: 'pay', buyerDid: null, [field]: value },
    };
    await expect(publishFeeReceipt('fee.record', taxFact, context)).rejects.toThrow('Invalid fee receipt');
    expect(await receipts()).toEqual([]);
  });

  it('rejects non-platform signed publishers, forged signatures, and wrong adjustment roles', async () => {
    const payload = {
      ...fact, stripeEventId: context.stripeEventId, loopId: feeCreditKey(fact),
      kind: 'pay.fee', principal: platform, state: 'recorded', summary: 'Fee', at,
    };
    const request = { type: 'fee.record' as const, payload, publisherDid: platform,
      signature: { keyId: key.publicKey, alg: 'ed25519' as const, sig: '0'.repeat(128) } };
    expect(await ingestLoopEvent(request)).toMatchObject({ status: 400 });
    expect(validateFeeReceipt('fee.record', { ...payload, principal: 'did:imajin:other' }, 'did:imajin:other')).toBe(false);
    expect(validateFeeReceipt('fee.rebate', payload, platform)).toBe(false);
    expect(validateFeeReceipt('fee.surcharge', payload, platform)).toBe(false);
    expect(parseLoopIngestRequest({ ...request, payload: { ...payload, at: new Date().toISOString() } }).ok).toBe(true);
    expect(parseLoopIngestRequest({ ...request, payload: { ...payload, at: new Date().toISOString(), role: '' } }).ok).toBe(false);
    expect(await receipts()).toEqual([]);
  });

  it('migration is repeatable, preserves unsigned history, and seeds all scoped/default fee chains', async () => {
    await state.db.insert(feeLedger).values({ ...fact, id: 'legacy' });
    await harness.client.exec(`INSERT INTO kernel.bus_chain_configs VALUES ('fee.record', 'pay', '[]', false, now())`);
    await harness.client.exec(migration);
    await harness.client.exec(migration);
    expect(await state.db.select().from(feeLedger)).toEqual([expect.objectContaining({ id: 'legacy', receiptId: null })]);
    const configs = (await harness.client.query(`SELECT * FROM kernel.bus_chain_configs WHERE event_type LIKE 'fee.%'`)).rows;
    expect(configs).toHaveLength(4);
    for (const row of configs) expect(row.reactors).toEqual([
      { type: 'loop-projection', config: {}, await: true, enabled: true },
      { type: 'fee-ledger', config: {}, await: true, propagateError: true, enabled: true },
      { type: 'emit', config: {}, enabled: true },
    ]);
    expect(configs.find(row => row.scope === 'pay')?.enabled).toBe(false);
  });
});
