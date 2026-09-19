import { describe, it, expect } from 'vitest';
import { buildDefaultPaymentRequestManifest, validateCustomPaymentRequestManifest } from '../manifest';

describe('buildDefaultPaymentRequestManifest', () => {
  it('builds a single-payee manifest (one seller share) carrying the request total', () => {
    const manifest = buildDefaultPaymentRequestManifest({
      payeeAccount: 'did:imajin:issuer',
      paymentRequestId: 'pr_1',
      total: { amount: 5000, currency: 'CAD' },
    });

    expect(manifest.total).toEqual({ amount: 5000, currency: 'CAD' });
    expect(Array.isArray(manifest.chain)).toBe(true);
    const sellerEntry = (manifest.chain as Array<{ did: string; role: string; share: number }>).find(
      (e) => e.role === 'seller',
    );
    expect(sellerEntry?.did).toBe('did:imajin:issuer');
    // One customer/attribution entry, matching "one payee, one customer".
    expect(manifest.attribution).toEqual([{ did: 'did:imajin:issuer', role: 'creator', share: 1 }]);
  });
});

describe('validateCustomPaymentRequestManifest', () => {
  const requestTotal = { amount: 1000, currency: 'USD' };

  it('accepts a manifest whose total matches the request total', () => {
    const result = validateCustomPaymentRequestManifest({ chain: [], total: { amount: 1000, currency: 'USD' } }, requestTotal);
    expect(result.ok).toBe(true);
  });

  it('rejects a manifest whose total amount does not match', () => {
    const result = validateCustomPaymentRequestManifest({ total: { amount: 999, currency: 'USD' } }, requestTotal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/does not match the request total/);
  });

  it('rejects a manifest whose total currency does not match', () => {
    const result = validateCustomPaymentRequestManifest({ total: { amount: 1000, currency: 'CAD' } }, requestTotal);
    expect(result.ok).toBe(false);
  });

  it('rejects a manifest missing a total field', () => {
    const result = validateCustomPaymentRequestManifest({ chain: [] }, requestTotal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/fair_manifest\.total/);
  });

  it('rejects a non-object manifest', () => {
    expect(validateCustomPaymentRequestManifest('not-an-object', requestTotal).ok).toBe(false);
    expect(validateCustomPaymentRequestManifest(null, requestTotal).ok).toBe(false);
    expect(validateCustomPaymentRequestManifest([1, 2, 3], requestTotal).ok).toBe(false);
  });
});
