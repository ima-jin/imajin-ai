import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  where: vi.fn(),
  updateWhere: vi.fn().mockResolvedValue(undefined),
  set: vi.fn(),
  values: vi.fn().mockResolvedValue(undefined),
  fetch: vi.fn(),
  requireAuth: vi.fn(),
  getToken: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: mocks.where }) }),
    insert: () => ({ values: mocks.values }),
    update: () => ({ set: mocks.set }),
  },
  events: { id: 'eventId' },
  pledges: { id: 'pledgeId', eventId: 'eventId', backerDid: 'backerDid', status: 'status' },
}));
vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuth,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));
vi.mock('@imajin/auth/delegation-policy', () => ({ enforceRoutePolicy: () => null }));
vi.mock('@imajin/config', () => ({
  corsHeaders: () => ({}),
  rateLimit: () => ({ limited: false }),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@imajin/logger', () => ({
  withLogger: (_name: string, handler: (request: Request, context: {
    log: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  }) => Promise<Response>) => (request: Request) => handler(request, {
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  }),
}));
vi.mock('@imajin/auth-client', () => ({
  loadAppSigningKey: vi.fn().mockResolvedValue({ appDid: 'did:imajin:events', privateKey: 'key' }),
  createAppServiceTokenProvider: () => ({ getToken: mocks.getToken, invalidate: mocks.invalidate }),
}));
vi.mock('@/src/lib/pay-app-token', async () => import('../lib/pay-app-token'));

import { resetPayAppTokenForTests } from '../lib/pay-app-token';
import { POST as pledge } from '../../app/api/campaign/pledge/route';
import { POST as settle } from '../../app/api/campaign/[eventId]/settle/route';

const campaign = {
  id: 'evt_1', creatorDid: 'did:imajin:creator', eventType: 'campaign',
  status: 'published', targetAmount: 100, deadline: null,
};
const confirmedPledge = {
  id: 'plg_1', amount: 100, currency: 'CAD', stripeSetupIntentId: 'seti_1',
  stripeCustomerId: 'cus_untrusted', stripePaymentMethodId: 'pm_untrusted',
};

function nextRows(rows: unknown[]) {
  const result = Object.assign(Promise.resolve(rows), { limit: vi.fn().mockResolvedValue(rows) });
  mocks.where.mockReturnValueOnce(result);
}

function request(path: string, body: unknown = {}) {
  return new NextRequest(`https://events.test/api/campaign/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'imajin_session=backer' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.where.mockReset();
  mocks.getToken.mockReset();
  resetPayAppTokenForTests();
  process.env.IMAJIN_KERNEL_URL = 'https://kernel.test';
  process.env.PAY_SERVICE_URL = 'https://kernel.test/pay';
  mocks.getToken.mockResolvedValue('events-app-token');
  mocks.requireAuth.mockResolvedValue({ identity: { id: 'did:imajin:creator' } });
  mocks.set.mockReturnValue({ where: mocks.updateWhere });
  mocks.updateWhere.mockResolvedValue(undefined);
  mocks.values.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', mocks.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetPayAppTokenForTests();
});

describe('campaign pay authority (#2735)', () => {
  it('sends only the app credential and canonical buyer/seller/pledge bindings for BYO setup', async () => {
    nextRows([campaign]);
    nextRows([]);
    mocks.fetch.mockResolvedValue(Response.json({ clientSecret: 'secret', setupIntentId: 'seti_1', customerId: 'cus_1' }));
    expect((await pledge(request('pledge', { eventId: 'evt_1', amount: 100 }))).status).toBe(200);
    const pledgeId = mocks.values.mock.calls[0][0].id;
    expect(mocks.fetch).toHaveBeenCalledWith('https://kernel.test/pay/api/setup-intent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Authorization: 'Bearer events-app-token',
      },
      body: JSON.stringify({
        pledgeId, eventId: 'evt_1', buyerDid: 'did:imajin:creator',
        sellerDid: campaign.creatorDid, amount: 100, currency: 'CAD',
      }),
      cache: 'no-store',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({ stripeSetupIntentId: 'seti_1' }));
  });

  it('sends setup ids, never caller card/amount authority, when charging', async () => {
    nextRows([campaign]);
    nextRows([confirmedPledge]);
    mocks.fetch.mockResolvedValue(Response.json({ charged: 1, results: [{ pledgeId: 'plg_1', status: 'charged' }] }));
    expect((await settle(request('evt_1/settle'))).status).toBe(200);
    const [, init] = mocks.fetch.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer events-app-token');
    expect(init.headers.Cookie).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ eventId: 'evt_1', pledges: [{ pledgeId: 'plg_1', setupIntentId: 'seti_1' }] });
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'charged' }));
  });

  it.each([401, 403])('leaves pledges unchanged after pay refuses with %s', async (status) => {
    nextRows([campaign]);
    nextRows([confirmedPledge]);
    mocks.fetch.mockImplementation(() => Promise.resolve(Response.json({ error: 'refused' }, { status })));
    expect((await settle(request('evt_1/settle'))).status).toBe(500);
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(status === 401 ? 2 : 1);
  });

  it('does not create a local pledge if the app credential is unavailable', async () => {
    nextRows([campaign]);
    nextRows([]);
    mocks.getToken.mockRejectedValue(new Error('not provisioned'));
    const response = await pledge(request('pledge', { eventId: 'evt_1', amount: 100 }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'payment_verification_unavailable' });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.values).not.toHaveBeenCalled();
  });
});
