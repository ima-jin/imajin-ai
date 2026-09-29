import type { FairEntry, FairFee, FairTax } from './types';
import {
  PROTOCOL_FEE_BPS,
  PROTOCOL_DID,
  NODE_FEE_MIN_BPS,
  NODE_FEE_MAX_BPS,
  NODE_FEE_DEFAULT_BPS,
  BUYER_CREDIT_MIN_BPS,
  BUYER_CREDIT_MAX_BPS,
  BUYER_CREDIT_DEFAULT_BPS,
  PLATFORM_FEE_BPS,
  PLATFORM_DID,
  STRIPE_RATE_BPS,
  STRIPE_MIN_RATE_BPS,
  STRIPE_FIXED_CENTS,
} from './constants';

export interface FairFeeManifest {
  version: string;
  fees: FairFee[];
  chain: FairEntry[];
  distributions: FairEntry[];
  attribution: FairEntry[];
  /** #2419 — present only when the caller supplied `taxes` (non-empty). */
  taxes?: FairTax[];
}

/** Caller-supplied input for a single tax row (#2419) — everything except the computed `basisAmount`/`amount`, which `buildFairManifest` derives from `basisAmountCents`. `registrationNumber` is required, per the issue's tax-row shape (sourced from the business-profile tax registration, #2423). */
export interface BuildFairManifestTaxInput {
  jurisdiction: string;
  kind: string;
  rateBps: number;
  registrationNumber: string;
  collectorDid: string;
  remitTo: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function bpsToShare(bps: number): number {
  return bps / 10000;
}

/**
 * Compute the resolved `taxes[]` rows for the fee manifest (#2419).
 *
 * `basisAmountCents` is the pre-tax subtotal (in cents) the caller charged
 * for the goods/services — required whenever `taxes` is non-empty, since
 * `FairTax.basisAmount`/`amount` are absolute cents, not the fractional
 * shares the rest of this function deals in. `amount` is computed with
 * plain integer rounding (`Math.round`), matching every other cents-based
 * fee computation already in this codebase (`resolveSettlementChain`'s
 * `computeFeeCents`, `checkout.ts`'s `computePlatformShareCents`) —
 * deliberately NOT `@imajin/money`: `packages/fair` dropped that
 * dependency entirely (see `docs/npm-publishing.md`) because `money` is
 * unpublished and pulls in `@imajin/db`/`@imajin/auth`, which would have
 * broken `@ima-jin/fair`'s publishability.
 *
 * Chain shares and platform/protocol/node/scope/buyer-credit fees never
 * reference `basisAmountCents` at all — they're pure ratios of 1.0 by
 * construction (see the fee cascade below) — so tax structurally cannot
 * enter any skim basis here.
 */
function computeTaxRows(
  taxes: BuildFairManifestTaxInput[] | undefined,
  basisAmountCents: number | undefined,
): FairTax[] {
  if (!taxes || taxes.length === 0) return [];
  if (!Number.isInteger(basisAmountCents) || (basisAmountCents as number) < 0) {
    throw new Error('buildFairManifest: basisAmountCents (a non-negative integer) is required when taxes are provided');
  }
  const basis = basisAmountCents as number;
  return taxes.map((t) => ({
    jurisdiction: t.jurisdiction,
    kind: t.kind,
    rateBps: t.rateBps,
    basisAmount: basis,
    amount: Math.round((basis * t.rateBps) / 10000),
    registrationNumber: t.registrationNumber,
    collectorDid: t.collectorDid,
    remitTo: t.remitTo,
  }));
}

/**
 * Build a .fair fee manifest for a piece of content.
 *
 * Fee cascade order:
 *   1. Protocol fee (fixed, governance-controlled)
 *   2. Node fee (operator-configurable within bounds)
 *   3. Buyer credit (operator-configurable within bounds)
 *   4. Scope fee (optional, only when content is created inside a scope/group)
 *   5. Seller share (remainder)
 */
export function buildFairManifest(params: {
  creatorDid: string;
  contentDid: string;
  scopeDid?: string | null;
  contentType: string;
  collaborators?: Array<{ did: string; role: string; share: number }>;
  nodeFeeBps?: number;
  buyerCreditBps?: number;
  nodeOperatorDid?: string;
  scopeFeeBps?: number | null;
  /** #2419 — one rate per invoice (v1 granularity). Requires `basisAmountCents`. */
  taxes?: BuildFairManifestTaxInput[];
  /** #2419 — the pre-tax subtotal (cents) `taxes[].amount` is computed from. Required whenever `taxes` is non-empty. */
  basisAmountCents?: number;
}): FairFeeManifest {
  const {
    creatorDid,
    scopeDid,
    collaborators,
    nodeOperatorDid,
  } = params;

  // Protocol fee: always fixed
  const protocolShare = bpsToShare(PROTOCOL_FEE_BPS);

  // Node fee: clamped to operator bounds
  const nodeFeeBps = params.nodeFeeBps == null
    ? NODE_FEE_DEFAULT_BPS
    : clamp(params.nodeFeeBps, NODE_FEE_MIN_BPS, NODE_FEE_MAX_BPS);
  const nodeShare = bpsToShare(nodeFeeBps);

  // Buyer credit: clamped to operator bounds
  const buyerCreditBps = params.buyerCreditBps == null
    ? BUYER_CREDIT_DEFAULT_BPS
    : clamp(params.buyerCreditBps, BUYER_CREDIT_MIN_BPS, BUYER_CREDIT_MAX_BPS);
  const buyerCreditShare = bpsToShare(buyerCreditBps);

  // Scope fee: only when scopeDid AND scopeFeeBps are both provided
  const hasScopeFee = !!(scopeDid && params.scopeFeeBps != null);
  const scopeShare = hasScopeFee ? bpsToShare(params.scopeFeeBps!) : 0;

  // Platform fee
  const platformShare = bpsToShare(PLATFORM_FEE_BPS);

  // Seller gets the remainder
  const sellerShare =
    1 - protocolShare - nodeShare - buyerCreditShare - scopeShare - platformShare;

  const chain: FairEntry[] = [
    { did: PROTOCOL_DID, role: 'protocol', share: protocolShare },
    { did: nodeOperatorDid || 'NODE_PLACEHOLDER', role: 'node', share: nodeShare },
    { did: 'BUYER_PLACEHOLDER', role: 'buyer_credit', share: buyerCreditShare },
  ];

  if (hasScopeFee) {
    chain.push({ did: scopeDid, role: 'scope', share: scopeShare });
  }

  chain.push(
    { did: PLATFORM_DID, role: 'platform', share: platformShare },
    { did: creatorDid, role: 'seller', share: sellerShare },
  );

  const distributions: FairEntry[] =
    collaborators && collaborators.length > 0
      ? collaborators.map((c) => ({ did: c.did, role: c.role, share: c.share }))
      : [{ did: creatorDid, role: 'creator', share: 1.0 }];

  const attribution: FairEntry[] = [
    { did: creatorDid, role: 'creator', share: 1 },
  ];

  const fees: FairFee[] = [
    { role: 'processor', name: 'Stripe', rateBps: STRIPE_RATE_BPS, minRateBps: STRIPE_MIN_RATE_BPS, fixedCents: STRIPE_FIXED_CENTS },
  ];

  const taxes = computeTaxRows(params.taxes, params.basisAmountCents);

  return {
    // #2419: fee-manifest version bumps 0.4.0 -> 0.5.0 only for manifests
    // that actually carry taxes[] — manifests without taxes keep validating
    // exactly as today.
    version: taxes.length > 0 ? '0.5.0' : '0.4.0',
    fees,
    chain,
    distributions,
    attribution,
    ...(taxes.length > 0 ? { taxes } : {}),
  };
}
