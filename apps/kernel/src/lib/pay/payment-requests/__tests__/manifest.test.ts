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
    // No tax: no `taxes`, no `fair` stamp, version untouched.
    expect(manifest).not.toHaveProperty('taxes');
    expect(manifest).not.toHaveProperty('fair');
    expect(manifest.version).toBe('0.4.0');
  });

  it('#2421: with taxes, carries taxes[] verbatim, stamps fair "1.2" and bumps the fee-manifest version, keeping total pre-tax', () => {
    const tax = {
      jurisdiction: 'CA-ON',
      kind: 'GST/HST',
      rateBps: 1300,
      basisAmount: 5000,
      amount: 650,
      registrationNumber: '123456789RT0001',
      collectorDid: 'did:imajin:issuer',
      remitTo: 'did:imajin:authority:ca-cra',
    };
    const manifest = buildDefaultPaymentRequestManifest({
      payeeAccount: 'did:imajin:issuer',
      paymentRequestId: 'pr_1',
      total: { amount: 5000, currency: 'CAD' },
      taxes: [tax],
    });

    expect(manifest.taxes).toEqual([tax]);
    expect(manifest.fair).toBe('1.2');
    expect(manifest.version).toBe('0.5.0');
    expect(manifest.total).toEqual({ amount: 5000, currency: 'CAD' });
    // The default manifest's own chain always satisfies the collector-is-a-seller rule for the payee.
    expect(validateCustomPaymentRequestManifest(manifest, { amount: 5000, currency: 'CAD' }).ok).toBe(true);
  });

  it('#2421: an empty taxes array is treated as no tax', () => {
    const manifest = buildDefaultPaymentRequestManifest({
      payeeAccount: 'did:imajin:issuer',
      paymentRequestId: 'pr_1',
      total: { amount: 5000, currency: 'CAD' },
      taxes: [],
    });
    expect(manifest).not.toHaveProperty('taxes');
    expect(manifest).not.toHaveProperty('fair');
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
  // #2439 item 2: the tax collector must be a seller in the manifest chain.
  const SELLER_CHAIN = [
    { did: 'did:imajin:protocol', role: 'protocol', share: 0.01 },
    { did: 'did:imajin:issuer', role: 'seller', share: 0.99 },
  ];

  it('accepts a manifest with a valid taxes[] row whose basisAmount matches the request total', () => {
    const result = validateCustomPaymentRequestManifest(
      { fair: '1.2', total: { amount: 10_000, currency: 'CAD' }, chain: SELLER_CHAIN, taxes: [VALID_TAX] },
      requestTotal,
    );
    expect(result.ok).toBe(true);
  });

  it('#2439: rejects a non-empty taxes[] on a manifest not stamped fair "1.2"', () => {
    for (const fair of [undefined, '1.1', '1.0']) {
      const result = validateCustomPaymentRequestManifest(
        { fair, total: { amount: 10_000, currency: 'CAD' }, chain: SELLER_CHAIN, taxes: [VALID_TAX] },
        requestTotal,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/fair_manifest\.fair must be "1\.2" when fair_manifest\.taxes is present/);
    }
  });

  it('#2439: an empty taxes[] needs no "1.2" stamp', () => {
    const result = validateCustomPaymentRequestManifest(
      { total: { amount: 10_000, currency: 'CAD' }, chain: SELLER_CHAIN, taxes: [] },
      requestTotal,
    );
    expect(result.ok).toBe(true);
  });

  it('#2439 item 4: rejects every non-array taxes value instead of silently ignoring it', () => {
    for (const taxes of [null, 'GST', 13, true, { not: 'an array' }]) {
      const result = validateCustomPaymentRequestManifest(
        { fair: '1.2', total: { amount: 10_000, currency: 'CAD' }, chain: SELLER_CHAIN, taxes },
        requestTotal,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/taxes must be an array/);
    }
  });

  it('#2439 item 2: rejects at create time when the tax collector is not a seller in the chain', () => {
    const result = validateCustomPaymentRequestManifest(
      {
        total: { amount: 10_000, currency: 'CAD' },
        chain: [{ did: 'did:imajin:someone-else', role: 'seller', share: 1 }],
        taxes: [VALID_TAX],
      },
      requestTotal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/collectorDid \(did:imajin:issuer\) must be a seller in fair_manifest\.chain/);
  });

  it('#2439 item 2: a collector that is in the chain but only as a non-seller role (e.g. platform) is rejected', () => {
    const result = validateCustomPaymentRequestManifest(
      {
        total: { amount: 10_000, currency: 'CAD' },
        chain: [{ did: 'did:imajin:issuer', role: 'platform', share: 1 }],
        taxes: [VALID_TAX],
      },
      requestTotal,
    );
    expect(result.ok).toBe(false);
  });

  it('#2439 item 2: a manifest with taxes[] and no chain at all is rejected', () => {
    const result = validateCustomPaymentRequestManifest(
      { total: { amount: 10_000, currency: 'CAD' }, taxes: [VALID_TAX] },
      requestTotal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/must be a seller/);
  });

  it('accepts a collector whose chain role is creator or event (the same SELLER_ROLES settle-core credits)', () => {
    for (const role of ['creator', 'event']) {
      const result = validateCustomPaymentRequestManifest(
        {
          fair: '1.2',
          total: { amount: 10_000, currency: 'CAD' },
          chain: [{ did: 'did:imajin:issuer', role, share: 1 }],
          taxes: [VALID_TAX],
        },
        requestTotal,
      );
      expect(result.ok).toBe(true);
    }
  });

  it('rejects when taxes[].basisAmount does not match the request total (fix 5)', () => {
    const result = validateCustomPaymentRequestManifest(
      { total: { amount: 10_000, currency: 'CAD' }, chain: SELLER_CHAIN, taxes: [{ ...VALID_TAX, basisAmount: 9_000 }] },
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
      { total: { amount: 10_000, currency: 'CAD' }, chain: SELLER_CHAIN, taxes: [{ ...VALID_TAX, amount: 9999 }] },
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
