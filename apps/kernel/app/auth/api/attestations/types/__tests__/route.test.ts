/**
 * Tests for GET/POST /auth/api/attestations/types (#1885) — the
 * registry-as-data extension surface. POST is gated on requireEstablishedDID
 * and always namespaces under the caller's own handle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  requireEstablishedDID: vi.fn(),
  listRegisteredAttestationTypes: vi.fn(),
  registerAttestationType: vi.fn(),
  resolveHandleForDid: vi.fn(),
}));

vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));

vi.mock('@imajin/auth', () => ({
  requireEstablishedDID: h.requireEstablishedDID,
  resolveActingDid: (identity: { actingFor?: string; actingAs?: string; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

vi.mock('@/src/lib/auth/attestation-type-registry', () => ({
  listRegisteredAttestationTypes: h.listRegisteredAttestationTypes,
  registerAttestationType: h.registerAttestationType,
  resolveHandleForDid: h.resolveHandleForDid,
}));

import { GET, POST } from '../route';

const DID = 'did:imajin:acme-agent';
const HANDLE = 'acme';

function makeReq(body?: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /auth/api/attestations/types', () => {
  it('lists registered types', async () => {
    h.listRegisteredAttestationTypes.mockResolvedValue([{ typeName: 'intro_proposed', namespace: 'platform' }]);

    const res = await GET(makeReq());
    const body = await res.json();

    expect(body).toEqual([{ typeName: 'intro_proposed', namespace: 'platform' }]);
  });
});

describe('POST /auth/api/attestations/types', () => {
  it('registers a type under the caller handle for an established identity', async () => {
    h.requireEstablishedDID.mockResolvedValue({ identity: { id: DID, handle: HANDLE, tier: 'established' } });
    h.registerAttestationType.mockResolvedValue({
      ok: true,
      entry: { typeName: `${HANDLE}/referral_made`, namespace: HANDLE, registeredByDid: DID },
    });

    const res = await POST(makeReq({ localName: 'referral_made', description: 'A referral was made' }));

    expect(res.status).toBe(201);
    expect(h.registerAttestationType).toHaveBeenCalledWith({
      registeredByDid: DID,
      handle: HANDLE,
      localName: 'referral_made',
      description: 'A referral was made',
    });
    const body = await res.json();
    expect(body.typeName).toBe('acme/referral_made');
  });

  it('rejects a non-established identity with the auth error', async () => {
    h.requireEstablishedDID.mockResolvedValue({ error: 'This action requires an established identity', status: 403 });

    const res = await POST(makeReq({ localName: 'referral_made' }));

    expect(res.status).toBe(403);
    expect(h.registerAttestationType).not.toHaveBeenCalled();
  });

  it('rejects when the identity has no handle to namespace under', async () => {
    h.requireEstablishedDID.mockResolvedValue({ identity: { id: DID, tier: 'established' } });
    h.resolveHandleForDid.mockResolvedValue(null);

    const res = await POST(makeReq({ localName: 'referral_made' }));

    expect(res.status).toBe(400);
    expect(h.registerAttestationType).not.toHaveBeenCalled();
  });

  it('requires localName', async () => {
    h.requireEstablishedDID.mockResolvedValue({ identity: { id: DID, handle: HANDLE, tier: 'established' } });

    const res = await POST(makeReq({}));

    expect(res.status).toBe(400);
    expect(h.registerAttestationType).not.toHaveBeenCalled();
  });

  it('surfaces a namespace/validation rejection from the registry as 409', async () => {
    h.requireEstablishedDID.mockResolvedValue({ identity: { id: DID, handle: 'platform', tier: 'established' } });
    h.registerAttestationType.mockResolvedValue({ ok: false, error: 'The "platform" namespace is reserved' });

    const res = await POST(makeReq({ localName: 'referral_made' }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/reserved/);
  });
});
