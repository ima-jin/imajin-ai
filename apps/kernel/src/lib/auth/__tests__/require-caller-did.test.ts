/**
 * Unit tests for the shared provisioner-route auth preamble (#1933).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  authErrorResponse: (authError: { error: string; status: number }) =>
    new Response(JSON.stringify({ error: authError.error, onboarding: 'https://imajin.ai/.well-known/agent.json' }), {
      status: authError.status,
      headers: { 'Content-Type': 'application/json' },
    }),
}));

import { resolveCallerIdentity, isCallerIdentityError } from '../require-caller-did';

const ENDPOINT = 'http://localhost:3000/auth/api/agents/provision';

function makeRequest(): Parameters<typeof resolveCallerIdentity>[0] {
  return new Request(ENDPOINT) as unknown as Parameters<typeof resolveCallerIdentity>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveCallerIdentity', () => {
  it('returns an error response when the caller is unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const result = await resolveCallerIdentity(makeRequest());

    expect(isCallerIdentityError(result)).toBe(true);
    if (isCallerIdentityError(result)) {
      expect(result.errorResponse.status).toBe(401);
    }
  });

  it('resolves callerDid from identity.id when there is no actingAs', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:ryan' } });

    const result = await resolveCallerIdentity(makeRequest());

    expect(isCallerIdentityError(result)).toBe(false);
    if (!isCallerIdentityError(result)) {
      expect(result.callerDid).toBe('did:imajin:ryan');
      expect(result.identity.id).toBe('did:imajin:ryan');
    }
  });

  it('prefers actingAs over id when group-impersonating', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:admin', actingAs: 'did:imajin:group' } });

    const result = await resolveCallerIdentity(makeRequest());

    expect(isCallerIdentityError(result)).toBe(false);
    if (!isCallerIdentityError(result)) {
      expect(result.callerDid).toBe('did:imajin:group');
    }
  });

  it('preserves actingFor on the returned identity for callers to inspect', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:agent', actingFor: 'did:imajin:ryan' } });

    const result = await resolveCallerIdentity(makeRequest());

    expect(isCallerIdentityError(result)).toBe(false);
    if (!isCallerIdentityError(result)) {
      expect(result.identity.actingFor).toBe('did:imajin:ryan');
      expect(result.callerDid).toBe('did:imajin:agent');
    }
  });
});
