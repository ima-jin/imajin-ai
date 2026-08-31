/**
 * Tests for POST /pay/api/settle's #1886 intro-attribution money-rule guard.
 *
 * These deliberately do NOT exercise the full settlement transaction path
 * (balances/transactions/db.transaction) — that is pre-existing, unrelated
 * surface. They isolate the new guard: it must run before any balance is
 * touched, be a no-op for ordinary (non intro-attribution) settlements, and
 * block on a failing verification with a 400 and never call `db.transaction`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { verifyIntroAttributionManifestForSettlementMock, dbTransactionMock } = vi.hoisted(() => ({
  verifyIntroAttributionManifestForSettlementMock: vi.fn(),
  dbTransactionMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/src/lib/fair/intro-attribution', () => ({
  verifyIntroAttributionManifestForSettlement: verifyIntroAttributionManifestForSettlementMock,
}));

function limitReturningEmpty() {
  return Promise.resolve([]);
}
function whereClause() {
  return { limit: limitReturningEmpty };
}
function fromClause() {
  return { where: whereClause };
}
function selectClause() {
  return { from: fromClause };
}

vi.mock('@/src/db', () => ({
  db: {
    select: selectClause,
    transaction: dbTransactionMock,
  },
  balances: {},
  transactions: {},
  identities: {},
  identityChains: {},
}));

vi.mock('@imajin/fair', () => ({
  verifyManifest: vi.fn().mockResolvedValue({ valid: true }),
}));

vi.mock('@imajin/auth', () => ({
  createDbResolver: () => async () => 'fake-public-key',
}));

vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

import { POST } from '../route';

const ENDPOINT = 'http://localhost:3000/pay/api/settle';
const API_KEY = 'test-api-key';

function makeRequest(body: unknown): NextRequestLike {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  }) as unknown as NextRequestLike;
}

type NextRequestLike = Parameters<typeof POST>[0];

const BASE_BODY = {
  from_did: 'did:imajin:buyer',
  total_amount: 100,
  service: 'market',
  type: 'sale',
  funded: true,
  funded_provider: 'stripe',
  fair_manifest: { chain: [{ did: 'did:imajin:seller', amount: 100, role: 'seller' }] },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PAY_SERVICE_API_KEY = API_KEY;
  verifyIntroAttributionManifestForSettlementMock.mockResolvedValue({ ok: true });
  dbTransactionMock.mockResolvedValue(undefined);
});

describe('POST /pay/api/settle — intro-attribution guard (#1886)', () => {
  it('calls the guard with the submitted fair_manifest for every settlement', async () => {
    await POST(makeRequest(BASE_BODY));

    expect(verifyIntroAttributionManifestForSettlementMock).toHaveBeenCalledWith(BASE_BODY.fair_manifest);
  });

  it('proceeds to settle when the guard is a no-op (ordinary, non intro-attribution manifest)', async () => {
    const res = await POST(makeRequest(BASE_BODY));

    expect(res.status).toBe(200);
    expect(dbTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('rejects with 400 and never touches the balance transaction when the guard fails', async () => {
    verifyIntroAttributionManifestForSettlementMock.mockResolvedValue({
      ok: false,
      error: 'attribution window has expired for this intro',
    });

    const res = await POST(makeRequest(BASE_BODY));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/attribution window has expired/);
    expect(dbTransactionMock).not.toHaveBeenCalled();
  });

  it('rejects an uncountersigned value_realized-backed manifest before settling', async () => {
    verifyIntroAttributionManifestForSettlementMock.mockResolvedValue({
      ok: false,
      error: 'value_realized attestation att_1 must be countersigned (bilateral) before it can trigger settlement',
    });

    const res = await POST(
      makeRequest({
        ...BASE_BODY,
        fair_manifest: {
          type: 'intro-attribution',
          provenance: [{ attestationId: 'att_1', type: 'value_realized' }],
          chain: [{ did: 'did:imajin:matchmaker', amount: 100, role: 'matchmaker' }],
        },
      }),
    );

    expect(res.status).toBe(400);
    expect(dbTransactionMock).not.toHaveBeenCalled();
  });
});
