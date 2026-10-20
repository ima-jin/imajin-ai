import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
const h = vi.hoisted(() => ({
  actor: vi.fn(), canRead: vi.fn(), select: vi.fn(), readFile: vi.fn(),
}));
vi.mock('@/src/lib/auth/document-authorization', () => ({ requireDocumentActor: h.actor, canReadDocument: h.canRead }));
vi.mock('node:fs/promises', () => ({ readFile: h.readFile }));
vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));
vi.mock('@/src/db', () => ({ db: { select: h.select }, attestations: {}, assets: {} }));
import { GET } from '../../../../app/auth/api/documents/[id]/content/route';
const bytes = Buffer.from('Exact private agreement');
const hash = createHash('sha256').update(bytes).digest('hex');
const context = { params: Promise.resolve({ id: 'att_agreement' }) };
function request(query = '') {
  return new NextRequest(`https://test.example/auth/api/documents/att_agreement/content${query}`);
}
function query(rows: unknown[]) {
  return { from: () => ({ where: () => ({ limit: async () => rows }) }) };
}
beforeEach(() => {
  vi.resetAllMocks();
  h.actor.mockResolvedValue({ effectiveDid: 'did:imajin:buyer', actingHumanDid: 'did:imajin:buyer' });
  h.canRead.mockResolvedValue(true);
  h.select.mockReturnValueOnce(query([{ issuerDid: 'did:imajin:org', documentAssetId: 'asset_exact', documentHash: hash }]))
    .mockReturnValueOnce(query([{ status: 'active', storagePath: '/fixture/exact.pdf', mimeType: 'application/pdf', filename: 'Exact agreement.pdf' }]));
  h.readFile.mockResolvedValue(bytes);
});
describe('private document content invitation', () => {
  it('lets an invited counterparty see only the exact hash-bound document before signing', async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-document-hash')).toBe(hash);
    expect(h.readFile).toHaveBeenCalledWith('/fixture/exact.pdf');
  });
  it('supports a safe download filename', async () => {
    const response = await GET(request('?download=true'), context);
    expect(response.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''Exact%20agreement.pdf");
  });
  it.each([401, 403])('refuses unauthorized caller with %s and no reads', async (status) => {
    h.actor.mockResolvedValue(new Response(null, { status }));
    expect((await GET(request(), context)).status).toBe(status);
    expect(h.select).not.toHaveBeenCalled();
    expect(h.readFile).not.toHaveBeenCalled();
  });
  it('never reads storage for an unrelated org document', async () => {
    h.canRead.mockResolvedValue(false);
    expect((await GET(request(), context)).status).toBe(403);
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(h.readFile).not.toHaveBeenCalled();
  });
  it('refuses a missing document or asset', async () => {
    h.select.mockReset().mockReturnValue(query([]));
    expect((await GET(request(), context)).status).toBe(404);
    expect(h.readFile).not.toHaveBeenCalled();
  });
  it('refuses a deleted asset', async () => {
    h.select.mockReset().mockReturnValueOnce(query([{ issuerDid: 'org', documentAssetId: 'asset', documentHash: hash }]))
      .mockReturnValueOnce(query([{ status: 'deleted' }]));
    expect((await GET(request(), context)).status).toBe(404);
  });
  it('reports a missing stored file without leaking its path', async () => {
    h.readFile.mockRejectedValue(new Error('/private/path unavailable'));
    const response = await GET(request(), context);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('/private/path');
  });
  it('refuses tampered storage bytes plainly', async () => {
    h.readFile.mockResolvedValue(Buffer.from('changed'));
    const response = await GET(request(), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Document hash mismatch — stored file has changed' });
  });
  it.each([['text/html', 'text/plain; charset=utf-8'], ['image/svg+xml', 'application/octet-stream']])(
    'never executes active document type %s', async (mimeType, expected) => {
      h.select.mockReset().mockReturnValueOnce(query([{ issuerDid: 'org', documentAssetId: 'asset', documentHash: hash }]))
        .mockReturnValueOnce(query([{ status: 'active', storagePath: '/fixture', mimeType, filename: 'file' }]));
      const response = await GET(request(), context);
      expect(response.headers.get('content-type')).toBe(expected);
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'self'");
    },
  );
});
