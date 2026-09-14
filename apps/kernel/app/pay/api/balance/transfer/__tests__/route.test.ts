/**
 * Tests for POST /api/balance/transfer (#2016, #2166).
 *
 * A transfer moves a single wallet unit — no more "burn credit then cash"
 * cascade, and never a cross-unit conversion. An unknown unit is a 400.
 *
 * #2166: the sender's debit is now a single guarded conditional UPDATE
 * (`debitUnitIfSufficient` in `src/lib/pay/ledger.ts`) inside the SAME
 * transaction as the recipient credit — not a pre-transaction
 * `getBalanceRow` read compared in JS. That earlier shape was a TOCTOU
 * race: two concurrent transfers from the same DID could both pass a
 * stale balance read and both proceed, driving the ledger negative (an
 * unbacked credit). `state.returningQueue` simulates the `.returning()`
 * result of the guarded UPDATE: a non-empty array means the guard passed,
 * `[]` means it failed (insufficient balance) — mirroring the gift/
 * event-topup route tests (#2018).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { jsonPostRequest, resetMockDbCallState } from '@/src/lib/pay/__tests__/mock-drizzle-table';

const dialect = new PgDialect();

/**
 * Decode the numeric amount actually bound into a guarded UPDATE's SET
 * clause (`sql\`${balances.amount} - ${amountStr}\``) — same technique as
 * the gift route suite (#2018) — to assert the debited amount matches
 * exactly what the recipient was credited, not just "some debit happened".
 */
function decodedDebitAmount(values: Record<string, unknown>): string {
  const { params } = dialect.sqlToQuery(values.amount as Parameters<PgDialect['sqlToQuery']>[0]);
  return String(params[params.length - 1]);
}

const state = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  // Consumed in call order: sender balance first, then recipient balance.
  balanceRowQueue: [] as Array<{ did: string; unit: string; amount: string; currency: string } | undefined>,
  // Consumed in call order: one entry per guarded `debitUnitIfSufficient` UPDATE.
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

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

import { db } from '@/src/db';
import { POST } from '../route';

const FROM_DID = 'did:imajin:sender';
const TO_DID = 'did:imajin:recipient';

function makeRequest(body: Record<string, unknown>): Request {
  return jsonPostRequest('https://kernel.test/api/balance/transfer', body);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMockDbCallState(state);
  state.resolveEffectiveDidMock.mockResolvedValue({ ok: true, effectiveDid: FROM_DID });
});

