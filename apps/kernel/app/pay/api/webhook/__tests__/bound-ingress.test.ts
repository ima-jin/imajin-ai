import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock('@/src/lib/stripe/connector', () => ({ handleVerifiedWebhookEvent: handle }));

import { POST as unbound } from '../route';
import { POST } from '../[routingId]/route';

function request() {
  return new Request('https://node.example/pay/api/webhook/stripewh_fake', {
    method: 'POST',
    headers: { 'stripe-signature': 'fake-signature' },
    body: '{"untrusted":"unchanged"}',
  }) as NextRequest;
}

beforeEach(() => vi.clearAllMocks());

describe('connector-bound pay webhook ingress', () => {
  it('rejects the unbound endpoint without reading or dispatching an event', async () => {
    const response = await unbound(request());
    expect(response.status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
  });

  it('passes the URL binding and unmodified body to the shared verifier', async () => {
    handle.mockResolvedValue({ status: 'ok', published: true });
    const response = await POST(request(), { params: Promise.resolve({ routingId: 'stripewh_fake' }) });
    expect(response.status).toBe(200);
    expect(handle).toHaveBeenCalledWith('stripewh_fake', '{"untrusted":"unchanged"}', 'fake-signature');
  });

  it.each([
    [{ status: 'unknown_routing' }, 404],
    [{ status: 'invalid_signature', reason: 'signature_mismatch' }, 400],
    [{ status: 'malformed_payload' }, 400],
  ])('maps verification rejection %j to HTTP %i', async (result, status) => {
    handle.mockResolvedValue(result);
    const response = await POST(request(), { params: Promise.resolve({ routingId: 'stripewh_fake' }) });
    expect(response.status).toBe(status);
  });
});
