import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
const m = vi.hoisted(() => ({
  keys: vi.fn(), charge: vi.fn(), escrow: vi.fn(), update: vi.fn(), persistCharge: vi.fn(), persistEscrow: vi.fn(),
  find: vi.fn(), mark: vi.fn(), cryptoCharge: vi.fn(), cryptoEscrow: vi.fn(),
  auth: vi.fn(), appAuth: vi.fn(), effective: vi.fn(), policy: vi.fn(), log: vi.fn(),
}));
vi.mock('@imajin/logger', () => ({ withLogger: (_: string, fn: Function) => (req: Request) => fn(req, { log: { error: m.log } }) }));
vi.mock('@imajin/auth', () => ({
  requireAuth: m.auth, requireAppAuth: m.appAuth, resolveEffectiveDid: m.effective,
  resolveActingDid: (identity: { did: string }) => identity.did,
}));
vi.mock('@imajin/auth/delegation-policy', () => ({ enforceRoutePolicy: m.policy }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: vi.fn() }));
vi.mock('@/src/lib/pay/rails/stripe-keys', () => ({
  resolveDidStripeKeys: m.keys,
  SellerNoCardRailError: class extends Error { code = 'SELLER_NO_CARD_RAIL'; constructor() { super('Seller has no card rail'); } },
}));
vi.mock('@/src/lib/pay/providers/seller-stripe-payments', () => ({ chargeSeller: m.charge, escrowSeller: m.escrow, updateSellerEscrow: m.update }));
vi.mock('@/src/lib/pay/providers/seller-transactions', () => ({
  persistSellerCharge: m.persistCharge, persistSellerEscrow: m.persistEscrow, findSellerEscrow: m.find, markSellerEscrow: m.mark,
}));
vi.mock('@/src/lib/pay/providers/crypto-only', () => ({ getCryptoOnlyProvider: () => ({ charge: m.cryptoCharge, escrow: m.cryptoEscrow }) }));
vi.mock('@/src/lib/pay/pay', () => { throw new Error('Platform service must not be imported'); });
import { SellerNoCardRailError } from '@/src/lib/pay/rails/stripe-keys';
import { POST as charge } from '../route';
import { POST as escrow, PUT as update } from '../../escrow/route';

