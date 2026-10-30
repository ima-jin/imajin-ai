import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn(), write: vi.fn() }));
vi.mock('@imajin/auth', () => ({ requireAuth: mocks.auth }));
vi.mock('@/src/lib/warp/brief-ledger', () => ({ readBriefStorage: mocks.read, writeBriefStorage: mocks.write }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: vi.fn() }));
import { GET, PUT } from '../route';

const request = (body?: unknown) => new NextRequest('http://localhost/jin/api/brief-settings', {
  method: body === undefined ? 'GET' : 'PUT', body: body === undefined ? undefined : JSON.stringify(body),
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ identity: { id: 'did:imajin:human', subtype: 'human' } });
  mocks.read.mockResolvedValue('full-text');
  mocks.write.mockResolvedValue({ storage: 'hash-only', attestationId: 'att_signed' });
});

describe('brief settings route', () => {
  it('reads the authenticated principal, disables caching and uses scoped session auth', async () => {
    const response = await GET(request());
    expect(await response.json()).toEqual({ storage: 'full-text' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.read).toHaveBeenCalledWith('did:imajin:human');
    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), { service: 'warp', sessionOnly: true });
  });
  it('changes only the server-resolved principal and returns signed evidence', async () => {
    mocks.auth.mockResolvedValue({ identity: { id: 'did:imajin:human', actingAs: 'did:imajin:org', actingAsRole: 'owner' } });
    const response = await PUT(request({ storage: 'hash-only' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ storage: 'hash-only', attestationId: 'att_signed' });
    expect(mocks.write).toHaveBeenCalledWith('did:imajin:org', 'did:imajin:human', 'hash-only');
  });
  it.each([{ error: 'Unauthenticated', status: 401 }, { error: 'Service denied', status: 403 }])('denies auth failure %j', async auth => {
    mocks.auth.mockResolvedValue(auth);
    expect((await GET(request())).status).toBe(auth.status);
    expect((await PUT(request({ storage: 'hash-only' }))).status).toBe(auth.status);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it.each([
    { id: 'did:agent', subtype: 'agent' },
    { id: 'did:agent', actingFor: 'did:principal' },
    { id: 'did:human', actingAs: 'did:org', actingAsRole: 'member' },
  ])('denies delegated agents and non-owner controllers %j', async identity => {
    mocks.auth.mockResolvedValue({ identity });
    expect((await GET(request())).status).toBe(403);
    expect((await PUT(request({ storage: 'hash-only' }))).status).toBe(403);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it.each([null, [], {}, 'hash-only', { storage: 'typo' }, { storage: false },
    { storage: 'hash-only', did: 'did:other' }])('rejects invalid bodies %j', async body => {
    expect((await PUT(request(body))).status).toBe(400);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON', async () => {
    expect((await PUT(new NextRequest('http://localhost/jin/api/brief-settings', { method: 'PUT', body: '{' }))).status).toBe(400);
  });
  it('returns value-free failures rather than assuming the default or claiming a save', async () => {
    mocks.read.mockRejectedValue(new Error('private driver details'));
    mocks.write.mockRejectedValue(new Error('private driver details'));
    const responses = [await GET(request()), await PUT(request({ storage: 'full-text' }))];
    for (const response of responses) {
      expect(response.status).toBe(503);
      expect(JSON.stringify(await response.json())).not.toContain('private driver');
    }
  });
});
