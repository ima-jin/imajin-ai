import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ resolveOwner: vi.fn(), connect: vi.fn(), keySealed: vi.fn() }));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: () => new Response(null, { status: 204 }) }));
vi.mock('@/src/lib/kernel/connector-owner-did', () => ({ resolveConnectorOwnerDid: mocks.resolveOwner }));
vi.mock('@/src/lib/http/public-origin', () => ({ publicOrigin: () => 'https://kernel.test' }));
vi.mock('@/src/lib/stripe/connector', () => ({ connectAndProvisionWebhook: mocks.connect, keySealed: mocks.keySealed }));

import { POST } from '../route';

function post(body: unknown) {
  return POST(
    new NextRequest('https://kernel.test/stripe/api/token', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveOwner.mockResolvedValue({ ok: true, ownerDid: 'did:imajin:imajin-inc' });
});

describe('POST /stripe/api/token — connect failures (#2754)', () => {
  it('seals and reports 201 for a key that can take an invoice payment', async () => {
    mocks.connect.mockResolvedValue({ routingId: 'r', endpointId: 'e' });

    const res = await post({ token: 'rk_live_x' });

    expect(res.status).toBe(201);
    expect(mocks.connect).toHaveBeenCalledWith('did:imajin:imajin-inc', 'rk_live_x', 'https://kernel.test');
  });

  it.each([
    ['stripe_key_not_restricted: paste a RESTRICTED key'],
    ['stripe_key_missing_permission: this restricted key cannot create Checkout Sessions.'],
  ])('answers a caller-mistake 400 — with the specific detail — for %s', async (message) => {
    mocks.connect.mockRejectedValue(new Error(message));

    const res = await post({ token: 'rk_live_x' });

    expect(res.status).toBe(400);
    expect((await res.json()).detail).toBe(message);
  });

  it('keeps a Stripe-side provisioning failure a 500', async () => {
    mocks.connect.mockRejectedValue(new Error('stripe_webhook_provision_failed: 401'));

    expect((await post({ token: 'rk_live_x' })).status).toBe(500);
  });
});
