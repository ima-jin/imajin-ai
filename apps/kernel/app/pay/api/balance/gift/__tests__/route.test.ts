/**
 * Tests for POST /api/balance/gift (#2016, #2018).
 *
 * The cash leg and credit leg now land on separate per-unit balance rows
 * (MJN / MJNx), so each nonzero leg gets its own transaction row instead of
 * one row spanning both buckets.
 *
 * #2018: gift is a FUNDED TRANSFER, never a mint — from_did's MJN balance
 * backs the cash leg and its MJNx balance backs the credit leg. Funding
 * sufficiency is enforced by a single guarded conditional UPDATE per unit
 * (`debitFundedLegs` / `debitUnitIfSufficient` in `src/lib/pay/ledger.ts`),
 * not a pre-transaction `getBalanceRow` read compared in JS — the latter is
 * a TOCTOU race that lets two concurrent gifts both pass a stale balance
 * read and drive the ledger negative. `state.returningQueue` simulates the
 * `.returning()` result of each guarded UPDATE: a non-empty array means the
 * guard passed, `[]` means it failed (insufficient balance).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonPostRequest, resetMockDbCallState } from '@/src/lib/pay/__tests__/mock-drizzle-table';

const state = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  balanceRowQueue: [] as Array<{ did: string; unit: string; amount: string; currency: string } | undefined>,
  returningQueue: [] as Array<Record<string, unknown>[]>,
  resolveEffectiveDidMock: vi.fn(),
}));

vi.mock('@imajin/logger', async () => {
  const { withLoggerPassthrough } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');
  return { withLogger: withLoggerPassthrough() };
});

vi.mock('@imajin/auth', () => ({ resolveEffectiveDid: state.resolveEffectiveDidMock }));

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
  return jsonPostRequest('https://kernel.test/api/balance/gift', body);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMockDbCallState(state);
  state.resolveEffectiveDidMock.mockResolvedValue({ ok: true, effectiveDid: FROM_DID });
});

describe('POST /api/balance/gift — per-unit balance writes (#2016)', () => {
  it('rejects a missing recipients array', async () => {
    const res = await POST(makeRequest({ from_did: FROM_DID }) as never);
    expect(res.status).toBe(400);
  });

  it('forbids gifting from a DID other than the authenticated one', async () => {
    const res = await POST(makeRequest({ from_did: 'did:imajin:other', recipients: [{ did: 'x', cash_amount: 1 }] }) as never);
    expect(res.status).toBe(403);
  });

  it('rejects negative recipient amounts', async () => {
    const res = await POST(
      makeRequest({ from_did: FROM_DID, recipients: [{ did: 'did:imajin:r1', cash_amount: -5 }] }) as never,
    );
    expect(res.status).toBe(400);
  });

  it('rejects insufficient MJN balance with a 402, never a mint (#2018 guarded UPDATE)', async () => {
    // The guarded UPDATE itself is attempted (that's the sufficiency check),
    // it just matches zero rows.
    state.returningQueue.push([]);
    const res = await POST(
      makeRequest({ from_did: FROM_DID, recipients: [{ did: 'did:imajin:r1', cash_amount: 10 }] }) as never,
    );
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/Insufficient MJN balance/);
    expect(state.updateCalls).toHaveLength(1);
    expect(state.insertCalls).toHaveLength(0);
  });

  it('rejects insufficient MJNx balance with a 402, never a mint, rolling back the already-succeeded MJN debit (#2018)', async () => {
    // MJN leg's guard passes, MJNx leg's guard fails.
    state.returningQueue.push([{ did: FROM_DID, unit: 'MJN', amount: '90', currency: 'CAD' }], []);
    const res = await POST(
      makeRequest({
        from_did: FROM_DID,
        recipients: [{ did: 'did:imajin:r1', cash_amount: 10, credit_amount: 5 }],
      }) as never,
    );
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/Insufficient MJNx balance/);
    // Both guarded UPDATEs were attempted (MJN passed, MJNx failed), but the
    // throw happens before any recipient row is written.
    expect(state.updateCalls).toHaveLength(2);
    expect(state.insertCalls).toHaveLength(0);
  });

  it('writes an MJN transaction + balance credit for the cash leg only', async () => {
    state.returningQueue.push([{ did: FROM_DID, unit: 'MJN', amount: '90', currency: 'CAD' }]);
    const res = await POST(
      makeRequest({ from_did: FROM_DID, recipients: [{ did: 'did:imajin:r1', cash_amount: 10 }] }) as never,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toHaveLength(1);

    const txValues = state.insertCalls.find((c) => c.values.type === 'gift')?.values;
    expect(txValues).toMatchObject({ unit: 'MJN', sourceKind: 'transfer', toDid: 'did:imajin:r1' });
    const balanceValues = state.insertCalls.find((c) => c.values.did === 'did:imajin:r1')?.values;
    expect(balanceValues).toMatchObject({ unit: 'MJN', amount: '10' });
    // Only the cash leg's guarded debit runs — no MJNx debit when credit_amount is 0.
    expect(state.updateCalls).toHaveLength(1);
  });

  it('writes both an MJN row and an MJNx row when both legs are nonzero, debiting from_did in both units (#2018)', async () => {
    state.returningQueue.push(
      [{ did: FROM_DID, unit: 'MJN', amount: '90', currency: 'CAD' }],
      [{ did: FROM_DID, unit: 'MJNx', amount: '45', currency: 'CAD' }],
    );
    const res = await POST(
      makeRequest({
        from_did: FROM_DID,
        recipients: [{ did: 'did:imajin:r1', cash_amount: 10, credit_amount: 5 }],
      }) as never,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toHaveLength(2);

    const txInserts = state.insertCalls.filter((c) => c.values.type === 'gift').map((c) => c.values);
    expect(txInserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unit: 'MJN', amount: '10' }),
        expect.objectContaining({ unit: 'MJNx', amount: '5' }),
      ]),
    );

    // Total supply is conserved: the business is debited exactly what the
    // two recipient credit rows (issued below) sum to — one guarded debit
    // per unit.
    expect(state.updateCalls).toHaveLength(2);
    const recipientCredits = state.insertCalls.filter((c) => c.values.did === 'did:imajin:r1').map((c) => c.values);
    expect(recipientCredits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unit: 'MJN', amount: '10' }),
        expect.objectContaining({ unit: 'MJNx', amount: '5' }),
      ]),
    );
  });

  it('skips a recipient whose gift amounts are both zero', async () => {
    const res = await POST(
      makeRequest({ from_did: FROM_DID, recipients: [{ did: 'did:imajin:r1', cash_amount: 0, credit_amount: 0 }] }) as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toHaveLength(0);
    // Both legs are 0 — debitFundedLegs skips them, so no guarded UPDATE is
    // even attempted.
    expect(state.updateCalls).toHaveLength(0);
  });
});

describe('POST /api/balance/gift — concurrent debit race (#2018 review: TOCTOU)', () => {
  it('two parallel gifts against a balance that covers only one: exactly one 200, one 402, balance never goes negative, supply unchanged', async () => {
    // Simulates what a real guarded `UPDATE ... WHERE amount >= $x
    // RETURNING *` does under contention: exactly one of two concurrent
    // callers sees a matched row. The queue holds a "success" result
    // followed by an empty (failure) result. There is no separate
    // pre-transaction sufficiency read to race — the guarded UPDATE *is*
    // the check, so this queue is a faithful stand-in for two callers
    // hitting the same atomic statement one after another.
    state.returningQueue.push([{ did: FROM_DID, unit: 'MJN', amount: '0', currency: 'CAD' }], []);

    const req = () =>
      makeRequest({ from_did: FROM_DID, recipients: [{ did: 'did:imajin:r1', cash_amount: 10 }] }) as never;

    const [resA, resB] = await Promise.all([POST(req()), POST(req())]);
    const statuses = [resA.status, resB.status].sort();

    expect(statuses).toEqual([200, 402]);

    const bodies = await Promise.all([resA.json(), resB.json()]);
    const failed = bodies.find((b) => 'error' in b);
    expect(failed?.error).toMatch(/Insufficient MJN balance/);

    // Exactly one guarded debit succeeded, so exactly one recipient credit
    // was written — the balance can never have gone negative, and supply
    // (what the business lost) exactly matches what the recipient gained.
    const recipientCredits = state.insertCalls.filter((c) => c.values.did === 'did:imajin:r1');
    expect(recipientCredits).toHaveLength(1);
    expect(recipientCredits[0].values).toMatchObject({ unit: 'MJN', amount: '10' });

    // Both requests attempted their guarded UPDATE (that's the atomic check
    // itself), but only the winner produced a transaction row.
    expect(state.updateCalls).toHaveLength(2);
    const giftTxRows = state.insertCalls.filter((c) => c.values.type === 'gift');
    expect(giftTxRows).toHaveLength(1);
  });
});
