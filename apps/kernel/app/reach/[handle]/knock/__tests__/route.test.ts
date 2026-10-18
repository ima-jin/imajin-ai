import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { KNOCK_IP_RATE_LIMIT, KNOCK_IP_RATE_WINDOW, KNOCK_TARGET_RATE_LIMIT, KNOCK_TARGET_RATE_WINDOW } from '@imajin/auth';
import { POST } from '../route';
import { POST as reach } from '../../route';

const mocks = vi.hoisted(() => ({
  limit: vi.fn(), issue: vi.fn(), parse: vi.fn(), recipient: vi.fn(), deliver: vi.fn(),
}));
vi.mock('@imajin/config', () => ({ rateLimit: mocks.limit, getClientIP: () => '192.0.2.1' }));
vi.mock('@/src/lib/access/reach-bearer', () => ({
  issueReachBearer: mocks.issue, parseReachKnock: mocks.parse, resolveReachRecipient: mocks.recipient,
}));
vi.mock('@/app/auth/api/agents/[did]/reach/route', () => ({ POST: mocks.deliver }));
const input = { agentLabel: 'curl', onBehalfOf: { platform: 'curl', externalRef: 'opaque' }, slidingWindowDays: 30 };
const credential = {
  bearer: 'synthetic-issuance-secret', bearerId: 'dgb_1', requestId: 'dgr_1', requesterDid: 'did:imajin:stub',
  audience: 'did:imajin:ryan', scopes: ['agent:reach'], surfaces: ['reach:did:imajin:ryan'],
  claimVerified: false, expiresAt: '2026-11-17T00:00:00Z', hardCapAt: '2027-01-15T00:00:00Z',
};
const props = { params: Promise.resolve({ handle: 'ryan' }) };
function request(body: unknown = input) {
  return new NextRequest('https://example.test/reach/ryan/knock', { method: 'POST', body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.limit.mockReturnValue({ limited: false, retryAfter: 0 });
  mocks.recipient.mockResolvedValue({ id: credential.audience });
  mocks.parse.mockReturnValue({ ok: true, input });
  mocks.issue.mockResolvedValue({ ok: true, ...credential, tokenHash: 'must-not-leak' });
  mocks.deliver.mockResolvedValue(new Response('delivered'));
});
describe('public reach knock', () => {
  it.each([undefined, '1', '65537'])('rejects an oversized knock with declared length %s before minting a credential', async length => {
    const response = await POST(new NextRequest('https://example.test/reach/ryan/knock', {
      method: 'POST', body: JSON.stringify({ ...input, padding: 'x'.repeat(64 * 1024) }),
      headers: length ? { 'content-length': length } : {},
    }), props);
    expect(response.status).toBe(413);
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(mocks.recipient).not.toHaveBeenCalled();
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it('issues exactly one response with a reach-only audience and no cacheable/retrievable hash', async () => {
    const response = await POST(request(), props);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(credential);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(mocks.issue).toHaveBeenCalledOnce();
    expect(mocks.issue).toHaveBeenCalledWith(credential.audience, input);
    expect(mocks.limit).toHaveBeenNthCalledWith(1, 'knock:ip:192.0.2.1', KNOCK_IP_RATE_LIMIT, KNOCK_IP_RATE_WINDOW);
    expect(mocks.limit).toHaveBeenNthCalledWith(2, `knock:target:${credential.audience}`, KNOCK_TARGET_RATE_LIMIT, KNOCK_TARGET_RATE_WINDOW);
  });
  it('limits IPs before parsing or resolving a recipient', async () => {
    mocks.limit.mockReturnValue({ limited: true, retryAfter: 42 });
    const response = await POST(request(), props);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(mocks.recipient).not.toHaveBeenCalled();
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it('uses the resolved recipient DID for quotas so handles and DID aliases cannot bypass them', async () => {
    mocks.limit.mockReturnValueOnce({ limited: false }).mockReturnValueOnce({ limited: true, retryAfter: 8 });
    const response = await POST(request(), { params: Promise.resolve({ handle: credential.audience }) });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('8');
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON before issuance', async () => {
    const response = await POST(new NextRequest('https://example.test/reach/ryan/knock', { method: 'POST', body: '{' }), props);
    expect(response.status).toBe(400);
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it('rejects invalid claims before resolving or creating a stub', async () => {
    mocks.parse.mockReturnValue({ ok: false, error: 'UNVERIFIED claim required' });
    const response = await POST(request(), props);
    expect(response.status).toBe(400);
    expect(mocks.recipient).not.toHaveBeenCalled();
  });
  it('never mints a recipient for an unknown target', async () => {
    mocks.recipient.mockResolvedValue(null);
    expect((await POST(request(), props)).status).toBe(404);
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it('respects a closed gate without operator approval', async () => {
    mocks.issue.mockResolvedValue({ ok: false, status: 403, error: 'Gate closed' });
    const response = await POST(request(), props);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Gate closed' });
  });
  it('does not disclose thrown errors or query parameters', async () => {
    mocks.issue.mockRejectedValue(new Error('private-query-value'));
    const response = await POST(request(), props);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-query-value');
  });
});
describe('friendly reach alias', () => {
  it('preserves the original request and dispatches to the canonical recipient-bound handler', async () => {
    const req = request();
    expect(await (await reach(req, props)).text()).toBe('delivered');
    expect(mocks.deliver).toHaveBeenCalledWith(req, { params: expect.any(Promise) });
    expect(await mocks.deliver.mock.calls[0][1].params).toEqual({ did: credential.audience });
  });
  it('rejects unknown recipients and hides dependency errors', async () => {
    mocks.recipient.mockResolvedValueOnce(null);
    expect((await reach(request(), props)).status).toBe(404);
    mocks.recipient.mockRejectedValueOnce(new Error('private-query-value'));
    const response = await reach(request(), props);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-query-value');
  });
});
