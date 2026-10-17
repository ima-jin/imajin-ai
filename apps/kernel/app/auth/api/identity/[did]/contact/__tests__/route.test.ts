/**
 * Tests for POST /auth/api/identity/:did/contact (#2058, sibling of
 * #1999/#2053's eligibility/evaluate route). Only the new POST handler is
 * covered here — GET uses the same vault-sourced internal Bearer contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { useVaultInternalKey } from '../../../../__tests__/internal-api-key-auth-test-support';

const API_KEY = 'internal-api-key';
const DID = 'did:imajin:buyer';

const h = vi.hoisted(() => ({
  mockDbUpdate: vi.fn(),
  mockDbSelect: vi.fn(),
  mockProfileUpdate: vi.fn(),
  authenticate: vi.fn(),
  related: vi.fn(),
}));
vi.mock('@/src/lib/profile/app-contact-auth', () => ({
  authenticateContactApp: h.authenticate,
  relatedContactDids: h.related,
}));

function makeUpdateChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.returning = vi.fn(async () => result);
  return chain;
}

function makeSelectChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(async () => result);
  return chain;
}

vi.mock('@/src/lib/vault/internal-secret', async () =>
  (await import('@/app/auth/api/__tests__/internal-api-key-auth-test-support')).internalSecretModuleMock);

vi.mock('@/src/db', () => {
  const profiles = { did: 'profile_did', contactEmail: 'profile_contact_email' };
  const db = {
    update: (table: unknown) => table === profiles ? h.mockProfileUpdate() : h.mockDbUpdate(table),
    select: (...args: unknown[]) => h.mockDbSelect(...args),
    transaction: async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(db),
  };
  return {
    db,
    profiles,
    identities: { id: 'col_id', contactEmail: 'col_contact_email' },
    credentials: { did: 'col_did', type: 'col_type', value: 'col_value' },
  };
});

describe('registered-app contact backfill', () => {
  beforeEach(() => {
    h.authenticate.mockResolvedValue({ appDid: 'did:imajin:events' });
    h.related.mockResolvedValue([DID]);
    h.mockDbUpdate.mockReturnValue(makeUpdateChain([{ contactEmail: 'buyer@example.com' }]));
  });

  it('accepts the exact write scope and target relationship and redacts the address', async () => {
    const response = await POST(makeReq({ email: ' Buyer@Example.com ' }, 'app-token'), makeParams(DID));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ did: DID, contactEmail: null, backfilled: true });
    expect(h.authenticate).toHaveBeenCalledWith(expect.anything(), 'profile:contact:backfill');
    expect(h.related).toHaveBeenCalledWith('did:imajin:events', [DID], 'profile:contact:backfill');
    expect(h.mockProfileUpdate).toHaveBeenCalledOnce();
  });

  it('never returns the existing email on a write-only no-op', async () => {
    h.mockDbUpdate.mockReturnValue(makeUpdateChain([]));
    h.mockDbSelect.mockReturnValue(makeSelectChain([{ contactEmail: 'private@example.com' }]));
    const response = await POST(makeReq({ email: 'new@example.com' }, 'app-token'), makeParams(DID));
    expect(await response.json()).toEqual({ did: DID, contactEmail: null, backfilled: false });
  });

  it.each([401, 403])('rejects invalid or unscoped tokens (%s) without writes', async (status) => {
    h.authenticate.mockResolvedValue({ error: 'Denied', status });
    const response = await POST(makeReq({ email: 'a@b.com' }, 'app-token'), makeParams(DID));
    expect(response.status).toBe(status);
    expect(h.mockDbUpdate).not.toHaveBeenCalled();
    expect(h.mockProfileUpdate).not.toHaveBeenCalled();
    expect(h.related).not.toHaveBeenCalled();
  });

  it('rejects another app with no relationship without reading or writing contact data', async () => {
    h.authenticate.mockResolvedValue({ appDid: 'did:imajin:other' });
    h.related.mockResolvedValue([]);
    const response = await POST(makeReq({ email: 'a@b.com' }, 'other-app-token'), makeParams(DID));
    expect(response.status).toBe(403);
    expect(h.mockDbUpdate).not.toHaveBeenCalled();
    expect(h.mockDbSelect).not.toHaveBeenCalled();
    expect(h.mockProfileUpdate).not.toHaveBeenCalled();
  });

  it('fails closed on authorization store failure', async () => {
    h.related.mockRejectedValue(new Error('store down'));
    const response = await POST(makeReq({ email: 'a@b.com' }, 'app-token'), makeParams(DID));
    expect(response.status).toBe(503);
    expect(h.mockDbUpdate).not.toHaveBeenCalled();
  });

  it.each([null, [], 'email', { email: 5 }])('rejects malformed JSON values: %j', async (body) => {
    expect((await POST(makeReq(body, 'app-token'), makeParams(DID))).status).toBe(400);
    expect(h.mockDbUpdate).not.toHaveBeenCalled();
  });

  it('does not add app authentication to the internal GET', async () => {
    expect((await GET(makeReq({}, 'app-token'), makeParams(DID))).status).toBe(401);
    expect(h.authenticate).not.toHaveBeenCalled();
    expect(h.mockDbSelect).not.toHaveBeenCalled();
  });

  it('fills a missing profile email even when the identity email was already set', async () => {
    h.mockDbUpdate.mockReturnValue(makeUpdateChain([]));
    h.mockDbSelect.mockReturnValue(makeSelectChain([{ contactEmail: 'existing@example.com' }]));
    const profile = makeUpdateChain([{ did: DID }]);
    h.mockProfileUpdate.mockReturnValue(profile);
    const response = await POST(makeReq({ email: 'Buyer@Example.com' }), makeParams(DID));
    expect(await response.json()).toEqual({ did: DID, contactEmail: 'existing@example.com', backfilled: true });
    expect(profile.set).toHaveBeenCalledWith({ contactEmail: 'buyer@example.com' });
  });
});

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { GET, POST } from '../route';

function makeReq(body: unknown, apiKey: string | undefined = API_KEY): NextRequest {
  const headers = new Headers();
  if (apiKey !== undefined) headers.set('authorization', `Bearer ${apiKey}`);
  return { headers, json: async () => body } as unknown as NextRequest;
}

function makeParams(did: string) {
  return { params: Promise.resolve({ did }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  useVaultInternalKey(API_KEY);
  h.authenticate.mockResolvedValue({ error: 'Unauthorized', status: 401 });
  h.related.mockResolvedValue([]);
  h.mockProfileUpdate.mockReturnValue(makeUpdateChain([]));
});

describe('POST /auth/api/identity/:did/contact', () => {
  it('rejects when the API key is missing or wrong', async () => {
    const res = await POST(makeReq({ email: 'a@b.com' }, 'wrong-key'), makeParams(DID));
    expect(res.status).toBe(401);
    expect(h.mockDbUpdate).not.toHaveBeenCalled();
  });

  it('fails closed when the vault has no ATTESTATION_INTERNAL_API_KEY value', async () => {
    useVaultInternalKey(undefined);
    const res = await POST(makeReq({ email: 'a@b.com' }), makeParams(DID));
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid JSON', async () => {
    const req = {
      headers: new Headers({ authorization: `Bearer ${API_KEY}` }),
      json: async () => { throw new Error('bad'); },
    } as unknown as NextRequest;
    const res = await POST(req, makeParams(DID));
    expect(res.status).toBe(400);
  });

  it('returns 400 when email is missing', async () => {
    const res = await POST(makeReq({}), makeParams(DID));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'email required' });
  });

  it('returns 400 when email is blank after trimming', async () => {
    const res = await POST(makeReq({ email: '   ' }), makeParams(DID));
    expect(res.status).toBe(400);
  });

  it('backfills contact_email and reports backfilled: true when the NULL guard allows the write', async () => {
    h.mockDbUpdate.mockReturnValue(makeUpdateChain([{ contactEmail: 'buyer@example.com' }]));

    const res = await POST(makeReq({ email: 'Buyer@Example.com ' }), makeParams(DID));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ did: DID, contactEmail: 'buyer@example.com', backfilled: true });
    expect(h.mockDbSelect).not.toHaveBeenCalled();
  });

  it('normalizes the email (lowercase + trim) before writing', async () => {
    const chain = makeUpdateChain([{ contactEmail: 'buyer@example.com' }]);
    h.mockDbUpdate.mockReturnValue(chain);

    await POST(makeReq({ email: '  Buyer@Example.com  ' }), makeParams(DID));

    expect(chain.set).toHaveBeenCalledWith({ contactEmail: 'buyer@example.com' });
  });

  it('reports backfilled: false without a write when the identity already has a contact_email', async () => {
    h.mockDbUpdate.mockReturnValue(makeUpdateChain([])); // NULL guard blocked the write
    h.mockDbSelect.mockReturnValue(makeSelectChain([{ contactEmail: 'existing@example.com' }]));

    const res = await POST(makeReq({ email: 'new@example.com' }), makeParams(DID));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ did: DID, contactEmail: 'existing@example.com', backfilled: false });
  });

  it('returns 404 when the identity does not exist', async () => {
    h.mockDbUpdate.mockReturnValue(makeUpdateChain([]));
    h.mockDbSelect.mockReturnValue(makeSelectChain([]));

    const res = await POST(makeReq({ email: 'new@example.com' }), makeParams(DID));
    expect(res.status).toBe(404);
  });

  it('returns 500 when the database write throws', async () => {
    h.mockDbUpdate.mockImplementation(() => { throw new Error('db down'); });

    const res = await POST(makeReq({ email: 'new@example.com' }), makeParams(DID));
    expect(res.status).toBe(500);
  });
});


describe('GET /auth/api/identity/:did/contact', () => {
  it('resolves contact email using the vault internal Bearer', async () => {
    h.mockDbSelect.mockReturnValue(makeSelectChain([{ id: DID, contactEmail: 'buyer@example.com' }]));
    const response = await GET(makeReq({}), makeParams(DID));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ did: DID, email: 'buyer@example.com' });
  });
  it('rejects the retired notify header before looking up contact information', async () => {
    const req = { headers: new Headers({ 'x-webhook-secret': 'fake-retired-key' }) } as NextRequest;
    const response = await GET(req, makeParams(DID));
    expect(response.status).toBe(401);
    expect(h.mockDbSelect).not.toHaveBeenCalled();
  });
  it('fails closed when the vault internal credential is unavailable', async () => {
    useVaultInternalKey(undefined);
    expect((await GET(makeReq({}), makeParams(DID))).status).toBe(401);
    expect(h.mockDbSelect).not.toHaveBeenCalled();
  });
});
