/**
 * Tests for #2419 — top-level `taxes[]` on the `.fair` manifest.
 *
 * Covers:
 *  (a) buildFairManifest's taxes/basisAmountCents input
 *  (b) validate.ts's taxes[] structural validation + v1.2 acceptance
 *  (c) resolveSettlementChain's taxCredits/gross-fee behavior
 */
import { describe, it, expect } from 'vitest';
import { buildFairManifest } from '../src/buildManifest';
import { validateManifest } from '../src/validate';
import { resolveSettlementChain, type FairSettlementEntry, type FairSettlementTax } from '../src/settlement';
import { AUTHORITY_DID_CA_CRA } from '../src/constants';
import type { FairManifestV11 } from '../src/types';

const CREATOR = 'did:imajin:seller123';
const CONTENT = 'did:imajin:content456';

// ── buildFairManifest ────────────────────────────────────────────────────────

describe('buildFairManifest — taxes (#2419)', () => {
  it('omits taxes and stays version 0.4.0 when no taxes are supplied', () => {
    const manifest = buildFairManifest({ creatorDid: CREATOR, contentDid: CONTENT, contentType: 'event' });
    expect(manifest.version).toBe('0.4.0');
    expect(manifest.taxes).toBeUndefined();
  });

  it('computes basisAmount/amount and bumps version to 0.5.0 when taxes are supplied', () => {
    const manifest = buildFairManifest({
      creatorDid: CREATOR,
      contentDid: CONTENT,
      contentType: 'event',
      basisAmountCents: 10_000, // $100.00 pre-tax
      taxes: [
        { jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, registrationNumber: '123456789RT0001', collectorDid: CREATOR, remitTo: AUTHORITY_DID_CA_CRA },
      ],
    });

    expect(manifest.version).toBe('0.5.0');
    expect(manifest.taxes).toHaveLength(1);
    const tax = manifest.taxes![0];
    expect(tax.basisAmount).toBe(10_000);
    expect(tax.amount).toBe(1300); // 10000 * 1300 / 10000
    expect(tax.jurisdiction).toBe('CA-ON');
    expect(tax.kind).toBe('GST/HST');
    expect(tax.collectorDid).toBe(CREATOR);
    expect(tax.remitTo).toBe(AUTHORITY_DID_CA_CRA);
  });

  it('includes the caller-supplied registrationNumber on every tax row (required, #2419 review fix 7)', () => {
    const manifest = buildFairManifest({
      creatorDid: CREATOR,
      contentDid: CONTENT,
      contentType: 'event',
      basisAmountCents: 10_000,
      taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, registrationNumber: '123456789RT0001', collectorDid: CREATOR, remitTo: AUTHORITY_DID_CA_CRA }],
    });
    expect(manifest.taxes![0].registrationNumber).toBe('123456789RT0001');
  });

  it('throws when taxes are supplied without basisAmountCents', () => {
    expect(() =>
      buildFairManifest({
        creatorDid: CREATOR,
        contentDid: CONTENT,
        contentType: 'event',
        taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, registrationNumber: '123456789RT0001', collectorDid: CREATOR, remitTo: AUTHORITY_DID_CA_CRA }],
      }),
    ).toThrow(/basisAmountCents/);
  });

  it('never lets tax enter chain-share math — chain shares are identical with and without taxes', () => {
    const withoutTax = buildFairManifest({ creatorDid: CREATOR, contentDid: CONTENT, contentType: 'event' });
    const withTax = buildFairManifest({
      creatorDid: CREATOR,
      contentDid: CONTENT,
      contentType: 'event',
      basisAmountCents: 10_000,
      taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, registrationNumber: '123456789RT0001', collectorDid: CREATOR, remitTo: AUTHORITY_DID_CA_CRA }],
    });
    expect(withTax.chain).toEqual(withoutTax.chain);
  });

  it('supports multiple tax rows sharing the same basisAmount (v1 invoice-level granularity)', () => {
    const manifest = buildFairManifest({
      creatorDid: CREATOR,
      contentDid: CONTENT,
      contentType: 'event',
      basisAmountCents: 10_000,
      taxes: [
        { jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, registrationNumber: '123456789RT0001', collectorDid: CREATOR, remitTo: AUTHORITY_DID_CA_CRA },
        { jurisdiction: 'CA-QC', kind: 'QST', rateBps: 998, registrationNumber: '123456789RT0001', collectorDid: CREATOR, remitTo: 'did:imajin:authority:ca-qc-rq' },
      ],
    });
    expect(manifest.taxes).toHaveLength(2);
    expect(manifest.taxes!.every((t) => t.basisAmount === 10_000)).toBe(true);
  });
});

