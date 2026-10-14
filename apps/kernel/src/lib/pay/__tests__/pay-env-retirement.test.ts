import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const h = vi.hoisted(() => ({ construct: vi.fn() }));
vi.mock('@/src/lib/pay', () => ({ PaymentService: class { constructor(config: unknown) { h.construct(config); } } }));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllEnvs());

describe('legacy payment service env retirement', () => {
  it('does not list retired credentials in the kernel check-env manifest', () => {
    const manifest = readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8');
    expect(manifest).not.toMatch(/STRIPE_(?:SECRET_KEY|PUBLISHABLE_KEY|WEBHOOK_SECRET)/);
  });
  it('does not register a fiat provider even with all obsolete env credentials set', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fake_ignored');
    vi.stubEnv('STRIPE_PUBLISHABLE_KEY', 'pk_test_fake_ignored');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test_fake_ignored');
    vi.stubEnv('SOLANA_RPC_URL', undefined);
    const { getPaymentService, getStripePublishableKey } = await import('../pay');
    expect(() => getPaymentService()).toThrow('Cards require a DID-bound sealed connector');
    expect(getStripePublishableKey()).toBeUndefined();
    expect(h.construct).not.toHaveBeenCalled();
  });

  it('configures only the independent Solana provider', async () => {
    vi.stubEnv('SOLANA_RPC_URL', 'https://rpc.test.invalid');
    const { getPaymentService } = await import('../pay');
    const first = getPaymentService();
    expect(getPaymentService()).toBe(first);
    expect(h.construct).toHaveBeenCalledOnce();
    expect(h.construct).toHaveBeenCalledWith({
      providers: { solana: { rpcUrl: 'https://rpc.test.invalid' } },
    });
  });
});
