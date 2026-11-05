import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createFeeCreditHarness, feeMigration } from './fee-credit-harness';
import { forEachSequential } from '@/src/lib/async/sequential';
import type { Unit } from '../ledger';

const state = vi.hoisted(() => ({
  db: undefined as unknown as Awaited<ReturnType<typeof createFeeCreditHarness>>['db'],
}));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/pay'),
  db: {
    insert: (...args: Parameters<typeof state.db.insert>) => state.db.insert(...args),
    transaction: (...args: Parameters<typeof state.db.transaction>) => state.db.transaction(...args),
  },
}));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../settle-core', () => ({ verifySettlementSignature: vi.fn() }));
vi.mock('../providers/stripe-webhook', () => ({ fetchActualFee: vi.fn() }));

import { transactions, balances, balanceRollups } from '@/src/db/schemas/pay';
import { feeCreditKey, applyFeeCredit } from '../fee-credits';
import { processChainDistribution, reconcileStripeFee } from '../webhook-handlers';
import * as ledger from '../ledger';

let harness: Awaited<ReturnType<typeof createFeeCreditHarness>>;
beforeAll(async () => {
  harness = await createFeeCreditHarness();
  state.db = harness.db;
  await harness.client.exec(feeMigration);
}, 30_000);
afterAll(async () => { await harness?.client.close(); });

async function threeTimes(action: () => Promise<void>) {
  await forEachSequential([0, 1, 2], action);
}

async function balance(did: string, unit: Unit) {
  const rows = await state.db.select().from(balances).where(eq(balances.did, did));
  return rows.find((row) => row.unit === unit)?.amount;
}

describe('fee credit identity', () => {
  const identity = { transactionId: 'tx_payment', role: 'node', recipientDid: 'did:imajin:node' };
  it('is deterministic and scoped to the payment, role, recipient and optional chain position', () => {
    expect(feeCreditKey(identity)).toBe('fee:tx_payment:node:did:imajin:node');
    expect(feeCreditKey({ ...identity })).toBe(feeCreditKey(identity));
    expect(new Set([
      feeCreditKey(identity),
      feeCreditKey({ ...identity, transactionId: 'tx_other' }),
      feeCreditKey({ ...identity, role: 'protocol' }),
      feeCreditKey({ ...identity, recipientDid: 'did:imajin:other' }),
      feeCreditKey({ ...identity, chainIndex: 0 }),
      feeCreditKey({ ...identity, chainIndex: 1 }),
    ]).size).toBe(6);
  });
});

