/**
 * Tests for POST /api/emission (#2016).
 *
 * An emission can never mint the withdrawable unit — `unit` must be
 * 'MJNx'. Also verifies the attestation id (when supplied via
 * metadata.attestation_id, as the `mjn` reactor now forwards it) lands on
 * the transaction's first-class `attestationId` column.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
  const insertValuesMock = vi.fn(() => ({ onConflictDoUpdate: onConflictDoUpdateMock }));
  const insertMock = vi.fn(() => ({ values: insertValuesMock }));
  return { onConflictDoUpdateMock, insertValuesMock, insertMock };
});

vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: (req: unknown, ctx: { log: unknown }) => Promise<Response>) =>
    (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }),
}));

vi.mock('@imajin/config', () => ({
  rateLimit: () => ({ limited: false }),
  getClientIP: () => '127.0.0.1',
}));

vi.mock('@/src/db', () => ({
  db: { insert: mocks.insertMock },
  balances: { did: 'did', unit: 'unit', amount: 'amount' },
  transactions: {},
}));

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

import { POST } from '../route';

const API_KEY = 'test-pay-api-key';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://kernel.test/api/emission', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PAY_SERVICE_API_KEY = API_KEY;
});

describe('POST /api/emission — MJNx-only enforcement (#2016)', () => {
  it('rejects unit: MJN with a 400 — an emission can never mint the withdrawable unit', async () => {
    const res = await POST(makeRequest({ to_did: 'did:imajin:x', amount: 10, unit: 'MJN', reason: 'test' }) as never);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/MJNx/);
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it('rejects a missing/unknown unit', async () => {
    const res = await POST(makeRequest({ to_did: 'did:imajin:x', amount: 10, reason: 'test' }) as never);
    expect(res.status).toBe(400);
  });

  it('credits the MJNx balance row and logs a source_kind=emission transaction for unit: MJNx', async () => {
    const res = await POST(makeRequest({ to_did: 'did:imajin:x', amount: 10, unit: 'MJNx', reason: 'Welcome' }) as never);

    expect(res.status).toBe(201);
    expect(mocks.insertMock).toHaveBeenCalledTimes(2); // balance credit + transaction row

    const balanceValues = mocks.insertValuesMock.mock.calls[0][0];
    expect(balanceValues).toMatchObject({ did: 'did:imajin:x', unit: 'MJNx', amount: '10' });

    const txValues = mocks.insertValuesMock.mock.calls[1][0];
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

    const txValues = mocks.insertValuesMock.mock.calls[1][0];
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
