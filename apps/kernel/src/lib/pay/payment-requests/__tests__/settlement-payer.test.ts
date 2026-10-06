import { describe, it, expect } from 'vitest';
import { payingDidOf, resolveSettlementPayerDid } from '../settlement-payer';

describe('resolveSettlementPayerDid (#2665 — the one seam #2656 extends)', () => {
  it("is the request's recipient when one is resolved", () => {
    expect(resolveSettlementPayerDid({ recipientDid: 'did:imajin:payer', issuerDid: 'did:imajin:issuer' })).toBe('did:imajin:payer');
  });

  it('falls back to the issuer for a request with no resolved recipient DID (an unclaimed stub) — as the card path always did', () => {
    expect(resolveSettlementPayerDid({ recipientDid: null, issuerDid: 'did:imajin:issuer' })).toBe('did:imajin:issuer');
  });

  describe('#2656 — paid_by_did', () => {
    it('prefers the DID the payer chose over the recipient (the invoice stays addressed to the recipient)', () => {
      expect(
        resolveSettlementPayerDid({ recipientDid: 'did:imajin:eric', issuerDid: 'did:imajin:issuer', paidByDid: 'did:imajin:artifact' }),
      ).toBe('did:imajin:artifact');
    });

    it('prefers it over the issuer fallback too — an unclaimed stub paid by a chosen DID', () => {
      expect(
        resolveSettlementPayerDid({ recipientDid: null, issuerDid: 'did:imajin:issuer', paidByDid: 'did:imajin:artifact' }),
      ).toBe('did:imajin:artifact');
    });

    it.each([null, undefined])('is the recipient, exactly as before, when paid_by_did is %s', (paidByDid) => {
      expect(
        resolveSettlementPayerDid({ recipientDid: 'did:imajin:eric', issuerDid: 'did:imajin:issuer', paidByDid }),
      ).toBe('did:imajin:eric');
    });
  });
});

describe('payingDidOf (#2656 — what a receipt / attestation names)', () => {
  it('is paid_by_did ?? recipient_did', () => {
    expect(payingDidOf({ recipientDid: 'did:imajin:eric', paidByDid: 'did:imajin:artifact' })).toBe('did:imajin:artifact');
    expect(payingDidOf({ recipientDid: 'did:imajin:eric', paidByDid: null })).toBe('did:imajin:eric');
  });

  it('has no issuer fallback — an unclaimed stub nobody chose a payer for names nobody', () => {
    expect(payingDidOf({ recipientDid: null, paidByDid: null })).toBeNull();
  });
});
