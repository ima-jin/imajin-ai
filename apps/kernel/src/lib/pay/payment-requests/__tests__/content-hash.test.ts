import { describe, it, expect } from 'vitest';
import { computePaymentRequestContentHash, type PaymentRequestContentFields } from '../content-hash';

const BASE_FIELDS: PaymentRequestContentFields = {
  kind: 'invoice',
  issuerDid: 'did:imajin:issuer',
  payeeAccount: 'did:imajin:issuer',
  recipientDid: 'did:imajin:recipient',
  recipientStubId: null,
  lineItems: [{ name: 'Consulting', amount: 5000, quantity: 1 }],
  currency: 'CAD',
  totalAmount: 5000,
  dueAt: null,
  allowOnPlatform: true,
};

describe('computePaymentRequestContentHash', () => {
  it('is deterministic for identical content', async () => {
    const a = await computePaymentRequestContentHash(BASE_FIELDS);
    const b = await computePaymentRequestContentHash({ ...BASE_FIELDS });
    expect(a).toBe(b);
  });

  it('changes when the total changes', async () => {
    const a = await computePaymentRequestContentHash(BASE_FIELDS);
    const b = await computePaymentRequestContentHash({ ...BASE_FIELDS, totalAmount: 5001 });
    expect(a).not.toBe(b);
  });

  it('changes when the recipient changes', async () => {
    const a = await computePaymentRequestContentHash(BASE_FIELDS);
    const b = await computePaymentRequestContentHash({ ...BASE_FIELDS, recipientDid: 'did:imajin:other' });
    expect(a).not.toBe(b);
  });

  it('is independent of line item array identity (structural, not reference)', async () => {
    const a = await computePaymentRequestContentHash(BASE_FIELDS);
    const b = await computePaymentRequestContentHash({
      ...BASE_FIELDS,
      lineItems: [{ name: 'Consulting', amount: 5000, quantity: 1 }],
    });
    expect(a).toBe(b);
  });
});
