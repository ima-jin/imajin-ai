import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  insertCalls: [] as Array<Record<string, unknown>>,
  resolveOrMintMock: vi.fn(),
  publishMock: vi.fn().mockResolvedValue(undefined),
}));

function insertReturning(values: Record<string, unknown>) {
  return Promise.resolve([{ ...values, id: values.id, code: values.code }]);
}

function insertValues(values: Record<string, unknown>) {
  state.insertCalls.push(values);
  return { returning: () => insertReturning(values) };
}

vi.mock('@/src/db', () => ({
  db: { insert: () => ({ values: insertValues }) },
  invites: { __table: 'invites' },
}));

vi.mock('@imajin/bus', () => ({ publish: state.publishMock }));

vi.mock('@imajin/config', () => ({ buildPublicUrl: (service: string) => `https://jin.imajin.ai/${service}` }));

vi.mock('@/src/lib/auth/claimable-stub', () => ({
  resolveOrMintInviteTarget: state.resolveOrMintMock,
}));

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

import { createPaymentRequestInvite } from '../payment-request-invite';

const ISSUER_DID = 'did:imajin:issuer';
const STUB_DID = 'did:imajin:new-stub';

beforeEach(() => {
  state.insertCalls.length = 0;
  state.publishMock.mockClear();
  state.resolveOrMintMock.mockReset();
  state.resolveOrMintMock.mockResolvedValue(STUB_DID);
});

describe('createPaymentRequestInvite', () => {
  it('resolves the recipient via the claimable-stub primitive (create-or-reuse per email)', async () => {
    const result = await createPaymentRequestInvite({
      issuerDid: ISSUER_DID,
      email: 'customer@example.com',
      delivery: 'email',
      reasonContextId: 'pr_1',
      reasonContextType: 'payment_request',
    });

    expect(state.resolveOrMintMock).toHaveBeenCalledWith('customer@example.com');
    expect(result.recipientStubId).toBe(STUB_DID);
  });

  it('stamps the invite row with the opaque reason and toDid, and returns a usable url/code', async () => {
    const result = await createPaymentRequestInvite({
      issuerDid: ISSUER_DID,
      email: 'Customer@Example.com',
      delivery: 'email',
      note: 'Invoice for consulting',
      reasonContextId: 'pr_1',
      reasonContextType: 'payment_request',
    });

    expect(state.insertCalls).toHaveLength(1);
    const inserted = state.insertCalls[0];
    expect(inserted.fromDid).toBe(ISSUER_DID);
    expect(inserted.toDid).toBe(STUB_DID);
    expect(inserted.toEmail).toBe('customer@example.com');
    expect(inserted.reasonContextId).toBe('pr_1');
    expect(inserted.reasonContextType).toBe('payment_request');
    expect(inserted.status).toBe('pending');

    expect(result.inviteUrl).toContain(`/invite/${ISSUER_DID}/`);
    expect(result.inviteCode).toBeTruthy();
  });

  it('never leaks the resolved stub DID in anything other than the return value (no PII pre-claim)', async () => {
    await createPaymentRequestInvite({
      issuerDid: ISSUER_DID,
      email: 'customer@example.com',
      delivery: 'email',
      reasonContextId: 'pr_1',
      reasonContextType: 'payment_request',
    });

    // The connection.invited publish carries only opaque ids, never PII.
    expect(state.publishMock).toHaveBeenCalledWith(
      'connection.invited',
      expect.objectContaining({ payload: { context_id: 'inv_test', context_type: 'connection', delivery: 'email' } }),
    );
  });
});
