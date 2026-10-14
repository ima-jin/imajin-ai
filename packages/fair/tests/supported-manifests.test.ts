import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  buildFairManifest,
  getDefaultManifest,
  isFairFeeManifest,
  isFairManifestV11,
  isValidManifest,
  validateManifest,
} from '../src';
import type { FairFeeManifest, FairManifest, SupportedFairManifest } from '../src';
import { storedDocumentManifest, storedFeeManifest } from './fixtures/stored-manifests';

const tax = {
  jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300,
  registrationNumber: '123456789RT0001',
  collectorDid: 'did:imajin:seller', remitTo: 'did:imajin:authority:ca-cra',
};
const builtFee = () => buildFairManifest({
  creatorDid: 'did:imajin:seller', contentDid: 'did:imajin:event', contentType: 'event',
});
const builtTaxFee = () => buildFairManifest({
  creatorDid: 'did:imajin:seller', contentDid: 'did:imajin:event', contentType: 'event',
  taxes: [tax], basisAmountCents: 10_000,
});
const legacyDocument = () => ({
  fair: '1.0', id: 'legacy', type: 'text/plain', owner: 'did:imajin:seller',
  created: '2020-01-01T00:00:00Z', access: 'public',
  attribution: [{ did: 'did:imajin:seller', role: 'creator', share: 0.5 }],
});

function assertInvalid(value: unknown) {
  const result = validateManifest(value);
  expect(result.ok).toBe(false);
  expect(result.valid).toBe(false);
  expect(result.errors.length).toBeGreaterThan(0);
  expect(isValidManifest(value)).toBe(false);
}

