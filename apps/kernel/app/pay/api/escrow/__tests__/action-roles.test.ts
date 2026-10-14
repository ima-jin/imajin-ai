import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ auth: vi.fn(), appAuth: vi.fn(), find: vi.fn(), keys: vi.fn(), update: vi.fn(), mark: vi.fn() }));
vi.mock('@imajin/logger', () => ({
  withLogger: (_name: string, handler: (request: NextRequest, context: unknown) => unknown) =>
    (request: NextRequest) => handler(request, { log: { error: vi.fn() } }),
}));
vi.mock('@imajin/auth', () => ({
  requireAuth: h.auth, requireAppAuth: h.appAuth, resolveEffectiveDid: vi.fn(),
  resolveActingDid: (identity: { id: string }) => identity.id,
}));
vi.mock('@imajin/auth/delegation-policy', () => ({ enforceRoutePolicy: vi.fn() }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: vi.fn() }));
vi.mock('@/src/lib/pay/rails/stripe-keys', () => ({
  resolveDidStripeKeys: h.keys, SellerNoCardRailError: class extends Error {},
}));
vi.mock('@/src/lib/pay/providers/seller-stripe-payments', () => ({
  escrowSeller: vi.fn(), updateSellerEscrow: h.update,
}));
vi.mock('@/src/lib/pay/providers/seller-transactions', () => ({
  findSellerEscrow: h.find, markSellerEscrow: h.mark, persistSellerEscrow: vi.fn(),
}));
vi.mock('@/src/lib/pay/providers/crypto-only', () => ({ getCryptoOnlyProvider: vi.fn() }));

import { PUT } from '../route';

const BUYER = 'did:imajin:buyer';
const SELLER = 'did:imajin:seller';
const ARBITER = 'did:imajin:arbiter';
const OTHER = 'did:imajin:unrelated';
function request(action: unknown, app = false) {
  return new NextRequest('https://kernel.test/pay/api/escrow', {
    method: 'PUT', headers: { 'content-type': 'application/json', ...(app ? { 'x-app-did': 'did:imajin:app' } : {}) },
    body: JSON.stringify({ action, escrowId: 'pi_escrow', provider: 'stripe', toDid: BUYER, fromDid: SELLER, arbiter: OTHER }),
  });
}
function acting(did: string) {
  h.auth.mockResolvedValue({ identity: { id: did } });
  h.appAuth.mockResolvedValue({ appAuth: { userDid: did } });
}
beforeEach(() => {
  vi.clearAllMocks();
  acting(BUYER);
  h.find.mockResolvedValue({
    id: 'tx_escrow', rail: 'stripe-byo', type: 'escrow', fromDid: BUYER, toDid: SELLER,
    metadata: { arbiter_did: ARBITER },
  });
  h.keys.mockResolvedValue({ secretKey: 'rk_test_fake', publishableKey: 'pk_test_fake' });
  h.update.mockImplementation(async (_key: string, _id: string, action: string) => ({
    id: 'pi_escrow', provider: 'stripe', status: action === 'release' ? 'released' : 'refunded',
    amount: 1000, currency: 'CAD', createdAt: new Date(0),
  }));
});

describe('escrow action-specific authorization', () => {
  it.each([
    ['release', BUYER], ['release', ARBITER], ['refund', SELLER], ['refund', ARBITER],
  ])('allows %s by the stored authorized party %s', async (action, did) => {
    acting(did);
    const response = await PUT(request(action));
    expect(response.status).toBe(200);
    expect(h.keys).toHaveBeenCalledWith(SELLER);
    expect(h.update).toHaveBeenCalledWith('rk_test_fake', 'pi_escrow', action);
    expect(h.mark).toHaveBeenCalledWith('tx_escrow', action === 'release' ? 'released' : 'refunded');
  });
  it.each([
    ['release', SELLER], ['refund', BUYER], ['release', OTHER], ['refund', OTHER],
  ])('refuses %s by %s before key access or side effects', async (action, did) => {
    acting(did);
    const response = await PUT(request(action));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'ESCROW_ACTION_FORBIDDEN' });
    expect(h.keys).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled(); expect(h.mark).not.toHaveBeenCalled();
  });
  it.each([['release', SELLER], ['refund', BUYER]])('applies the same refusal to delegated app users for %s', async (action, did) => {
    acting(did);
    expect((await PUT(request(action, true))).status).toBe(403);
    expect(h.keys).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
  });
  it('does not invent an arbiter when the stored field is absent', async () => {
    h.find.mockResolvedValue({ id: 'tx_escrow', rail: 'stripe-byo', fromDid: BUYER, toDid: SELLER, metadata: {} });
    acting(ARBITER);
    expect((await PUT(request('release'))).status).toBe(403);
    expect(h.keys).not.toHaveBeenCalled();
  });
  it.each([undefined, null, '', 'capture', 'cancel', 12])('rejects unsupported action %j instead of defaulting to capture', async (action) => {
    expect((await PUT(request(action))).status).toBe(400);
    expect(h.find).not.toHaveBeenCalled(); expect(h.keys).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
  });
});
