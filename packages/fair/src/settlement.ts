/**
 * .fair settlement fee-math utilities (#1453).
 *
 * Extracts the duplicated fee-computation and chain-resolution logic that
 * previously lived in (at least) three separate settle files:
 *   - apps/market/src/lib/settle.ts
 *   - packages/bus/src/reactors/settle.ts
 *   - (snapshot amounts in apps/kernel/src/lib/quickbooks/settlement.ts)
 *
 * This module is PURE — no DB, HTTP, or environment-variable reads. All
 * environment resolution (NODE_DID, PAY_SERVICE_URL, etc.) stays in the
 * caller; this module only performs the arithmetic and DID substitution.
 */
import type { FairEntry } from './types';

// ── Core formula ───────────────────────────────────────────────────────────────

/**
 * Compute the fee amount in cents for a single fee entry.
 *
 * `amountCents * rateBps / 10_000 + fixedCents`
 *
 * @param amountCents - Transaction total in minor units (cents).
 * @param rateBps     - Fee rate in basis points (1 bps = 0.01%).
 * @param fixedCents  - Fixed per-transaction fee in minor units (cents).
 * @returns Fee amount in cents (unrounded — caller decides rounding).
 */
export function computeFeeCents(
  amountCents: number,
  rateBps: number,
  fixedCents: number,
): number {
  return (amountCents * rateBps) / 10_000 + fixedCents;
}

// ── Chain resolution types ─────────────────────────────────────────────────────

/**
 * A single entry in a .fair settlement chain (before placeholder resolution).
 *
 * Derived from the canonical {@link FairEntry} (#1712) rather than
 * hand-maintained separately: `did` is narrowed from optional to required
 * because a settlement chain entry has always been resolved (or carries a
 * `*_PLACEHOLDER` sentinel) by the time it reaches this module. Deriving via
 * `Pick` means a field added to `FairEntry` shows up here automatically
 * instead of silently diverging.
 */
export type FairSettlementEntry = Pick<FairEntry, 'did' | 'role' | 'share'> & {
  /** DID of the recipient, or a placeholder: 'BUYER_PLACEHOLDER' | 'NODE_PLACEHOLDER'. */
  did: string;
};

/**
 * Compile-time exhaustiveness check (#1712): `FairSettlementEntry` must stay
 * assignable *from* a fully-resolved `FairEntry` (i.e. every field this
 * settlement module reads is still present on the canonical shape). If a
 * future edit to `FairEntry` ever removed or renamed `role`/`share`, this
 * line would fail to compile instead of silently breaking
 * `resolveSettlementChain` callers. `Required` mirrors `did` being resolved
 * (never a placeholder-less optional) by the time a chain reaches this
 * module — the same narrowing `FairSettlementEntry` itself applies.
 */
export type AssertExtends<Actual extends Expected, Expected = Actual> = Actual;
export type _FairSettlementEntryAssignableFromFairEntry = AssertExtends<
  Required<Pick<FairEntry, 'did' | 'role' | 'share'>>,
  FairSettlementEntry
>;

/** A resolved chain entry with absolute dollar amounts (not cents). */
export interface ResolvedChainEntry {
  did: string;
  role: string;
  /** Recipient's share in dollars (not cents). */
  amount: number;
}

/** A resolved `.fair` `taxes[]` row, in the cents-based shape `FairTax` uses. */
export interface FairSettlementTax {
  jurisdiction: string;
  kind: string;
  rateBps: number;
  basisAmount: number;
  amount: number;
  collectorDid: string;
  remitTo: string;
  /** Issuer tax registration — required end-to-end (#2439) so the remittance-owed report can show it next to what's owed. */
  registrationNumber: string;
}