describe('supported .fair manifest shapes (#2787)', () => {
  it.each([
    ['built fee', builtFee()],
    ['built tax fee', builtTaxFee()],
    ['built document', { ...getDefaultManifest('image/png', 'did:imajin:seller'), id: 'asset_built_document' }],
    ['stored fee', storedFeeManifest],
    ['stored document', storedDocumentManifest],
    ['legacy document', legacyDocument()],
  ])('accepts %s without migration or mutation', (_name, manifest) => {
    const before = JSON.stringify(manifest);
    expect(validateManifest(manifest)).toEqual({ ok: true, valid: true, errors: [] });
    expect(isValidManifest(manifest)).toBe(true);
    expect(JSON.stringify(manifest)).toBe(before);
  });

  it('narrows unknown to the supported union without broadening document-only APIs', () => {
    const value: unknown = builtFee();
    if (!isValidManifest(value)) throw new Error('expected valid fixture');
    expectTypeOf(value).toEqualTypeOf<SupportedFairManifest>();
    if (isFairFeeManifest(value)) {
      expectTypeOf(value).toEqualTypeOf<FairFeeManifest>();
      expect(value.version).toBe('0.4.0');
    }
    expectTypeOf<FairFeeManifest>().not.toMatchTypeOf<FairManifest>();
    expect(isFairFeeManifest(storedDocumentManifest)).toBe(false);
    expect(isFairFeeManifest(null)).toBe(false);
    expect(isFairManifestV11(storedFeeManifest)).toBe(false);
    expect(isFairManifestV11(storedDocumentManifest)).toBe(true);
  });

  it.each(['fees', 'chain', 'distributions', 'attribution'])('requires fee %s', (field) => {
    const manifest: Record<string, unknown> = { ...builtFee() };
    delete manifest[field];
    assertInvalid(manifest);
    assertInvalid({ ...builtFee(), [field]: null });
    assertInvalid({ ...builtFee(), [field]: {} });
  });

  it.each(['chain', 'distributions', 'attribution'])('strictly validates fee %s rows and totals', (field) => {
    for (const rows of [
      [], [null], [undefined], [[]], [1], ['entry'], [{}],
      [{ role: 'creator', share: 1 }],
      [{ did: '', role: 'creator', share: 1 }],
      [{ did: 'did:test', share: 1 }],
      [{ did: 'did:test', role: 'creator', share: 0.5 }],
      [{ did: 'did:test', role: 'creator', share: Number.NaN }],
      [{ did: 'did:test', role: 'creator', share: Number.POSITIVE_INFINITY }],
      [{ did: 'did:test', role: 'creator', share: -1 }],
      [{ did: 'did:test', role: 'creator', share: 2 }],
      new Array(1),
    ]) assertInvalid({ ...builtFee(), [field]: rows });
  });

  it('validates every required fee row field and optional minimum', () => {
    assertInvalid({ ...builtFee(), fees: [] });
    assertInvalid({ ...builtFee(), fees: new Array(1) });
    const fee = builtFee().fees[0];
    for (const field of ['role', 'name', 'rateBps', 'fixedCents']) {
      const row: Record<string, unknown> = { ...fee };
      delete row[field];
      assertInvalid({ ...builtFee(), fees: [row] });
    }
    for (const row of [null, [], {}, { ...fee, rateBps: Number.NaN },
      { ...fee, rateBps: Number.POSITIVE_INFINITY }, { ...fee, rateBps: -1 },
      { ...fee, fixedCents: 0.5 }, { ...fee, minRateBps: -1 },
      { ...fee, minRateBps: fee.rateBps + 1 }]) {
      assertInvalid({ ...builtFee(), fees: [row] });
    }
    expect(isValidManifest({ ...builtFee(), fees: [{ ...fee, minRateBps: 0 }] })).toBe(true);
  });

  it('validates optional share-entry metadata while preserving extensions', () => {
    const row = { did: 'did:test', role: 'creator', share: 1 };
    for (const extension of [
      { name: 1 }, { note: false }, { chainProof: null }, { chainProof: [] },
      { chainProof: {} }, { chainProof: { verified: 'true' } },
      { chainProof: { verified: true, verifiedAt: 1 } },
    ]) {
      assertInvalid({ ...builtFee(), attribution: [{ ...row, ...extension }] });
      assertInvalid({ ...legacyDocument(), attribution: [{ ...row, ...extension }] });
    }
    expect(isValidManifest({
      ...builtFee(), signature: { custom: 'stored-signature' }, customExtension: 'unchanged',
      attribution: [{ ...row, name: 'Creator', note: '', chainProof: { verified: true, verifiedAt: '2026-01-01T00:00:00Z' } }],
    })).toBe(true);
  });

  it.each(['1.3', '2.0', '0.3.0', '0.6.0', '', null, 1])('rejects unsupported marker %s', (version) => {
    assertInvalid({ ...builtFee(), version });
    assertInvalid({ ...storedDocumentManifest, fair: version, version });
  });

  it('rejects hybrid and mismatched document/fee markers', () => {
    assertInvalid({ ...storedDocumentManifest, version: '0.4.0' });
    assertInvalid({ ...storedDocumentManifest, fair: '1.0' });
    for (const field of ['fair', 'id', 'type', 'owner', 'created', 'access', 'transfer', 'distribution']) {
      assertInvalid({ ...builtFee(), [field]: field === 'fair' ? undefined : {} });
    }
    const withoutFair: Record<string, unknown> = { ...storedDocumentManifest };
    delete withoutFair.fair;
    assertInvalid(withoutFair);
  });

  it('retains document-version-specific attribution semantics', () => {
    expect(isValidManifest(legacyDocument())).toBe(true);
    assertInvalid({ ...storedDocumentManifest, attribution: legacyDocument().attribution });
    assertInvalid({ ...legacyDocument(), attribution: [{ role: 'creator', share: 1 }] });
    expect(isValidManifest({ ...storedDocumentManifest, attribution: [{ role: 'platform', name: 'Imajin', share: 1 }] })).toBe(true);
    assertInvalid({ ...legacyDocument(), attribution: [{ did: 'did:test', role: 'creator', share: 1.1 }] });
  });

  it('rejects invalid documents rather than falling back to fee validation', () => {
    for (const field of ['id', 'type', 'owner', 'created', 'access', 'attribution']) {
      assertInvalid({ ...storedDocumentManifest, [field]: null });
    }
    assertInvalid({ ...storedDocumentManifest, attribution: [{ role: 'creator', share: Number.NaN }] });
    assertInvalid({ ...storedDocumentManifest, transfer: { allowed: true, resaleRoyaltyBps: Number.NaN } });
    assertInvalid({ ...legacyDocument(), transfer: { allowed: true, resaleRoyalty: Number.NaN } });
  });

  it.each([null, undefined, false, 42, '', [], [storedFeeManifest]])('rejects malformed root %s without throwing', assertInvalid);

  it('rejects malformed nested document sections without throwing', () => {
    for (const field of ['access', 'transfer', 'training', 'commercial', 'distribution', 'settlement']) {
      for (const value of [null, [], 1, 'bad']) assertInvalid({ ...storedDocumentManifest, [field]: value });
    }
    for (const field of ['attribution', 'provenance', 'chain', 'distributions', 'fees']) {
      for (const value of [null, [], 1, 'bad']) assertInvalid({ ...storedDocumentManifest, [field]: [value] });
    }
    for (const value of [null, [], 1, 'bad']) {
      assertInvalid({ ...legacyDocument(), attribution: [value] });
      assertInvalid({ ...legacyDocument(), transfer: value });
      assertInvalid({ ...legacyDocument(), intent: value });
      assertInvalid({ ...legacyDocument(), signature: value });
      assertInvalid({ ...storedDocumentManifest, distribution: { reproduction: value } });
      assertInvalid({ ...storedDocumentManifest, transfer: { allowed: true, price: value } });
    }
    assertInvalid({ ...storedDocumentManifest, settlement: { schemes: [Object.create(null)] } });
  });

  it('does not mutate invalid data or frozen stored records', () => {
    for (const manifest of [storedDocumentManifest, storedFeeManifest]) {
      const frozen = structuredClone(manifest);
      Object.freeze(frozen.attribution[0]);
      Object.freeze(frozen.attribution);
      Object.freeze(frozen);
      const before = JSON.stringify(frozen);
      expect(validateManifest(frozen).ok).toBe(true);
      expect(JSON.stringify(frozen)).toBe(before);
    }
    const invalid = { ...builtFee(), chain: [{ did: 'did:test', role: 'seller', share: -0.5 }] };
    const before = structuredClone(invalid);
    assertInvalid(invalid);
    expect(invalid).toEqual(before);
  });
});

