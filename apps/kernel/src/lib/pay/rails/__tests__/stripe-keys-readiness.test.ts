import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  status: vi.fn(),
  credentials: vi.fn(),
  unseal: vi.fn(),
}));
vi.mock('@/src/lib/stripe/connector-core', () => ({
  stripe: {
    keySealed: vi.fn().mockResolvedValue(true),
    resolveActiveGrant: vi.fn().mockResolvedValue(true),
    loadSealedCredentials: h.credentials,
  },
  stripeEventsScope: 'stripe:events',
  stripePublishableKeyField: (did: string) => `stripe-publishable-key:${did}`,
  stripeWebhookSecretField: (did: string) => `stripe-webhook-secret:${did}`,
}));
vi.mock('@/src/lib/vault', () => ({
  vaultFieldStatus: h.status,
  loadAndUnseal: h.unseal,
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// The shared rail selector is deliberately real: resolver callers must not
// acquire charge credentials while manual webhook setup is incomplete.
import { resolveDidStripeKeys } from '../stripe-keys';

const DID = 'did:imajin:seller';
beforeEach(() => {
  vi.clearAllMocks();
  h.status.mockResolvedValue('ready');
  h.credentials.mockResolvedValue({ apiKey: 'rk_test_fake' });
  h.unseal.mockResolvedValue('pk_test_fake');
});

describe('DID credential resolution requires complete card readiness', () => {
  it.each(['stripe-publishable-key', 'stripe-webhook-secret'])('refuses incomplete %s setup before decrypting any credentials', async prefix => {
    h.status.mockImplementation(async (field: string) => field.startsWith(prefix) ? 'absent' : 'ready');
    await expect(resolveDidStripeKeys(DID)).rejects.toMatchObject({ code: 'SELLER_NO_CARD_RAIL' });
    expect(h.credentials).not.toHaveBeenCalled();
    expect(h.unseal).not.toHaveBeenCalled();
  });

  it('allows a fully ready seller and rechecks before later credential acquisition', async () => {
    expect(await resolveDidStripeKeys(DID)).toEqual({ secretKey: 'rk_test_fake', publishableKey: 'pk_test_fake' });
    expect(h.credentials).toHaveBeenCalledWith(DID);
    expect(h.unseal).toHaveBeenCalledWith(`stripe-publishable-key:${DID}`);
    h.credentials.mockClear();
    h.unseal.mockClear();
    h.status.mockResolvedValue('pending-grant');
    await expect(resolveDidStripeKeys(DID)).rejects.toMatchObject({ code: 'SELLER_NO_CARD_RAIL' });
    expect(h.credentials).not.toHaveBeenCalled();
    expect(h.unseal).not.toHaveBeenCalled();
  });
});
