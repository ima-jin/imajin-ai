import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { PgliteLedgerHarness } from './pglite-pay-harness';

const h = vi.hoisted(() => ({ select: vi.fn(), keys: vi.fn(), session: vi.fn() }));
vi.mock('@/src/db', async () => ({
  db: { select: h.select },
  ...(await import('@/src/db/schemas/pay')),
}));
vi.mock('../rails/stripe-keys', () => ({ resolveDidStripeKeys: h.keys }));
vi.mock('../providers/seller-pledge-refund', () => ({
  sellerSessionPaymentIntent: h.session, sellerPledgeRefundClient: vi.fn(),
}));

import { transactions } from '@/src/db/schemas/pay';
import { resolveOriginalTransaction } from '../refund';
import { createPgliteLedgerHarness } from './pglite-pay-harness';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const APP = 'did:imajin:fake-app';
const SELLER = 'did:imajin:fake-seller';
const log = { error: vi.fn() };
let harness: PgliteLedgerHarness;

beforeAll(async () => {
  harness = await createPgliteLedgerHarness();
  // The shared balance harness omits the later emission provenance migration;
  // replay only its existing transaction-column DDL, not its unrelated bus seed.
  const emissionMigration = readFileSync(
    new URL('../../../../../../migrations/archive/pre-kernel-baseline/0170_emission_config.sql', import.meta.url), 'utf8',
  );
  const transactionColumns = emissionMigration.match(/ALTER TABLE pay\.transactions[\s\S]*?;/)?.[0];
  if (!transactionColumns) throw new Error('Existing transaction-column migration was not found');
  await harness.client.exec(transactionColumns);
  h.select.mockImplementation(() => harness.connA.select());
});
afterAll(async () => { await harness.close(); });
beforeEach(async () => {
  await harness.client.exec('TRUNCATE pay.transactions');
  h.keys.mockReset().mockResolvedValue({ secretKey: 'rk_test_fake' });
  h.session.mockReset().mockResolvedValue('pi_other');
  log.error.mockClear();
});

async function seed(id: string, extra: Partial<typeof transactions.$inferInsert> = {}) {
  await harness.connA.insert(transactions).values({
    id, service: 'events', type: 'checkout', toDid: SELLER, amount: '10.00',
    appDid: APP, rail: 'stripe-byo', externalRef: `cs_${id}`, status: 'completed',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...extra,
  });
}

describe('refund lookup against real Postgres predicates', () => {
  it.each(['completed', 'partially_refunded'])('uses a provenance-marked %s settlement without any Stripe calls', async (status) => {
    await seed('verified', { status, settledAt: new Date(), metadata: { settledPaymentIntentId: 'pi_verified' } });
    const match = await resolveOriginalTransaction('pi_verified', log, APP);
    expect(match?.id).toBe('verified');
    expect(h.keys).not.toHaveBeenCalled();
    expect(h.session).not.toHaveBeenCalled();
  });

  it('does not trust caller-forged PI metadata without the first-class settlement marker', async () => {
    await seed('forged', { metadata: { settledPaymentIntentId: 'pi_forged' } });
    expect(await resolveOriginalTransaction('pi_forged', log, APP)).toBeUndefined();
    expect(h.session).toHaveBeenCalledWith('rk_test_fake', 'cs_forged');
  });

  it('does not return another app settlement or query that app seller', async () => {
    await seed('other_app', {
      appDid: 'did:imajin:other-app', settledAt: new Date(),
      metadata: { settledPaymentIntentId: 'pi_other_app' },
    });
    expect(await resolveOriginalTransaction('pi_other_app', log, APP)).toBeUndefined();
    expect(h.keys).not.toHaveBeenCalled();
    expect(h.session).not.toHaveBeenCalled();
  });

  it.each(['pending', 'failed', 'refunded'])('excludes %s settled metadata and legacy sessions', async (status) => {
    await seed(`ineligible_${status}`, { status, settledAt: new Date(), metadata: { settledPaymentIntentId: 'pi_target' } });
    expect(await resolveOriginalTransaction('pi_target', log, APP)).toBeUndefined();
    expect(h.keys).not.toHaveBeenCalled();
    expect(h.session).not.toHaveBeenCalled();
  });

  it('filters fallback rows by authenticated app, seller rail and the literal cs_ prefix', async () => {
    await seed('other_app', { appDid: 'did:imajin:other-app' });
    await seed('platform', { rail: 'stripe' });
    await seed('not_session', { externalRef: 'csX_not_a_session' });
    await seed('no_ref', { externalRef: null });
    await seed('valid', { status: 'partially_refunded' });
    h.session.mockResolvedValue('pi_target');
    expect((await resolveOriginalTransaction('pi_target', log, APP))?.id).toBe('valid');
    expect(h.keys).toHaveBeenCalledTimes(1);
    expect(h.session.mock.calls).toEqual([['rk_test_fake', 'cs_valid']]);
  });

  it('caps requests at 25 even for an app with many eligible sessions and uses stable ordering', async () => {
    for (let index = 0; index < 30; index++) {
      await seed(`legacy_${String(index).padStart(2, '0')}`);
    }
    expect(await resolveOriginalTransaction('pi_missing', log, APP)).toBeUndefined();
    expect(h.keys).toHaveBeenCalledTimes(25);
    expect(h.session).toHaveBeenCalledTimes(25);
    expect(h.session.mock.calls.map((call) => call[1])).toEqual(
      Array.from({ length: 25 }, (_, index) => `cs_legacy_${String(index).padStart(2, '0')}`),
    );
  });

  it('prioritizes newer sessions before the stable id tie-breaker', async () => {
    await seed('a_old');
    await seed('z_new', { createdAt: new Date('2026-01-02T00:00:00Z') });
    h.session.mockResolvedValue('pi_target');
    expect((await resolveOriginalTransaction('pi_target', log, APP))?.id).toBe('z_new');
    expect(h.session.mock.calls).toEqual([['rk_test_fake', 'cs_z_new']]);
  });

  it('keeps direct-reference cross-app results for the route ownership check without remote lookup', async () => {
    await seed('direct_other_app', { appDid: 'did:imajin:other-app', externalRef: 'pi_direct' });
    expect((await resolveOriginalTransaction('pi_direct', log, APP))?.appDid).toBe('did:imajin:other-app');
    expect(h.keys).not.toHaveBeenCalled();
    expect(h.session).not.toHaveBeenCalled();
  });

  it('continues past a disconnected seller to a later valid matching session', async () => {
    await seed('a_disconnected', { toDid: 'did:imajin:fake-disconnected' });
    await seed('b_matching');
    h.keys.mockRejectedValueOnce(new Error('rk_test_fake_private_upstream'));
    h.session.mockResolvedValue('pi_target');
    expect((await resolveOriginalTransaction('pi_target', log, APP))?.id).toBe('b_matching');
    expect(h.keys).toHaveBeenCalledTimes(2);
    expect(h.session.mock.calls).toEqual([['rk_test_fake', 'cs_b_matching']]);
    expect(log.error).toHaveBeenCalledWith({ transactionId: 'a_disconnected' }, expect.any(String));
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('fake_private_upstream');
  });
});
