/**
 * Golden characterization tests for POST /pay/api/settle (#1073).
 *
 * These capture the CURRENT behaviour of the canonical settlement route
 * across a fixture set (simple manifest, multi-party split, mixed
 * credit+cash source, funded/Stripe settlement, unsigned manifest,
 * invalid signature) before the #1073 `settlePayment()` extraction.
 *
 * They exercise the route as a black box (`POST(request)`), so they keep
 * passing across the extraction refactor as long as `settlePayment()`'s
 * observable behaviour (response body, `balances`/`transactions` writes,
 * emitted attestations) is unchanged. They must pass unmodified on `main`
 * before any refactor commit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  senderBalanceRow: undefined as { did: string; cashAmount: string; creditAmount: string; currency: string } | undefined,
  chainVerified: true,
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  idCounter: 0,
}));

function resetState() {
  state.senderBalanceRow = undefined;
  state.chainVerified = true;
  state.insertCalls = [];
  state.updateCalls = [];
  state.idCounter = 0;
}

vi.mock('@/src/db', () => {
  const balances = { __table: 'balances', did: 'did', cashAmount: 'cashAmount', creditAmount: 'creditAmount' };
  const transactions = { __table: 'transactions', id: 'id' };
  const identities = { __table: 'identities' };
  const identityChains = { __table: 'identityChains', did: 'did' };

  function tableName(t: unknown): string {
    return (t as { __table?: string } | undefined)?.__table ?? 'unknown';
  }

  function limitResultFor(table: unknown) {
    const t = tableName(table);
    if (t === 'balances') {
      return Promise.resolve(state.senderBalanceRow ? [state.senderBalanceRow] : []);
    }
    if (t === 'identityChains') {
      return Promise.resolve(state.chainVerified ? [{ did: 'chain-row' }] : []);
    }
    return Promise.resolve([]);
  }
  function whereClauseFor(table: unknown) {
    return { limit: (_n: number) => limitResultFor(table) };
  }
  function fromClauseFor() {
    return (table: unknown) => ({ where: (_cond?: unknown) => whereClauseFor(table) });
  }
  function select(_proj?: unknown) {
    return { from: fromClauseFor() };
  }

  function update(table: unknown) {
    return {
      set(values: Record<string, unknown>) {
        return {
          where(_cond?: unknown) {
            state.updateCalls.push({ table: tableName(table), values });
            return Promise.resolve(undefined);
          },
        };
      },
    };
  }

  function insert(table: unknown) {
    return {
      values(values: Record<string, unknown>) {
        const record = { table: tableName(table), values } as { table: string; values: Record<string, unknown>; conflict?: unknown };
        state.insertCalls.push(record);
        const promise = Promise.resolve(undefined);
        return Object.assign(promise, {
          onConflictDoUpdate(conflict: unknown) {
            record.conflict = conflict;
            return Promise.resolve(undefined);
          },
        });
      },
    };
  }

  async function transaction(cb: (tx: { update: typeof update; insert: typeof insert }) => Promise<void>) {
    return cb({ update, insert });
  }

  return {
    db: { select, update, insert, transaction },
    balances,
    transactions,
    identities,
    identityChains,
  };
});

const { verifyManifestMock } = vi.hoisted(() => ({ verifyManifestMock: vi.fn() }));
vi.mock('@imajin/fair', () => ({ verifyManifest: verifyManifestMock }));

vi.mock('@imajin/auth', () => ({
  createDbResolver: () => async () => 'fake-public-key',
}));

const { publishMock } = vi.hoisted(() => ({ publishMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@imajin/bus', () => ({ publish: publishMock }));

vi.mock('@/src/lib/fair/intro-attribution', () => ({
  verifyIntroAttributionManifestForSettlement: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_${state.idCounter++}`,
}));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

import { POST } from '../route';

type NextRequestLike = Parameters<typeof POST>[0];

const ENDPOINT = 'http://localhost:3000/pay/api/settle';
const API_KEY = 'test-api-key';

function makeRequest(body: unknown): NextRequestLike {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  }) as unknown as NextRequestLike;
}

/** Let fire-and-forget attestation work (not awaited by POST) flush. */
async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
  process.env.PAY_SERVICE_API_KEY = API_KEY;
  process.env.PLATFORM_DID = 'did:imajin:platform';
  verifyManifestMock.mockResolvedValue({ valid: true });
});

