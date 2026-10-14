import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMemoryKernelWebhookNonceStore } from '@imajin/auth/kernel-webhook';
import { discoveryResponse, EVENTS_APP_DID, signedWebhook, TEST_AUTH_URL } from './signed-webhook-support';

const mocks = vi.hoisted(() => ({
  update: vi.fn(), set: vi.fn(), where: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('@/src/db', () => ({ db: { update: mocks.update }, orders: { id: 'id' } }));
vi.mock('@imajin/auth/kernel-webhook', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@imajin/auth/kernel-webhook')>();
  const pinStore = {
    load: async () => null, save: async () => undefined,
    withLock: async <T>(_namespace: string, operation: () => Promise<T>): Promise<T> => operation(),
  };
  return { ...sdk, verifyKernelWebhook: (req: Request, opts: Parameters<typeof sdk.verifyKernelWebhook>[1]) =>
    sdk.verifyKernelWebhook(req, { ...opts, pinStore }) };
});

import { POST } from '../../app/api/webhook/settlement/route';
import { configureEventsWebhookNonceStore } from '../lib/kernel-webhook';

const PAYLOAD = {
  orderId: 'order_test', eventId: 'event_test', buyerDid: 'did:imajin:test-buyer',
  amount: 1000, totalAmount: 1000, netAmount: 900, currency: 'CAD',
  fees: [{ role: 'platform', name: 'test', rateBps: 1000, fixedCents: 0, amount: 100, estimated: false }],
  chain: [{ did: 'did:imajin:test-organizer', amount: 900, role: 'seller' }],
};
const callRoute = (request: Request) => POST(new NextRequest(request));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('IMAJIN_APP_DID', EVENTS_APP_DID);
  vi.stubEnv('AUTH_SERVICE_URL', TEST_AUTH_URL);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => discoveryResponse()));
  mocks.update.mockReturnValue({ set: mocks.set });
  mocks.set.mockReturnValue({ where: mocks.where });
  mocks.where.mockResolvedValue(undefined);
  configureEventsWebhookNonceStore(createMemoryKernelWebhookNonceStore());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('events settlement webhook with actual SDK verification', () => {
  it.each([false, true])('accepts signed settlement (bus envelope=%s) and records the snapshot', async (envelope) => {
    const body = envelope ? { type: 'settlement.completed', payload: PAYLOAD } : PAYLOAD;
    const response = await callRoute(signedWebhook('/api/webhook/settlement', body));
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.set).toHaveBeenCalledWith({ fairSettlement: {
      version: '1.1', settledAt: expect.any(String),
      totalAmount: 1000, netAmount: 900, currency: 'CAD', fees: PAYLOAD.fees, chain: PAYLOAD.chain,
    } });
    expect(mocks.where).toHaveBeenCalledOnce();
  });

  it.each(['legacy', 'audience', 'signature', 'tamper', 'missing-audience'])('rejects %s without database writes', async (kind) => {
    let request = signedWebhook('/api/webhook/settlement', PAYLOAD,
      kind === 'audience' ? 'did:imajin:other-test-app' : EVENTS_APP_DID);
    if (kind === 'legacy') request = new Request(request.url, {
      method: 'POST', body: JSON.stringify(PAYLOAD), headers: { 'x-webhook-secret': 'fake-legacy-test-only' },
    });
    if (kind === 'signature') request.headers.set('x-kernel-signature', '00'.repeat(64));
    if (kind === 'missing-audience') request.headers.delete('x-kernel-audience');
    if (kind === 'tamper') request = new Request(request.url, {
      method: 'POST', headers: request.headers, body: JSON.stringify({ ...PAYLOAD, orderId: 'tampered' }),
    });
    const response = await callRoute(request);
    expect(response.status).toBe(401);
    if (kind === 'audience') expect(await response.json()).toMatchObject({ code: 'AUDIENCE_MISMATCH' });
    expect(mocks.update).not.toHaveBeenCalled();
    if (['legacy', 'audience', 'missing-audience'].includes(kind)) expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a replay before writing the order a second time', async () => {
    const request = signedWebhook('/api/webhook/settlement', PAYLOAD);
    expect((await callRoute(request.clone())).status).toBe(200);
    expect((await callRoute(request.clone())).status).toBe(401);
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it('fails closed if a configured durable replay store is unavailable', async () => {
    configureEventsWebhookNonceStore({ consume: async () => { throw new Error('test store unavailable'); } });
    expect((await callRoute(signedWebhook('/api/webhook/settlement', PAYLOAD))).status).toBe(503);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('returns 503 without effects when local app identity is not configured or provisioned', async () => {
    vi.stubEnv('IMAJIN_APP_DID', '');
    vi.stubEnv('IMAJIN_KERNEL_URL', '');
    expect((await callRoute(signedWebhook('/api/webhook/settlement', PAYLOAD))).status).toBe(503);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an authenticated callback without an order id without writes', async () => {
    const response = await callRoute(signedWebhook('/api/webhook/settlement', { ...PAYLOAD, orderId: '' }));
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('preserves processing failures as 500 after successful verification', async () => {
    mocks.where.mockRejectedValue(new Error('test db unavailable'));
    expect((await callRoute(signedWebhook('/api/webhook/settlement', PAYLOAD))).status).toBe(500);
  });
});
