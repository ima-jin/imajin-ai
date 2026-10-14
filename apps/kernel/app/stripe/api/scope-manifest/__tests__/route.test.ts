import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  owner: vi.fn(), find: vi.fn(), scopes: vi.fn(), publish: vi.fn(),
  keySealed: vi.fn(), keyPending: vi.fn(), publishableKeySealed: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn() }) }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: () => new Response(null, { status: 204 }) }));
vi.mock('@/src/lib/kernel/connector-owner-did', () => ({ resolveConnectorOwnerDid: mocks.owner }));
vi.mock('@/src/lib/stripe/connector', () => ({ publishableKeySealed: mocks.publishableKeySealed }));
vi.mock('@/src/lib/stripe/scope-manifest', () => ({
  publishStripeScopeManifest: mocks.publish,
  readActiveStripeScopes: mocks.scopes,
  findStripeManifestAsset: mocks.find,
  stripeKeySealed: mocks.keySealed,
  stripeKeyPending: mocks.keyPending,
  VALID_STRIPE_SCOPES: ['stripe:events'],
}));

import { GET } from '../route';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.owner.mockResolvedValue({ ok: true, ownerDid: 'did:imajin:fake-owner' });
  mocks.find.mockResolvedValue(null);
  mocks.scopes.mockResolvedValue(['stripe:events']);
  mocks.keySealed.mockResolvedValue(true);
  mocks.keyPending.mockResolvedValue(false);
  mocks.publishableKeySealed.mockResolvedValue(false);
});

describe('GET /stripe/api/scope-manifest', () => {
  it.each([true, false])('includes publishableKeySealed=%s for the resolved owner without key values', async (sealed) => {
    mocks.publishableKeySealed.mockResolvedValue(sealed);
    const response = await GET(new NextRequest('https://kernel.test/stripe/api/scope-manifest'));
    expect(await response.json()).toEqual({
      manifestAssetId: null, activeScopes: ['stripe:events'], validScopes: ['stripe:events'],
      keySealed: true, credentialPending: false, publishableKeySealed: sealed,
    });
    expect(mocks.publishableKeySealed).toHaveBeenCalledWith('did:imajin:fake-owner');
    expect(mocks.keySealed).toHaveBeenCalledWith('did:imajin:fake-owner');
    expect(mocks.keyPending).toHaveBeenCalledWith('did:imajin:fake-owner');
  });

  it('denies unauthenticated GET without probing credentials', async () => {
    mocks.owner.mockResolvedValue({ ok: false, error: 'Unauthorized', status: 401 });
    const response = await GET(new NextRequest('https://kernel.test/stripe/api/scope-manifest'));
    expect(response.status).toBe(401);
    expect(mocks.publishableKeySealed).not.toHaveBeenCalled();
    expect(mocks.find).not.toHaveBeenCalled();
  });
});
