import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockHandleVerifiedWebhookEvent } = vi.hoisted(() => ({
  mockHandleVerifiedWebhookEvent: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/src/lib/stripe/connector', () => ({ handleVerifiedWebhookEvent: mockHandleVerifiedWebhookEvent }));

vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
}));

import { POST } from '../route';

type RouteRequest = Parameters<typeof POST>[0];

function makeRequest(body: string, headers: Record<string, string> = {}): RouteRequest {
  return {
    text: async () => body,
    headers: new Headers(headers),
  } as unknown as RouteRequest;
}

function withRoutingId(routingId: string) {
  return { params: Promise.resolve({ routingId }) };
}

beforeEach(() => {
  mockHandleVerifiedWebhookEvent.mockReset();
});

describe('POST /stripe/api/webhook/[routingId] (#1785)', () => {
  it('passes the routing id, raw body, and stripe-signature header straight through', async () => {
    mockHandleVerifiedWebhookEvent.mockResolvedValue({ status: 'ok', published: true });

    await POST(makeRequest('{"id":"evt_1"}', { 'stripe-signature': 't=1,v1=abc' }), withRoutingId('stripewh_abc'));

    expect(mockHandleVerifiedWebhookEvent).toHaveBeenCalledWith('stripewh_abc', '{"id":"evt_1"}', 't=1,v1=abc');
  });

  it('passes null when no stripe-signature header is present', async () => {
    mockHandleVerifiedWebhookEvent.mockResolvedValue({ status: 'invalid_signature', reason: 'missing_header' });

    await POST(makeRequest('{}'), withRoutingId('stripewh_abc'));

    expect(mockHandleVerifiedWebhookEvent).toHaveBeenCalledWith('stripewh_abc', '{}', null);
  });

  it('acknowledges a verified, published delivery with 200', async () => {
    mockHandleVerifiedWebhookEvent.mockResolvedValue({ status: 'ok', published: true });

    const res = await POST(makeRequest('{}', { 'stripe-signature': 't=1,v1=abc' }), withRoutingId('stripewh_abc'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, published: true });
  });

  it('acknowledges a verified delivery with no bus mapping (published: false) with 200', async () => {
    mockHandleVerifiedWebhookEvent.mockResolvedValue({ status: 'ok', published: false });

    const res = await POST(makeRequest('{}', { 'stripe-signature': 't=1,v1=abc' }), withRoutingId('stripewh_abc'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, published: false });
  });

  it('rejects an unknown routing id with 404 — never retried the same way twice', async () => {
    mockHandleVerifiedWebhookEvent.mockResolvedValue({ status: 'unknown_routing' });

    const res = await POST(makeRequest('{}', { 'stripe-signature': 't=1,v1=abc' }), withRoutingId('stripewh_unknown'));

    expect(res.status).toBe(404);
  });

  it('rejects an invalid signature with 400', async () => {
    mockHandleVerifiedWebhookEvent.mockResolvedValue({ status: 'invalid_signature', reason: 'signature_mismatch' });

    const res = await POST(makeRequest('{}', { 'stripe-signature': 't=1,v1=bad' }), withRoutingId('stripewh_abc'));

    expect(res.status).toBe(400);
  });

  it('rejects a replayed delivery with 400', async () => {
    mockHandleVerifiedWebhookEvent.mockResolvedValue({ status: 'invalid_signature', reason: 'timestamp_out_of_tolerance' });

    const res = await POST(makeRequest('{}', { 'stripe-signature': 't=1,v1=stale' }), withRoutingId('stripewh_abc'));

    expect(res.status).toBe(400);
  });

  it('rejects a malformed payload with 400', async () => {
    mockHandleVerifiedWebhookEvent.mockResolvedValue({ status: 'malformed_payload' });

    const res = await POST(makeRequest('not-json', { 'stripe-signature': 't=1,v1=abc' }), withRoutingId('stripewh_abc'));

    expect(res.status).toBe(400);
  });
});
