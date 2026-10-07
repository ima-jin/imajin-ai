/**
 * #2176 — the pay routes that write or read `pay.transactions.external_ref`:
 *
 *   - POST /api/checkout and POST /api/topup/stripe DUAL-WRITE `rail` + `external_ref` + the deprecated
 *     `stripe_id` alias (so step 5's DROP of `stripe_id` is safe);
 *   - GET /api/transactions/[did] keeps the public `stripe_id` field name, fed from `external_ref`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => {
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const selectedRows: { rows: unknown[] } = { rows: [] };
  const offset = vi.fn(async () => selectedRows.rows);
  const limit = vi.fn(() => ({ offset }));
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  return {
    insertValues,
    selectedRows,
    select: vi.fn(() => ({ from })),
    payCheckout: vi.fn(),
    requireAuth: vi.fn(),
  };
});

vi.mock('@/src/db', () => ({
  db: { insert: () => ({ values: mocks.insertValues }), select: mocks.select },
  transactions: {},
}));
vi.mock('@/src/lib/pay/pay', () => ({ getPaymentService: () => ({ checkout: mocks.payCheckout }) }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: () => new Response(null, { status: 204 }) }));
vi.mock('@imajin/config', () => ({
  rateLimit: () => ({ limited: false }),
  getClientIP: () => '127.0.0.1',
  buildPublicUrlAbsolute: (name: string) => `https://${name}.test`,
}));
vi.mock('@imajin/fair', () => ({ grossUpForProcessorFee: (_rail: string, cents: number) => cents }));
vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: (req: unknown, ctx: { log: unknown }) => Promise<Response>) => (req: unknown) =>
    handler(req, { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuth,
  requireAppAuth: vi.fn(),
  resolveActingDid: (identity: { id: string }) => identity.id,
}));
vi.mock('@/src/lib/pay/checkout', () => ({
  validateCheckoutBody: () => ({ ok: true }),
  resolveCheckoutIdentity: async () => ({ ok: true, identity: { id: 'did:imajin:buyer' } }),
  resolveConnectedAccountFee: async () => ({ ok: true, connectedAccountId: undefined, applicationFeeAmount: undefined }),
  taxLineItems: () => [],
}));

import { POST as checkoutPOST } from '../checkout/route';
import { POST as topupStripePOST } from '../topup/stripe/route';
import { GET as transactionsGET } from '../transactions/[did]/route';

const DID = 'did:imajin:buyer';

function jsonRequest(url: string, body: unknown): NextRequest {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertValues.mockResolvedValue(undefined);
  mocks.payCheckout.mockResolvedValue({ id: 'cs_route_1', url: 'https://checkout.test/cs_route_1', expiresAt: new Date('2026-01-01T00:00:00Z') });
  mocks.requireAuth.mockResolvedValue({ identity: { id: DID, handle: 'buyer', actingAs: null } });
  mocks.selectedRows.rows = [];
});

describe('writers dual-write rail + external_ref + stripe_id (#2176)', () => {
  it('POST /api/checkout: the pending transaction carries rail, external_ref and the stripe_id alias', async () => {
    const res = await checkoutPOST(
      jsonRequest('https://kernel.test/api/checkout', {
        items: [{ name: 'Ticket', amount: 1000, quantity: 1 }],
        currency: 'CAD',
        successUrl: 'https://app.test/ok',
        cancelUrl: 'https://app.test/cancel',
        metadata: { service: 'events', type: 'ticket' },
      }),
    );

    expect(res.status).toBe(200);
    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(mocks.insertValues.mock.calls[0][0]).toMatchObject({
      status: 'pending',
      rail: 'stripe',
      externalRef: 'cs_route_1',
      stripeId: 'cs_route_1',
    });
  });

  it('POST /api/topup/stripe: the pending top-up transaction carries rail, external_ref and the stripe_id alias', async () => {
    const res = await topupStripePOST(jsonRequest('https://kernel.test/pay/api/topup/stripe', { amount: 25 }));

    expect(res.status).toBe(200);
    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(mocks.insertValues.mock.calls[0][0]).toMatchObject({
      service: 'topup',
      status: 'pending',
      rail: 'stripe',
      externalRef: 'cs_route_1',
      stripeId: 'cs_route_1',
    });
  });
});

describe('GET /api/transactions/[did] (#2176)', () => {
  const txRow = {
    id: 'tx_1',
    service: 'topup',
    type: 'topup',
    fromDid: null,
    toDid: DID,
    amount: '25',
    currency: 'CAD',
    status: 'completed',
    metadata: {},
    fairManifest: null,
    batchId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  async function get() {
    const req = new Request(`https://kernel.test/pay/api/transactions/${DID}`) as unknown as NextRequest;
    return transactionsGET(req, { params: Promise.resolve({ did: DID }) });
  }

  it('keeps the public `stripe_id` field name but feeds it from external_ref', async () => {
    // `stripeId` deliberately disagrees: the response must come from `externalRef`.
    mocks.selectedRows.rows = [{ ...txRow, externalRef: 'cs_from_external_ref', stripeId: 'cs_from_alias' }];

    const res = await get();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.transactions[0].stripe_id).toBe('cs_from_external_ref');
  });

  it('returns a null stripe_id for a row with no external reference', async () => {
    mocks.selectedRows.rows = [{ ...txRow, externalRef: null, stripeId: 'cs_alias_only' }];

    const json = await (await get()).json();

    expect(json.transactions[0].stripe_id).toBeNull();
  });
});
