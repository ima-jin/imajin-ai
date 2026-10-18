import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePaymentMailSender } from '../payment-mail-sender';

const { lookup, where } = vi.hoisted(() => ({ lookup: vi.fn(), where: vi.fn() }));
vi.mock('@/src/db', () => ({
  paymentRequests: { id: 'id', issuerDid: 'issuer', recipientDid: 'recipient', recipientStubId: 'stub' },
  db: { select: () => ({ from: () => ({ where: (...args: unknown[]) => {
    where(...args);
    return { limit: lookup };
  } }) }) },
}));
vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => args }));
const issuerDid = 'did:imajin:issuer';
const row = { issuerDid, recipientDid: 'did:imajin:recipient', recipientStubId: 'did:imajin:stub' };
const input = {
  internal: true, sender: {}, scope: 'pay:payment_request-paid', to: row.recipientDid,
  data: { paymentRequestId: 'pr_test', ownerDid: 'did:imajin:spoof', appDid: 'did:imajin:spoof' },
};
beforeEach(() => { vi.clearAllMocks(); lookup.mockResolvedValue([row]); });

describe('internal payment-request mail identity', () => {
  it.each([row.issuerDid, row.recipientDid, row.recipientStubId])('attributes canonical issuer when delivering to %s', async (to) => {
    expect(await resolvePaymentMailSender({ ...input, to })).toEqual({ ownerDid: issuerDid });
    expect(where).toHaveBeenCalledWith(['id', 'pr_test']);
  });
  it.each(['pay:payment_request-issued', 'pay:payment_request-settled', 'pay:payment_request-voided', 'pay:payment_request-claimed'])(
    'supports the exact canonical lifecycle scope %s', async (scope) => {
      expect(await resolvePaymentMailSender({ ...input, scope })).toEqual({ ownerDid: issuerDid });
    },
  );
  it('does not replace authenticated external app identity with request data', async () => {
    const sender = { ownerDid: 'did:imajin:app-owner', appDid: 'did:imajin:app' };
    expect(await resolvePaymentMailSender({ ...input, internal: false, sender })).toBe(sender);
    expect(lookup).not.toHaveBeenCalled();
  });
  it.each(['custom:receipt', 'pay:payment_request-paid:spoof'])('does not broaden the canonical scope list: %s', async (scope) => {
    expect(await resolvePaymentMailSender({ ...input, scope })).toEqual({});
    expect(lookup).not.toHaveBeenCalled();
  });
  it.each([undefined, '', 123])('ignores malformed/missing canonical reference %s', async (paymentRequestId) => {
    expect(await resolvePaymentMailSender({ ...input, data: { paymentRequestId } })).toEqual({});
    expect(lookup).not.toHaveBeenCalled();
  });
  it('does not send as the issuer for an unrelated recipient', async () => {
    expect(await resolvePaymentMailSender({ ...input, to: 'did:imajin:stranger' })).toEqual({});
  });
  it('does not invent an owner when the request is missing', async () => {
    lookup.mockResolvedValue([]);
    expect(await resolvePaymentMailSender(input)).toEqual({});
  });
});
