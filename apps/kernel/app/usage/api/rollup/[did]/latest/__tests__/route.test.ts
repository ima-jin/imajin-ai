import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';

const { mockSelectLimit, mockSelectWhere, mockDbSelect } = vi.hoisted(() => {
  const mockSelectLimit = vi.fn().mockResolvedValue([]);
  const mockSelectOrderBy = vi.fn(() => ({ limit: mockSelectLimit }));
  const mockSelectWhere = vi.fn(() => ({ orderBy: mockSelectOrderBy }));
  const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere }));
  const mockDbSelect = vi.fn(() => ({ from: mockSelectFrom }));
  return { mockSelectLimit, mockSelectWhere, mockDbSelect };
});

vi.mock('@/src/db', () => ({
  db: { select: mockDbSelect },
  attestations: {
    id: 'id',
    type: 'type',
    subjectDid: 'subject_did',
    issuerDid: 'issuer_did',
    revokedAt: 'revoked_at',
    issuedAt: 'issued_at',
    payload: 'payload',
    signature: 'signature',
    contextId: 'context_id',
    contextType: 'context_type',
    cid: 'cid',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  desc: (col: unknown) => ({ desc: col }),
  isNull: (col: unknown) => ({ isNull: col }),
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://example.test' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

vi.mock('@/src/lib/usage/rollup', () => ({
  contextIdFor: (did: string, windowStart: Date) => `usage-rollup:${did}:${windowStart.toISOString().slice(0, 10)}`,
}));

import { GET, OPTIONS } from '../route';

const OWNER_DID = 'did:imajin:owner';
const BASE_URL = `https://kernel.test/usage/api/rollup/${encodeURIComponent(OWNER_DID)}/latest`;

type RouteParams = { params: Promise<{ did: string }> };

function makeReq(url = BASE_URL): NextRequest {
  return new NextRequest(url);
}

function makeParams(did: string = encodeURIComponent(OWNER_DID)): RouteParams {
  return { params: Promise.resolve({ did }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectLimit.mockResolvedValue([]);
});

describe('GET /usage/api/rollup/{did}/latest (public)', () => {
  it('requires no authentication at all', async () => {
    mockSelectLimit.mockResolvedValueOnce([
      { id: 'att_1', type: 'usage.rollup', subjectDid: OWNER_DID, issuerDid: 'did:imajin:node', contextId: null, contextType: null, signature: 'sig', cid: null, issuedAt: new Date('2026-08-02T00:00:00.000Z'), payload: {} },
    ]);

    const res = await GET(makeReq(), makeParams());

    expect(res.status).toBe(200);
  });

  it('returns 404 when no rollup attestation exists for the DID', async () => {
    mockSelectLimit.mockResolvedValueOnce([]);

    const res = await GET(makeReq(), makeParams());

    expect(res.status).toBe(404);
  });

  it('returns the full self-verifiable envelope exactly as stored — no field-by-field projection', async () => {
    const payload = {
      windowStart: '2026-08-01T00:00:00.000Z',
      windowEnd: '2026-08-02T00:00:00.000Z',
      totalCostEstimateUsd: 4.2,
      breakdown: [{ resource: 'model:anthropic/claude', source: 's', quantity: 1, unit: 'tokens', costEstimateUsd: 4.2 }],
      attestationClass: 'system',
      issuerDid: 'did:imajin:node',
      actingFor: OWNER_DID,
      source: 'usage-rollup-cron',
      context_id: 'usage-rollup:did:imajin:owner:2026-08-01',
      context_type: 'usage.rollup',
    };
    const issuedAt = new Date('2026-08-02T00:00:00.123Z');
    mockSelectLimit.mockResolvedValueOnce([
      {
        id: 'att_1',
        type: 'usage.rollup',
        subjectDid: OWNER_DID,
        issuerDid: 'did:imajin:node',
        contextId: 'usage-rollup:did:imajin:owner:2026-08-01',
        contextType: 'usage.rollup',
        signature: 'deadbeef',
        cid: 'bafy-test',
        issuedAt,
        payload,
      },
    ]);

    const res = await GET(makeReq(), makeParams());
    const body = await res.json();

    expect(body).toEqual({
      id: 'att_1',
      type: 'usage.rollup',
      issuerDid: 'did:imajin:node',
      subjectDid: OWNER_DID,
      contextId: 'usage-rollup:did:imajin:owner:2026-08-01',
      contextType: 'usage.rollup',
      payload,
      issuedAt: issuedAt.toISOString(),
      issuedAtMs: issuedAt.getTime(),
      signature: 'deadbeef',
      cid: 'bafy-test',
    });
    // No incurred/billed rows or connector ids leak through.
    expect(body).not.toHaveProperty('windowStart');
    expect(body).not.toHaveProperty('totalCostEstimateUsd');
  });

  /**
   * #2030 acceptance criterion: "the signature must verify against the
   * node DID." This reconstructs the exact canonical bytes
   * `emitMechanicalAttestation` signs (`canonicalize({ subject_did, type,
   * context_id, context_type, payload, issued_at })`) using ONLY fields
   * present in the route's JSON response, and verifies the signature
   * against a real Ed25519 keypair — proving a third party never needs
   * anything else from this node to check it.
   */
  it('returns a response whose signature independently verifies against the issuer public key', async () => {
    const keypair = authCrypto.generateKeypair();
    const payload = {
      windowStart: '2026-08-01T00:00:00.000Z',
      windowEnd: '2026-08-02T00:00:00.000Z',
      totalCostEstimateUsd: 4.2,
      breakdown: [{ resource: 'model:anthropic/claude', source: 's', quantity: 1, unit: 'tokens', costEstimateUsd: 4.2 }],
      attestationClass: 'system',
      issuerDid: 'did:imajin:node',
      actingFor: OWNER_DID,
      source: 'usage-rollup-cron',
      context_id: 'usage-rollup:did:imajin:owner:2026-08-01',
      context_type: 'usage.rollup',
    };
    const issuedAtMs = Date.UTC(2026, 7, 2, 0, 0, 0, 456);
    const contextId = 'usage-rollup:did:imajin:owner:2026-08-01';
    const contextType = 'usage.rollup';
    const type = 'usage.rollup';

    // Sign EXACTLY the way emit-mechanical-attestation.ts does.
    const canonicalPayload = canonicalize({
      subject_did: OWNER_DID,
      type,
      context_id: contextId,
      context_type: contextType,
      payload,
      issued_at: issuedAtMs,
    });
    const signature = authCrypto.signSync(canonicalPayload, keypair.privateKey);

    mockSelectLimit.mockResolvedValueOnce([
      {
        id: 'att_1',
        type,
        subjectDid: OWNER_DID,
        issuerDid: 'did:imajin:node',
        contextId,
        contextType,
        signature,
        cid: null,
        issuedAt: new Date(issuedAtMs),
        payload,
      },
    ]);

    const res = await GET(makeReq(), makeParams());
    const body = await res.json();

    // Reconstruct the canonical bytes from the RESPONSE ALONE (no other lookup).
    const rebuiltCanonical = canonicalize({
      subject_did: body.subjectDid,
      type: body.type,
      context_id: body.contextId,
      context_type: body.contextType,
      payload: body.payload,
      issued_at: body.issuedAtMs,
    });

    expect(rebuiltCanonical).toBe(canonicalPayload);
    expect(authCrypto.verifySync(body.signature, rebuiltCanonical, keypair.publicKey)).toBe(true);
  });

  it('filters on the specific contextId when ?window=YYYY-MM-DD is given', async () => {
    await GET(makeReq(`${BASE_URL}?window=2026-08-01`), makeParams());

    expect(mockSelectWhere).toHaveBeenCalledWith(
      expect.objectContaining({
        and: expect.arrayContaining([{ eq: ['context_id', `usage-rollup:${OWNER_DID}:2026-08-01`] }]),
      }),
    );
  });

  it('rejects a malformed window date', async () => {
    const res = await GET(makeReq(`${BASE_URL}?window=not-a-date`), makeParams());
    expect(res.status).toBe(400);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('marks the response as no-store', async () => {
    mockSelectLimit.mockResolvedValueOnce([
      { id: 'att_1', type: 'usage.rollup', subjectDid: OWNER_DID, issuerDid: 'did:imajin:node', contextId: null, contextType: null, signature: 'sig', cid: null, issuedAt: new Date(), payload: {} },
    ]);

    const res = await GET(makeReq(), makeParams());
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns 500 without leaking the underlying failure when the query throws', async () => {
    mockSelectLimit.mockImplementationOnce(() => {
      throw new Error('db down');
    });

    const res = await GET(makeReq(), makeParams());

    expect(res.status).toBe(500);
  });

  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq());
    expect(res.status).toBe(204);
  });
});
