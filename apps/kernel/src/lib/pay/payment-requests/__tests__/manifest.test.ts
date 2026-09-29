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

describe('validateCustomPaymentRequestManifest — taxes[] (#2419 review fixes 5/7)', () => {
  const requestTotal = { amount: 10_000, currency: 'CAD' };
  const VALID_TAX = {
    jurisdiction: 'CA-ON',
    kind: 'GST/HST',
    rateBps: 1300,
    basisAmount: 10_000,
    amount: 1300,
    registrationNumber: '123456789RT0001',
    collectorDid: 'did:imajin:issuer',
    remitTo: 'did:imajin:authority:ca-cra',
  };

  it('accepts a manifest with a valid taxes[] row whose basisAmount matches the request total', () => {
    const result = validateCustomPaymentRequestManifest(
      { total: { amount: 10_000, currency: 'CAD' }, taxes: [VALID_TAX] },
      requestTotal,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects when taxes[].basisAmount does not match the request total (fix 5)', () => {
    const result = validateCustomPaymentRequestManifest(
      { total: { amount: 10_000, currency: 'CAD' }, taxes: [{ ...VALID_TAX, basisAmount: 9_000 }] },
      requestTotal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/basisAmount/);
  });

  it('rejects when a taxes[] row is missing registrationNumber (fix 7 — required)', () => {
    const missingReg = { jurisdiction: VALID_TAX.jurisdiction, kind: VALID_TAX.kind, rateBps: VALID_TAX.rateBps, basisAmount: VALID_TAX.basisAmount, amount: VALID_TAX.amount, collectorDid: VALID_TAX.collectorDid, remitTo: VALID_TAX.remitTo };
    const result = validateCustomPaymentRequestManifest(
      { total: { amount: 10_000, currency: 'CAD' }, taxes: [missingReg] },
      requestTotal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/registrationNumber/);
  });

  it('rejects when a taxes[] row is missing a required field (jurisdiction)', () => {
    const missingJurisdiction = { kind: VALID_TAX.kind, rateBps: VALID_TAX.rateBps, basisAmount: VALID_TAX.basisAmount, amount: VALID_TAX.amount, registrationNumber: VALID_TAX.registrationNumber, collectorDid: VALID_TAX.collectorDid, remitTo: VALID_TAX.remitTo };
    const result = validateCustomPaymentRequestManifest(
      { total: { amount: 10_000, currency: 'CAD' }, taxes: [missingJurisdiction] },
      requestTotal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/jurisdiction/);
  });

  it('rejects when taxes[].amount does not match basisAmount × rateBps / 10000', () => {
    const result = validateCustomPaymentRequestManifest(
      { total: { amount: 10_000, currency: 'CAD' }, taxes: [{ ...VALID_TAX, amount: 9999 }] },
      requestTotal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/does not match/);
  });

  it('rejects a non-array taxes field', () => {
    const result = validateCustomPaymentRequestManifest(
      { total: { amount: 10_000, currency: 'CAD' }, taxes: { not: 'an array' } },
      requestTotal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/taxes must be an array/);
  });

  it('accepts a manifest without a taxes field at all (unaffected, backward compatible)', () => {
    const result = validateCustomPaymentRequestManifest({ total: { amount: 10_000, currency: 'CAD' } }, requestTotal);
    expect(result.ok).toBe(true);
  });
});
