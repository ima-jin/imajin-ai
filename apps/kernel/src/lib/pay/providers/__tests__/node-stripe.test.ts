import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const h = vi.hoisted(() => ({ nodeDid: vi.fn(), keys: vi.fn(), construct: vi.fn() }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDidFromConfig: h.nodeDid }));
vi.mock('../../rails/stripe-keys', () => ({
  resolveDidStripeKeys: h.keys,
  SellerNoCardRailError: class extends Error {},
}));
vi.mock('stripe', () => ({ default: class { constructor(key: string) { h.construct(key); } } }));
import { getNodeStripeClient, NodeCardRailNotConfiguredError } from '../node-stripe';
import { SellerNoCardRailError } from '../../rails/stripe-keys';

beforeEach(() => {
  vi.clearAllMocks();
  h.nodeDid.mockResolvedValue('did:imajin:node');
  h.keys.mockResolvedValue({ secretKey: 'sk_test_fake', publishableKey: undefined });
});
afterEach(() => vi.unstubAllEnvs());

describe('node Stripe adapter', () => {
  it('does not resolve or construct a client at module import or rail construction', async () => {
    const { StripeWithdrawRail } = await import('../stripe-withdraw-rail');
    expect(new StripeWithdrawRail().name).toBe('stripe');
    expect(h.nodeDid).not.toHaveBeenCalled();
    expect(h.keys).not.toHaveBeenCalled();
    expect(h.construct).not.toHaveBeenCalled();
  });

  it.each([undefined, 'sk_test_fake_ignored'])('uses the node sealed key regardless of env presence (%s)', async (env) => {
    vi.stubEnv('STRIPE_SECRET_KEY', env);
    expect(await getNodeStripeClient()).toMatchObject({ nodeDid: 'did:imajin:node' });
    expect(h.keys).toHaveBeenCalledWith('did:imajin:node');
    expect(h.construct).toHaveBeenCalledWith('sk_test_fake');
  });

  it('does not cache credentials after connector revocation', async () => {
    await getNodeStripeClient();
    h.keys.mockRejectedValue(new SellerNoCardRailError());
    await expect(getNodeStripeClient()).rejects.toBeInstanceOf(NodeCardRailNotConfiguredError);
    expect(h.keys).toHaveBeenCalledTimes(2);
    expect(h.construct).toHaveBeenCalledTimes(1);
  });

  it('fails clearly without a node identity, before looking up a connector', async () => {
    h.nodeDid.mockResolvedValue('');
    await expect(getNodeStripeClient()).rejects.toMatchObject({ code: 'NODE_CARD_RAIL_NOT_CONFIGURED' });
    expect(h.keys).not.toHaveBeenCalled();
  });

  it('does not hide unexpected vault errors or try another key', async () => {
    h.keys.mockRejectedValue(new Error('vault unavailable'));
    await expect(getNodeStripeClient()).rejects.toThrow('vault unavailable');
    expect(h.construct).not.toHaveBeenCalled();
  });

  it('has no credential env read or legacy client dependency anywhere in the node paths', () => {
    for (const path of [
      '../node-stripe.ts',
      '../stripe-withdraw-rail.ts',
      '../../rails/stripe-keys.ts',
      '../../../../../app/pay/api/topup/stripe/route.ts',
    ]) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(source).not.toMatch(/process\.env/);
      expect(source).not.toContain("from './stripe-client'");
      expect(source).not.toContain('getPaymentService');
    }
  });
});
