/**
 * Tests for POST /api/emission (#2016, #2017).
 *
 * An emission can never mint the withdrawable unit — `unit` must be
 * 'MJNx'. Also verifies the provenance the `mjn` reactor forwards lands on
 * first-class columns: the attestation id (#2016) and the bus_chain_configs
 * row id + version that produced the emission (#2017), and that a repeated
 * `idempotency_key` credits nothing the second time (#2017).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonPostRequest, resetMockDbCallState } from '@/src/lib/pay/__tests__/mock-drizzle-table';

const state = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  // FIFO queues drained by the shared db mock (see mock-drizzle-table.ts).
  insertReturningQueue: [] as Array<Record<string, unknown>[]>,
  transactionRowQueue: [] as Array<Record<string, unknown> | undefined>,
}));

vi.mock('@imajin/logger', async () => {
  const { withLoggerPassthrough } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');
  return { withLogger: withLoggerPassthrough() };
});

vi.mock('@imajin/config', () => ({
  rateLimit: () => ({ limited: false }),
  getClientIP: () => '127.0.0.1',
}));

vi.mock('@/src/db', async () => {
  const { balanceRouteDbModule } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');
  return balanceRouteDbModule(state, {
    insertReturningQueue: state.insertReturningQueue,
    transactionRowQueue: state.transactionRowQueue,
    extra: { transactions: { __table: 'transactions', id: 'id', idempotencyKey: 'idempotency_key' } },
  });
});

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: () => new Response(null, { status: 204 }),
}));

import { POST } from '../route';

const API_KEY = 'test-pay-api-key';

function makeRequest(body: Record<string, unknown>): Request {
  return jsonPostRequest('https://kernel.test/api/emission', body, { Authorization: `Bearer ${API_KEY}` });
}

function insertsInto(table: string) {
  return state.insertCalls.filter((c) => c.table === table);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMockDbCallState(state);
  process.env.PAY_SERVICE_API_KEY = API_KEY;
});

describe('POST /api/emission — MJNx-only enforcement (#2016)', () => {
  it('rejects unit: MJN with a 400 — an emission can never mint the withdrawable unit', async () => {
    const res = await POST(makeRequest({ to_did: 'did:imajin:x', amount: 10, unit: 'MJN', reason: 'test' }) as never);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/MJNx/);
    expect(state.insertCalls).toHaveLength(0);
  });

  it('rejects a missing/unknown unit', async () => {
    const res = await POST(makeRequest({ to_did: 'did:imajin:x', amount: 10, reason: 'test' }) as never);
    expect(res.status).toBe(400);
  });

  it('credits the MJNx balance row and logs a source_kind=emission transaction for unit: MJNx', async () => {
    const res = await POST(makeRequest({ to_did: 'did:imajin:x', amount: 10, unit: 'MJNx', reason: 'Welcome' }) as never);

    expect(res.status).toBe(201);
    expect(state.insertCalls).toHaveLength(2); // transaction row (claimed first) + balance credit

    const txValues = insertsInto('transactions')[0].values;
    expect(txValues).toMatchObject({ unit: 'MJNx', sourceKind: 'emission', toDid: 'did:imajin:x' });
    expect(txValues.attestationId).toBeNull();
    expect(txValues.emissionConfigId).toBeNull();
    expect(txValues.emissionConfigVersion).toBeNull();
    expect(txValues.idempotencyKey).toBeNull();

    const balanceValues = insertsInto('balances')[0].values;
    expect(balanceValues).toMatchObject({ did: 'did:imajin:x', unit: 'MJNx', amount: '10' });
  });

  it('rejects a missing API key', async () => {
    const res = await POST(
      new Request('https://kernel.test/api/emission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to_did: 'did:imajin:x', amount: 10, unit: 'MJNx', reason: 'test' }),
      }) as never,
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /api/emission — provenance (#2016, #2017)', () => {
  const provenance = {
    attestation_type: 'identity.created',
    attestation_id: 'att_123',
    emission_config_id: 'cfg_abc',
    emission_config_version: 4,
    idempotency_key: 'emission:att_123:0:subject',
  };

  it('lifts attestation id, config id/version and idempotency key into first-class columns', async () => {
    const res = await POST(
      makeRequest({ to_did: 'did:imajin:x', amount: 10, unit: 'MJNx', reason: 'Welcome', metadata: provenance }) as never,
    );

    expect(res.status).toBe(201);
    const txValues = insertsInto('transactions')[0].values;
    expect(txValues).toMatchObject({
      attestationId: 'att_123',
      emissionConfigId: 'cfg_abc',
      emissionConfigVersion: 4,
      idempotencyKey: 'emission:att_123:0:subject',
    });
    // The raw metadata bag keeps the same trail for anyone reading metadata.
    expect(txValues.metadata).toMatchObject({ reason: 'Welcome', ...provenance });
  });

  it('ignores a non-integer config version rather than storing garbage', async () => {
    await POST(
      makeRequest({
        to_did: 'did:imajin:x',
        amount: 10,
        unit: 'MJNx',
        reason: 'Welcome',
        metadata: { ...provenance, emission_config_version: '4' },
      }) as never,
    );
    expect(insertsInto('transactions')[0].values.emissionConfigVersion).toBeNull();
  });
});

describe('POST /api/emission — idempotency (#2017)', () => {
  const body = {
    to_did: 'did:imajin:x',
    amount: 10,
    unit: 'MJNx',
    reason: 'Welcome',
    metadata: { attestation_id: 'att_123', idempotency_key: 'emission:att_123:0:subject' },
  };

  it('a duplicate idempotency key credits nothing and returns the original transaction', async () => {
    state.insertReturningQueue.push([]); // unique index conflict: nothing inserted
    state.transactionRowQueue.push({ id: 'tx_original' });

    const res = await POST(makeRequest(body) as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'tx_original', status: 'completed', duplicate: true });
    // The claim insert was attempted with ON CONFLICT DO NOTHING; no balance credit followed.
    expect(state.insertCalls).toHaveLength(1);
    expect(state.insertCalls[0].table).toBe('transactions');
    expect(state.insertCalls[0].conflict).toBe('do-nothing');
  });

  it('the first delivery credits exactly once', async () => {
    const res = await POST(makeRequest(body) as never);

    expect(res.status).toBe(201);
    expect((await res.json()).duplicate).toBeUndefined();
    expect(insertsInto('balances')).toHaveLength(1); // one balance credit
  });
});
