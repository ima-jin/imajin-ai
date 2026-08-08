import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResolveRealmOwner, mockLoadConfig, mockVerify, mockSettle, afterCallbacks } = vi.hoisted(() => ({
  mockResolveRealmOwner: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockVerify: vi.fn(),
  mockSettle: vi.fn(),
  afterCallbacks: [] as Array<() => unknown>,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/src/lib/quickbooks/connector', () => ({ loadConfig: mockLoadConfig }));
vi.mock('@/src/lib/quickbooks/realm-index', () => ({ resolveRealmOwner: mockResolveRealmOwner }));
vi.mock('@/src/lib/quickbooks/webhook-verify', () => ({ verifyIntuitWebhookSignature: mockVerify }));
vi.mock('@/src/lib/quickbooks/settlement', () => ({ settlePaidInvoices: mockSettle }));

vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
  after: vi.fn((cb: () => unknown) => {
    afterCallbacks.push(cb);
  }),
}));

import { POST } from '../route';

const OWNER = 'did:imajin:scott';
const APP = 'did:imajin:agrifortress';
const REALM = 'realm9';
const VERIFIER = 'verifier-token';

type RouteRequest = Parameters<typeof POST>[0];

function makeRequest(body: string, headers: Record<string, string> = {}): RouteRequest {
  return {
    text: async () => body,
    headers: new Headers(headers),
  } as unknown as RouteRequest;
}

function payload(realmId = REALM): string {
  return JSON.stringify({
    eventNotifications: [{ realmId, dataChangeEvent: { entities: [{ name: 'Invoice', id: '1', operation: 'Update' }] } }],
  });
}

beforeEach(() => {
  mockResolveRealmOwner.mockReset();
  mockLoadConfig.mockReset();
  mockVerify.mockReset();
  mockSettle.mockReset();
  afterCallbacks.length = 0;
  mockResolveRealmOwner.mockResolvedValue({ ownerDid: OWNER, appDid: APP });
  mockLoadConfig.mockResolvedValue({ webhookVerifierToken: VERIFIER });
  mockVerify.mockReturnValue(true);
  mockSettle.mockResolvedValue({ settled: ['inv1'], skipped: [] });
});

describe('POST /quickbooks/api/webhook (xprize #35)', () => {
  it('rejects a request with no intuit-signature header', async () => {
    const res = await POST(makeRequest(payload()));
    expect(res.status).toBe(400);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('rejects a malformed JSON body', async () => {
    const res = await POST(makeRequest('not-json', { 'intuit-signature': 'sig' }));
    expect(res.status).toBe(400);
  });

  it('rejects a payload with no realmId before ever loading a verifier token', async () => {
    const res = await POST(makeRequest(JSON.stringify({ eventNotifications: [] }), { 'intuit-signature': 'sig' }));
    expect(res.status).toBe(400);
    expect(mockLoadConfig).not.toHaveBeenCalled();
  });

  it('rejects an unknown realmId before ever loading a verifier token', async () => {
    mockResolveRealmOwner.mockResolvedValue(undefined);
    const res = await POST(makeRequest(payload(), { 'intuit-signature': 'sig' }));
    expect(res.status).toBe(400);
    expect(mockLoadConfig).not.toHaveBeenCalled();
  });

  it('returns 500 when the app has no webhookVerifierToken sealed', async () => {
    mockLoadConfig.mockResolvedValue({});
    const res = await POST(makeRequest(payload(), { 'intuit-signature': 'sig' }));
    expect(res.status).toBe(500);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('returns 500 when the app config cannot be loaded at all', async () => {
    mockLoadConfig.mockRejectedValue(new Error('quickbooks_no_config'));
    const res = await POST(makeRequest(payload(), { 'intuit-signature': 'sig' }));
    expect(res.status).toBe(500);
  });

  it('rejects an invalid signature', async () => {
    mockVerify.mockReturnValue(false);
    const res = await POST(makeRequest(payload(), { 'intuit-signature': 'bad-sig' }));
    expect(res.status).toBe(401);
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it('acknowledges immediately and settles in the background via after()', async () => {
    const res = await POST(makeRequest(payload(), { 'intuit-signature': 'good-sig' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    // Settlement is deferred to after() — not run inline before the response.
    expect(mockSettle).not.toHaveBeenCalled();

    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();

    expect(mockSettle).toHaveBeenCalledWith(OWNER, APP);
  });

  it('settles each distinct realm once when a delivery batches multiple companies', async () => {
    const multi = JSON.stringify({
      eventNotifications: [
        { realmId: 'realm-a', dataChangeEvent: { entities: [] } },
        { realmId: 'realm-b', dataChangeEvent: { entities: [] } },
        { realmId: 'realm-a', dataChangeEvent: { entities: [] } },
      ],
    });
    mockResolveRealmOwner.mockImplementation(async (realmId: string) =>
      (realmId === 'realm-a'
        ? { ownerDid: 'did:imajin:a', appDid: APP }
        : { ownerDid: 'did:imajin:b', appDid: APP }));

    const res = await POST(makeRequest(multi, { 'intuit-signature': 'good-sig' }));
    expect(res.status).toBe(200);

    await afterCallbacks[0]();

    expect(mockSettle).toHaveBeenCalledTimes(2);
    expect(mockSettle).toHaveBeenCalledWith('did:imajin:a', APP);
    expect(mockSettle).toHaveBeenCalledWith('did:imajin:b', APP);
  });

  it('does not throw out of the background job when settlement fails for one realm', async () => {
    mockSettle.mockRejectedValueOnce(new Error('boom'));
    const res = await POST(makeRequest(payload(), { 'intuit-signature': 'good-sig' }));
    expect(res.status).toBe(200);

    await expect(afterCallbacks[0]()).resolves.toBeUndefined();
  });
});
