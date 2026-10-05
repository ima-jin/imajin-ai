/**
 * Tests for the rail-generic alias routes (#2177 item 3):
 *   /api/connect/{provider}/onboard | status | dashboard | webhook
 *   /api/webhook/{provider}
 *
 * Each dispatches `{provider}` to the SAME handler its Stripe-named sibling
 * exports. The Stripe-named routes are mocked here (their own behavior is
 * covered by their own suites) so this only exercises the aliasing.
 */
import { describe, it, expect, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  onboard: vi.fn(),
  status: vi.fn(),
  dashboard: vi.fn(),
  connectWebhook: vi.fn(),
  webhook: vi.fn(),
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': '*' }),
}));
vi.mock('../connect/onboard/route', () => ({ POST: mocks.onboard }));
vi.mock('../connect/status/route', () => ({ GET: mocks.status }));
vi.mock('../connect/dashboard/route', () => ({ GET: mocks.dashboard }));
vi.mock('../connect/webhook/route', () => ({ POST: mocks.connectWebhook }));
vi.mock('../webhook/route', () => ({ POST: mocks.webhook }));

import { OPTIONS as onboardOptions, POST as onboardPost } from '../connect/[provider]/onboard/route';
import { OPTIONS as statusOptions, GET as statusGet } from '../connect/[provider]/status/route';
import { OPTIONS as dashboardOptions, GET as dashboardGet } from '../connect/[provider]/dashboard/route';
import { POST as connectWebhookPost } from '../connect/[provider]/webhook/route';
import { POST as webhookPost } from '../webhook/[provider]/route';

const req = () => new Request('https://kernel.test/pay/api/x') as unknown as NextRequest;
const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('connect/{provider}/onboard', () => {
  it('runs the Stripe onboard handler for provider=stripe and tags the body with provider', async () => {
    mocks.onboard.mockResolvedValueOnce(json({ accountId: 'acct_1', onboardingUrl: 'https://x', isNew: true }));
    const res = await onboardPost(req(), ctx('stripe'));
    expect(mocks.onboard).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({ accountId: 'acct_1', onboardingUrl: 'https://x', isNew: true, provider: 'stripe' });
  });

  it('passes handler errors through unannotated', async () => {
    mocks.onboard.mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401));
    const res = await onboardPost(req(), ctx('stripe'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('404s an unknown provider', async () => {
    mocks.onboard.mockClear();
    const res = await onboardPost(req(), ctx('paypal'));
    expect(res.status).toBe(404);
    expect(mocks.onboard).not.toHaveBeenCalled();
  });

  it('answers OPTIONS', async () => {
    expect((await onboardOptions(req())).status).toBe(204);
  });
});

describe('connect/{provider}/status', () => {
  it('runs the Stripe status handler and adds provider + rail-neutral accountId', async () => {
    mocks.status.mockResolvedValueOnce(json({ did: 'did:imajin:a', stripeAccountId: 'acct_1', chargesEnabled: true }));
    const res = await statusGet(req(), ctx('stripe'));
    expect(await res.json()).toEqual({
      did: 'did:imajin:a',
      stripeAccountId: 'acct_1',
      chargesEnabled: true,
      provider: 'stripe',
      accountId: 'acct_1',
    });
  });

  it('passes a 404 from the handler through', async () => {
    mocks.status.mockResolvedValueOnce(json({ error: 'No connected account' }, 404));
    const res = await statusGet(req(), ctx('stripe'));
    expect(res.status).toBe(404);
  });

  it('404s an unknown provider', async () => {
    expect((await statusGet(req(), ctx('paypal'))).status).toBe(404);
  });

  it('answers OPTIONS', async () => {
    expect((await statusOptions(req())).status).toBe(204);
  });
});

describe('connect/{provider}/dashboard', () => {
  it('runs the Stripe dashboard handler and returns its body unchanged', async () => {
    mocks.dashboard.mockResolvedValueOnce(json({ url: 'https://dash' }));
    const res = await dashboardGet(req(), ctx('stripe'));
    expect(await res.json()).toEqual({ url: 'https://dash' });
  });

  it('404s an unknown provider', async () => {
    expect((await dashboardGet(req(), ctx('paypal'))).status).toBe(404);
  });

  it('answers OPTIONS', async () => {
    expect((await dashboardOptions(req())).status).toBe(204);
  });
});

describe('connect/{provider}/webhook', () => {
  it('runs the Stripe Connect webhook handler unchanged', async () => {
    mocks.connectWebhook.mockResolvedValueOnce(json({ received: true }));
    const res = await connectWebhookPost(req(), ctx('stripe'));
    expect(mocks.connectWebhook).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({ received: true });
  });

  it('404s an unknown provider without invoking the handler', async () => {
    mocks.connectWebhook.mockClear();
    expect((await connectWebhookPost(req(), ctx('paypal'))).status).toBe(404);
    expect(mocks.connectWebhook).not.toHaveBeenCalled();
  });
});

describe('webhook/{provider}', () => {
  it('runs the Stripe payment webhook handler unchanged', async () => {
    mocks.webhook.mockResolvedValueOnce(json({ received: true }));
    const res = await webhookPost(req(), ctx('stripe'));
    expect(mocks.webhook).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({ received: true });
  });

  it('passes a signature-verification failure through unchanged', async () => {
    mocks.webhook.mockResolvedValueOnce(json({ error: 'Invalid signature' }, 400));
    const res = await webhookPost(req(), ctx('stripe'));
    expect(res.status).toBe(400);
  });

  it('404s an unknown provider without invoking the handler', async () => {
    mocks.webhook.mockClear();
    expect((await webhookPost(req(), ctx('paypal'))).status).toBe(404);
    expect(mocks.webhook).not.toHaveBeenCalled();
  });
});
