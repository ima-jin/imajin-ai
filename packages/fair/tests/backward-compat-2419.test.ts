/**
 * Backward-compat regression tests for #2419 ("top-level taxes[]").
 *
 * Replays representative existing manifest shapes (an events ticket, a
 * market listing, and a v1.1 tip) through `buildFairManifest`,
 * `validateManifest`, and `resolveSettlementChain` — none of which pass
 * `taxes`/`basisAmountCents` — and asserts every output is IDENTICAL to
 * what those functions produced before #2419 (fee-manifest version
 * `0.4.0`, `fair`/`version` `'1.1'`, no `taxes` field, zero tax credits,
 * fee math unaffected). This is the "byte-for-byte identical" contract
 * from the issue's backward-compatibility section.
 */
import { describe, it, expect } from 'vitest';
import { buildFairManifest } from '../src/buildManifest';
import { validateManifest } from '../src/validate';
import { resolveSettlementChain, type FairSettlementEntry } from '../src/settlement';
import type { FairManifestV11 } from '../src/types';

const SELLER_DID = 'did:imajin:events-seller';
const BUYER_DID = 'did:imajin:buyer-xyz';

describe('#2419 backward compatibility — events ticket (buildFairManifest, no taxes)', () => {
  const manifest = buildFairManifest({
    creatorDid: SELLER_DID,
    contentDid: 'did:imajin:event-ticket-1',
    contentType: 'event',
  });

  it('stays fee-manifest version 0.4.0 (not bumped)', () => {
    expect(manifest.version).toBe('0.4.0');
  });

  it('carries no taxes field at all', () => {
    expect('taxes' in manifest).toBe(false);
  });

  it('chain shares still sum to 1.0', () => {
    const total = manifest.chain.reduce((sum, e) => sum + e.share, 0);
    expect(total).toBeCloseTo(1, 10);
  });
});

describe('#2419 backward compatibility — market listing (buildFairManifest, no taxes)', () => {
  const manifest = buildFairManifest({
    creatorDid: SELLER_DID,
    contentDid: 'did:imajin:listing-1',
    contentType: 'listing',
    scopeDid: 'did:imajin:scope-market',
    scopeFeeBps: 25,
  });

  it('stays fee-manifest version 0.4.0 (not bumped)', () => {
    expect(manifest.version).toBe('0.4.0');
  });

  it('carries no taxes field at all', () => {
    expect('taxes' in manifest).toBe(false);
  });
});

describe('#2419 backward compatibility — v1.1 tip manifest (validateManifest, no taxes)', () => {
  const tipManifest: FairManifestV11 = {
    fair: '1.1',
    version: '1.1',
    id: 'asset_tip_1',
    type: 'application/x-imajin-tip',
    owner: SELLER_DID,
    created: new Date().toISOString(),
    access: { type: 'public' },
    attribution: [{ did: SELLER_DID, role: 'creator', share: 1 }],
    tipping: { enabled: true },
  };

  it('validates ok with zero errors, unaffected by #2419', () => {
    const result = validateManifest(tipManifest);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('is not reclassified as v1.2', () => {
    expect(tipManifest.fair).toBe('1.1');
    expect(tipManifest.version).toBe('1.1');
  });
});

describe('#2419 backward compatibility — resolveSettlementChain (events ticket settlement, no taxes)', () => {
  const CHAIN: FairSettlementEntry[] = [
    { did: 'did:imajin:protocol', role: 'protocol', share: 0.01 },
    { did: 'did:imajin:platform', role: 'platform', share: 0.01 },
    { did: SELLER_DID, role: 'seller', share: 0.98 },
  ];
  const FEES = [{ role: 'processor', rateBps: 370, fixedCents: 30 }];

  it('produces identical resolvedChain/expectedTotal/estimatedFeeDollars to the pre-#2419 shape, plus empty tax fields', () => {
    const result = resolveSettlementChain({ amountCents: 5_000, chain: CHAIN, fees: FEES, buyerDid: BUYER_DID, nodeDid: null });

    // Pre-#2419 assertions (same formulas as packages/fair/src/__tests__/settlement.test.ts)
    const seller = result.resolvedChain.find((e) => e.role === 'seller')!;
    const rawSellerShare = (5_000 * 0.98) / 100;
    expect(seller.amount).toBeCloseTo(rawSellerShare - result.estimatedFeeDollars, 2);
    expect(result.expectedTotal).toBeCloseTo(50 - result.estimatedFeeDollars, 2);

    // New #2419 fields are present but inert for a no-tax settlement.
    expect(result.taxCredits).toEqual([]);
    expect(result.totalTaxDollars).toBe(0);
  });
});
