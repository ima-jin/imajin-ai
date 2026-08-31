/**
 * Tests for POST /auth/api/internal/verify-delegation (#1653, migrated to
 * grants-first dual-read resolution by #1887).
 *
 * The actual grants-first / membership-fallback logic lives in and is
 * thoroughly tested by `@/src/lib/auth/agent-authority`
 * (`agent-authority.test.ts`). This route is a thin, internal-key-guarded
 * HTTP wrapper around `resolveAgentAuthority`, so these tests focus on the
 * route's own responsibilities: caller authentication, request validation,
 * and translating the resolver's result/failure into the wire response.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { resolveAgentAuthorityMock } = vi.hoisted(() => ({
  resolveAgentAuthorityMock: vi.fn(),
}));

vi.mock('@/src/lib/auth/agent-authority', () => ({
  resolveAgentAuthority: resolveAgentAuthorityMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST } from '../route';

const INTERNAL_KEY = 'test-internal-key';
const AGENT = 'did:imajin:jin';
const PRINCIPAL = 'did:imajin:ryan';
const ENDPOINT = 'http://localhost:3000/auth/api/internal/verify-delegation';

type RouteRequest = Parameters<typeof POST>[0];

function makeRequest(
  body: string,
  { key = INTERNAL_KEY as string | null } = {},
): RouteRequest {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (key !== null) headers.set('x-internal-key', key);
  return new Request(ENDPOINT, { method: 'POST', headers, body }) as unknown as RouteRequest;
}

function verify(body: unknown, options?: { key?: string | null }) {
  return POST(makeRequest(JSON.stringify(body), options));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_INTERNAL_API_KEY = INTERNAL_KEY;
});

afterEach(() => {
  delete process.env.AUTH_INTERNAL_API_KEY;
});

describe('POST /auth/api/internal/verify-delegation — caller authentication', () => {
  it('rejects a request with no x-internal-key header', async () => {
    const res = await verify({ agentDid: AGENT, principalDid: PRINCIPAL }, { key: null });

    expect(res.status).toBe(401);
    expect(resolveAgentAuthorityMock).not.toHaveBeenCalled();
  });

  it('rejects a request with the wrong key', async () => {
    const res = await verify({ agentDid: AGENT, principalDid: PRINCIPAL }, { key: 'nope' });

    expect(res.status).toBe(401);
    expect(resolveAgentAuthorityMock).not.toHaveBeenCalled();
  });

  it('rejects every caller when AUTH_INTERNAL_API_KEY is unset', async () => {
    delete process.env.AUTH_INTERNAL_API_KEY;

    const res = await verify({ agentDid: AGENT, principalDid: PRINCIPAL }, { key: null });

    expect(res.status).toBe(401);
    expect(resolveAgentAuthorityMock).not.toHaveBeenCalled();
  });
});

describe('POST /auth/api/internal/verify-delegation — request body', () => {
  it('rejects a malformed JSON body', async () => {
    const res = await POST(makeRequest('{ not json'));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON' });
  });

  it.each([
    ['missing agentDid', { principalDid: PRINCIPAL }],
    ['missing principalDid', { agentDid: AGENT }],
    ['empty agentDid', { agentDid: '', principalDid: PRINCIPAL }],
    ['non-string principalDid', { agentDid: AGENT, principalDid: 42 }],
    ['a null body', null],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await verify(body);

    expect(res.status).toBe(400);
    expect(resolveAgentAuthorityMock).not.toHaveBeenCalled();
  });
});

describe('POST /auth/api/internal/verify-delegation — delegates to resolveAgentAuthority', () => {
  it('passes agentDid and principalDid through and returns an allowed grant result verbatim', async () => {
    resolveAgentAuthorityMock.mockResolvedValue({ allowed: true, via: 'grant', grantId: 'grant_1' });

    const res = await verify({ agentDid: AGENT, principalDid: PRINCIPAL });

    expect(resolveAgentAuthorityMock).toHaveBeenCalledWith(AGENT, PRINCIPAL);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: true, via: 'grant', grantId: 'grant_1' });
  });

  it('surfaces a membership-fallback result (the #1887 dual-read path)', async () => {
    resolveAgentAuthorityMock.mockResolvedValue({ allowed: true, via: 'membership' });

    const res = await verify({ agentDid: AGENT, principalDid: PRINCIPAL });

    expect(await res.json()).toEqual({ allowed: true, via: 'membership', grantId: undefined });
  });

  it('returns allowed: false when the resolver denies', async () => {
    resolveAgentAuthorityMock.mockResolvedValue({ allowed: false, via: 'none' });

    const res = await verify({ agentDid: AGENT, principalDid: PRINCIPAL });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ allowed: false });
  });

  it('denies rather than throwing when the resolver rejects (fail-closed on lookup failure)', async () => {
    resolveAgentAuthorityMock.mockRejectedValue(new Error('connection terminated'));

    const res = await verify({ agentDid: AGENT, principalDid: PRINCIPAL });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ allowed: false });
  });
});
