import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake postgres.js tagged-template client: records each query's skeleton +
// interpolated values so we can assert what SQL the recorder issues, no DB needed.
// `resolveWith` lets individual tests override the return value for the next call.
const { calls, fakeSql, resolveWith } = vi.hoisted(() => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let nextResult: unknown[] = [];
  const resolveWith = (rows: unknown[]) => { nextResult = rows; };
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join(' ? '), values });
    const result = nextResult;
    nextResult = [];
    return Promise.resolve(result);
  };
  return { calls, fakeSql, resolveWith };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

import { supplyRecorderReactor } from '../src/reactors/supply-recorder';
import type { BusEvent } from '../src/types';

const CORRELATION_ID = 'lot_eggs_001';
const SCOTT = 'did:imajin:scott';
const BUYER = 'did:imajin:david';

function makeEvent(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    type: 'supply.declared',
    issuer: SCOTT,
    subject: SCOTT,
    scope: 'supply',
    correlationId: CORRELATION_ID,
    payload: { commodity: 'eggs', quantity: 12, unit: 'dozen' },
    ...overrides,
  };
}

describe('supplyRecorderReactor (#1136)', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('creates the lot (idempotent) then appends a stage on supply.declared', async () => {
    await supplyRecorderReactor(makeEvent(), {});

    expect(calls).toHaveLength(2);

    expect(calls[0].text).toContain('INSERT INTO kernel.supply_lots');
    expect(calls[0].text).toContain('ON CONFLICT (correlation_id) DO NOTHING');
    expect(calls[0].values).toEqual([CORRELATION_ID, SCOTT, 'eggs']);

    expect(calls[1].text).toContain('INSERT INTO kernel.supply_stages');
    expect(calls[1].values[0]).toBe(CORRELATION_ID);
    expect(calls[1].values[1]).toBe('declared');
    expect(calls[1].values[2]).toBe(SCOTT);
    expect(calls[1].values[3]).toBeNull(); // no priorCid on the first stage
    expect(JSON.parse(calls[1].values[4] as string)).toEqual({
      commodity: 'eggs',
      quantity: 12,
      unit: 'dozen',
    });
  });

  it('threads priorCid + stage on supply.collected and does not UPDATE the lot', async () => {
    await supplyRecorderReactor(
      makeEvent({ type: 'supply.collected', payload: { commodity: 'eggs', priorCid: 'bafy-declared' } }),
      {},
    );

    expect(calls).toHaveLength(2); // lot upsert + stage; no status change
    expect(calls[1].values[1]).toBe('collected');
    expect(calls[1].values[3]).toBe('bafy-declared');
  });

  it('advances lot status to listed on supply.listed', async () => {
    await supplyRecorderReactor(makeEvent({ type: 'supply.listed', payload: {} }), {});

    expect(calls).toHaveLength(3); // lot upsert + stage + status UPDATE
    expect(calls[2].text).toContain('UPDATE kernel.supply_lots');
    expect(calls[2].text).toContain("status = 'listed'");
    expect(calls[2].values).toEqual([CORRELATION_ID]);
  });

  it('records commodity as null when the payload omits it', async () => {
    await supplyRecorderReactor(makeEvent({ payload: { quantity: 12 } }), {});
    expect(calls[0].values[2]).toBeNull();
  });

  it('skips all DB work when correlationId is absent', async () => {
    await supplyRecorderReactor(makeEvent({ correlationId: undefined }), {});
    expect(calls).toHaveLength(0);
  });

  it('is a no-op for non-supply order.completed (e.g. scope=market)', async () => {
    await supplyRecorderReactor(
      makeEvent({ type: 'order.completed', scope: 'market', correlationId: 'ticket_001' }),
      {},
    );
    expect(calls).toHaveLength(0);
  });
});

describe('supplyRecorderReactor — settled stage (#1375)', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('writes the settled stage row and advances lot status on order.completed (scope=supply)', async () => {
    // fakeSql returns [] by default for every call, so:
    //   call 0 (settled-check) → [] = not yet settled
    //   call 1 (priorCid-lookup) → [] = no prior stage found → priorCid = null
    //   call 2 (lot-upsert), call 3 (stage-insert), call 4 (status-update) → []
    await supplyRecorderReactor(
      makeEvent({
        type: 'order.completed',
        scope: 'supply',
        issuer: BUYER,
        payload: { orderId: 'inv-001', amount: 5000, currency: 'CAD', buyerDid: BUYER },
      }),
      {},
    );

    // 5 SQL calls: settled-check, priorCid-lookup, lot-upsert, stage-insert, status-update
    expect(calls).toHaveLength(5);

    // call 0: idempotency check
    expect(calls[0].text).toContain('SELECT 1 FROM kernel.supply_lots');
    expect(calls[0].text).toContain("status = 'settled'");
    expect(calls[0].values).toEqual([CORRELATION_ID]);

    // call 1: priorCid lookup from most recent stage
    expect(calls[1].text).toContain('SELECT attestation_cid');
    expect(calls[1].text).toContain('FROM kernel.supply_stages');
    expect(calls[1].values).toEqual([CORRELATION_ID]);

    // call 2: lot get-or-create
    expect(calls[2].text).toContain('INSERT INTO kernel.supply_lots');
    expect(calls[2].text).toContain('ON CONFLICT (correlation_id) DO NOTHING');

    // call 3: settled stage insert
    expect(calls[3].text).toContain('INSERT INTO kernel.supply_stages');
    expect(calls[3].values[0]).toBe(CORRELATION_ID);
    expect(calls[3].values[1]).toBe('settled');
    expect(calls[3].values[2]).toBe(BUYER);
    // priorCid is null because the lookup returned no prior stage row
    expect(calls[3].values[3]).toBeNull();

    // call 4: status advance
    expect(calls[4].text).toContain('UPDATE kernel.supply_lots');
    expect(calls[4].text).toContain("status = 'settled'");
    expect(calls[4].values).toEqual([CORRELATION_ID]);
  });

  it('is idempotent: skips all writes when lot is already settled', async () => {
    // Prime the idempotency SELECT to return a row (lot already settled)
    resolveWith([{ '1': 1 }]);

    await supplyRecorderReactor(
      makeEvent({ type: 'order.completed', scope: 'supply' }),
      {},
    );

    // Only 1 SQL call: the idempotency check — nothing else is written
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('SELECT 1 FROM kernel.supply_lots');
    expect(calls[0].text).toContain("status = 'settled'");
  });

  it('prefers attestation_cid over id as prior_cid when the last stage has one', () => {
    // Documents the resolver contract: attestationCid ?? id ?? null.
    // attestationCid wins when present:
    const withAttestation = { attestationCid: 'bafyreigx12345', id: 'stage-uuid' };
    expect(withAttestation.attestationCid ?? withAttestation.id ?? null).toBe('bafyreigx12345');

    // Falls back to id when attestationCid is null (e.g. supply.listed has no attestation):
    const withoutAttestation = { attestationCid: null, id: 'stage-uuid' };
    expect(withoutAttestation.attestationCid ?? withoutAttestation.id ?? null).toBe('stage-uuid');
  });
});
