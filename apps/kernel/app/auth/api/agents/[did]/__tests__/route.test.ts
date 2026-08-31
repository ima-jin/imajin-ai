/**
 * Tests for DELETE /auth/api/agents/:did — agent revocation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  },
}));

const { mockSelectWhere, mockDbSelect, mockDbUpdate, mockRequireAuth } = vi.hoisted(() => {
  const mockSelectWhere = vi.fn();
  const mockDbSelect = vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(() => ({ limit: mockSelectWhere })) })),
  }));
  const mockDbUpdate = vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  }));
  const mockRequireAuth = vi.fn();
  return { mockSelectWhere, mockDbSelect, mockDbUpdate, mockRequireAuth };
});

vi.mock('@/src/db', () => ({
  db: { select: mockDbSelect, update: mockDbUpdate },
  identityMembers: {
    identityDid: 'identityMembers.identityDid',
    memberDid: 'identityMembers.memberDid',
    role: 'identityMembers.role',
    removedAt: 'identityMembers.removedAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  isNull: (...args: unknown[]) => ({ isNull: args }),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  authErrorResponse: (authError: { error: string; status: number }) =>
    new Response(JSON.stringify({ error: authError.error, onboarding: 'https://imajin.ai/.well-known/agent.json' }), {
      status: authError.status,
      headers: { 'Content-Type': 'application/json' },
    }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { DELETE } from '../route';

const CALLER_DID = 'did:imajin:ryan';
const AGENT_DID = 'did:imajin:jin';

function makeRequest(): Request {
  return new Request(`https://test.imajin.ai/auth/api/agents/${AGENT_DID}`, { method: 'DELETE' });
}

function params(did: string) {
  return { params: Promise.resolve({ did }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: CALLER_DID } });
});

describe('DELETE /auth/api/agents/:did', () => {
  it('propagates an unauthenticated caller', async () => {
    mockRequireAuth.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await DELETE(makeRequest(), params(AGENT_DID));

    expect(res.status).toBe(401);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('rejects a DID that is not a did:imajin address', async () => {
    const res = await DELETE(makeRequest(), params('not-a-did'));

    expect(res.status).toBe(400);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('returns 404 when the caller has no membership on the agent', async () => {
    mockSelectWhere.mockResolvedValue([]);

    const res = await DELETE(makeRequest(), params(AGENT_DID));

    expect(res.status).toBe(404);
  });

  it('returns 403 when the caller is not the owner', async () => {
    mockSelectWhere.mockResolvedValue([{ role: 'agent' }]);

    const res = await DELETE(makeRequest(), params(AGENT_DID));

    expect(res.status).toBe(403);
  });

  it('revokes the agent when the caller is the owner', async () => {
    mockSelectWhere.mockResolvedValue([{ role: 'owner' }]);

    const res = await DELETE(makeRequest(), params(AGENT_DID));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect(mockDbUpdate).toHaveBeenCalledOnce();
  });
});
