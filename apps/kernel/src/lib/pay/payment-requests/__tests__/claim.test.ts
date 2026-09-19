import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  selectQueue: [] as Array<Record<string, unknown>[]>,
  updateReturningQueue: [] as Array<Record<string, unknown>[]>,
  updateCalls: [] as Array<{ values: Record<string, unknown> }>,
  publishMock: vi.fn().mockResolvedValue(undefined),
  mechanicalAttestationMock: vi.fn().mockResolvedValue('att_claimed_1'),
}));

function selectResult() {
  return Promise.resolve(state.selectQueue.shift() ?? []);
}

function updateReturning() {
  return Promise.resolve(state.updateReturningQueue.shift() ?? []);
}

function updateWhere(values: Record<string, unknown>) {
  state.updateCalls.push({ values });
  return { returning: updateReturning };
}

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: selectResult }) }),
    update: () => ({ set: (values: Record<string, unknown>) => ({ where: () => updateWhere(values) }) }),
  },
  paymentRequests: { __table: 'payment_request' },
}));

vi.mock('@imajin/bus', () => ({ publish: state.publishMock }));

vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({
  emitMechanicalAttestation: state.mechanicalAttestationMock,
}));

import { resolvePaymentRequestsOnRecipientClaim } from '../claim';

const ISSUER_DID = 'did:imajin:issuer';
const CLAIMED_DID = 'did:imajin:claimed-stub';

function resetState() {
  for (const value of Object.values(state)) {
    if (Array.isArray(value)) value.length = 0;
  }
  state.publishMock.mockClear();
  state.mechanicalAttestationMock.mockClear();
  state.mechanicalAttestationMock.mockResolvedValue('att_claimed_1');
}

beforeEach(() => {
  resetState();
});

const ADDRESSED_ROW = {
  id: 'pr_1',
  issuerDid: ISSUER_DID,
  recipientStubId: CLAIMED_DID,
  recipientDid: null,
  totalAmount: 5000,
  currency: 'CAD',
  contentHash: 'bafy-x',
  status: 'issued',
};

describe('resolvePaymentRequestsOnRecipientClaim', () => {
  it('does nothing when no payment_request is addressed to the claimed stub', async () => {
    state.selectQueue.push([]);
    await resolvePaymentRequestsOnRecipientClaim(CLAIMED_DID);
    expect(state.updateCalls).toHaveLength(0);
    expect(state.publishMock).not.toHaveBeenCalled();
  });

  it('re-points recipient_stub_id -> recipient_did, mints exactly one attestation, and publishes exactly one event', async () => {
    state.selectQueue.push([ADDRESSED_ROW]);
    state.updateReturningQueue.push([{ ...ADDRESSED_ROW, recipientDid: CLAIMED_DID, recipientStubId: null }]);

    await resolvePaymentRequestsOnRecipientClaim(CLAIMED_DID);

    expect(state.updateCalls).toHaveLength(1);
    expect(state.updateCalls[0].values).toEqual(
      expect.objectContaining({ recipientDid: CLAIMED_DID, recipientStubId: null }),
    );

    expect(state.mechanicalAttestationMock).toHaveBeenCalledOnce();
    expect(state.mechanicalAttestationMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'payment_request.recipient_claimed', subjectDid: CLAIMED_DID, contextId: 'pr_1' }),
    );

    expect(state.publishMock).toHaveBeenCalledOnce();
    expect(state.publishMock).toHaveBeenCalledWith(
      'payment_request.recipient_claimed',
      expect.objectContaining({
        issuer: ISSUER_DID,
        subject: CLAIMED_DID,
        payload: expect.objectContaining({ paymentRequestId: 'pr_1', recipientDid: CLAIMED_DID, recipientStubId: CLAIMED_DID }),
      }),
    );
  });

  it('re-points every payment_request sharing the same stub, one attestation + event each', async () => {
    const rowB = { ...ADDRESSED_ROW, id: 'pr_2' };
    state.selectQueue.push([ADDRESSED_ROW, rowB]);
    state.updateReturningQueue.push(
      [{ ...ADDRESSED_ROW, recipientDid: CLAIMED_DID, recipientStubId: null }],
      [{ ...rowB, recipientDid: CLAIMED_DID, recipientStubId: null }],
    );

    await resolvePaymentRequestsOnRecipientClaim(CLAIMED_DID);

    expect(state.updateCalls).toHaveLength(2);
    expect(state.mechanicalAttestationMock).toHaveBeenCalledTimes(2);
    expect(state.publishMock).toHaveBeenCalledTimes(2);
  });

  it('is idempotent: a request already resolved by a concurrent/prior call is skipped (no duplicate attestation/event)', async () => {
    state.selectQueue.push([ADDRESSED_ROW]);
    // The guarded UPDATE returns nothing — recipient_stub_id no longer matches.
    state.updateReturningQueue.push([]);

    await resolvePaymentRequestsOnRecipientClaim(CLAIMED_DID);

    expect(state.updateCalls).toHaveLength(1);
    expect(state.mechanicalAttestationMock).not.toHaveBeenCalled();
    expect(state.publishMock).not.toHaveBeenCalled();
  });

  it('never touches attestations for a different payment_request not addressed to this stub', async () => {
    state.selectQueue.push([]); // the select itself is already filtered by recipient_stub_id
    await resolvePaymentRequestsOnRecipientClaim('did:imajin:unrelated-stub');
    expect(state.mechanicalAttestationMock).not.toHaveBeenCalled();
  });
});
