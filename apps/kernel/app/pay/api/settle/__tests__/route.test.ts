/**
 * Tests for the settlement core's #1886 intro-attribution money-rule guard
 * (moved off the HTTP route by #2642 — the route is now app-contract only).
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
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: () => new Response(null, { status: 204 }),
}));

import { settlePayment, type SettlePaymentParams } from '@/src/lib/pay/settle-core';

/**
 * #2642: `POST /pay/api/settle` no longer takes the shared key / arbitrary
 * (from_did, amount, unit, funded) bodies — that surface is the registered-app
 * contract (see `app-settle-route.test.ts`). These characterization tests pin
 * the settlement CORE every settler shares, so they drive `settlePayment()`
 * directly with the same snake_case request shape they always used.
 */
type SettleBody = {
  from_did: string;
  total_amount: number;
  service: string;
  type: string;
  fair_manifest: SettlePaymentParams['fair_manifest'];
  funded?: boolean;
  funded_provider?: string;
  unit?: string;
  accepted_units?: string[];
};

function makeRequest(body: SettleBody): SettleBody {
  return body;
}

async function POST(body: SettleBody): Promise<{ status: number; json: () => Promise<any> }> {
  const result = await settlePayment({
    from_did: body.from_did,
    total_amount: body.total_amount,
    service: body.service,
    type: body.type,
    fair_manifest: body.fair_manifest,
    funded: body.funded,
    funded_provider: body.funded_provider,
    unit: body.unit,
    acceptedUnits: body.accepted_units,
  });
  if ('error' in result) return { status: result.status, json: async () => ({ error: result.error }) };
  return { status: 200, json: async () => result };
}

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
  verifyIntroAttributionManifestForSettlementMock.mockResolvedValue({ ok: true });
  dbTransactionMock.mockResolvedValue(undefined);
});

describe('settlePayment() — intro-attribution guard (#1886)', () => {
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
