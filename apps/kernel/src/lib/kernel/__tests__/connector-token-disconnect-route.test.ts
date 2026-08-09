/**
 * Tests for the shared token-paste connector disconnect route factory (#1720).
 *
 * Every sealed token-paste connector (Gemini, Anthropic, GCP) gets its
 * disconnect handler from here: revoke the sealed key's delegation grant for
 * the ACTING DID, and never claim success on a thrown revoke.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth } = vi.hoisted(() => ({ mockRequireAuth: vi.fn() }));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://app.imajin.ai' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createConnectorTokenDisconnectRoute } from '../connector-token-route';

const OWNER = 'did:imajin:veteze';

const revokeApiKey = vi.fn();

const { POST, OPTIONS } = createConnectorTokenDisconnectRoute({
  name: 'TestProvider',
  revokeApiKey,
});

type RouteRequest = Parameters<typeof POST>[0];

function makeReq(): RouteRequest {
  return { headers: new Headers() } as unknown as RouteRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: OWNER } });
  revokeApiKey.mockResolvedValue(true);
});

describe('token disconnect route — POST', () => {
  it('revokes the sealed key for the acting DID', async () => {
    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    expect(revokeApiKey).toHaveBeenCalledWith(OWNER);
  });

  it('reports connected: false plus whether a grant was actually revoked', async () => {
    revokeApiKey.mockResolvedValueOnce(true);
    const res = await POST(makeReq());
    expect(await res.json()).toEqual({ connected: false, revoked: true });
  });

  it('reports revoked: false when there was nothing to revoke', async () => {
    revokeApiKey.mockResolvedValueOnce(false);
    const res = await POST(makeReq());
    expect(await res.json()).toEqual({ connected: false, revoked: false });
  });

  it('returns 401 without revoking when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await POST(makeReq());

    expect(res.status).toBe(401);
    expect(revokeApiKey).not.toHaveBeenCalled();
  });

  it('carries CORS headers', async () => {
    const res = await POST(makeReq());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.imajin.ai');
  });

  it('reports a revoke failure without claiming success', async () => {
    revokeApiKey.mockRejectedValueOnce(new Error('db unavailable'));

    const res = await POST(makeReq());

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'Failed to revoke TestProvider API key' });
  });
});

describe('token disconnect route — OPTIONS', () => {
  it('answers CORS pre-flight', async () => {
    expect((await OPTIONS(makeReq())).status).toBe(204);
  });
});