/** Options for {@link resolveSettlementChain}. */
export interface ResolveChainOptions {
  /**
   * Transaction total in cents. When `taxes` is present/non-empty, this
   * MUST be the pre-tax `basisAmount` (NOT the gross subtotal+tax) — chain
   * shares and fee-skim math never see tax (#2419 rule 2). The gross
   * (`amountCents + Σtaxes.amount`) is derived internally, solely to feed
   * the processor-fee calculation — see `taxes` below.
   */
  amountCents: number;
  /** The .fair manifest chain entries (shares must sum to 1.0). */
  chain: FairSettlementEntry[];
  /**
   * Fee entries from the manifest (used to find the `processor` fee entry).
   * If absent or if no `processor` role is found, falls back to
   * 3.7% + CA$0.30 (Stripe international estimate).
   */
  fees?: Array<{ role: string; rateBps: number; fixedCents: number }>;
  /** Resolved DID of the buyer (substituted for 'BUYER_PLACEHOLDER'). */
  buyerDid: string;
  /**
   * Resolved DID of the node operator (substituted for 'NODE_PLACEHOLDER').
   * Pass `null` when NODE_DID is unresolved; a sentinel DID is used instead.
   */
  nodeDid: string | null;
  /**
   * Set of roles considered "seller" for the purpose of processor-fee deduction.
   * Defaults to {@link DEFAULT_SELLER_ROLES}.
   */
  sellerRoles?: ReadonlySet<string>;
  /**
   * The manifest's `taxes[]` rows (#2419), cents-based. When present, the
   * processor/Stripe fee is computed on the GROSS amount (`amountCents +
   * Σtaxes.amount`) per Ryan's ruling: the seller absorbs the processing
   * fee on the tax portion, same as they already absorb it on their own
   * share. Chain-share math is entirely unaffected (still `amountCents` =
   * basisAmount). Omit/empty for byte-identical pre-#2419 behavior.
   */
  taxes?: FairSettlementTax[];
}

/** Result of {@link resolveSettlementChain}. */
export interface ResolvedChain {
  /** Chain entries with absolute amounts in dollars, ready for POST /api/settle. */
  resolvedChain: ResolvedChainEntry[];
  /**
   * Expected total payout in dollars (= totalDollars - estimatedFeeDollars).
   * Used as `total_amount` in the settlement body.
   */
  expectedTotal: number;
  /**
   * Estimated processor fee deducted from the seller's share, in dollars.
   * Derived from the manifest `processor` fee entry or the 3.7%+30¢ fallback.
   * Computed on the GROSS amount (basisAmount + tax total) when `taxes` is
   * supplied — see {@link ResolveChainOptions.taxes}.
   */
  estimatedFeeDollars: number;
  /**
   * One trust-liability credit per tax row (#2419), each for the row's
   * FULL `amount` (dollars) to its own `collectorDid` — deliberately kept
   * OUT of `resolvedChain` so `ΣresolvedChain == basisAmount` never has to
   * account for tax, and so tax is structurally excluded from fee-skim
   * math and MJNx reconciliation (both of which only ever look at
   * `chain`/`resolvedChain`). Empty when `taxes` is absent/empty. Carries
   * `jurisdiction`/`kind`/`rateBps`/`remitTo` (not just `did`/`amount`) so
   * the caller can pass this straight through as `fair_manifest.taxCredits`
   * to `settlePayment()`, which needs those fields for ledger metadata.
   */
  taxCredits: ResolvedTaxCredit[];
  /** Σ`taxes[].amount` in dollars. Zero when `taxes` is absent/empty. */
  totalTaxDollars: number;
}

/** A resolved trust-liability tax credit (#2419) — the row's FULL `amount` (dollars) to `did` (the row's `collectorDid`), plus the metadata `settlePayment()` writes onto the ledger row. */
export interface ResolvedTaxCredit {
  did: string;
  amount: number;
  jurisdiction: string;
  kind: string;
  rateBps: number;
  remitTo: string;
  /** Required (#2439) — persisted on the tax ledger row by `settlePayment()`. */
  registrationNumber: string;
}

/**
 * Role set whose members have the processor fee deducted from their share.
 * Reflects that Stripe deducts `applicationFee` (which includes processing)
 * from the connected account transfer, so the seller's net payout is
 * `(total × share) - processorFee`.
 */