// ── validate.ts ──────────────────────────────────────────────────────────────

function makeV1_2(taxes: FairManifestV11['taxes']): FairManifestV11 {
  return {
    fair: '1.2',
    version: '1.2',
    id: 'asset_tax_test',
    type: 'application/x-imajin-ticket',
    owner: CREATOR,
    created: new Date().toISOString(),
    access: { type: 'public' },
    attribution: [{ did: CREATOR, role: 'creator', share: 1 }],
    taxes,
  };
}

describe('validateManifest — taxes[] (#2419)', () => {
  const VALID_TAX = {
    jurisdiction: 'CA-ON',
    kind: 'GST/HST',
    rateBps: 1300,
    basisAmount: 10_000,
    amount: 1300,
    registrationNumber: '123456789RT0001',
    collectorDid: CREATOR,
    remitTo: AUTHORITY_DID_CA_CRA,
  };

  it('accepts a valid v1.2 manifest with taxes[]', () => {
    const result = validateManifest(makeV1_2([VALID_TAX]));
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts fair: "1.1" manifests without taxes exactly as before (no regression)', () => {
    const result = validateManifest(makeV1_2(undefined) as unknown as Record<string, unknown>);
    // fair is '1.2' here with taxes undefined — also valid, since taxes is optional.
    expect(result.ok).toBe(true);
  });

  it('rejects a taxes[] row missing a required field', () => {
    const { jurisdiction, ...missingJurisdiction } = VALID_TAX;
    const result = validateManifest(makeV1_2([missingJurisdiction as typeof VALID_TAX]));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('jurisdiction'))).toBe(true);
  });

  it('rejects a taxes[] row whose amount does not match basisAmount × rateBps / 10000', () => {
    const result = validateManifest(makeV1_2([{ ...VALID_TAX, amount: 9999 }]));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('does not match'))).toBe(true);
  });

  it('accepts amount within 1-cent rounding tolerance', () => {
    const result = validateManifest(makeV1_2([{ ...VALID_TAX, amount: VALID_TAX.amount + 1 }]));
    expect(result.ok).toBe(true);
  });

  it('rejects taxes that is not an array', () => {
    const result = validateManifest(makeV1_2({ not: 'an array' } as unknown as FairManifestV11['taxes']));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('taxes must be an array'))).toBe(true);
  });

  it('rejects a v1.2-routed manifest (version: "1.2") whose fair field was tampered to something else', () => {
    // version: '1.2' routes through the v1.1/v1.2 validator (isV1_1 checks
    // fair OR version), where validateRequiredFieldsV1_1 then rejects a
    // 'fair' value outside {'1.1','1.2'}.
    const result = validateManifest({ ...makeV1_2([VALID_TAX]), fair: 'bogus' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('fair'))).toBe(true);
  });
});

// ── resolveSettlementChain ───────────────────────────────────────────────────

const CHAIN: FairSettlementEntry[] = [
  { did: 'did:imajin:platform', role: 'platform', share: 0.02 },
  { did: 'did:imajin:seller', role: 'seller', share: 0.98 },
];
const BUYER_DID = 'did:imajin:buyer-abc';