const result = { id: 'pi_test_fake', provider: 'stripe', status: 'held', amount: 123, currency: 'CAD', from: 'did:test:buyer', to: 'did:test:seller', createdAt: new Date(0), clientSecret: 'fake-secret' };
const req = (body: unknown, app = false) => new NextRequest('http://localhost/pay/api/charge', {
  method: 'POST', body: JSON.stringify(body), headers: app ? { 'x-app-did': 'did:test:app' } : {},
});
const chargeBody = { amount: 123, currency: 'CAD', to: { did: 'did:test:seller' } };
const escrowBody = { amount: 123, currency: 'CAD', from: 'did:test:buyer', to: 'did:test:seller' };
beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ identity: { did: 'did:test:buyer' } });
  m.appAuth.mockResolvedValue({ appAuth: { userDid: 'did:test:buyer' } });
  m.effective.mockResolvedValue({ ok: true, effectiveDid: 'did:test:buyer' });
  m.keys.mockResolvedValue({ secretKey: 'sk_test_obvious_seller_fake', publishableKey: 'pk_test_obvious_seller_fake' });
  m.charge.mockResolvedValue(result); m.escrow.mockResolvedValue(result); m.update.mockResolvedValue({ ...result, status: 'released' });
  m.cryptoCharge.mockResolvedValue({ ...result, provider: 'solana' });
  m.find.mockResolvedValue({ id: 'tx_test', type: 'escrow', rail: 'stripe-byo', toDid: 'did:test:seller', fromDid: 'did:test:buyer', metadata: { arbiter_did: 'did:test:arbiter' } });
});
describe('seller routes', () => {
  it('owned paths have no platform key or payment-service fallback imports/reads', () => {
    for (const path of [
      '../route.ts', '../../escrow/route.ts',
      '../../../../../src/lib/pay/providers/seller-stripe-payments.ts',
      '../../../../../src/lib/pay/providers/seller-transactions.ts',
      '../../../../../src/lib/pay/providers/crypto-only.ts',
    ]) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(source).not.toMatch(/process\.env\.STRIPE_(SECRET|PUBLISHABLE)_KEY/);
      expect(source).not.toMatch(/\b(getPaymentService|getStripeClient)\s*\(/);
    }
  });
  it.each([charge, escrow, update])('does not disclose or log SDK error key material', async (handler) => {
    const error = new Error('obvious-fake-sensitive-error');
    if (handler === charge) m.charge.mockRejectedValue(error);
    else if (handler === escrow) m.escrow.mockRejectedValue(error);
    else m.update.mockRejectedValue(error);
    const body = handler === charge ? chargeBody : handler === escrow ? escrowBody : { escrowId: result.id, provider: 'stripe' };
    const response = await handler(req(body));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(error.message);
    expect(JSON.stringify(m.log.mock.calls)).not.toContain(error.message);
  });
  it.each([charge, escrow])('returns same-connector key and secret and persists ownership', async (handler) => {
    const response = await handler(req(handler === charge ? chargeBody : escrowBody));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ clientSecret: 'fake-secret', publishableKey: 'pk_test_obvious_seller_fake' });
    expect(m.keys).toHaveBeenCalledWith('did:test:seller');
    expect(handler === charge ? m.persistCharge : m.persistEscrow).toHaveBeenCalled();
  });
  it.each([charge, escrow])('does not create an unconfirmable intent when seller publishable key is absent', async (handler) => {
    m.keys.mockResolvedValue({ secretKey: 'sk_test_fake', publishableKey: undefined });
    expect((await handler(req(handler === charge ? chargeBody : escrowBody))).status).toBe(400);
    expect(m.charge).not.toHaveBeenCalled(); expect(m.escrow).not.toHaveBeenCalled();
  });
  it.each([charge, escrow])('missing sealed key fails closed with no platform fallback', async (handler) => {
    m.keys.mockRejectedValue(new SellerNoCardRailError());
    const response = await handler(req(handler === charge ? chargeBody : escrowBody));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'SELLER_NO_CARD_RAIL' });
    expect(m.charge).not.toHaveBeenCalled(); expect(m.escrow).not.toHaveBeenCalled();
  });
  it('requires seller for customer-only charge and supports explicit sellerDid', async () => {
    expect((await charge(req({ ...chargeBody, to: { customerId: 'cus_fake' } }))).status).toBe(400);
    expect((await charge(req({ ...chargeBody, sellerDid: 'did:test:seller', to: { customerId: 'cus_fake' } }))).status).toBe(200);
    expect(m.charge).toHaveBeenCalledWith('sk_test_obvious_seller_fake', 'did:test:seller', expect.objectContaining({ to: { stripeCustomerId: 'cus_fake' } }));
  });
  it('to.did wins over a caller sellerDid', async () => {
    await charge(req({ ...chargeBody, sellerDid: 'did:test:spoof' }));
    expect(m.keys).toHaveBeenCalledWith('did:test:seller');
  });
  it('keeps crypto charge outside card resolution', async () => {
    expect((await charge(req({ amount: 123, currency: 'SOL', to: { solanaAddress: 'fake-address' } }))).status).toBe(200);
    expect(m.keys).not.toHaveBeenCalled(); expect(m.cryptoCharge).toHaveBeenCalled();
  });
  it('preserves crypto escrow unsupported result without card initialization', async () => {
    m.cryptoEscrow.mockRejectedValue(new Error('Solana escrow not yet implemented'));
    expect((await escrow(req({ ...escrowBody, currency: 'SOL' }))).status).toBe(500);
    expect(m.keys).not.toHaveBeenCalled();
  });
  it.each(['release', 'refund'])('escrow %s resolves persisted seller, ignores body DID', async (action) => {
    const response = await update(req({ escrowId: result.id, provider: 'stripe', action, to: 'did:test:spoof' }));
    expect(response.status).toBe(200);
    expect(m.keys).toHaveBeenCalledWith('did:test:seller');
    expect(m.update).toHaveBeenCalledWith('sk_test_obvious_seller_fake', result.id, action);
    expect(m.mark).toHaveBeenCalled();
  });
  it.each([undefined, { rail: 'stripe', toDid: 'did:test:seller' }])('rejects legacy/unowned escrow with clear logged error', async (row) => {
    m.find.mockResolvedValue(row);
    const response = await update(req({ escrowId: result.id, provider: 'stripe', action: 'refund' }));
    expect(response.status).toBe(422); expect(m.log).toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ code: 'LEGACY_ESCROW_UNSUPPORTED' });
    expect(m.keys).not.toHaveBeenCalled(); expect(m.update).not.toHaveBeenCalled();
  });
  it('forbids unrelated authenticated callers and app users', async () => {
    m.auth.mockResolvedValue({ identity: { did: 'did:test:outsider' } });
    m.appAuth.mockResolvedValue({ appAuth: { userDid: 'did:test:outsider' } });
    for (const app of [false, true]) expect((await update(req({ escrowId: result.id, provider: 'stripe' }, app))).status).toBe(403);
    expect(m.keys).not.toHaveBeenCalled();
  });
  it('allows stored arbiter and fails closed if stored seller loses keys', async () => {
    m.auth.mockResolvedValue({ identity: { did: 'did:test:arbiter' } });
    m.keys.mockRejectedValue(new SellerNoCardRailError());
    expect((await update(req({ escrowId: result.id, provider: 'stripe' }))).status).toBe(400);
    expect(m.update).not.toHaveBeenCalled();
  });
  it('preserves depositor authentication', async () => {
    expect((await escrow(req({ ...escrowBody, from: 'did:test:spoof' }))).status).toBe(403);
    m.effective.mockResolvedValue({ ok: false, error: 'Unauthorized', status: 401 });
    expect((await escrow(req(escrowBody))).status).toBe(401);
    m.auth.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await update(req({ escrowId: result.id, provider: 'stripe' }))).status).toBe(401);
    expect(m.keys).not.toHaveBeenCalled();
  });
});