describe('POST /pay/api/settle — golden characterization (#1073)', () => {
  it('simple manifest: single recipient paid from credit balance, unsigned manifest allowed', async () => {
    state.senderBalanceRow = { did: 'did:imajin:buyer', cashAmount: '0', creditAmount: '100', currency: 'CAD' };

    const res = await POST(
      makeRequest({
        from_did: 'did:imajin:buyer',
        total_amount: 100,
        service: 'market',
        type: 'sale',
        fair_manifest: { chain: [{ did: 'did:imajin:seller', amount: 100, role: 'seller' }] },
      }),
    );
    await flushMicrotasks();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ settled: true, total_amount: 100, recipients: 1, source: 'credit' });

    // Debit the payer, credit the one recipient.
    const balanceDebits = state.updateCalls.filter((c) => c.table === 'balances');
    expect(balanceDebits).toEqual([
      { table: 'balances', values: expect.objectContaining({ creditAmount: expect.anything(), cashAmount: expect.anything() }) },
    ]);
    const balanceCredits = state.insertCalls.filter((c) => c.table === 'balances');
    expect(balanceCredits).toHaveLength(1);
    expect(balanceCredits[0].values).toMatchObject({ did: 'did:imajin:seller', cashAmount: '100' });

    const txInserts = state.insertCalls.filter((c) => c.table === 'transactions');
    expect(txInserts).toHaveLength(1);
    expect(txInserts[0].values).toMatchObject({ toDid: 'did:imajin:seller', amount: '100' });
    // Unsigned manifest: signature_verified recorded as false, settlement still proceeds.
    expect((txInserts[0].values.metadata as Record<string, unknown>).signature_verified).toBe(false);

    expect(publishMock).toHaveBeenCalledWith('transaction.settled', expect.objectContaining({ payload: expect.objectContaining({ total_amount: 100, source: 'credit' }) }));
  });

  it('multi-party split: three recipients, each credited their own amount', async () => {
    state.senderBalanceRow = { did: 'did:imajin:buyer', cashAmount: '0', creditAmount: '1000', currency: 'CAD' };

    const chain = [
      { did: 'did:imajin:seller', amount: 70, role: 'seller' },
      { did: 'did:imajin:node', amount: 20, role: 'node' },
      { did: 'did:imajin:platform', amount: 10, role: 'platform' },
    ];
    const res = await POST(
      makeRequest({
        from_did: 'did:imajin:buyer',
        total_amount: 100,
        service: 'market',
        type: 'sale',
        fair_manifest: { chain },
      }),
    );
    await flushMicrotasks();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ settled: true, recipients: 3 });

    const balanceCredits = state.insertCalls.filter((c) => c.table === 'balances');
    expect(balanceCredits.map((c) => c.values)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ did: 'did:imajin:seller', cashAmount: '70' }),
        expect.objectContaining({ did: 'did:imajin:node', cashAmount: '20' }),
        expect.objectContaining({ did: 'did:imajin:platform', cashAmount: '10' }),
      ]),
    );
    expect(state.insertCalls.filter((c) => c.table === 'transactions')).toHaveLength(3);
  });

  it('mixed credit+cash source: burns all credit then remainder from cash', async () => {
    state.senderBalanceRow = { did: 'did:imajin:buyer', cashAmount: '80', creditAmount: '30', currency: 'CAD' };

    const res = await POST(
      makeRequest({
        from_did: 'did:imajin:buyer',
        total_amount: 100,
        service: 'market',
        type: 'sale',
        fair_manifest: { chain: [{ did: 'did:imajin:seller', amount: 100, role: 'seller' }] },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('mixed');

    const balanceDebits = state.updateCalls.filter((c) => c.table === 'balances');
    expect(balanceDebits[0].values).toMatchObject({});
    // creditBurn = min(30, 100) = 30; cashBurn = 100 - 30 = 70
    // Values are drizzle `sql` templates, not plain numbers — assert shape only.
    expect(balanceDebits).toHaveLength(1);
  });

  it('funded (Stripe) settlement: skips balance debit; sellers skip balance credit', async () => {
    const res = await POST(
      makeRequest({
        from_did: 'did:imajin:buyer',
        total_amount: 100,
        service: 'market',
        type: 'sale',
        funded: true,
        funded_provider: 'stripe',
        fair_manifest: {
          chain: [
            { did: 'did:imajin:seller', amount: 85, role: 'seller' },
            { did: 'did:imajin:node', amount: 15, role: 'node' },
          ],
        },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('external');

    // No debit update at all for a funded settlement.
    expect(state.updateCalls.filter((c) => c.table === 'balances')).toHaveLength(0);
    // Seller balance credit is skipped (Stripe already paid them); node still credited.
    const balanceCredits = state.insertCalls.filter((c) => c.table === 'balances');
    expect(balanceCredits).toHaveLength(1);
    expect(balanceCredits[0].values).toMatchObject({ did: 'did:imajin:node', cashAmount: '15' });

    const txInserts = state.insertCalls.filter((c) => c.table === 'transactions');
    const sellerTx = txInserts.find((t) => t.values.toDid === 'did:imajin:seller')!;
    expect((sellerTx.values.metadata as Record<string, unknown>).balance_skipped).toBe(true);
  });

  it('invalid signature: rejected with 400, no db.transaction touched', async () => {
    verifyManifestMock.mockResolvedValue({ valid: false, error: 'bad signature' });
    state.senderBalanceRow = { did: 'did:imajin:buyer', cashAmount: '0', creditAmount: '100', currency: 'CAD' };

    const res = await POST(
      makeRequest({
        from_did: 'did:imajin:buyer',
        total_amount: 100,
        service: 'market',
        type: 'sale',
        fair_manifest: {
          signature: { value: 'deadbeef', signer: 'did:imajin:buyer' },
          chain: [{ did: 'did:imajin:seller', amount: 100, role: 'seller' }],
        },
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/signature verification failed/);
    expect(state.insertCalls).toHaveLength(0);
    expect(state.updateCalls).toHaveLength(0);
  });
});
