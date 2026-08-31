/**
 * Tests for GET /auth/api/attestations — intro-funnel envelope behavior (#1885):
 * disclosure_scope enforcement (scoped to registry-gated types only, legacy
 * types stay unrestricted), computed evidenceGrade annotation, and
 * decline-inclusive denominator queries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// Distinct object identities so the db mock can route `.from(table)` calls
// without depending on real Drizzle table shapes. Declared inside
// vi.hoisted since vi.mock factories are hoisted above regular top-level
// const declarations.
const mocks = vi.hoisted(() => ({
  ATTESTATIONS: { __table: 'attestations' },
  REGISTRY: { __table: 'attestation_type_registry' },
  attestationRows: [] as Record<string, unknown>[],
  registryRows: [] as Record<string, unknown>[],
  trustRadius: vi.fn(),
  verifySessionToken: vi.fn(),
}));

// Named helpers (rather than inline nested arrows) keep the mock chain
// under sonarjs's nested-function-depth budget.
function attestationsOrderBy() {
  return { limit: () => Promise.resolve(mocks.attestationRows) };
}

function dbFrom(table: unknown) {
  if (table === mocks.REGISTRY) {
    return { where: () => Promise.resolve(mocks.registryRows) };
  }
  return { where: () => ({ orderBy: attestationsOrderBy }) };
}

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: dbFrom }),
  },
  identities: {},
  attestations: mocks.ATTESTATIONS,
  attestationTypeRegistry: mocks.REGISTRY,
  tokens: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: (...args: unknown[]) => args,
  isNull: vi.fn(),
  gt: vi.fn(),
  desc: vi.fn(),
  notInArray: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@/src/lib/auth/jwt', () => ({
  verifySessionToken: mocks.verifySessionToken,
  getSessionCookieOptions: () => ({ name: 'session' }),
}));

vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));

vi.mock('@imajin/auth', () => ({
  canonicalize: (obj: unknown) => JSON.stringify(obj),
  crypto: { verifySync: () => true },
  ATTESTATION_TYPES: ['vouch'],
  MECHANICAL_ATTESTATION_TYPES: [],
  verifyNostrSig: vi.fn(),
  evidenceGradeForAttestationStatus: (status: string | null) => {
    if (status === 'pending') return 'unilateral';
    if (status === 'bilateral') return 'corroborated';
    if (status === 'declined') return 'disputed';
    return null;
  },
  isDisclosureScope: (v: string) => ['parties', 'connections', 'network', 'public'].includes(v),
}));

vi.mock('@imajin/cid', () => ({ computeCid: vi.fn() }));

vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: (req: unknown, ctx: unknown) => Promise<Response>) =>
    (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }),
  // The route module transitively imports grants.ts (via attestation-helpers'
  // delegation check, #1895/#1897), which calls createLogger at module scope.
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/bus', () => ({ publish: vi.fn() }));

vi.mock('@imajin/trust-graph', () => ({ trustRadius: mocks.trustRadius }));

vi.mock('@/src/lib/auth/attestation-type-registry', () => ({
  isRegisteredAttestationType: vi.fn(),
}));

import { GET } from '../route';

const SUBJECT = 'did:imajin:alice';
const ACTOR = 'did:imajin:agent';
const STRANGER = 'did:imajin:mallory';

function makeGetReq(url: string, opts: { sessionSub?: string } = {}): NextRequest {
  return {
    url,
    cookies: { get: () => (opts.sessionSub ? { value: 'session-token' } : undefined) },
    headers: new Headers(),
  } as unknown as NextRequest;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'att_1',
    subjectDid: SUBJECT,
    issuerDid: ACTOR,
    delegatorDid: null,
    type: 'consent_given',
    disclosureScope: 'parties',
    attestationStatus: 'pending',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attestationRows = [];
  mocks.registryRows = [];
  mocks.trustRadius.mockResolvedValue(new Set());
});

describe('GET /auth/api/attestations — disclosure_scope enforcement (#1885)', () => {
  it('returns legacy (non-registered) types unfiltered to an anonymous caller', async () => {
    mocks.attestationRows = [row({ type: 'vouch', disclosureScope: 'parties' })];
    mocks.registryRows = []; // 'vouch' is not in the registry

    const res = await GET(makeGetReq(`https://kernel.test/auth/api/attestations?subject_did=${SUBJECT}`));
    const body = await res.json();

    expect(body).toHaveLength(1);
  });

  it('hides a parties-scoped registered-type row from an anonymous caller', async () => {
    mocks.attestationRows = [row({ disclosureScope: 'parties' })];
    mocks.registryRows = [{ typeName: 'consent_given' }];

    const res = await GET(makeGetReq(`https://kernel.test/auth/api/attestations?subject_did=${SUBJECT}`));
    const body = await res.json();

    expect(body).toHaveLength(0);
  });

  it('shows a parties-scoped row to the subject', async () => {
    mocks.attestationRows = [row({ disclosureScope: 'parties' })];
    mocks.registryRows = [{ typeName: 'consent_given' }];
    mocks.verifySessionToken.mockResolvedValue({ sub: SUBJECT });

    const res = await GET(
      makeGetReq(`https://kernel.test/auth/api/attestations?subject_did=${SUBJECT}`, { sessionSub: SUBJECT }),
    );
    const body = await res.json();

    expect(body).toHaveLength(1);
  });

  it('hides a parties-scoped row from an authenticated non-party', async () => {
    mocks.attestationRows = [row({ disclosureScope: 'parties' })];
    mocks.registryRows = [{ typeName: 'consent_given' }];
    mocks.verifySessionToken.mockResolvedValue({ sub: STRANGER });

    const res = await GET(
      makeGetReq(`https://kernel.test/auth/api/attestations?subject_did=${SUBJECT}`, { sessionSub: STRANGER }),
    );
    const body = await res.json();

    expect(body).toHaveLength(0);
  });

  it('shows a network-scoped row to any authenticated caller but not to an anonymous one', async () => {
    mocks.attestationRows = [row({ disclosureScope: 'network' })];
    mocks.registryRows = [{ typeName: 'consent_given' }];

    const anon = await GET(makeGetReq(`https://kernel.test/auth/api/attestations?subject_did=${SUBJECT}`));
    expect(await anon.json()).toHaveLength(0);

    mocks.verifySessionToken.mockResolvedValue({ sub: STRANGER });
    const authed = await GET(
      makeGetReq(`https://kernel.test/auth/api/attestations?subject_did=${SUBJECT}`, { sessionSub: STRANGER }),
    );
    expect(await authed.json()).toHaveLength(1);
  });

  it('shows a public-scoped row to an anonymous caller', async () => {
    mocks.attestationRows = [row({ disclosureScope: 'public' })];
    mocks.registryRows = [{ typeName: 'consent_given' }];

    const res = await GET(makeGetReq(`https://kernel.test/auth/api/attestations?subject_did=${SUBJECT}`));
    expect(await res.json()).toHaveLength(1);
  });

  it('shows a connections-scoped row to a trust-graph neighbor of the subject, hides it from a non-neighbor', async () => {
    mocks.attestationRows = [row({ disclosureScope: 'connections' })];
    mocks.registryRows = [{ typeName: 'consent_given' }];
    mocks.verifySessionToken.mockResolvedValue({ sub: STRANGER });

    mocks.trustRadius.mockResolvedValue(new Set([SUBJECT]));
    const neighbor = await GET(
      makeGetReq(`https://kernel.test/auth/api/attestations?subject_did=${SUBJECT}`, { sessionSub: STRANGER }),
    );
    expect(await neighbor.json()).toHaveLength(1);

    mocks.trustRadius.mockResolvedValue(new Set());
    const nonNeighbor = await GET(
      makeGetReq(`https://kernel.test/auth/api/attestations?subject_did=${SUBJECT}`, { sessionSub: STRANGER }),
    );
    expect(await nonNeighbor.json()).toHaveLength(0);
  });
});

describe('GET /auth/api/attestations — evidenceGrade annotation (#1885)', () => {
  it('annotates rows with the evidence grade derived from attestationStatus', async () => {
    mocks.attestationRows = [
      row({ id: 'att_pending', attestationStatus: 'pending', disclosureScope: 'public' }),
      row({ id: 'att_bilateral', attestationStatus: 'bilateral', disclosureScope: 'public' }),
      row({ id: 'att_declined', attestationStatus: 'declined', disclosureScope: 'public' }),
    ];
    mocks.registryRows = [{ typeName: 'consent_given' }];

    const res = await GET(makeGetReq(`https://kernel.test/auth/api/attestations?subject_did=${SUBJECT}`));
    const body = await res.json();

    expect(body).toEqual([
      expect.objectContaining({ id: 'att_pending', evidenceGrade: 'unilateral' }),
      expect.objectContaining({ id: 'att_bilateral', evidenceGrade: 'corroborated' }),
      expect.objectContaining({ id: 'att_declined', evidenceGrade: 'disputed' }),
    ]);
  });
});

describe('GET /auth/api/attestations — decline-included denominator queries (#1885)', () => {
  it('returns both consent_given and consent_declined rows for a subject, unfiltered', async () => {
    mocks.attestationRows = [
      row({ id: 'att_given', type: 'consent_given', attestationStatus: 'pending', disclosureScope: 'public' }),
      row({ id: 'att_declined', type: 'consent_declined', attestationStatus: 'declined', disclosureScope: 'public' }),
    ];
    mocks.registryRows = [{ typeName: 'consent_given' }, { typeName: 'consent_declined' }];

    const res = await GET(makeGetReq(`https://kernel.test/auth/api/attestations?subject_did=${SUBJECT}`));
    const body = await res.json();

    expect(body.map((r: { id: string }) => r.id)).toEqual(['att_given', 'att_declined']);
  });
});
