/**
 * Tests for POST /auth/api/knock/:knockId/accept (#1883) — mint-on-accept.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAuthMock, acceptKnockMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  acceptKnockMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  authErrorResponse: (authError: { error: string; status: number }) =>
    new Response(JSON.stringify({ error: authError.error, onboarding: 'https://imajin.ai/.well-known/agent.json' }), {
      status: authError.status,
      headers: { 'Content-Type': 'application/json' },
    }),
}));
vi.mock('@/src/lib/auth/knock', () => ({ acceptKnock: acceptKnockMock }));

import { POST } from '../route';

const TARGET = 'did:imajin:ryan';
const KNOCK_ID = 'knock_1';
const ENDPOINT = `http://localhost:3000/auth/api/knock/${KNOCK_ID}/accept`;

function makeRequest(): Parameters<typeof POST>[0] {
  return new Request(ENDPOINT, { method: 'POST' });
}

function params() {
  return { params: Promise.resolve({ knockId: KNOCK_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /auth/api/knock/:knockId/accept', () => {
  it('propagates an unauthenticated caller', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await POST(makeRequest(), params());

    expect(res.status).toBe(401);
    expect(acceptKnockMock).not.toHaveBeenCalled();
  });

  it('accepts using the directly authenticated identity as requestedBy', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: TARGET } });
    acceptKnockMock.mockResolvedValue({ result: { agentDid: 'did:imajin:agent', minted: true } });

    const res = await POST(makeRequest(), params());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agentDid: 'did:imajin:agent', minted: true });
    expect(acceptKnockMock).toHaveBeenCalledWith({ knockId: KNOCK_ID, requestedBy: TARGET });
  });

  it('sources requestedBy from actingAs', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:controller', actingAs: 'did:imajin:business' } });
    acceptKnockMock.mockResolvedValue({ result: { agentDid: 'did:imajin:agent', minted: false } });

    await POST(makeRequest(), params());

    expect(acceptKnockMock).toHaveBeenCalledWith({ knockId: KNOCK_ID, requestedBy: 'did:imajin:business' });
  });

  it('surfaces a lib-level error (e.g. not the declared target) with its own status', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: TARGET } });
    acceptKnockMock.mockResolvedValue({ error: 'Only the declared target may respond to this knock', status: 403 });

    const res = await POST(makeRequest(), params());

    expect(res.status).toBe(403);
  });
});