describe('fee tax version invariant (#2787)', () => {
  it('requires non-empty taxes exactly for 0.5.0 and 1.2', () => {
    for (const taxes of [undefined, [], null, {}]) {
      assertInvalid({ ...builtFee(), version: '0.5.0', taxes });
      assertInvalid({ ...storedDocumentManifest, fair: '1.2', version: '1.2', taxes });
    }
    const taxes = builtTaxFee().taxes;
    assertInvalid({ ...builtFee(), taxes });
    assertInvalid({ ...storedDocumentManifest, taxes });
    assertInvalid({ ...legacyDocument(), taxes });
    expect(isValidManifest({ ...storedDocumentManifest, fair: '1.2', version: '1.2', taxes })).toBe(true);
    expect(isValidManifest({ ...builtFee(), taxes: [] })).toBe(true);
  });

  it('shares strict tax row validation and existing rounding tolerance', () => {
    const manifest = builtTaxFee();
    const row = manifest.taxes![0];
    for (const field of Object.keys(row)) {
      const missing: Record<string, unknown> = { ...row };
      delete missing[field];
      assertInvalid({ ...manifest, taxes: [missing] });
    }
    for (const taxRow of [null, [], {}, { ...row, amount: 9999 },
      { ...row, rateBps: Number.NaN }, { ...row, amount: Number.POSITIVE_INFINITY },
      { ...row, basisAmount: -1 }, { ...row, rateBps: 0.5 },
      { ...row, basisAmount: 1e308, rateBps: 1e308, amount: 0 }]) {
      assertInvalid({ ...manifest, taxes: [taxRow] });
    }
    expect(isValidManifest({ ...manifest, taxes: [{ ...row, amount: row.amount + 1 }] })).toBe(true);
  });
});
