import { describe, it, expect } from 'vitest';
import { resolveSettlementPayerDid } from '../settlement-payer';

describe('resolveSettlementPayerDid (#2665 — the one seam #2656 extends)', () => {
  it("is the request's recipient when one is resolved", () => {
    expect(resolveSettlementPayerDid({ recipientDid: 'did:imajin:payer', issuerDid: 'did:imajin:issuer' })).toBe('did:imajin:payer');
  });

  it('falls back to the issuer for a request with no resolved recipient DID (an unclaimed stub) — as the card path always did', () => {
    expect(resolveSettlementPayerDid({ recipientDid: null, issuerDid: 'did:imajin:issuer' })).toBe('did:imajin:issuer');
  });
});