describe('POST /api/balance/transfer — unit-aware (#2016)', () => {
  it('rejects an unknown unit with a 400, never a conversion', async () => {
    const res = await POST(makeRequest({ from_did: FROM_DID, to_did: TO_DID, amount: 10, unit: 'BTC' }) as never);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Unknown unit/);
    expect(state.insertCalls).toHaveLength(0);
  });

  it('defaults to MJN when unit is omitted', async () => {
    state.balanceRowQueue.push({ did: FROM_DID, unit: 'MJN', amount: '100', currency: 'CAD' }, undefined);
    state.returningQueue.push([{ did: FROM_DID, unit: 'MJN', amount: '90', currency: 'CAD' }]);

    const res = await POST(makeRequest({ from_did: FROM_DID, to_did: TO_DID, amount: 10 }) as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.unit).toBe('MJN');
  });

  it('transfers MJNx to MJNx — both legs touch the same unit row, never laundered into MJN', async () => {
    state.balanceRowQueue.push({ did: FROM_DID, unit: 'MJNx', amount: '50', currency: 'CAD' }, undefined);
    state.returningQueue.push([{ did: FROM_DID, unit: 'MJNx', amount: '30', currency: 'CAD' }]);

    const res = await POST(makeRequest({ from_did: FROM_DID, to_did: TO_DID, amount: 20, unit: 'MJNx' }) as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ unit: 'MJNx', source: 'credit' });

    const txValues = state.insertCalls.find((c) => c.values.type === 'transfer')?.values;
    expect(txValues).toMatchObject({ unit: 'MJNx', sourceKind: 'transfer' });

    const balanceCredit = state.insertCalls.find((c) => c.values.did === TO_DID)?.values;
    expect(balanceCredit).toMatchObject({ unit: 'MJNx', amount: '20' });
  });

  it('debits the sender by exactly what the recipient is credited (supply-neutral) (#2166)', async () => {
    state.balanceRowQueue.push({ did: FROM_DID, unit: 'MJN', amount: '100', currency: 'CAD' }, undefined);
    state.returningQueue.push([{ did: FROM_DID, unit: 'MJN', amount: '85', currency: 'CAD' }]);

    const res = await POST(makeRequest({ from_did: FROM_DID, to_did: TO_DID, amount: 15 }) as never);

    expect(res.status).toBe(200);
    expect(state.updateCalls).toHaveLength(1);
    const debited = decodedDebitAmount(state.updateCalls[0].values);
    const credited = state.insertCalls.find((c) => c.values.did === TO_DID)?.values.amount;
    expect(debited).toBe('15');
    expect(String(credited)).toBe(debited);
  });

  it('rejects insufficient balance with a 402, never a partial write (#2166 guarded UPDATE)', async () => {
    state.balanceRowQueue.push({ did: FROM_DID, unit: 'MJN', amount: '5', currency: 'CAD' }, undefined);
    // The guarded UPDATE itself is attempted (that's the sufficiency check), it just matches zero rows.
    state.returningQueue.push([]);

    const res = await POST(makeRequest({ from_did: FROM_DID, to_did: TO_DID, amount: 10, unit: 'MJN' }) as never);

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/Insufficient MJN balance/);
    expect(state.updateCalls).toHaveLength(1);
    // Rollback evidence: no recipient credit and no transaction row were
    // ever issued — the throw happens before either statement runs.
    expect(state.insertCalls.filter((c) => c.table === 'balances')).toHaveLength(0);
    expect(state.insertCalls.filter((c) => c.table !== 'balances')).toHaveLength(0);
  });

  it('forbids transferring from a DID other than the authenticated one', async () => {
    const res = await POST(makeRequest({ from_did: 'did:imajin:someone-else', to_did: TO_DID, amount: 10 }) as never);
    expect(res.status).toBe(403);
  });

  it('re-throws a genuinely unexpected transaction error as a 500, never swallowing it as an insufficient-balance 402', async () => {
    state.balanceRowQueue.push({ did: FROM_DID, unit: 'MJN', amount: '100', currency: 'CAD' }, undefined);
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('unexpected db failure'));

    const res = await POST(makeRequest({ from_did: FROM_DID, to_did: TO_DID, amount: 10 }) as never);
    expect(res.status).toBe(500);
  });
});

describe('POST /api/balance/transfer — concurrent debit race (#2166: TOCTOU)', () => {
  it('two parallel transfers against a balance that covers only one: exactly one 200, one 402, balance never goes negative, supply unchanged', async () => {
    // Simulates what a real guarded `UPDATE ... WHERE amount >= $x
    // RETURNING *` does under contention: exactly one of two concurrent
    // callers sees a matched row. There is no separate pre-transaction
    // sufficiency read to race — the guarded UPDATE *is* the check.
    state.balanceRowQueue.push(
      { did: FROM_DID, unit: 'MJN', amount: '10', currency: 'CAD' },
      undefined,
      { did: FROM_DID, unit: 'MJN', amount: '10', currency: 'CAD' },
      undefined,
    );
    state.returningQueue.push([{ did: FROM_DID, unit: 'MJN', amount: '0', currency: 'CAD' }], []);

    const req = () => makeRequest({ from_did: FROM_DID, to_did: TO_DID, amount: 10 }) as never;

    const [resA, resB] = await Promise.all([POST(req()), POST(req())]);
    const statuses = [resA.status, resB.status].sort();

    expect(statuses).toEqual([200, 402]);

    const bodies = await Promise.all([resA.json(), resB.json()]);
    const failed = bodies.find((b) => 'error' in b);
    expect(failed?.error).toMatch(/Insufficient MJN balance/);

    // Exactly one guarded debit succeeded, so exactly one recipient credit
    // was written — the balance can never have gone negative, and supply
    // (what the sender lost) exactly matches what the recipient gained.
    const recipientCredits = state.insertCalls.filter((c) => c.values.did === TO_DID);
    expect(recipientCredits).toHaveLength(1);
    expect(recipientCredits[0].values).toMatchObject({ unit: 'MJN', amount: '10' });

    // Both requests attempted their guarded UPDATE (that's the atomic check
    // itself), but only the winner produced a transaction row.
    expect(state.updateCalls).toHaveLength(2);
    const transferTxRows = state.insertCalls.filter((c) => c.values.type === 'transfer');
    expect(transferTxRows).toHaveLength(1);
  });
});