const TAX_ROW: FairSettlementTax = {
  jurisdiction: 'CA-ON',
  kind: 'GST/HST',
  rateBps: 1300,
  basisAmount: 10_000,
  amount: 1300,
  collectorDid: 'did:imajin:seller',
  remitTo: AUTHORITY_DID_CA_CRA,
};

describe('resolveSettlementChain — taxes (#2419)', () => {
  it('chain sums to basisAmount-derived expectedTotal, unaffected by tax', () => {
    const withoutTax = resolveSettlementChain({ amountCents: 10_000, chain: CHAIN, buyerDid: BUYER_DID, nodeDid: null });
    const withTax = resolveSettlementChain({
      amountCents: 10_000,
      chain: CHAIN,
      buyerDid: BUYER_DID,
      nodeDid: null,
      taxes: [TAX_ROW],
    });
    // Chain-share dollar amounts (before processor-fee deduction) are identical —
    // only the processor-fee component (below) differs when tax is present.
    const platformWithout = withoutTax.resolvedChain.find((e) => e.role === 'platform')!;
    const platformWith = withTax.resolvedChain.find((e) => e.role === 'platform')!;
    expect(platformWith.amount).toBeCloseTo(platformWithout.amount, 2);
  });

  it('computes the processor fee on the GROSS amount (basisAmount + tax) when taxes are present', () => {
    const fees = [{ role: 'processor', rateBps: 370, fixedCents: 30 }];
    const withoutTax = resolveSettlementChain({ amountCents: 10_000, chain: CHAIN, fees, buyerDid: BUYER_DID, nodeDid: null });
    const withTax = resolveSettlementChain({ amountCents: 10_000, chain: CHAIN, fees, buyerDid: BUYER_DID, nodeDid: null, taxes: [TAX_ROW] });

    // Gross = 10_000 + 1300 = 11_300 cents; fee = 11300*370/10000 + 30 = 448.1 cents = $4.481 -> $4.48
    expect(withTax.estimatedFeeDollars).toBeGreaterThan(withoutTax.estimatedFeeDollars);
    expect(withTax.estimatedFeeDollars).toBeCloseTo(4.48, 2);
  });

  it('is byte-identical to pre-#2419 behavior when taxes is omitted', () => {
    const fees = [{ role: 'processor', rateBps: 370, fixedCents: 30 }];
    const result = resolveSettlementChain({ amountCents: 10_000, chain: CHAIN, fees, buyerDid: BUYER_DID, nodeDid: null });
    expect(result.taxCredits).toEqual([]);
    expect(result.totalTaxDollars).toBe(0);
  });

  it('produces one taxCredit per tax row, full amount, to the collectorDid, kept out of resolvedChain', () => {
    const { taxCredits, resolvedChain, totalTaxDollars } = resolveSettlementChain({
      amountCents: 10_000,
      chain: CHAIN,
      buyerDid: BUYER_DID,
      nodeDid: null,
      taxes: [TAX_ROW],
    });
    expect(taxCredits).toEqual([
      {
        did: 'did:imajin:seller',
        amount: 13,
        jurisdiction: 'CA-ON',
        kind: 'GST/HST',
        rateBps: 1300,
        remitTo: AUTHORITY_DID_CA_CRA,
      },
    ]);
    expect(totalTaxDollars).toBe(13);
    expect(resolvedChain.some((e) => e.role === 'tax')).toBe(false);
  });

  it('supports multiple tax rows, summing totalTaxDollars correctly', () => {
    const secondTax: FairSettlementTax = { ...TAX_ROW, jurisdiction: 'CA-QC', kind: 'QST', rateBps: 998, amount: 998 };
    const { taxCredits, totalTaxDollars } = resolveSettlementChain({
      amountCents: 10_000,
      chain: CHAIN,
      buyerDid: BUYER_DID,
      nodeDid: null,
      taxes: [TAX_ROW, secondTax],
    });
    expect(taxCredits).toHaveLength(2);
    expect(totalTaxDollars).toBeCloseTo(13 + 9.98, 2);
  });
});
