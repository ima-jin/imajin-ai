import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const h = vi.hoisted(() => ({
  actor: vi.fn(), select: vi.fn(), verify: vi.fn(), canRead: vi.fn(),
}));
vi.mock('@/src/lib/auth/document-authorization', () => ({ requireDocumentActor: h.actor, canReadDocument: h.canRead }));
vi.mock('@/src/lib/auth/verify-document', () => ({ verifyDocumentFile: h.verify }));
vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));
vi.mock('@/src/db', () => ({
  db: { select: h.select }, attestations: {}, attestationSignatures: {}, identities: {},
}));
import { POST } from '../../../../app/auth/api/documents/[id]/verify/route';
const org = 'did:imajin:org';
const buyer = 'did:imajin:buyer';
const context = { params: Promise.resolve({ id: 'att_agreement' }) };
function request(file: string | Blob | null = new Blob(['agreement'])) {
  const body = new FormData();
  if (file !== null) body.set('file', file);
  return new NextRequest('https://test.example/auth/api/documents/att_agreement/verify', { method: 'POST', body });
}
function rows(values: unknown[]) {
  return { from: () => ({ where: () => Object.assign(Promise.resolve(values), { limit: async () => values }) }) };
}
beforeEach(() => {
  vi.resetAllMocks();
  h.actor.mockResolvedValue({ effectiveDid: buyer, actingHumanDid: buyer });
  h.canRead.mockResolvedValue(true);
  h.select.mockReturnValueOnce(rows([{ issuerDid: org, documentHash: 'hash', totalSigners: 2, revokedAt: null }]))
    .mockReturnValueOnce(rows([{ signerDid: org }, { signerDid: buyer }]))
    .mockReturnValueOnce(rows([{ id: org, publicKey: 'org-key' }, { id: buyer, publicKey: 'buyer-key' }]));
  h.verify.mockResolvedValue({ valid: true, hashMatches: true, signaturesValid: true, revoked: false });
});

describe('document verify HTTP boundary', () => {
  it.each([org, buyer])('permits party %s to verify uploaded bytes', async (effectiveDid) => {
    h.actor.mockResolvedValue({ ok: true, effectiveDid, actingHumanDid: buyer });
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ valid: true });
    expect(h.verify.mock.calls[0][0]).toEqual(new TextEncoder().encode('agreement'));
    expect(h.actor).toHaveBeenCalledWith(expect.anything());
  });
  it('returns modified-file failure plainly, not a server error', async () => {
    h.verify.mockResolvedValue({ valid: false, hashMatches: false, signaturesValid: true, revoked: false });
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ valid: false, hashMatches: false });
  });
  it.each([401, 403])('refuses unauthorized request %s before DB access', async (status) => {
    h.actor.mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), { status }));
    expect((await POST(request(), context)).status).toBe(status);
    expect(h.select).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
  });
  it('refuses outsiders before reading upload bytes or keys', async () => {
    h.actor.mockResolvedValue({ effectiveDid: 'did:imajin:outsider', actingHumanDid: buyer });
    h.canRead.mockResolvedValue(false);
    expect((await POST(request(), context)).status).toBe(403);
    expect(h.select).toHaveBeenCalledTimes(2);
    expect(h.verify).not.toHaveBeenCalled();
  });
  it('returns 404 for an absent document', async () => {
    h.select.mockReset().mockReturnValue(rows([]));
    expect((await POST(request(), context)).status).toBe(404);
  });
  it.each([null, 'not a file'])('rejects absent or non-file upload', async (file) => {
    expect((await POST(request(file), context)).status).toBe(400);
    expect(h.verify).not.toHaveBeenCalled();
  });
  it('rejects malformed multipart input', async () => {
    const bad = new NextRequest('https://test.example', { method: 'POST', body: 'bad' });
    expect((await POST(bad, context)).status).toBe(400);
  });
  it('limits verification to 25MB', async () => {
    expect((await POST(request(new Blob([new Uint8Array(25 * 1024 * 1024 + 1)])), context)).status).toBe(413);
    expect(h.verify).not.toHaveBeenCalled();
  });
});
