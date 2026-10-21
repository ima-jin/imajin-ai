import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const h = vi.hoisted(() => ({
  caller: vi.fn(), actor: vi.fn(), revoke: vi.fn(), limit: vi.fn(),
}));
vi.mock('@/app/auth/api/attestations/caller-did', () => ({ resolveCallerDid: h.caller }));
vi.mock('@/src/lib/auth/document-authorization', () => ({ requireDocumentActor: h.actor }));
vi.mock('@/src/lib/auth/revoke-agreement', () => ({ revokeAgreement: h.revoke }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: h.limit }) }) }) },
  attestations: {},
}));
vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));
import { POST } from '../../../../app/auth/api/attestations/[did]/revoke/route';
const request = new NextRequest('https://test.example/auth/api/attestations/att_agreement/revoke', { method: 'POST' });
const context = { params: Promise.resolve({ did: 'att_agreement' }) };
beforeEach(() => {
  vi.resetAllMocks();
  h.caller.mockResolvedValue('did:imajin:owner');
  h.actor.mockResolvedValue({ effectiveDid: 'did:imajin:org', actingHumanDid: 'did:imajin:owner' });
  h.limit.mockResolvedValue([{ id: 'att_agreement', type: 'agreement' }]);
  h.revoke.mockResolvedValue({ status: 200, id: 'att_agreement', revokedAt: new Date('2026-10-20T00:00:00Z') });
});
describe('agreement revocation route', () => {
  it('passes the authorized org and human to atomic signed revocation', async () => {
    const response = await POST(request, context);
    expect(response.status).toBe(200);
    expect(h.actor).toHaveBeenCalledWith(request, { write: true });
    expect(h.revoke).toHaveBeenCalledWith({
      attestationId: 'att_agreement', effectiveDid: 'did:imajin:org', actingHumanDid: 'did:imajin:owner',
    });
    expect(await response.json()).toEqual({ id: 'att_agreement', revokedAt: '2026-10-20T00:00:00.000Z' });
  });
  it('returns 401 before querying without a session', async () => {
    h.caller.mockResolvedValue(null);
    expect((await POST(request, context)).status).toBe(401);
    expect(h.limit).not.toHaveBeenCalled();
  });
  it('returns 404 for a missing agreement', async () => {
    h.limit.mockResolvedValue([]);
    expect((await POST(request, context)).status).toBe(404);
  });
  it('refuses a controller without allowed_services with no writes', async () => {
    h.actor.mockResolvedValue(new Response(JSON.stringify({ error: 'Not authorized to act as this group' }), { status: 403 }));
    expect((await POST(request, context)).status).toBe(403);
    expect(h.revoke).not.toHaveBeenCalled();
  });
  it.each([403, 409, 503])('preserves the signed revoke refusal %s', async (status) => {
    h.revoke.mockResolvedValue({ status, error: 'Refused' });
    const response = await POST(request, context);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: 'Refused' });
  });
});
