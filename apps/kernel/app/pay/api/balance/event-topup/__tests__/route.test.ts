/**
 * Tests for POST /api/balance/event-topup (#2016, #2018).
 *
 * The cash (refund) leg and credit (bonus) leg now land on separate
 * per-unit balance rows (MJN / MJNx), so each nonzero leg gets its own
 * transaction row.
 *
 * #2018: event-topup is a FUNDED TRANSFER, never a mint — from_did's MJN
 * balance backs the refund leg and its MJNx balance backs the bonus leg.
 * Funding sufficiency is enforced by a single guarded conditional UPDATE
 * per unit (`debitFundedLegs` / `debitUnitIfSufficient` in
 * `src/lib/pay/ledger.ts`), not a pre-transaction `getBalanceRow` read
 * compared in JS — the latter is a TOCTOU race that lets two concurrent
 * top-ups both pass a stale balance read and drive the ledger negative.
 * `state.returningQueue` simulates the `.returning()` result of each
 * guarded UPDATE: a non-empty array means the guard passed, `[]` means it
 * failed (insufficient balance).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { jsonPostRequest, resetMockDbCallState } from '@/src/lib/pay/__tests__/mock-drizzle-table';

const dialect = new PgDialect();

/**
 * Decode the numeric amount actually bound into a guarded UPDATE's SET
 * clause (`sql\`${balances.amount} - ${amountStr}\``) — the amount is the
 * last bound param regardless of whether `balances.amount` resolves to a
 * real Drizzle column or (as in this shared mock) a plain string; either
 * way the interpolated value itself is preserved as a bind param. Used to
 * assert the debited amount is supply-neutral: exactly what recipients
 * were credited, not just "some debit happened" (#2018 review round 2).
 */
function decodedDebitAmount(values: Record<string, unknown>): string {
  const { params } = dialect.sqlToQuery(values.amount as Parameters<PgDialect['sqlToQuery']>[0]);
  return String(params[params.length - 1]);
}

const state = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  balanceRowQueue: [] as Array<{ did: string; unit: string; amount: string; currency: string } | undefined>,
  returningQueue: [] as Array<Record<string, unknown>[]>,
  requireAuthMock: vi.fn(),
}));

vi.mock('@imajin/logger', async () => {
  const { withLoggerPassthrough } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');
  return { withLogger: withLoggerPassthrough() };
});

