import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  access: vi.fn(), add: vi.fn(), list: vi.fn(), verify: vi.fn(), remove: vi.fn(), normalize: vi.fn(), log: vi.fn(),
}));
vi.mock('@/src/lib/domains/access', () => ({ requireDomainManager: mocks.access }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: mocks.log }) }));
vi.mock('@/src/lib/domains/service', () => ({
  addDomain: mocks.add, listDomains: mocks.list, verifyDomain: mocks.verify, removeDomain: mocks.remove,
  normalizeDomain: mocks.normalize,
  DomainError: class DomainError extends Error {
    constructor(public code: string, message: string, public status: number) { super(message); }
  },
}));

import { DomainError } from '@/src/lib/domains/service';
import { GET, POST } from '@/app/auth/api/identities/[did]/domains/route';
import { POST as verify } from '@/app/auth/api/identities/[did]/domains/[domain]/verify/route';
import { DELETE as remove } from '@/app/auth/api/identities/[did]/domains/[domain]/route';
import { GET as publicList } from '@/app/auth/api/identities/[did]/domains/public/route';

const did = 'did:imajin:owner';
const domain = 'example.com';
const context = { params: Promise.resolve({ did, domain }) };
const binding = { domain, zoneOwner: did, siteOwner: did, appDid: null, status: 'pending', method: 'dns-txt', attestation: null };
const publicBinding = { ...binding, status: 'verified', attestation: { signature: 'public-signature' } };
function request(body?: unknown) {
  return new Request('https://example.test/auth/api/identities/owner/domains', {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue({ id: did });
  mocks.list.mockResolvedValue([binding]);
  mocks.add.mockResolvedValue(binding);
  mocks.verify.mockResolvedValue(publicBinding);
  mocks.normalize.mockImplementation((value: string) => value.toLowerCase());
});

describe('identity domain API', () => {
  it('lists private bindings only after owner/admin authorization', async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ domains: [binding] });
    expect(mocks.access).toHaveBeenCalledWith(expect.any(Request), did);
    expect(mocks.list).toHaveBeenCalledWith(did);
  });

  it('adds using the path owner and app DID, not a caller-asserted site owner', async () => {
    const response = await POST(request({ domain, appDid: 'did:imajin:app' }), context);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ domain: binding });
    expect(mocks.add).toHaveBeenCalledWith({ domain, appDid: 'did:imajin:app', zoneOwner: did });
    expect(mocks.access).toHaveBeenCalledWith(expect.any(Request), did, { action: 'add-domain', class: 'value-moving' });
  });

  it('allows an identity-only binding with no app', async () => {
    await POST(request({ domain }), context);
    expect(mocks.add).toHaveBeenCalledWith({ domain, appDid: null, zoneOwner: did });
  });

  it.each([
    { domain, siteOwner: 'did:imajin:other' }, { domain, zoneOwner: 'did:imajin:other' },
    { domain, appDid: 'not-a-did' }, { domain: 12 }, { domain: '' }, { domain: 'x'.repeat(254) }, [], null,
  ])('rejects invalid or authority-injecting input %j', async (input) => {
    expect((await POST(request(input), context)).status).toBe(400);
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it('handles malformed JSON', async () => {
    const invalid = new Request('https://example.test', { method: 'POST', body: '{' });
    expect((await POST(invalid, context)).status).toBe(400);
  });

  it('verifies the domain for the path owner using value-moving policy', async () => {
    const response = await verify(request(), context);
    expect(await response.json()).toEqual({ domain: publicBinding });
    expect(mocks.verify).toHaveBeenCalledWith(domain, did);
    expect(mocks.access).toHaveBeenCalledWith(expect.any(Request), did, { action: 'verify-domain', class: 'value-moving' });
  });

  it('removes through the service after an irreversible policy gate', async () => {
    const response = await remove(request(), context);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(mocks.remove).toHaveBeenCalledWith(domain, did);
    expect(mocks.access).toHaveBeenCalledWith(expect.any(Request), did, { action: 'remove-domain', class: 'irreversible' });
  });

  it.each([GET, POST, verify, remove])('propagates auth/policy rejection without a service call', async (handler) => {
    mocks.access.mockResolvedValue(Response.json({ error: 'Denied' }, { status: 403 }));
    expect((await handler(request({ domain }), context)).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it.each([GET, POST, verify, remove])('redacts unexpected service errors', async (handler) => {
    const error = new Error('provider secret response');
    mocks.list.mockRejectedValue(error);
    mocks.add.mockRejectedValue(error);
    mocks.verify.mockRejectedValue(error);
    mocks.remove.mockRejectedValue(error);
    const response = await handler(request({ domain }), context);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('provider secret');
    expect(mocks.log).toHaveBeenCalledWith({ errorType: 'Error' }, 'Domain operation failed');
  });

  it('preserves safe domain error codes and HTTP status', async () => {
    mocks.verify.mockRejectedValue(new DomainError('txt_not_found', 'TXT proof does not match', 409));
    const response = await verify(request(), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'TXT proof does not match', code: 'txt_not_found' });
  });

  it('returns retryable 503 when manual verification cannot reach DNS', async () => {
    mocks.verify.mockRejectedValue(new DomainError('dns_unavailable', 'DNS lookup unavailable; retry verification', 503));
    const response = await verify(request(), context);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'DNS lookup unavailable; retry verification', code: 'dns_unavailable' });
  });
});

describe('public domain evidence API', () => {
  it('explicitly requests publicOnly and drops unsigned, pending, revoked and legacy claims', async () => {
    mocks.list.mockResolvedValue([
      binding, publicBinding, { ...publicBinding, status: 'revoked' },
      { ...publicBinding, status: 'legacy' }, { ...publicBinding, attestation: null },
    ]);
    const response = await publicList(request(), context);
    expect(mocks.list).toHaveBeenCalledWith(did, true);
    expect(mocks.access).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ domains: [publicBinding] });
  });

  it('supports a normalized single-domain signed evidence link', async () => {
    mocks.list.mockResolvedValue([publicBinding, { ...publicBinding, domain: 'other.example' }]);
    const response = await publicList(new Request('https://example.test?domain=EXAMPLE.COM'), context);
    expect(mocks.normalize).toHaveBeenCalledWith('EXAMPLE.COM');
    expect(await response.json()).toEqual({ domains: [publicBinding] });
  });

  it('redacts unexpected public lookup failures', async () => {
    mocks.list.mockRejectedValue('private resolver details');
    const response = await publicList(request(), context);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Domain operation failed' });
    expect(mocks.log).toHaveBeenCalledWith({ errorType: 'unknown' }, 'Domain operation failed');
  });
});