export const DEFAULT_SELLER_ROLES: ReadonlySet<string> = new Set([
  'seller',
  'creator',
  'event',
]);

/** Fallback processor-fee rate when no `processor` entry is in manifest.fees. */
const FALLBACK_PROCESSOR_RATE_BPS = 370;   // 3.7% (Stripe international estimate)
const FALLBACK_PROCESSOR_FIXED_CENTS = 30; // CA$0.30 per transaction

/** Sentinel used when NODE_DID is not configured. */
const NODE_DID_UNRESOLVED = 'did:imajin:node-unresolved';

// ── Integer-cent allocation helpers ────────────────────────────────────────────

/**
 * Split `totalCents` across `weights` pro rata using the largest-remainder
 * method, so the parts are whole cents that sum to exactly `totalCents`.
 * Ties on the remainder go to the earlier index, keeping the result
 * deterministic. When every weight is zero the total is split evenly.
 */
function allocateProRata(totalCents: number, weights: readonly number[]): number[] {
  if (weights.length === 0 || totalCents === 0) return weights.map(() => 0);

  const effective = weights.reduce((sum, w) => sum + w, 0) > 0 ? weights : weights.map(() => 1);
  const weightSum = effective.reduce((sum, w) => sum + w, 0);

  const parts = effective.map((w) => Math.floor((totalCents * w) / weightSum));
  let leftover = totalCents - parts.reduce((sum, p) => sum + p, 0);

  const byRemainder = effective
    .map((w, index) => ({ index, remainder: (totalCents * w) % weightSum }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of byRemainder) {
    if (leftover <= 0) break;
    parts[index]! += 1;
    leftover -= 1;
  }
  return parts;
}

/**
 * Spread `driftCents` (signed) over `centsByIndex` in place, one cent at a time,
 * round-robin across `sellerIndexes` in chain order. A negative step skips any
 * entry already at zero so no amount goes negative. Whatever the sellers cannot
 * absorb (including everything when there are no seller-role entries) goes to
 * the largest entry.
 */
function distributeDrift(
  centsByIndex: number[],
  sellerIndexes: readonly number[],
  driftCents: number,
): void {
  if (driftCents === 0 || centsByIndex.length === 0) return;

  const step = Math.sign(driftCents);
  let remaining = driftCents;
  let skipped = 0;
  for (let n = 0; remaining !== 0 && skipped < sellerIndexes.length; n++) {
    const target = sellerIndexes[n % sellerIndexes.length]!;
    if (step < 0 && centsByIndex[target]! <= 0) {
      skipped++;
      continue;
    }
    skipped = 0;
    centsByIndex[target]! += step;
    remaining -= step;
  }

  if (remaining !== 0) {
    const largest = centsByIndex.indexOf(Math.max(...centsByIndex));
    centsByIndex[largest]! += remaining;
  }
}

// ── Chain resolution ───────────────────────────────────────────────────────────

/**
 * Resolve a .fair settlement chain to absolute dollar amounts.
 *
 * Steps:
 *   1. Look up the `processor` fee entry (fallback: 3.7% + 30¢).
 *   2. Compute `estimatedFeeDollars` from that entry.
 *   3. For each chain entry: substitute placeholder DIDs; compute
 *      `share × totalDollars`.
 *   4. Split `estimatedFeeDollars` pro rata (by each seller-role entry's gross
 *      share, largest-remainder in whole cents) across the seller-role entries
 *      (#2472) — the fee is charged once in total, not once per seller.
 *   5. Correct rounding drift so the chain sums exactly to `expectedTotal`,
 *      spreading any remainder one cent at a time round-robin across the
 *      seller-role entries instead of loading it all onto the first.
 *
 * The result is ready to pass as `fair_manifest.chain` in a POST /api/settle
 * body. I/O (posting to the pay service, writing DB snapshots) stays in the
 * caller.
 */
export function resolveSettlementChain(opts: ResolveChainOptions): ResolvedChain {
  const {
    amountCents,
    chain,
    fees = [],
    buyerDid,
    nodeDid,
    sellerRoles = DEFAULT_SELLER_ROLES,
    taxes = [],
  } = opts;

  const totalDollars = amountCents / 100;
  const totalTaxCents = taxes.reduce((sum, t) => sum + t.amount, 0);
  // #2419 rule 3: the processor/Stripe fee applies to the GROSS amount
  // (basisAmount + tax) — identical to `amountCents` when there's no tax,
  // so this is a no-op for every pre-#2419 caller.
  const grossCentsForFee = amountCents + totalTaxCents;

  // ── 1. Find processor fee ──────────────────────────────────────────────────────────────────────
  const processorFee = fees.find((f) => f.role === 'processor');
  const estimatedFeeCents = processorFee
    ? computeFeeCents(grossCentsForFee, processorFee.rateBps, processorFee.fixedCents)
    : computeFeeCents(grossCentsForFee, FALLBACK_PROCESSOR_RATE_BPS, FALLBACK_PROCESSOR_FIXED_CENTS);
  const estimatedFeeDollars = Number.parseFloat((estimatedFeeCents / 100).toFixed(2));

  // ── 2. Resolve placeholder DIDs and compute per-entry gross amounts (cents) ──
  const grossCents: number[] = [];
  const resolvedChain: ResolvedChainEntry[] = chain.map((entry) => {
    let did = entry.did;
    if (did === 'BUYER_PLACEHOLDER') did = buyerDid;
    if (did === 'NODE_PLACEHOLDER') did = nodeDid ?? NODE_DID_UNRESOLVED;

    const gross = Number.parseFloat((totalDollars * entry.share).toFixed(2));
    grossCents.push(Math.round(gross * 100));
    return { did, role: entry.role, amount: gross };
  });

  const expectedTotal = Number.parseFloat((totalDollars - estimatedFeeDollars).toFixed(2));

  // ── 3. Split the processor fee pro rata across seller-role entries (#2472) ──
  // The fee is charged once in total; each seller bears a share proportional
  // to its gross share. Done in whole cents so the parts sum to the fee exactly.
  const sellerIndexes = resolvedChain.flatMap((e, i) => (sellerRoles.has(e.role) ? [i] : []));
  const centsByIndex = resolvedChain.map((e) => Math.round(e.amount * 100));
  const feeCents = Math.round(estimatedFeeDollars * 100);
  const feeParts = allocateProRata(
    feeCents,
    sellerIndexes.map((i) => grossCents[i]!),
  );
  sellerIndexes.forEach((chainIndex, n) => {
    centsByIndex[chainIndex]! -= feeParts[n]!;
  });

  // ── 4. Correct rounding drift ──────────────────────────────────────────────
  // Per-entry rounding can leave the chain a few cents off `expectedTotal`.
  // Spread the remainder one cent at a time, round-robin in chain order over the
  // seller-role entries (never driving an entry negative). With no seller-role
  // entry the whole remainder goes to the largest entry.
  distributeDrift(
    centsByIndex,
    sellerIndexes,
    Math.round(expectedTotal * 100) - centsByIndex.reduce((sum, c) => sum + c, 0),
  );
  resolvedChain.forEach((entry, i) => {
    entry.amount = Number.parseFloat((centsByIndex[i]! / 100).toFixed(2));
  });

  // ── 4. Tax credits (#2419) ── full amount each, no fee deduction, no
  // proportional math; kept entirely separate from `resolvedChain`.
  const taxCredits: ResolvedTaxCredit[] = taxes.map((t) => ({
    did: t.collectorDid,
    amount: Number.parseFloat((t.amount / 100).toFixed(2)),
    jurisdiction: t.jurisdiction,
    kind: t.kind,
    rateBps: t.rateBps,
    remitTo: t.remitTo,
    registrationNumber: t.registrationNumber,
  }));
  const totalTaxDollars = Number.parseFloat((totalTaxCents / 100).toFixed(2));

  return { resolvedChain, expectedTotal, estimatedFeeDollars, taxCredits, totalTaxDollars };
}
