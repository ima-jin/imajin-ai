import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  webhookStatus: vi.fn(), sealSecret: vi.fn(), resolveOwner: vi.fn(), connect: vi.fn(), keySealed: vi.fn(), publishableKeySealed: vi.fn(), error: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: mocks.error, info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: () => new Response(null, { status: 204 }) }));
vi.mock('@/src/lib/kernel/connector-owner-did', () => ({ resolveConnectorOwnerDid: mocks.resolveOwner }));
vi.mock('@/src/lib/http/public-origin', () => ({ publicOrigin: () => 'https://kernel.test' }));
vi.mock('@/src/lib/stripe/connector', () => ({
  webhookStatus: mocks.webhookStatus, sealWebhookSecret: mocks.sealSecret, connectAndProvisionWebhook: mocks.connect, keySealed: mocks.keySealed, publishableKeySealed: mocks.publishableKeySealed,
}));

import { GET, POST } from '../route';
import { StripeCredentialError } from '@/src/lib/stripe/credential-pair';

function post(body: unknown) {
  return POST(
    new NextRequest('https://kernel.test/stripe/api/token', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveOwner.mockResolvedValue({ ok: true, ownerDid: 'did:imajin:imajin-inc' });
  mocks.keySealed.mockResolvedValue(true);
  mocks.webhookStatus.mockResolvedValue({ webhookSecretSealed: false, routingId: 'stripewh_fake', webhookUrl: 'https://kernel.test/pay/api/webhook/did/stripewh_fake' });
  mocks.publishableKeySealed.mockResolvedValue(false);
});

describe('GET /stripe/api/token', () => {
  it.each([true, false])('reports publishable-key sealed status %s without key material', async (sealed) => {
    mocks.publishableKeySealed.mockResolvedValue(sealed);
    const res = await GET(new NextRequest('https://kernel.test/stripe/api/token'));
    expect(await res.json()).toEqual({ keySealed: true, publishableKeySealed: sealed, webhookSecretSealed: false, routingId: 'stripewh_fake', webhookUrl: 'https://kernel.test/pay/api/webhook/did/stripewh_fake' });
    expect(mocks.keySealed).toHaveBeenCalledWith('did:imajin:imajin-inc');
    expect(mocks.publishableKeySealed).toHaveBeenCalledWith('did:imajin:imajin-inc');
  });

  it('denies unauthenticated GET without checking vault status', async () => {
    mocks.resolveOwner.mockResolvedValue({ ok: false, error: 'Unauthorized', status: 401 });
    expect((await GET(new NextRequest('https://kernel.test/stripe/api/token'))).status).toBe(401);
    expect(mocks.keySealed).not.toHaveBeenCalled();
    expect(mocks.publishableKeySealed).not.toHaveBeenCalled();
  });
});

describe('POST /stripe/api/token — connect failures (#2754)', () => {
  it('accepts a signing-secret-only update without requiring the existing keys', async () => {
    const response = await post({ webhookSecret: ' whsec_fake_owner ' });
    expect(response.status).toBe(201);
    expect(mocks.sealSecret).toHaveBeenCalledWith('did:imajin:imajin-inc', 'whsec_fake_owner');
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain('whsec_');
  });

  it('accepts all three credentials on the same authenticated route', async () => {
    expect((await post({ token: 'rk_test_fake', publishableKey: 'pk_test_fake', webhookSecret: 'whsec_fake_owner' })).status).toBe(201);
    expect(mocks.connect).toHaveBeenCalledWith('did:imajin:imajin-inc', 'rk_test_fake', 'https://kernel.test', 'pk_test_fake', 'whsec_fake_owner');
  });

  it.each(['', 'bad', 12, null])('rejects invalid signing secrets with a safe field error %s', async (webhookSecret) => {
    const response = await post({ webhookSecret });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'stripe_webhook_secret_invalid', field: 'webhookSecret' });
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.sealSecret).not.toHaveBeenCalled();
  });
  it('seals and reports 201 for a key that can take an invoice payment', async () => {
    mocks.connect.mockResolvedValue({ routingId: 'r', endpointId: 'e' });

    const res = await post({ token: 'rk_live_fake', publishableKey: 'pk_live_fake' });

    expect(res.status).toBe(201);
    expect(mocks.connect).toHaveBeenCalledWith('did:imajin:imajin-inc', 'rk_live_fake', 'https://kernel.test', 'pk_live_fake', undefined);
  });

  it('never returns or logs a raw upstream error that echoes a key', async () => {
    mocks.connect.mockRejectedValue(new Error('Upstream echoed rk_test_fake_private and pk_test_fake_private'));
    const res = await post({ token: 'rk_test_fake', publishableKey: 'pk_test_fake' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to connect Stripe' });
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain('fake_private');
  });

  it('rejects invalid JSON without calling the connector', async () => {
    const res = await POST(new NextRequest('https://kernel.test/stripe/api/token', { method: 'POST', body: '{' }));
    expect(res.status).toBe(400);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('rejects a null JSON body safely', async () => {
    expect((await post(null)).status).toBe(400);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('uses the shared resolver and denies unauthenticated POST', async () => {
    mocks.resolveOwner.mockResolvedValue({ ok: false, error: 'Unauthorized', status: 401 });
    expect((await post({ token: 'rk_test_fake', publishableKey: 'pk_test_fake' })).status).toBe(401);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('passes the owner-provided publishable key to the same connector', async () => {
    expect((await post({ token: 'rk_test_fake', publishableKey: ' pk_test_fake ' })).status).toBe(201);
    expect(mocks.connect).toHaveBeenCalledWith('did:imajin:imajin-inc', 'rk_test_fake', 'https://kernel.test', 'pk_test_fake', undefined);
  });

  it.each([undefined, '', '  ', 12, null])('requires a nonempty publishable key with a typed 400', async (publishableKey) => {
    const res = await post({ token: 'rk_test_fake', publishableKey });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'stripe_publishable_key_missing', field: 'publishableKey' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each([
    [{ token: 'sk_test_fake', publishableKey: 'pk_test_fake' }, 'stripe_key_not_restricted', 'token'],
    [{ publishableKey: 'pk_test_fake' }, 'stripe_key_missing', 'token'],
    [{ token: 'rk_test_fake', publishableKey: 'not_a_key' }, 'stripe_publishable_key_invalid', 'publishableKey'],
    [{ token: 'rk_test_fake', publishableKey: 'pk_live_fake' }, 'stripe_key_mode_mismatch', 'publishableKey'],
    [{ token: 'rk_live_fake', publishableKey: 'pk_test_fake' }, 'stripe_key_mode_mismatch', 'publishableKey'],
  ])('validates the pair before calling the connector %#', async (body, code, field) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    const result = await res.json();
    expect(result).toMatchObject({ code, field });
    expect(JSON.stringify(result)).not.toContain('fake');
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('returns a typed error thrown by the connector without logging it', async () => {
    mocks.connect.mockRejectedValue(new StripeCredentialError('stripe_key_mode_mismatch', 'publishableKey', 'Keys must use the same mode.'));
    const res = await post({ token: 'rk_test_fake', publishableKey: 'pk_test_fake' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Keys must use the same mode.', code: 'stripe_key_mode_mismatch', field: 'publishableKey',
    });
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it.each([
    ['stripe_key_not_restricted: paste a RESTRICTED key'],
    ['stripe_key_missing_permission: this restricted key cannot create Checkout Sessions.'],
  ])('answers a generic safe caller-mistake 400 for %s', async (message) => {
    mocks.connect.mockRejectedValue(new Error(message));

    const res = await post({ token: 'rk_live_fake', publishableKey: 'pk_live_fake' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Failed to connect Stripe' });
  });

  it('keeps a Stripe-side provisioning failure a 500', async () => {
    mocks.connect.mockRejectedValue(new Error('stripe_webhook_provision_failed: 401'));

    expect((await post({ token: 'rk_live_fake', publishableKey: 'pk_live_fake' })).status).toBe(500);
  });
});
