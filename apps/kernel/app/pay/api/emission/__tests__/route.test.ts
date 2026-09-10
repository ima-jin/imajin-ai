/**
 * Tests for POST /api/emission (#2016).
 *
 * An emission can never mint the withdrawable unit — `unit` must be
 * 'MJNx'. Also verifies the attestation id (when supplied via
 * metadata.attestation_id, as the `mjn` reactor now forwards it) lands on
 * the transaction's first-class `attestationId` column.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonPostRequest, resetMockDbCallState } from '@/src/lib/pay/__tests__/mock-drizzle-table';

const state = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: string; values: Record<string, unknown>; conflict?: unknown }>,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
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
  return balanceRouteDbModule(state);
});

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

import { POST } from '../route';

const API_KEY = 'test-pay-api-key';

function makeRequest(body: Record<string, unknown>): Request {
  return jsonPostRequest('https://kernel.test/api/emission', body, { Authorization: `Bearer ${API_KEY}` });
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
    expect(state.insertCalls).toHaveLength(2); // balance credit + transaction row

    const balanceValues = state.insertCalls[0].values;
    expect(balanceValues).toMatchObject({ did: 'did:imajin:x', unit: 'MJNx', amount: '10' });

    const txValues = state.insertCalls[1].values;
    expect(txValues).toMatchObject({ unit: 'MJNx', sourceKind: 'emission', toDid: 'did:imajin:x' });
    expect(txValues.attestationId).toBeNull();
  });

  it('lifts metadata.attestation_id into the first-class attestationId column', async () => {
    await POST(
      makeRequest({
        to_did: 'did:imajin:x',
        amount: 10,
        unit: 'MJNx',
        reason: 'Welcome',
        metadata: { attestation_type: 'identity.created', attestation_id: 'att_123' },
      }) as never,
    );

    const txValues = state.insertCalls[1].values;
    expect(txValues.attestationId).toBe('att_123');
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
