/**
 * Unit tests for packages/fair/src/settlement.ts (#1453).
 *
 * Covers computeFeeCents and resolveSettlementChain — the fee-math utilities
 * previously duplicated in apps/market/src/lib/settle.ts and
 * packages/bus/src/reactors/settle.ts.
 *
 * Pure module, no mocks needed.
 */

import { describe, it, expect } from 'vitest';
import {
  computeFeeCents,
  resolveSettlementChain,
  DEFAULT_SELLER_ROLES,
  type FairSettlementEntry,
} from '../settlement';

// ── computeFeeCents ──────────────────────────────────────────────────────────

describe('computeFeeCents', () => {
  it('computes bps + fixed correctly', () => {
    // 370 bps (3.7%) on 10000 cents = 370 cents; + 30 fixed = 400 cents
    expect(computeFeeCents(10_000, 370, 30)).toBeCloseTo(400);
  });

  it('returns fixedCents when rateBps is zero', () => {
    expect(computeFeeCents(5000, 0, 25)).toBe(25);
  });

  it('returns zero for 0,0,0', () => {
    expect(computeFeeCents(0, 0, 0)).toBe(0);
  });

  it('works for the Stripe domestic rate (2.9% + 30¢ on $100)', () => {
    const fee = computeFeeCents(10_000, 290, 30);
    expect(fee).toBeCloseTo(320); // $3.20
  });
});

// ── DEFAULT_SELLER_ROLES ─────────────────────────────────────────────────────

describe('DEFAULT_SELLER_ROLES', () => {
  it('contains seller, creator, event', () => {
    expect(DEFAULT_SELLER_ROLES.has('seller')).toBe(true);
    expect(DEFAULT_SELLER_ROLES.has('creator')).toBe(true);
    expect(DEFAULT_SELLER_ROLES.has('event')).toBe(true);
  });

  it('does not contain node or platform', () => {
    expect(DEFAULT_SELLER_ROLES.has('node')).toBe(false);
    expect(DEFAULT_SELLER_ROLES.has('platform')).toBe(false);
  });
});

// ── resolveSettlementChain ───────────────────────────────────────────────────

const CHAIN: FairSettlementEntry[] = [
  { did: 'BUYER_PLACEHOLDER', role: 'buyer', share: 0 },
  { did: 'NODE_PLACEHOLDER', role: 'node', share: 0.01 },
  { did: 'did:imajin:platform', role: 'platform', share: 0.02 },
  { did: 'did:imajin:seller', role: 'seller', share: 0.97 },
];

const BUYER_DID = 'did:imajin:buyer-abc';
const NODE_DID = 'did:imajin:node-xyz';

describe('resolveSettlementChain', () => {
  it('substitutes BUYER_PLACEHOLDER and NODE_PLACEHOLDER', () => {
    const { resolvedChain } = resolveSettlementChain({
      amountCents: 10_000,
      chain: CHAIN,
      buyerDid: BUYER_DID,
      nodeDid: NODE_DID,
    });
    const buyer = resolvedChain.find((e) => e.role === 'buyer')!;
    const node = resolvedChain.find((e) => e.role === 'node')!;
    expect(buyer.did).toBe(BUYER_DID);
    expect(node.did).toBe(NODE_DID);
  });

  it('uses sentinel DID when nodeDid is null', () => {
    const { resolvedChain } = resolveSettlementChain({
      amountCents: 10_000,
      chain: CHAIN,
      buyerDid: BUYER_DID,
      nodeDid: null,
    });
    const node = resolvedChain.find((e) => e.role === 'node')!;
    expect(node.did).toBe('did:imajin:node-unresolved');
  });

  it('deducts processor fee from seller entries', () => {
    const { resolvedChain, estimatedFeeDollars } = resolveSettlementChain({
      amountCents: 10_000,
      chain: CHAIN,
      fees: [{ role: 'processor', rateBps: 370, fixedCents: 30 }],
      buyerDid: BUYER_DID,
      nodeDid: NODE_DID,
    });
    const seller = resolvedChain.find((e) => e.role === 'seller')!;
    const rawSellerShare = 10_000 * 0.97 / 100; // $97
    expect(seller.amount).toBeCloseTo(rawSellerShare - estimatedFeeDollars, 2);
  });

  it('does NOT deduct processor fee from non-seller entries', () => {
    const { resolvedChain } = resolveSettlementChain({
      amountCents: 10_000,
      chain: CHAIN,
      fees: [{ role: 'processor', rateBps: 370, fixedCents: 30 }],
      buyerDid: BUYER_DID,
      nodeDid: NODE_DID,
    });
    const platform = resolvedChain.find((e) => e.role === 'platform')!;
    expect(platform.amount).toBeCloseTo(10_000 * 0.02 / 100, 2); // $2, no deduction
  });

  it('falls back to 3.7% + 30¢ when no processor fee in manifest', () => {
    const { estimatedFeeDollars } = resolveSettlementChain({
      amountCents: 10_000,
      chain: CHAIN,
      fees: [], // no processor
      buyerDid: BUYER_DID,
      nodeDid: NODE_DID,
    });
    const expected = computeFeeCents(10_000, 370, 30) / 100;
    expect(estimatedFeeDollars).toBeCloseTo(expected, 2);
  });

  it('expectedTotal equals totalDollars - estimatedFeeDollars', () => {
    const { expectedTotal, estimatedFeeDollars } = resolveSettlementChain({
      amountCents: 10_000,
      chain: CHAIN,
      buyerDid: BUYER_DID,
      nodeDid: NODE_DID,
    });
    expect(expectedTotal).toBeCloseTo(100 - estimatedFeeDollars, 2);
  });

  it('corrects rounding drift so chain sums to expectedTotal', () => {
    // Use an amount and shares likely to produce rounding drift
    const { resolvedChain, expectedTotal } = resolveSettlementChain({
      amountCents: 9_999, // odd cents
      chain: [
        { did: 'did:imajin:a', role: 'creator', share: 0.3333 },
        { did: 'did:imajin:b', role: 'creator', share: 0.3333 },
        { did: 'did:imajin:c', role: 'seller', share: 0.3334 },
      ],
      buyerDid: BUYER_DID,
      nodeDid: null,
    });
    const chainSum = resolvedChain.reduce((sum, e) => sum + e.amount, 0);
    expect(Number.parseFloat(chainSum.toFixed(2))).toBe(expectedTotal);
  });

  it('respects custom sellerRoles', () => {
    const customChain: FairSettlementEntry[] = [
      { did: 'did:imajin:artist', role: 'artist', share: 0.9 },
      { did: 'did:imajin:node', role: 'node', share: 0.1 },
    ];
    const { resolvedChain, estimatedFeeDollars } = resolveSettlementChain({
      amountCents: 10_000,
      chain: customChain,
      fees: [{ role: 'processor', rateBps: 300, fixedCents: 30 }],
      buyerDid: BUYER_DID,
      nodeDid: NODE_DID,
      sellerRoles: new Set(['artist']),
    });
    const artist = resolvedChain.find((e) => e.role === 'artist')!;
    const rawArtistShare = 10_000 * 0.9 / 100;
    expect(artist.amount).toBeCloseTo(rawArtistShare - estimatedFeeDollars, 2);
  });
});

