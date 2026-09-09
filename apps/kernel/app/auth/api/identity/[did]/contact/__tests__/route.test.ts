/**
 * Tests for POST /auth/api/identity/:did/contact (#2058, sibling of
 * #1999/#2053's eligibility/evaluate route). Only the new POST handler is
 * covered here — the pre-existing GET handler (NOTIFY_WEBHOOK_SECRET auth)
 * is untouched by #2058 and out of scope.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const API_KEY = 'internal-api-key';
const DID = 'did:imajin:buyer';

const h = vi.hoisted(() => ({
  mockDbUpdate: vi.fn(),
  mockDbSelect: vi.fn(),
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

vi.mock('@/src/db', () => ({
  db: {
    update: (...args: unknown[]) => h.mockDbUpdate(...args),
    select: (...args: unknown[]) => h.mockDbSelect(...args),
  },
  identities: { id: 'col_id', contactEmail: 'col_contact_email' },
  credentials: { did: 'col_did', type: 'col_type', value: 'col_value' },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { POST } from '../route';

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
  process.env.ATTESTATION_INTERNAL_API_KEY = API_KEY;
});

describe('POST /auth/api/identity/:did/contact', () => {
  it('rejects when the API key is missing or wrong', async () => {
    const res = await POST(makeReq({ email: 'a@b.com' }, 'wrong-key'), makeParams(DID));
    expect(res.status).toBe(401);
    expect(h.mockDbUpdate).not.toHaveBeenCalled();
  });

  it('rejects when ATTESTATION_INTERNAL_API_KEY is not configured server-side', async () => {
    delete process.env.ATTESTATION_INTERNAL_API_KEY;
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
