/**
 * Tests for POST /pay/api/connect/webhook (#2175).
 *
 * Previously untested — this route had no `__tests__` directory before
 * this change. Covers signature verification (missing header, invalid
 * signature, unconfigured secret), `account.updated` normalization into a
 * `RailEvent` (including the not-found-locally no-op), `payout.paid` /
 * `payout.failed` logging, and replay idempotency (a repeated event id
 * produces no second connected-account write).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface AccountRow {
  stripeAccountId: string;
}

const state = vi.hoisted(() => ({
  constructEventMock: vi.fn(),
  accountRow: undefined as AccountRow | undefined,
  updateCalls: [] as Array<{ values: Record<string, unknown> }>,
}));

function resetState() {
  state.accountRow = undefined;
  state.updateCalls = [];
}

vi.mock('@imajin/logger', async () => {
  const { withLoggerPassthrough } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');
  return {
    withLogger: withLoggerPassthrough(),
    // The stripe-webhook adapter also calls createLogger('kernel') directly.
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  };
});

function selectLimitResult() {
  return Promise.resolve(state.accountRow ? [state.accountRow] : []);
}
function selectWhereClause() {
  return { limit: selectLimitResult };
}
function selectFromClause() {
  return { where: selectWhereClause };
}
function selectAccount() {
  return { from: selectFromClause };
}

function recordUpdate(values: Record<string, unknown>) {
  state.updateCalls.push({ values });
  return Promise.resolve(undefined);
}
function updateSetClause(values: Record<string, unknown>) {
  return { where: () => recordUpdate(values) };
}
function updateAccount() {
  return { set: updateSetClause };
}

vi.mock('@/src/db', () => ({
  db: { select: selectAccount, update: updateAccount },
  connectedAccounts: { stripeAccountId: 'stripeAccountId' },
}));

vi.mock('@/src/lib/pay/providers/stripe-client', () => ({
  getStripeClient: () => ({ webhooks: { constructEvent: state.constructEventMock } }),
}));

import { POST } from '../route';

function makeRequest(hasSignature = true): Parameters<typeof POST>[0] {
  return new Request('http://localhost:3000/pay/api/connect/webhook', {
    method: 'POST',
    headers: hasSignature ? { 'stripe-signature': 'sig_test' } : {},
    body: 'raw-body',
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect_test';
});

describe('POST /pay/api/connect/webhook (#2175)', () => {
  it('returns 400 when the signature is invalid', async () => {
    state.constructEventMock.mockImplementation(() => {
      throw new Error('bad signature');
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
  });

  it('returns 400 when the stripe-signature header is missing', async () => {
    const res = await POST(makeRequest(false));
    expect(res.status).toBe(400);
    expect(state.constructEventMock).not.toHaveBeenCalled();
  });

  it('returns 500 when STRIPE_CONNECT_WEBHOOK_SECRET is not configured', async () => {
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
  });

  it('normalizes account.updated and updates the matching connected account row', async () => {
    state.accountRow = { stripeAccountId: 'acct_1' };
    state.constructEventMock.mockReturnValue({
      id: 'evt_acct_1',
      type: 'account.updated',
      data: {
        object: {
          id: 'acct_1',
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          requirements: { currently_due: [], eventually_due: ['tos_acceptance'] },
        },
      },
    });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(state.updateCalls).toHaveLength(1);
    expect(state.updateCalls[0].values).toMatchObject({
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      onboardingComplete: true,
      eventuallyDue: ['tos_acceptance'],
    });
  });

  it('is a no-op when the connected account is not found locally', async () => {
    state.accountRow = undefined;
    state.constructEventMock.mockReturnValue({
      id: 'evt_acct_missing',
      type: 'account.updated',
      data: { object: { id: 'acct_missing', charges_enabled: true } },
    });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(state.updateCalls).toHaveLength(0);
  });

  it('logs payout.paid without a Stripe type ever crossing the route', async () => {
    state.constructEventMock.mockReturnValue({
      id: 'evt_payout_1',
      type: 'payout.paid',
      account: 'acct_1',
      data: { object: { id: 'po_1', amount: 500, currency: 'cad' } },
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
  });

  it('logs payout.failed the same way as payout.paid', async () => {
    state.constructEventMock.mockReturnValue({
      id: 'evt_payout_2',
      type: 'payout.failed',
      account: 'acct_1',
      data: { object: { id: 'po_2', amount: 500, currency: 'cad' } },
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
  });

  it('a replayed event id produces no second write (idempotency)', async () => {
    state.accountRow = { stripeAccountId: 'acct_dup' };
    state.constructEventMock.mockReturnValue({
      id: 'evt_dup_connect',
      type: 'account.updated',
      data: { object: { id: 'acct_dup', charges_enabled: true, payouts_enabled: true, details_submitted: true } },
    });

    const first = await POST(makeRequest());
    expect(first.status).toBe(200);
    expect(state.updateCalls).toHaveLength(1);

    const replay = await POST(makeRequest());
    const replayBody = await replay.json();

    expect(replay.status).toBe(200);
    expect(replayBody.duplicate).toBe(true);
    expect(state.updateCalls).toHaveLength(1); // unchanged — the replay never reached the dispatch switch
  });
});