vi.mock('@imajin/auth', () => ({
  requireAuth: state.requireAuthMock,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

vi.mock('@/src/db', async () => {
  const { balanceRouteDbModule } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');
  return balanceRouteDbModule(state, { balanceRowQueue: state.balanceRowQueue, returningQueue: state.returningQueue });
});

vi.mock('@/src/lib/kernel/id', () => {
  let n = 0;
  return { generateId: (prefix: string) => `${prefix}_${n++}` };
});
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

import { POST } from '../route';

const FROM_DID = 'did:imajin:business';

function makeRequest(body: Record<string, unknown>): Request {
  return jsonPostRequest('https://kernel.test/api/balance/event-topup', body);
}

const BASE_BODY = {
  from_did: FROM_DID,
  event_id: 'evt_1',
  recipient_dids: ['did:imajin:r1'],
  metadata: { ticket_price: 10 },
};

beforeEach(() => {
  vi.clearAllMocks();
  resetMockDbCallState(state);
  state.requireAuthMock.mockResolvedValue({ identity: { id: FROM_DID } });
});

describe('POST /api/balance/event-topup — per-unit balance writes (#2016)', () => {
  it('rejects a missing multiplier', async () => {
    const res = await POST(makeRequest({ ...BASE_BODY }) as never);
    expect(res.status).toBe(400);
  });

  it('rejects multiplier below 1.0', async () => {
    const res = await POST(makeRequest({ ...BASE_BODY, multiplier: 0.5 }) as never);
    expect(res.status).toBe(400);
  });

  it('rejects a missing ticket_price', async () => {
    const res = await POST(makeRequest({ ...BASE_BODY, multiplier: 2, metadata: {} }) as never);
    expect(res.status).toBe(400);
  });

  it('forbids topping up from a DID other than the authenticated one', async () => {
    const res = await POST(makeRequest({ ...BASE_BODY, from_did: 'did:imajin:other', multiplier: 2 }) as never);
    expect(res.status).toBe(403);
  });

  it('rejects insufficient MJN balance with a 402, never a mint (#2018 guarded UPDATE)', async () => {
    state.returningQueue.push([]);
    const res = await POST(makeRequest({ ...BASE_BODY, multiplier: 2 }) as never);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/Insufficient MJN balance/);
    expect(state.updateCalls).toHaveLength(1);
    // Rollback evidence: no balance credit and no transaction row were ever
    // issued — the throw happens before the recipient-credit loop runs.
    expect(state.insertCalls.filter((c) => c.table === 'balances')).toHaveLength(0);
    expect(state.insertCalls.filter((c) => c.table !== 'balances')).toHaveLength(0);
  });

  it('rejects insufficient MJNx balance with a 402, never a mint, rolling back the already-succeeded MJN debit (#2018)', async () => {
    // MJN (refund) leg's guard passes, MJNx (bonus) leg's guard fails.
    state.returningQueue.push([{ did: FROM_DID, unit: 'MJN', amount: '90', currency: 'CAD' }], []);
    // ticket_price 10, multiplier 10 => bonus leg is 90 per recipient.
    const res = await POST(makeRequest({ ...BASE_BODY, multiplier: 10 }) as never);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/Insufficient MJNx balance/);
    expect(state.updateCalls).toHaveLength(2);
    // Rollback evidence: no credit statement (balance insert) and no
    // transaction row exist for this request — not even for the MJN leg
    // whose guarded UPDATE alone had succeeded.
    expect(state.insertCalls.filter((c) => c.table === 'balances')).toHaveLength(0);
    expect(state.insertCalls.filter((c) => c.table !== 'balances')).toHaveLength(0);
  });

  it('multiplier 1.0: only the MJN refund leg is written, no MJNx bonus', async () => {
    state.returningQueue.push([{ did: FROM_DID, unit: 'MJN', amount: '90', currency: 'CAD' }]);
    const res = await POST(makeRequest({ ...BASE_BODY, multiplier: 1.0 }) as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toHaveLength(1);

    const txValues = state.insertCalls.find((c) => c.values.type === 'event-topup')?.values;
    expect(txValues).toMatchObject({ unit: 'MJN', sourceKind: 'transfer' });
    // Only the refund leg's guarded debit runs — no MJNx debit when the bonus is 0.
    expect(state.updateCalls).toHaveLength(1);
  });

  it('multiplier > 1.0: writes both an MJN refund row and an MJNx bonus row, debiting from_did in both units (#2018)', async () => {
    state.returningQueue.push(
      [{ did: FROM_DID, unit: 'MJN', amount: '90', currency: 'CAD' }],
      [{ did: FROM_DID, unit: 'MJNx', amount: '10', currency: 'CAD' }],
    );
    const res = await POST(makeRequest({ ...BASE_BODY, multiplier: 10 }) as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toHaveLength(2);
    expect(body).toMatchObject({ cashPerRecipient: 10, creditPerRecipient: 90 });

    const txInserts = state.insertCalls.filter((c) => c.values.type === 'event-topup').map((c) => c.values);
    expect(txInserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unit: 'MJN', amount: '10' }),
        expect.objectContaining({ unit: 'MJNx', amount: '90' }),
      ]),
    );

    // Total supply is conserved: the business is debited exactly what the
    // recipient receives in each unit — one guarded debit per unit.
    expect(state.updateCalls).toHaveLength(2);

    // Supply-neutral: the actual numeric amount bound into each guarded
    // UPDATE's SET clause (not just "an update happened") equals exactly
    // what was credited in that unit. `debitFundedLegs` always attempts MJN
    // before MJNx, so update index 0/1 map to those legs in order.
    expect(decodedDebitAmount(state.updateCalls[0].values)).toBe('10');
    expect(decodedDebitAmount(state.updateCalls[1].values)).toBe('90');
  });

  it('debits the business by exactly the SUM of what all recipients receive, per unit (supply-neutral across multiple recipients) (#2018 review round 2)', async () => {
    state.returningQueue.push(
      [{ did: FROM_DID, unit: 'MJN', amount: '80', currency: 'CAD' }],
      [{ did: FROM_DID, unit: 'MJNx', amount: '820', currency: 'CAD' }],
    );
    // Two recipients: refund leg = ticket_price (10) each = 20 total; bonus
    // leg = ticket_price * (multiplier - 1) = 90 each = 180 total.
    const res = await POST(
      makeRequest({ ...BASE_BODY, recipient_dids: ['did:imajin:r1', 'did:imajin:r2'], multiplier: 10 }) as never,
    );

    expect(res.status).toBe(200);
    expect(state.updateCalls).toHaveLength(2);

    const mjnDebit = decodedDebitAmount(state.updateCalls[0].values);
    const mjnxDebit = decodedDebitAmount(state.updateCalls[1].values);

    const balanceCredits = state.insertCalls.filter((c) => c.table === 'balances');
    const mjnCredited = balanceCredits
      .filter((c) => c.values.unit === 'MJN')
      .reduce((sum, c) => sum + Number(c.values.amount), 0);
    const mjnxCredited = balanceCredits
      .filter((c) => c.values.unit === 'MJNx')
      .reduce((sum, c) => sum + Number(c.values.amount), 0);

    // The number actually debited equals the SUM credited across BOTH
    // recipients — not just one recipient's amount — in each unit.
    expect(Number(mjnDebit)).toBe(mjnCredited);
    expect(Number(mjnxDebit)).toBe(mjnxCredited);
    expect(mjnDebit).toBe('20');
    expect(mjnxDebit).toBe('180');
  });
});

describe('POST /api/balance/event-topup — concurrent debit race (#2018 review: TOCTOU)', () => {
  it('two parallel top-ups against a balance that covers only one: exactly one 200, one 402, balance never goes negative, supply unchanged', async () => {
    // Same guard-under-contention shape as the gift route's concurrency
    // test: the queue holds one "success" result followed by one empty
    // (failure) result, standing in for two concurrent callers hitting the
    // same atomic guarded UPDATE.
    state.returningQueue.push([{ did: FROM_DID, unit: 'MJN', amount: '0', currency: 'CAD' }], []);

    const req = () => makeRequest({ ...BASE_BODY, multiplier: 1.0 }) as never;

    const [resA, resB] = await Promise.all([POST(req()), POST(req())]);
    const statuses = [resA.status, resB.status].sort();

    expect(statuses).toEqual([200, 402]);

    const bodies = await Promise.all([resA.json(), resB.json()]);
    const failed = bodies.find((b) => 'error' in b);
    expect(failed?.error).toMatch(/Insufficient MJN balance/);

    const recipientCredits = state.insertCalls.filter((c) => c.values.did === 'did:imajin:r1');
    expect(recipientCredits).toHaveLength(1);
    expect(recipientCredits[0].values).toMatchObject({ unit: 'MJN', amount: '10' });

    expect(state.updateCalls).toHaveLength(2);
    const topupTxRows = state.insertCalls.filter((c) => c.values.type === 'event-topup');
    expect(topupTxRows).toHaveLength(1);
  });
});
