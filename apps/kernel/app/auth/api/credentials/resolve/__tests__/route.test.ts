/**
 * Tests for POST /auth/api/credentials/resolve (#1992/#1983) — the internal
 * route that replaced the raw SQL `packages/auth/src/credentials.ts` used to
 * run directly against `auth.credentials`, `profile.profiles`, and
 * `auth.identities` for `getEmailForDid`/`getDidForEmail`/`resolveDidForEmail`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { describeInternalApiKeyAuth, makeInternalKeyRequest } from '../../../__tests__/internal-api-key-auth-test-support';

const API_KEY = 'internal-api-key';
const DID = 'did:imajin:kia';

const h = vi.hoisted(() => ({ mockDbSelect: vi.fn() }));

function makeSelectChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(async () => result);
  return chain;
}

vi.mock('@/src/db', () => ({
  db: { select: (...args: unknown[]) => h.mockDbSelect(...args) },
  credentials: { did: 'col_did', type: 'col_type', value: 'col_value' },
  identities: { id: 'col_id', contactEmail: 'col_contact_email' },
  profiles: { did: 'col_did', contactEmail: 'col_contact_email' },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { POST } from '../route';

function makeReq(body: unknown, apiKey: string | undefined = API_KEY): NextRequest {
  return makeInternalKeyRequest(body, apiKey);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ATTESTATION_INTERNAL_API_KEY = API_KEY;
});

describeInternalApiKeyAuth({
  routeLabel: 'POST /auth/api/credentials/resolve',
  post: POST,
  apiKey: API_KEY,
  validBody: { did: DID },
  assertNoSideEffect: () => expect(h.mockDbSelect).not.toHaveBeenCalled(),
});

describe('POST /auth/api/credentials/resolve — invalid request body', () => {
  it('returns 400 for invalid JSON', async () => {
    const req = {
      headers: new Headers({ authorization: `Bearer ${API_KEY}` }),
      json: async () => { throw new Error('bad'); },
    } as unknown as NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/api/credentials/resolve — request validation', () => {
  it('returns 400 when neither did nor email is provided', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it('returns 400 when both did and email are provided', async () => {
    const res = await POST(makeReq({ did: DID, email: 'kia@example.com' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for an unknown mode', async () => {
    const res = await POST(makeReq({ email: 'kia@example.com', mode: 'bogus' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/api/credentials/resolve — email-for-did (getEmailForDid)', () => {
  it('resolves the credentials-only email for a DID', async () => {
    h.mockDbSelect.mockReturnValue(makeSelectChain([{ value: 'kia@example.com' }]));

    const res = await POST(makeReq({ did: DID }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'kia@example.com' });
    expect(h.mockDbSelect).toHaveBeenCalledTimes(1);
  });

  it('returns null when the DID has no email credential', async () => {
    h.mockDbSelect.mockReturnValue(makeSelectChain([]));

    const res = await POST(makeReq({ did: DID }));

    expect(await res.json()).toEqual({ email: null });
  });
});

describe('POST /auth/api/credentials/resolve — did-for-email (getDidForEmail / resolveDidForEmail)', () => {
  it('mode=credential queries only auth.credentials', async () => {
    h.mockDbSelect.mockReturnValue(makeSelectChain([{ did: DID }]));

    const res = await POST(makeReq({ email: '  Kia@Example.com ', mode: 'credential' }));

    expect(await res.json()).toEqual({ did: DID });
    expect(h.mockDbSelect).toHaveBeenCalledTimes(1);
  });

  it('mode=full (default) resolves via auth.credentials and never queries the fallbacks when it hits', async () => {
    h.mockDbSelect.mockReturnValue(makeSelectChain([{ did: DID }]));

    const res = await POST(makeReq({ email: 'kia@example.com' }));

    expect(await res.json()).toEqual({ did: DID });
    expect(h.mockDbSelect).toHaveBeenCalledTimes(1);
  });

  it('mode=full falls back to profile.profiles then auth.identities in precedence order', async () => {
    h.mockDbSelect
      .mockReturnValueOnce(makeSelectChain([])) // auth.credentials miss
      .mockReturnValueOnce(makeSelectChain([])) // profile.profiles miss
      .mockReturnValueOnce(makeSelectChain([{ did: DID }])); // auth.identities hit

    const res = await POST(makeReq({ email: 'kia@example.com' }));

    expect(await res.json()).toEqual({ did: DID });
    expect(h.mockDbSelect).toHaveBeenCalledTimes(3);
  });

  it('mode=full returns null when no source matches', async () => {
    h.mockDbSelect.mockReturnValue(makeSelectChain([]));

    const res = await POST(makeReq({ email: 'nobody@example.com' }));

    expect(await res.json()).toEqual({ did: null });
    expect(h.mockDbSelect).toHaveBeenCalledTimes(3);
  });
});

describe('POST /auth/api/credentials/resolve — failure handling', () => {
  it('returns 500 when the database query throws', async () => {
    h.mockDbSelect.mockImplementation(() => { throw new Error('db down'); });

    const res = await POST(makeReq({ did: DID }));
    expect(res.status).toBe(500);
  });
});
