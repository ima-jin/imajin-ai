/**
 * #2563 — every pay route's CORS preflight is the shared `corsOptions`
 * handler (a synchronous 204 with CORS headers). Routes are imported for
 * real; only their heavy collaborators (db, stripe, auth) are stubbed.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/src/db', () => ({}));
vi.mock('@/src/lib/pay/providers/stripe-client', () => ({ getStripeClient: vi.fn() }));
vi.mock('@/src/lib/pay/pay', () => ({ getPaymentService: vi.fn() }));
vi.mock('@imajin/auth', () => ({
  requireAuth: vi.fn(),
  resolveActingDid: vi.fn(),
  resolveEffectiveDid: vi.fn(),
}));

const ROUTES: Record<string, () => Promise<{ OPTIONS: (req: NextRequest) => unknown }>> = {
  'agent-cost-estimate': () => import('../agent-cost-estimate/route'),
  'balance/[did]': () => import('../balance/[did]/route'),
  'balance/event-topup': () => import('../balance/event-topup/route'),
  'balance/gift': () => import('../balance/gift/route'),
  'balance/topup': () => import('../balance/topup/route'),
  'balance/transfer': () => import('../balance/transfer/route'),
  'card-rail/check': () => import('../card-rail/check/route'),
  'charge-pledges': () => import('../charge-pledges/route'),
  charge: () => import('../charge/route'),
  checkout: () => import('../checkout/route'),
  emission: () => import('../emission/route'),
  escrow: () => import('../escrow/route'),
  refund: () => import('../refund/route'),
  settle: () => import('../settle/route'),
  'setup-intent': () => import('../setup-intent/route'),
  'topup/emt': () => import('../topup/emt/route'),
  'topup/stripe': () => import('../topup/stripe/route'),
  'transactions/[did]': () => import('../transactions/[did]/route'),
  'transactions/[did]/summary': () => import('../transactions/[did]/summary/route'),
};

// Cold route imports belong in a hook with an explicit budget, not inside the
// first `it()` that happens to trigger them: on a loaded CI runner that cost
// blew the 5s testTimeout elsewhere in the kernel suite (#2616).
const ROUTE_IMPORT_TIMEOUT_MS = 120_000;

type OptionsHandler = (req: NextRequest) => unknown;
const handlers: Record<string, OptionsHandler> = {};

describe('pay route CORS preflight', () => {
  beforeAll(async () => {
    await Promise.all(
      Object.entries(ROUTES).map(async ([name, load]) => {
        handlers[name] = (await load()).OPTIONS;
      }),
    );
  }, ROUTE_IMPORT_TIMEOUT_MS);

  it.each(Object.keys(ROUTES))('%s OPTIONS returns a synchronous 204 with CORS headers', (name) => {
    const response = handlers[name](
      new NextRequest('http://localhost/pay/api/x', { method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } }),
    ) as Response;
    // Not a Promise: the handler is synchronous now that it no longer awaits anything.
    expect(response).not.toBeInstanceOf(Promise);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS');
    expect(response.headers.get('Vary')).toBe('Origin');
  });
});