describe('fee wallet effects through webhook helpers', () => {
  it.each([
    { role: 'processor_rebate', actualFeeCents: 280, delta: '0.40000000' },
    { role: 'processor_surcharge', actualFeeCents: 360, delta: '-0.40000000' },
  ])('$role replayed 3× makes one MJNx delta and one claim, without introducing a rollup', async ({ role, actualFeeCents, delta }) => {
    const sellerDid = `did:imajin:${role}`;
    const tx = { id: `tx_${role}`, service: 'market' };
    const params = {
      tx, manifest: { chain: [{ did: sellerDid, role: 'seller', share: 1 }] },
      actualFeeCents, estimatedFeeCents: 320, currency: 'CAD',
    };
    const credit = vi.spyOn(ledger, 'creditUnit');
    await threeTimes(() => reconcileStripeFee(params));
    expect(credit).toHaveBeenCalledTimes(1);
    credit.mockRestore();
    expect(await balance(sellerDid, 'MJNx')).toBe(delta);
    const rows = await state.db.select().from(transactions).where(eq(transactions.toDid, sellerDid));
    const key = feeCreditKey({ transactionId: tx.id, role, recipientDid: sellerDid });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      unit: 'MJNx', amount: delta, currency: 'CAD', sourceKind: 'fee', status: 'completed',
      idempotencyKey: key, metadata: { role, transactionId: tx.id, feeCreditKey: key },
    });
    expect(await state.db.select().from(balanceRollups).where(eq(balanceRollups.did, sellerDid))).toEqual([]);
  });

  it('replayed chain credits MJN/MJNx and rolls up each non-seller exactly once', async () => {
    const tx = { id: 'tx_chain', service: 'market' };
    const chain = [
      { did: 'did:imajin:chain-seller', role: 'seller', share: 0.9 },
      { did: 'did:imajin:chain-node', role: 'node', share: 0.07 },
      { did: 'BUYER_PLACEHOLDER', role: 'buyer_credit', share: 0.03 },
    ];
    const credit = vi.spyOn(ledger, 'creditUnit');
    await threeTimes(() => processChainDistribution({
      tx, totalAmountCents: 10000, currency: 'CAD', buyerDid: 'did:imajin:chain-buyer', chain,
    }));
    expect(credit).toHaveBeenCalledTimes(2);
    credit.mockRestore();
    expect(await balance('did:imajin:chain-node', 'MJN')).toBe('7.00000000');
    expect(await balance('did:imajin:chain-buyer', 'MJNx')).toBe('3.00000000');
    for (const [did, earned, index, role] of [
      ['did:imajin:chain-node', '7.00000000', 1, 'node'],
      ['did:imajin:chain-buyer', '3.00000000', 2, 'buyer_credit'],
    ] as const) {
      const rows = await state.db.select().from(transactions).where(eq(transactions.toDid, did));
      expect(rows).toHaveLength(1);
      expect(rows[0].idempotencyKey).toBe(feeCreditKey({ transactionId: tx.id, role, recipientDid: did, chainIndex: index }));
      expect(await state.db.select().from(balanceRollups).where(eq(balanceRollups.did, did))).toEqual([
        expect.objectContaining({ earned, spent: '0.00000000', txCount: 1 }),
      ]);
    }
  });

  it('keeps both repeated role/DID entries using their absolute manifest indexes', async () => {
    const did = 'did:imajin:repeated-node';
    const chain = [
      { did, role: 'node', share: 0.03 },
      { did, role: 'node', share: 0.02 },
    ];
    await threeTimes(() => processChainDistribution({
      tx: { id: 'tx_repeated' }, totalAmountCents: 10000, currency: 'CAD', buyerDid: null, chain,
    }));
    expect(await balance(did, 'MJN')).toBe('5.00000000');
    const rows = await state.db.select().from(transactions).where(eq(transactions.toDid, did));
    expect(rows.map((row) => row.idempotencyKey).sort()).toEqual([
      'fee:tx_repeated:node:did:imajin:repeated-node:0',
      'fee:tx_repeated:node:did:imajin:repeated-node:1',
    ]);
    expect(await state.db.select().from(balanceRollups).where(eq(balanceRollups.did, did))).toEqual([
      expect.objectContaining({ earned: '5.00000000', txCount: 2, service: 'unknown' }),
    ]);
  });

  it('seller and unresolved entries never claim, credit or roll up', async () => {
    await threeTimes(() => processChainDistribution({
      tx: { id: 'tx_skips' }, totalAmountCents: 10000, currency: 'CAD', buyerDid: null,
      chain: [
        { did: 'did:imajin:skip-seller', role: 'seller', share: 0.9 },
        { did: 'BUYER_PLACEHOLDER', role: 'buyer_credit', share: 0.1 },
      ],
    }));
    for (const did of ['did:imajin:skip-seller', 'unresolved']) {
      expect(await state.db.select().from(transactions).where(eq(transactions.toDid, did))).toEqual([]);
      expect(await state.db.select().from(balances).where(eq(balances.did, did))).toEqual([]);
      expect(await state.db.select().from(balanceRollups).where(eq(balanceRollups.did, did))).toEqual([]);
    }
  });
});

