import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const h = vi.hoisted(() => ({ actor: vi.fn(), get: vi.fn(), save: vi.fn() }));
vi.mock('@/src/lib/auth/document-authorization', () => ({ requireDocumentActor: h.actor }));
vi.mock('@/src/lib/profile/legal-entity', () => ({ getOwnerLegalEntity: h.get, saveLegalEntity: h.save }));
import { GET, PUT, DELETE } from '../route';
import { LEGAL_ENTITY_MAX_BYTES } from '@/src/lib/profile/legal-entity-schema';
import { legalEntityFixture, ownerDid, viewerDid } from '@/src/lib/profile/__tests__/legal-entity-fixture';
function request(body: unknown = legalEntityFixture(), headers?: HeadersInit) {
  return new NextRequest('https://test.example/auth/api/legal-entity', {
    method: 'PUT', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  h.actor.mockResolvedValue({ effectiveDid: ownerDid, actingHumanDid: viewerDid });
  h.get.mockResolvedValue(null);
});
describe('owner legal entity API', () => {
  it('loads private editing data with no-store', async () => {
    const document = { record: legalEntityFixture(), assetId: 'asset_legal', version: 2 };
    h.get.mockResolvedValue(document);
    const response = await GET(request());
    expect(await response.json()).toEqual({ document });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(h.actor).toHaveBeenCalledWith(expect.any(Request), { write: true });
    expect(h.get).toHaveBeenCalledWith(ownerDid);
  });
  it('saves only for the authenticated effective DID and records the actual human', async () => {
    const response = await PUT(request());
    expect(response.status).toBe(200);
    expect(h.save).toHaveBeenCalledWith(ownerDid, viewerDid, legalEntityFixture());
  });
  it('revokes the authenticated owner document', async () => {
    expect((await DELETE(request())).status).toBe(200);
    expect(h.save).toHaveBeenCalledWith(ownerDid, viewerDid, null);
  });
  it.each([GET, PUT, DELETE])('refuses unauthenticated/unauthorized callers before reading/writing', async handler => {
    for (const status of [401, 403]) {
      h.actor.mockResolvedValue(NextResponse.json({ error: 'Denied' }, { status }));
      expect((await handler(request())).status).toBe(status);
    }
    expect(h.get).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });
  it.each([
    ['legalName', { ...legalEntityFixture(), legalName: '' }],
    ['schema', { ...legalEntityFixture(), schema: 'legal-entity:v2' }],
    ['did', { ...legalEntityFixture(), did: 'foreign' }],
    ['taxNumbers', { ...legalEntityFixture(), taxNumbers: [] }],
    ['address.country', { ...legalEntityFixture(), address: { ...legalEntityFixture().address, country: 'ZZ' } }],
  ])('400 names the invalid %s', async (field, body) => {
    const response = await PUT(request(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(expect.objectContaining({ field, error: expect.stringContaining(field as string) }));
    expect(h.save).not.toHaveBeenCalled();
  });
  it.each(['{', 'null', '[]'])('400s malformed/non-record JSON %s', async body => {
    expect((await PUT(request(body))).status).toBe(400);
    expect(h.save).not.toHaveBeenCalled();
  });
  it('caps declared body bytes before consuming JSON', async () => {
    const response = await PUT(request({}, { 'content-length': String(LEGAL_ENTITY_MAX_BYTES + 1) }));
    expect(response.status).toBe(400);
    expect((await response.json()).field).toBe('legalEntity');
    expect(h.save).not.toHaveBeenCalled();
  });
  it('caps chunked and UTF-8 request bytes without trusting content-length', async () => {
    const response = await PUT(request('é'.repeat(LEGAL_ENTITY_MAX_BYTES / 2 + 1)));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('exceeds');
    expect(h.save).not.toHaveBeenCalled();
  });
  it('rejects an absent body', async () => {
    const response = await PUT(new NextRequest('https://test.example/auth/api/legal-entity', { method: 'PUT' }));
    expect(response.status).toBe(400);
  });
  it.each([GET, PUT, DELETE])('reports service failures without leaking signing/storage details', async handler => {
    h.get.mockRejectedValue(new Error('/private/storage signer unavailable'));
    h.save.mockRejectedValue(new Error('/private/storage signer unavailable'));
    const response = await handler(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('/private/storage');
  });
});
