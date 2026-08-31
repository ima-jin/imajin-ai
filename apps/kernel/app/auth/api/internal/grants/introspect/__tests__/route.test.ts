/**
 * Tests for POST /auth/api/internal/grants/introspect (#1882).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { introspectGrantMock } = vi.hoisted(() => ({ introspectGrantMock: vi.fn() }));

vi.mock('@/src/lib/auth/grants', () => ({ introspectGrant: introspectGrantMock }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@imajin/auth', () => ({ GRANT_INTROSPECTION_CACHE_TTL: 5000 }));

import { POST } from '../route';

const INTERNAL_KEY = 'test-internal-key';
const AGENT = 'did:imajin:matchmaker-agent';
const ENDPOINT = 'http://localhost:3000/auth/api/internal/grants/introspect';

type RouteRequest = Parameters<typeof POST>[0];

function makeRequest(body: string, { key = INTERNAL_KEY as string | null } = {}): RouteRequest {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (key !== null) headers.set('x-internal-key', key);
  return new Request(ENDPOINT, { method: 'POST', headers, body }) as unknown as RouteRequest;
}

function introspect(body: unknown, options?: { key?: string | null }) {
  return POST(makeRequest(JSON.stringify(body), options));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_INTERNAL_API_KEY = INTERNAL_KEY;
});

afterEach(() => {
  delete process.env.AUTH_INTERNAL_API_KEY;
});

describe('caller authentication', () => {
  it('rejects a request with no x-internal-key header', async () => {
    const res = await introspect({ agentDid: AGENT, capability: 'messages:write' }, { key: null });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ authorized: false });
    expect(introspectGrantMock).not.toHaveBeenCalled();
  });

  it('rejects a request with the wrong key', async () => {
    const res = await introspect({ agentDid: AGENT, capability: 'messages:write' }, { key: 'nope' });
    expect(res.status).toBe(401);
    expect(introspectGrantMock).not.toHaveBeenCalled();
  });

  it('rejects every caller when AUTH_INTERNAL_API_KEY is unset (fail-closed, not fail-open)', async () => {
    delete process.env.AUTH_INTERNAL_API_KEY;
    const res = await introspect({ agentDid: AGENT, capability: 'messages:write' }, { key: null });
    expect(res.status).toBe(401);
    expect(introspectGrantMock).not.toHaveBeenCalled();
  });
});

describe('request validation', () => {
  it('rejects malformed JSON', async () => {
    const res = await POST(makeRequest('{ not json'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ authorized: false });
  });

  it.each([
    ['missing agentDid', { capability: 'messages:write' }],
    ['missing capability', { agentDid: AGENT }],
    ['empty agentDid', { agentDid: '', capability: 'messages:write' }],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await introspect(body);
    expect(res.status).toBe(400);
    expect(introspectGrantMock).not.toHaveBeenCalled();
  });
});

describe('resolution', () => {
  it('returns the introspection result and a short private cache header on success', async () => {
    introspectGrantMock.mockResolvedValue({ authorized: true, grantId: 'grant_1', delegatorDid: 'did:imajin:ryan', agentDid: AGENT });

    const res = await introspect({ agentDid: AGENT, capability: 'messages:write', targetDid: 'did:imajin:x' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ authorized: true, grantId: 'grant_1' });
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=5');
    expect(introspectGrantMock).toHaveBeenCalledWith({ agentDid: AGENT, capability: 'messages:write', targetDid: 'did:imajin:x' });
  });

  it('passes through an explicit denial without treating it as a failure', async () => {
    introspectGrantMock.mockResolvedValue({ authorized: false, reason: 'no matching grant' });

    const res = await introspect({ agentDid: AGENT, capability: 'messages:write' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: false, reason: 'no matching grant' });
  });

  it('fails closed (500, authorized: false) when the lookup itself throws', async () => {
    introspectGrantMock.mockRejectedValue(new Error('connection terminated'));

    const res = await introspect({ agentDid: AGENT, capability: 'messages:write' });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ authorized: false });
  });
});
