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

/** A single entry in a .fair settlement chain (before placeholder resolution). */
export interface FairSettlementEntry {
  /** DID of the recipient, or a placeholder: 'BUYER_PLACEHOLDER' | 'NODE_PLACEHOLDER'. */
  did: string;
  /** Role of the recipient (e.g. 'seller', 'creator', 'node', 'platform'). */
  role: string;
  /** Share as a 0–1 fraction of the total. */
  share: number;
}

/** A resolved chain entry with absolute dollar amounts (not cents). */
export interface ResolvedChainEntry {
  did: string;
  role: string;
  /** Recipient's share in dollars (not cents). */
  amount: number;
}

/** Options for {@link resolveSettlementChain}. */
export interface ResolveChainOptions {
  /** Transaction total in cents. */
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
   */
  estimatedFeeDollars: number;
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

// ── Chain resolution ───────────────────────────────────────────────────────────

/**
 * Resolve a .fair settlement chain to absolute dollar amounts.
 *
 * Steps:
 *   1. Look up the `processor` fee entry (fallback: 3.7% + 30¢).
 *   2. Compute `estimatedFeeDollars` from that entry.
 *   3. For each chain entry: substitute placeholder DIDs; compute
 *      `share × totalDollars`; deduct `estimatedFeeDollars` from seller entries.
 *   4. Correct rounding drift so the chain sums exactly to `expectedTotal`.
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
  } = opts;

  const totalDollars = amountCents / 100;

  // ── 1. Find processor fee ──────────────────────────────────────────────────
  const processorFee = fees.find((f) => f.role === 'processor');
  const estimatedFeeCents = processorFee
    ? computeFeeCents(amountCents, processorFee.rateBps, processorFee.fixedCents)
    : computeFeeCents(amountCents, FALLBACK_PROCESSOR_RATE_BPS, FALLBACK_PROCESSOR_FIXED_CENTS);
  const estimatedFeeDollars = Number.parseFloat((estimatedFeeCents / 100).toFixed(2));

  // ── 2. Resolve placeholder DIDs and compute per-entry amounts ──────────────
  const resolvedChain: ResolvedChainEntry[] = chain.map((entry) => {
    let did = entry.did;
    if (did === 'BUYER_PLACEHOLDER') did = buyerDid;
    if (did === 'NODE_PLACEHOLDER') did = nodeDid ?? NODE_DID_UNRESOLVED;

    let amount = Number.parseFloat((totalDollars * entry.share).toFixed(2));
    if (sellerRoles.has(entry.role)) {
      amount = Number.parseFloat((amount - estimatedFeeDollars).toFixed(2));
    }

    return { did, role: entry.role, amount };
  });

  const expectedTotal = Number.parseFloat((totalDollars - estimatedFeeDollars).toFixed(2));

  // ── 3. Correct rounding drift ──────────────────────────────────────────────
  const chainSum = resolvedChain.reduce((sum, e) => sum + e.amount, 0);
  const drift = Number.parseFloat((expectedTotal - chainSum).toFixed(2));
  if (drift !== 0 && resolvedChain.length > 0) {
    // Prefer adjusting a seller entry; fall back to the largest entry
    const seller = resolvedChain.find((e) => sellerRoles.has(e.role));
    const target =
      seller ??
      resolvedChain.reduce((max, e) => (e.amount > max.amount ? e : max), resolvedChain[0]!);
    target.amount = Number.parseFloat((target.amount + drift).toFixed(2));
  }

  return { resolvedChain, expectedTotal, estimatedFeeDollars };
}
