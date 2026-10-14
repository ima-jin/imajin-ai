import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  nodeDid: vi.fn(),
  rail: vi.fn(),
  status: vi.fn(),
  unseal: vi.fn(),
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDidFromConfig: h.nodeDid }));
vi.mock('../../payment-requests/card-rail', () => ({ resolveCardRail: h.rail }));
vi.mock('@/src/lib/stripe/connector-core', () => ({
  stripePublishableKeyField: (did: string) => `stripe-publishable-key:${did}`,
  stripeWebhookSecretField: (did: string) => `stripe-webhook-secret:${did}`,
}));
vi.mock('@/src/lib/vault', () => ({ vaultFieldStatus: h.status, loadAndUnseal: h.unseal }));

import { isNodeCardRailConfigured } from '../node-card-rail';

beforeEach(() => {
  vi.clearAllMocks();
  h.nodeDid.mockResolvedValue('did:imajin:node');
  h.rail.mockResolvedValue({ kind: 'connector', ownerDid: 'did:imajin:node' });
  h.status.mockResolvedValue('ready');
});
afterEach(() => vi.unstubAllEnvs());

describe('node card availability', () => {
  it('uses only configured node identity and ready sealed metadata, without unsealing', async () => {
    expect(await isNodeCardRailConfigured()).toBe(true);
    expect(h.rail).toHaveBeenCalledWith('did:imajin:node');
    expect(h.status.mock.calls).toEqual([
      ['stripe-publishable-key:did:imajin:node'],
      ['stripe-webhook-secret:did:imajin:node'],
    ]);
    expect(h.unseal).not.toHaveBeenCalled();
  });

  it('does not substitute relay identity or env credentials for missing node configuration', async () => {
    vi.stubEnv('RELAY_DID', 'did:imajin:relay');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fake_ignored');
    h.nodeDid.mockResolvedValue('');
    expect(await isNodeCardRailConfigured()).toBe(false);
    expect(h.rail).not.toHaveBeenCalled();
    expect(h.status).not.toHaveBeenCalled();
  });

  it('does not advertise a missing, pending or revoked key/events grant', async () => {
    h.rail.mockResolvedValue({ kind: 'none' });
    expect(await isNodeCardRailConfigured()).toBe(false);
    expect(h.status).not.toHaveBeenCalled();
  });

  it.each([
    ['stripe-publishable-key', 'absent'],
    ['stripe-publishable-key', 'pending-grant'],
    ['stripe-webhook-secret', 'absent'],
    ['stripe-webhook-secret', 'pending-grant'],
  ])('rejects %s when %s', async (prefix, status) => {
    h.status.mockImplementation(async (field: string) => field.startsWith(prefix) ? status : 'ready');
    expect(await isNodeCardRailConfigured()).toBe(false);
    expect(h.unseal).not.toHaveBeenCalled();
  });

  it('rechecks readiness after connector revocation instead of caching', async () => {
    expect(await isNodeCardRailConfigured()).toBe(true);
    h.rail.mockResolvedValue({ kind: 'none' });
    expect(await isNodeCardRailConfigured()).toBe(false);
    expect(h.rail).toHaveBeenCalledTimes(2);
  });

  it.each(['identity', 'rail', 'vault'])('fails closed on %s lookup failure without returning diagnostics', async stage => {
    const failure = new Error('test-only-private-diagnostic');
    if (stage === 'identity') h.nodeDid.mockRejectedValue(failure);
    if (stage === 'rail') h.rail.mockRejectedValue(failure);
    if (stage === 'vault') h.status.mockRejectedValue(failure);
    expect(await isNodeCardRailConfigured()).toBe(false);
  });
});
