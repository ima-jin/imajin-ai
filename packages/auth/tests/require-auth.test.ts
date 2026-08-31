/**
 * Tests for `requireAuth`'s X-Acting-For branch (#1887): grants-first
 * resolution via `/auth/api/internal/verify-delegation`, falling back to
 * the legacy role='agent' membership check (`validateActingAs` against
 * `/api/groups/:groupDid/controllers/:controllerDid`) only when the
 * dual-read endpoint itself is unreachable or unconfigured.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const AGENT = 'did:imajin:jin';
const PRINCIPAL = 'did:imajin:ryan';
const SESSION_TOKEN = 'session-token-abc';
const INTERNAL_KEY = 'test-internal-key';
const ATTESTATION_KEY = 'test-attestation-key';

function sessionRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://kernel.test/api/whatever', {
    headers: { cookie: `imajin_session=${SESSION_TOKEN}`, ...headers },
  });
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  process.env.AUTH_SERVICE_URL = 'https://auth.test';
  process.env.AUTH_INTERNAL_API_KEY = INTERNAL_KEY;
  process.env.ATTESTATION_INTERNAL_API_KEY = ATTESTATION_KEY;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  delete process.env.AUTH_SERVICE_URL;
  delete process.env.AUTH_INTERNAL_API_KEY;
  delete process.env.ATTESTATION_INTERNAL_API_KEY;
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** The session-validation call every requireAuth() invocation makes first. */
function mockSessionOk(did = AGENT) {
  fetchMock.mockImplementationOnce((url: string) => {
    expect(url).toBe('https://auth.test/api/session');
    return Promise.resolve(jsonResponse({ did, scope: 'actor' }));
  });
}

describe('requireAuth — X-Acting-For grants-first resolution (#1887)', () => {
  it('authorizes via the dual-read endpoint when it reports an active grant, without ever calling the legacy controllers endpoint', async () => {
    const { requireAuth } = await import('../src/require-auth');
    mockSessionOk();
    fetchMock.mockImplementationOnce((url: string, init: RequestInit) => {
      expect(url).toBe('https://auth.test/api/internal/verify-delegation');
      expect((init.headers as Record<string, string>)['x-internal-key']).toBe(INTERNAL_KEY);
      expect(JSON.parse(init.body as string)).toEqual({ agentDid: AGENT, principalDid: PRINCIPAL });
      return Promise.resolve(jsonResponse({ allowed: true, via: 'grant', grantId: 'grant_1' }));
    });

    const result = await requireAuth(sessionRequest({ 'x-acting-for': PRINCIPAL }));

    expect('identity' in result && result.identity.actingFor).toBe(PRINCIPAL);
    expect('identity' in result && result.identity.actingForRole).toBe('agent');
    expect(fetchMock).toHaveBeenCalledTimes(2); // session + verify-delegation only
  });

  it('authorizes via the dual-read endpoint reporting a membership fallback', async () => {
    const { requireAuth } = await import('../src/require-auth');
    mockSessionOk();
    fetchMock.mockImplementationOnce(() => Promise.resolve(jsonResponse({ allowed: true, via: 'membership' })));

    const result = await requireAuth(sessionRequest({ 'x-acting-for': PRINCIPAL }));

    expect('identity' in result && result.identity.actingFor).toBe(PRINCIPAL);
  });

  it('falls back to the legacy membership-only controllers check when AUTH_INTERNAL_API_KEY is unset', async () => {
    delete process.env.AUTH_INTERNAL_API_KEY;
    const { requireAuth } = await import('../src/require-auth');
    mockSessionOk();
    fetchMock.mockImplementationOnce((url: string, init: RequestInit) => {
      expect(url).toBe(`https://auth.test/api/groups/${encodeURIComponent(PRINCIPAL)}/controllers/${encodeURIComponent(AGENT)}`);
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ATTESTATION_KEY}`);
      return Promise.resolve(jsonResponse({ valid: true, role: 'agent', allowedServices: null }));
    });

    const result = await requireAuth(sessionRequest({ 'x-acting-for': PRINCIPAL }));

    expect('identity' in result && result.identity.actingFor).toBe(PRINCIPAL);
    expect('identity' in result && result.identity.actingForRole).toBe('agent');
  });

  it('falls back to the legacy membership check when the dual-read endpoint errors', async () => {
    const { requireAuth } = await import('../src/require-auth');
    mockSessionOk();
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error('ECONNREFUSED')));
    fetchMock.mockImplementationOnce(() => Promise.resolve(jsonResponse({ valid: true, role: 'agent', allowedServices: null })));

    const result = await requireAuth(sessionRequest({ 'x-acting-for': PRINCIPAL }));

    expect('identity' in result && result.identity.actingFor).toBe(PRINCIPAL);
  });

  it('falls back to the legacy membership check when the dual-read endpoint responds with a non-2xx status', async () => {
    const { requireAuth } = await import('../src/require-auth');
    mockSessionOk();
    fetchMock.mockImplementationOnce(() => Promise.resolve(jsonResponse({}, false, 500)));
    fetchMock.mockImplementationOnce(() => Promise.resolve(jsonResponse({ valid: true, role: 'agent', allowedServices: null })));

    const result = await requireAuth(sessionRequest({ 'x-acting-for': PRINCIPAL }));

    expect('identity' in result && result.identity.actingFor).toBe(PRINCIPAL);
  });

  it.each([
    'rejects when the dual-read endpoint denies outright',
    'rejects when both the dual-read endpoint and the legacy fallback deny',
  ])('%s', async () => {
    const { requireAuth } = await import('../src/require-auth');
    mockSessionOk();
    fetchMock.mockImplementationOnce(() => Promise.resolve(jsonResponse({ allowed: false, via: 'none' })));

    const result = await requireAuth(sessionRequest({ 'x-acting-for': PRINCIPAL }));

    expect(result).toEqual({ error: 'Not authorized to act for this identity', status: 403 });
  });

  it('does not consult X-Acting-For resolution at all when the header is absent', async () => {
    const { requireAuth } = await import('../src/require-auth');
    mockSessionOk();

    const result = await requireAuth(sessionRequest());

    expect('identity' in result && result.identity.actingFor).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1); // session only
  });
});