describe('real transaction atomicity', () => {
  it('rolls back a claim when credit fails, then applies the next attempt once', async () => {
    const recipientDid = 'did:imajin:credit-failure';
    const params = { transactionId: 'tx_credit_failure', role: 'node', recipientDid, amountCents: 100, currency: 'CAD', unit: 'MJN' as const, rollup: true };
    const credit = vi.spyOn(ledger, 'creditUnit').mockRejectedValueOnce(new Error('injected after claim'));
    await expect(applyFeeCredit(params)).rejects.toThrow('injected after claim');
    credit.mockRestore();
    expect(await state.db.select().from(transactions).where(eq(transactions.toDid, recipientDid))).toEqual([]);
    expect(await balance(recipientDid, 'MJN')).toBeUndefined();
    await threeTimes(() => applyFeeCredit(params));
    expect(await balance(recipientDid, 'MJN')).toBe('1.00000000');
    expect(await state.db.select().from(transactions).where(eq(transactions.toDid, recipientDid))).toHaveLength(1);
    expect(await state.db.select().from(balanceRollups).where(eq(balanceRollups.did, recipientDid))).toEqual([
      expect.objectContaining({ earned: '1.00000000', txCount: 1 }),
    ]);
  });

  it('a rollup failure rolls back the already-written wallet and claim; webhook retry finishes exactly once', async () => {
    const recipientDid = 'did:imajin:rollup-failure';
    const params = {
      tx: { id: 'tx_rollup_failure' }, totalAmountCents: 10000, currency: 'CAD', buyerDid: null,
      chain: [{ did: recipientDid, role: 'node', share: 0.01 }],
    };
    await harness.client.exec(`
      CREATE FUNCTION pay.reject_rollup() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected rollup failure'; END $$;
      CREATE TRIGGER reject_rollup BEFORE INSERT ON pay.balance_rollups
      FOR EACH ROW EXECUTE FUNCTION pay.reject_rollup();
    `);
    try {
      await expect(processChainDistribution(params)).rejects.toThrow();
      expect(await state.db.select().from(transactions).where(eq(transactions.toDid, recipientDid))).toEqual([]);
      expect(await balance(recipientDid, 'MJN')).toBeUndefined();
      expect(await state.db.select().from(balanceRollups).where(eq(balanceRollups.did, recipientDid))).toEqual([]);
    } finally {
      await harness.client.exec('DROP TRIGGER reject_rollup ON pay.balance_rollups; DROP FUNCTION pay.reject_rollup();');
    }
    await threeTimes(() => processChainDistribution(params));
    expect(await balance(recipientDid, 'MJN')).toBe('1.00000000');
    expect(await state.db.select().from(transactions).where(eq(transactions.toDid, recipientDid))).toHaveLength(1);
    expect(await state.db.select().from(balanceRollups).where(eq(balanceRollups.did, recipientDid))).toEqual([
      expect.objectContaining({ earned: '1.00000000', txCount: 1 }),
    ]);
  });

  it('simultaneous attempts and direct receipt replay use the same durable claim', async () => {
    const params = {
      transactionId: 'tx_concurrent', role: 'node', recipientDid: 'did:imajin:concurrent',
      amountCents: 250, currency: 'CAD', unit: 'MJN' as const, chainIndex: 0, rollup: true,
    };
    await Promise.all([applyFeeCredit(params), applyFeeCredit(params), applyFeeCredit(params)]);
    await processChainDistribution({
      tx: { id: params.transactionId }, totalAmountCents: 10000, currency: 'CAD', buyerDid: null,
      chain: [{ did: params.recipientDid, role: 'node', share: 0.025 }],
    });
    expect(await balance(params.recipientDid, 'MJN')).toBe('2.50000000');
    expect(await state.db.select().from(transactions).where(eq(transactions.toDid, params.recipientDid))).toHaveLength(1);
    expect(await state.db.select().from(balanceRollups).where(eq(balanceRollups.did, params.recipientDid))).toEqual([
      expect.objectContaining({ earned: '2.50000000', txCount: 1 }),
    ]);
  });
});

describe('fee provenance migration', () => {
  it('can be applied twice, preserves every prior kind, allows fee and still rejects unknown provenance', async () => {
    await harness.client.exec(feeMigration);
    await forEachSequential(['receipt', 'emission', 'transfer', 'fee'], async (sourceKind) => {
      await state.db.insert(transactions).values({
        id: `tx_migration_${sourceKind}`, service: 'pay', type: 'probe',
        toDid: 'did:imajin:migration', amount: '0', sourceKind,
      });
    });
    await expect(state.db.insert(transactions).values({
      id: 'tx_migration_invalid', service: 'pay', type: 'probe',
      toDid: 'did:imajin:migration', amount: '0', sourceKind: 'invalid',
    })).rejects.toThrow();
  });
});
