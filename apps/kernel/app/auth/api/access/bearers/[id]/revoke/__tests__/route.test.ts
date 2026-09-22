/**
 * Tests for POST /auth/api/access/bearers/:id/revoke (#2252) — tombstone,
 * immediate effect, and the not-found/forbidden 404 collapse (never
 * disclosing whether a bearer id owned by someone else exists).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockRevokeDelegateGrantBearer } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockRevokeDelegateGrantBearer: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@/src/lib/access/delegate-grant', () => ({
  revokeDelegateGrantBearer: mockRevokeDelegateGrantBearer,
}));

import { POST, OPTIONS } from '../route';

const PRINCIPAL_DID = 'did:imajin:ryan';

function makeReq(): Request {
  return new Request('https://test.imajin.ai/auth/api/access/bearers/dgb_1/revoke', { method: 'POST' });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: PRINCIPAL_DID, scope: 'actor', subtype: 'human' } });
});

describe('OPTIONS /auth/api/access/bearers/:id/revoke', () => {
  it('delegates to the shared CORS preflight handler', async () => {
    const res = await OPTIONS(makeReq() as Parameters<typeof OPTIONS>[0]);
    expect(res.status).toBe(204);
  });
});

describe('POST /auth/api/access/bearers/:id/revoke', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await POST(makeReq() as Parameters<typeof POST>[0], params('dgb_1'));
    expect(res.status).toBe(401);
    expect(mockRevokeDelegateGrantBearer).not.toHaveBeenCalled();
  });

  it('passes the caller as requestedByDid, never trusting a body-supplied identity', async () => {
    mockRevokeDelegateGrantBearer.mockResolvedValue('revoked');
    await POST(makeReq() as Parameters<typeof POST>[0], params('dgb_1'));
    expect(mockRevokeDelegateGrantBearer).toHaveBeenCalledWith({ bearerId: 'dgb_1', requestedByDid: PRINCIPAL_DID });
  });

  it('returns 200 ok on revoked', async () => {
    mockRevokeDelegateGrantBearer.mockResolvedValue('revoked');
    const res = await POST(makeReq() as Parameters<typeof POST>[0], params('dgb_1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body).toEqual({ ok: true, status: 'revoked' });
  });

  it('returns 200 ok idempotently on already_revoked', async () => {
    mockRevokeDelegateGrantBearer.mockResolvedValue('already_revoked');
    const res = await POST(makeReq() as Parameters<typeof POST>[0], params('dgb_1'));
    expect(res.status).toBe(200);
  });

  it('collapses not_found into a plain 404', async () => {
    mockRevokeDelegateGrantBearer.mockResolvedValue('not_found');
    const res = await POST(makeReq() as Parameters<typeof POST>[0], params('missing'));
    expect(res.status).toBe(404);
  });

  it("collapses forbidden (someone else's bearer) into the SAME 404 as not_found", async () => {
    mockRevokeDelegateGrantBearer.mockResolvedValue('forbidden');
    const res = await POST(makeReq() as Parameters<typeof POST>[0], params('dgb_owned_by_someone_else'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Bearer not found');
  });
});
