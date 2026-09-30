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

  describe('tax (#2421)', () => {
    const TAX = {
      subtotalAmount: 5000,
      taxTotalAmount: 650,
      taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, amount: 650, registrationNumber: '123456789RT0001' }],
    };
    const TAXED = { ...BASE_FIELDS, totalAmount: 5650, tax: TAX };

    it('a request without tax hashes exactly as before: tax null / omitted change nothing', async () => {
      const base = await computePaymentRequestContentHash(BASE_FIELDS);
      expect(await computePaymentRequestContentHash({ ...BASE_FIELDS, tax: null })).toBe(base);
      expect(await computePaymentRequestContentHash({ ...BASE_FIELDS, tax: undefined })).toBe(base);
    });

    it('binds the breakdown: a different rate, amount, or registration number changes the hash', async () => {
      const a = await computePaymentRequestContentHash(TAXED);
      const withTax = (patch: Partial<(typeof TAX)['taxes'][number]>) => ({
        ...TAXED,
        tax: { ...TAX, taxes: [{ ...TAX.taxes[0], ...patch }] },
      });
      expect(await computePaymentRequestContentHash(TAXED)).toBe(a);
      expect(await computePaymentRequestContentHash(withTax({ rateBps: 1400 }))).not.toBe(a);
      expect(await computePaymentRequestContentHash(withTax({ registrationNumber: '999999999RT0001' }))).not.toBe(a);
      expect(await computePaymentRequestContentHash({ ...TAXED, tax: { ...TAX, taxTotalAmount: 651 } })).not.toBe(a);
    });
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
