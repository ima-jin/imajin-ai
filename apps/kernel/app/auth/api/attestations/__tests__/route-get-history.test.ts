/**
 * Tests for GET /auth/api/attestations?history_of=... (#1790) — the
 * amendment-by-supersession chain-walk wiring. `resolveAttestationHistory`
 * itself is unit-tested directly in attestation-helpers.test.ts; this file
 * only pins that the route wires `history_of` to it and short-circuits
 * before the normal subject_did-required list path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  resolveAttestationHistory: vi.fn(),
}));

vi.mock('../attestation-helpers', () => ({
  resolveIssuedAt: vi.fn(),
  validateNostrKeyBinding: vi.fn(),
  deriveOriginUrl: vi.fn(),
  resolveEnvelopeFields: vi.fn(),
  verifyDelegatedAttestation: vi.fn(),
  validateSupersedesReference: vi.fn(),
  resolveAttestationHistory: h.resolveAttestationHistory,
}));

vi.mock('@/src/db', () => ({
  db: { select: vi.fn() },
  identities: {},
  attestations: {},
  tokens: {},
  attestationTypeRegistry: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(), and: vi.fn(), isNull: vi.fn(), ne: vi.fn(), gt: vi.fn(), desc: vi.fn(), notInArray: vi.fn(), inArray: vi.fn(),
}));

vi.mock('@/src/lib/auth/jwt', () => ({
  verifySessionToken: vi.fn(),
  getSessionCookieOptions: () => ({ name: 'session' }),
}));

vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));

vi.mock('@imajin/auth', () => ({
  canonicalize: vi.fn(),
  crypto: { verifySync: vi.fn() },
  ATTESTATION_TYPES: [],
  MECHANICAL_ATTESTATION_TYPES: [],
  verifyNostrSig: vi.fn(),
  evidenceGradeForAttestationStatus: vi.fn(),
  isDisclosureScope: vi.fn(),
}));

vi.mock('@imajin/cid', () => ({ computeCid: vi.fn() }));

vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: (req: unknown, ctx: unknown) => Promise<Response>) =>
    (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }),
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/bus', () => ({ publish: vi.fn() }));

vi.mock('@imajin/trust-graph', () => ({ trustRadius: vi.fn() }));

vi.mock('@/src/lib/auth/attestation-type-registry', () => ({
  isRegisteredAttestationType: vi.fn(),
}));

vi.mock('@/src/lib/auth/disclosure-access', () => ({
  resolveDisclosureAccess: vi.fn(),
}));

import { GET } from '../route';

function makeGetReq(url: string): NextRequest {
  return {
    url,
    cookies: { get: () => undefined },
    headers: new Headers(),
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /auth/api/attestations?history_of=... (#1790)', () => {
  it('returns the resolved chain history without requiring subject_did', async () => {
    h.resolveAttestationHistory.mockResolvedValue({
      chain: [{ id: 'att_v1', attestationStatus: 'superseded', supersedes: null }],
      openDisputes: [],
    });

    const res = await GET(makeGetReq('https://kernel.test/auth/api/attestations?history_of=att_v1'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      chain: [{ id: 'att_v1', attestationStatus: 'superseded', supersedes: null }],
      openDisputes: [],
    });
    expect(h.resolveAttestationHistory).toHaveBeenCalledWith('att_v1');
  });

  it('returns 404 when the id does not resolve to any attestation', async () => {
    h.resolveAttestationHistory.mockResolvedValue(null);

    const res = await GET(makeGetReq('https://kernel.test/auth/api/attestations?history_of=att_missing'));

    expect(res.status).toBe(404);
  });
});
