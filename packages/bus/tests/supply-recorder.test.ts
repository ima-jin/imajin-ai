import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake postgres.js tagged-template client: records each query's skeleton +
// interpolated values so we can assert what SQL the recorder issues, no DB needed.
const { calls, fakeSql } = vi.hoisted(() => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join(' ? '), values });
    return Promise.resolve([]);
  };
  return { calls, fakeSql };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

import { supplyRecorderReactor } from '../src/reactors/supply-recorder';
import type { BusEvent } from '../src/types';

const CORRELATION_ID = 'lot_eggs_001';
const SCOTT = 'did:imajin:scott';

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
});
