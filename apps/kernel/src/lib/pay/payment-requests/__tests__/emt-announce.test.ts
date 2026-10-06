import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  emitSettled: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('@imajin/bus', () => ({ publish: mocks.publish }));
vi.mock('@/src/lib/pay/payment-requests/attestations', () => ({ emitPaymentRequestSettledAttestation: mocks.emitSettled }));

import { attestAndAnnounceEmtSettled } from '../emt-announce';

const REQUEST = {
  id: 'pr_1',
  issuerDid: 'did:imajin:issuer',
  recipientDid: 'did:imajin:payer',
  contentHash: 'bafy-x',
  totalAmount: 5000,
  subtotalAmount: 5000,
  taxTotalAmount: 0,
  currency: 'CAD',
  fairManifest: {},
} as unknown as Parameters<typeof attestAndAnnounceEmtSettled>[0];

const REF = { method: 'emt' as const, asserted_by: 'did:imajin:issuer', reference: 'INV-1', settled_at: '2026-10-09T18:45:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emitSettled.mockResolvedValue('att_1');
  mocks.publish.mockResolvedValue(undefined);
});

describe('attestAndAnnounceEmtSettled (#2665)', () => {
  it('mints one issuer-signed attestation naming the rail, then announces payment_request.settled to the payer', async () => {
    await attestAndAnnounceEmtSettled(REQUEST, REF);

    expect(mocks.emitSettled).toHaveBeenCalledTimes(1);
    expect(mocks.emitSettled.mock.calls[0][0]).toMatchObject({ method: 'emt', assertedBy: 'did:imajin:issuer', reference: 'INV-1', totalAmount: 5000 });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledWith(
      'payment_request.settled',
      expect.objectContaining({
        issuer: 'did:imajin:issuer',
        subject: 'did:imajin:payer',
        scope: 'pay',
        payload: expect.objectContaining({ method: 'emt', attestationId: 'att_1', paymentRequestId: 'pr_1' }),
      }),
    );
  });

  it("attributes the settlement to the issuer when the ref carries no asserter, and the subject to the issuer when there is no recipient DID", async () => {
    await attestAndAnnounceEmtSettled({ ...REQUEST, recipientDid: null }, { ...REF, asserted_by: undefined });

    expect(mocks.emitSettled.mock.calls[0][0]).toMatchObject({ assertedBy: 'did:imajin:issuer', recipientDid: null });
    expect(mocks.publish.mock.calls[0][1]).toMatchObject({ issuer: 'did:imajin:issuer', subject: 'did:imajin:issuer' });
  });

  it('swallows a failing publish — the announcement is best-effort and never throws', async () => {
    mocks.publish.mockRejectedValue(new Error('bus down'));
    await expect(attestAndAnnounceEmtSettled(REQUEST, REF)).resolves.toBeUndefined();
  });
});
