/**
 * Tests for in-process emission (#2016, #2017).
 *
 * An emission can never mint the withdrawable unit — `unit` must be
 * 'MJNx'. Also verifies the provenance the `mjn` reactor forwards lands on
 * first-class columns: the attestation id (#2016) and the bus_chain_configs
 * row id + version that produced the emission (#2017), and that a repeated
 * `idempotency_key` credits nothing the second time (#2017).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetMockDbCallState } from '@/src/lib/pay/__tests__/mock-drizzle-table';

const state = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  // FIFO queues drained by the shared db mock (see mock-drizzle-table.ts).
  insertReturningQueue: [] as Array<Record<string, unknown>[]>,
  transactionRowQueue: [] as Array<Record<string, unknown> | undefined>,
  chainRows: [] as Array<Record<string, unknown>>,
}));
vi.mock('@imajin/db', () => ({ getClient: () => () => Promise.resolve(state.chainRows) }));

vi.mock('@/src/db', async () => {
  const { balanceRouteDbModule } = await import('@/src/lib/pay/__tests__/mock-drizzle-table');
  return balanceRouteDbModule(state, {
    insertReturningQueue: state.insertReturningQueue,
    transactionRowQueue: state.transactionRowQueue,
    extra: { transactions: { __table: 'transactions', id: 'id', idempotencyKey: 'idempotency_key' } },
  });
});

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
import { emitMjnx } from '../emission-core';
import type { EmissionExecutorParams } from '@imajin/bus';
import { getReactor, registerEmissionExecutor } from '@imajin/bus';
import { ensureEmissionExecutorRegistered } from '../emission-executor';

// Response-shaped assertions retained from the ledger characterization suite.
async function invoke(body: Record<string, unknown>) {
  const result = await emitMjnx(body as unknown as EmissionExecutorParams);
  return {
    status: 'error' in result ? result.status : result.duplicate ? 200 : 201,
    json: async () => result,
  };
}

function insertsInto(table: string) {
  return state.insertCalls.filter((c) => c.table === table);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMockDbCallState(state);
});

afterEach(() => {
  registerEmissionExecutor(null);
  vi.unstubAllGlobals();
});

describe('in-process bus → kernel emission integration', () => {
  it('credits once through the registered executor and dedupes a re-published event, without HTTP', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    state.chainRows.push({
      id: 'cfg_1', version: 1, enabled: true,
      reactors: [{
        type: 'mjn', enabled: true,
        config: {
          attestationType: 'identity.created', unit: 'MJNx',
          emit: [{ to: 'subject', amount: 10, reason: 'Welcome' }],
          retryDelayMs: 0,
        },
      }],
    });
    ensureEmissionExecutorRegistered();
    const event = {
      type: 'identity.created', scope: 'auth', issuer: 'did:imajin:issuer',
      subject: 'did:imajin:subject', payload: { attestationId: 'att_1' },
    };
    const reactor = getReactor('mjn')!;
    await reactor(event, {});
    expect(insertsInto('balances')).toHaveLength(1);
    expect(insertsInto('transactions')[0].values).toMatchObject({
      unit: 'MJNx', toDid: event.subject, attestationId: 'att_1',
      emissionConfigId: 'cfg_1', idempotencyKey: 'emission:att_1:0:subject',
    });

    state.insertReturningQueue.push([]);
    state.transactionRowQueue.push({ id: 'tx_test' });
    await reactor(event, {});
    expect(insertsInto('balances')).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('emitMjnx — in-process ledger validation', () => {
  it.each([
    { to_did: '' }, { to_did: 3 },
    { amount: 0 }, { amount: -1 }, { amount: '10' },
    { amount: Number.NaN }, { amount: Number.POSITIVE_INFINITY }, { amount: Number.NEGATIVE_INFINITY },
    { reason: '' }, { reason: false },
    { metadata: null }, { metadata: [] }, { metadata: 'bad' },
  ])('rejects invalid input %j before a ledger write', async (invalid) => {
    const result = await emitMjnx({
      to_did: 'did:imajin:x', amount: 10, unit: 'MJNx', reason: 'Welcome', ...invalid,
    } as EmissionExecutorParams);
    expect(result).toMatchObject({ error: expect.any(String), status: 400 });
    expect(state.insertCalls).toHaveLength(0);
  });
});


describe('emitMjnx — MJNx-only enforcement (#2016)', () => {
  it('rejects unit: MJN with a 400 — an emission can never mint the withdrawable unit', async () => {
    const res = await invoke({ to_did: 'did:imajin:x', amount: 10, unit: 'MJN', reason: 'test' });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect('error' in body && body.error).toMatch(/MJNx/);
    expect(state.insertCalls).toHaveLength(0);
  });

  it('rejects a missing/unknown unit', async () => {
    const res = await invoke({ to_did: 'did:imajin:x', amount: 10, reason: 'test' });
    expect(res.status).toBe(400);
  });

  it('credits the MJNx balance row and logs a source_kind=emission transaction for unit: MJNx', async () => {
    const res = await invoke({ to_did: 'did:imajin:x', amount: 10, unit: 'MJNx', reason: 'Welcome' });

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
});

describe('emitMjnx — provenance (#2016, #2017)', () => {
  const provenance = {
    attestation_type: 'identity.created',
    attestation_id: 'att_123',
    emission_config_id: 'cfg_abc',
    emission_config_version: 4,
    idempotency_key: 'emission:att_123:0:subject',
  };

  it('lifts attestation id, config id/version and idempotency key into first-class columns', async () => {
    const res = await invoke(
      { to_did: 'did:imajin:x', amount: 10, unit: 'MJNx', reason: 'Welcome', metadata: provenance },
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
    await invoke(
      {
        to_did: 'did:imajin:x',
        amount: 10,
        unit: 'MJNx',
        reason: 'Welcome',
        metadata: { ...provenance, emission_config_version: '4' },
      },
    );
    expect(insertsInto('transactions')[0].values.emissionConfigVersion).toBeNull();
  });
});

describe('emitMjnx — idempotency (#2017)', () => {
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

    const res = await invoke(body);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'tx_original', status: 'completed', duplicate: true });
    // The claim insert was attempted with ON CONFLICT DO NOTHING; no balance credit followed.
    expect(state.insertCalls).toHaveLength(1);
    expect(state.insertCalls[0].table).toBe('transactions');
    expect(state.insertCalls[0].conflict).toBe('do-nothing');
  });

  it('the first delivery credits exactly once', async () => {
    const res = await invoke(body);

    expect(res.status).toBe(201);
    expect(await res.json()).not.toHaveProperty('duplicate');
    expect(insertsInto('balances')).toHaveLength(1); // one balance credit
  });
});
