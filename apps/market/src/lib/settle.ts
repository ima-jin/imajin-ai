/**
 * Market settlement via the registered-app contract (#2740, kernel #2642/#2695).
 *
 * Two halves, both authenticated with market's OWN app-service token
 * (`getAppServiceToken`) — no shared pay key:
 *
 *  1. `buildPayeeChain` — at purchase time, resolve the listing's .fair manifest
 *     chain into absolute dollar amounts. The purchase route sends it to pay's
 *     `/api/checkout` as `payeeManifest`, which binds the payment to market's app
 *     DID and records the payees the kernel will later verify against.
 *  2. `settleListingPurchase` — once the purchase webhook reports the payment,
 *     `POST /api/settle` with the `transaction_id` that checkout returned and
 *     exactly that recorded chain as `fair_manifest`. A replay of an
 *     already-settled payment (`alreadySettled: true`) counts as success.
 *
 * The chain sums to the GROSS payment: the kernel takes the payer, amount,
 * currency and rail from its own payment record and requires
 * `Σchain == recorded total`, so no processing-fee estimate is deducted here
 * (the pre-#2642 flow posted a fee-reduced chain and a caller-chosen total).
 *
 * Settlement failure is non-fatal — the listing has already been updated.
 * A listing without a .fair manifest chain is never settled.
 */

import { createLogger } from '@imajin/logger';
import { computeFeeCents, resolveSettlementChain, type FairSettlementEntry } from '@imajin/fair';
import { getAppServiceToken } from '@/lib/app-token';
import { saveSettlementSnapshot, type PayeeChainEntry, type PendingCheckout } from '@/lib/pending-checkout';

const log = createLogger('market');

/** Payer recorded by the kernel for a checkout that carried no user identity (an app-token checkout never does). */
const ANONYMOUS_BUYER = 'anonymous';

/** A zero processor fee: the posted chain must sum to the gross total the kernel recorded. */
const NO_PROCESSOR_FEE = [{ role: 'processor', rateBps: 0, fixedCents: 0 }];

interface FairFee {
  role: string;
  name: string;
  rateBps: number;
  fixedCents: number;
}

export interface FairManifest {
  version?: string;
  fees?: FairFee[];
  chain?: FairSettlementEntry[];
  distributions?: FairSettlementEntry[];
  [key: string]: unknown;
}

/**
 * Resolve a listing manifest's chain into the dollar-denominated payee chain
 * declared at checkout. Returns `null` when the manifest has no chain (v0.3.0+
 * manifests carry the full fee cascade; anything else is not settled).
 */
export function buildPayeeChain(params: {
  amountCents: number;
  fairManifest: FairManifest | null | undefined;
  buyerDid?: string;
}): PayeeChainEntry[] | null {
  const chain = params.fairManifest?.chain;
  if (!chain?.length) return null;

  const nodeDid = process.env.NODE_DID || process.env.RELAY_IMAJIN_DID || null;
  if (!nodeDid) {
    log.warn({}, '[settle] NODE_DID not set — node fee recipient unresolved');
  }

  const { resolvedChain } = resolveSettlementChain({
    amountCents: params.amountCents,
    chain,
    fees: NO_PROCESSOR_FEE,
    buyerDid: params.buyerDid || ANONYMOUS_BUYER,
    nodeDid,
  });
  return resolvedChain;
}

interface SettleListingPurchaseParams {
  listingId: string;
  /** Stripe Checkout session id the pending checkout was recorded under. */
  sessionId: string;
  /** The checkout recorded at purchase time: kernel transaction id + declared payee chain. */
  pending: PendingCheckout;
  currency: string;
  fairManifest: FairManifest | null;
}

interface SettleResponse {
  settled?: boolean;
  alreadySettled?: boolean;
  batchId?: string;
}

/** Snapshot the resolved .fair receipt onto the listing metadata and clear its pending entry. */
async function saveReceipt(params: SettleListingPurchaseParams): Promise<void> {
  const { listingId, sessionId, pending, currency, fairManifest } = params;
  const amount = pending.amountCents;
  try {
    const resolvedFees = (fairManifest?.fees || []).map((fee) => ({
      role: fee.role,
      name: fee.name,
      rateBps: fee.rateBps,
      fixedCents: fee.fixedCents,
      amount: Number.parseFloat((computeFeeCents(amount, fee.rateBps, fee.fixedCents) / 100).toFixed(2)),
      estimated: true,
    }));

    const fairSettlement = {
      version: fairManifest?.version || (fairManifest?.fair as string | undefined) || '1.0',
      settledAt: new Date().toISOString(),
      totalAmount: amount / 100,
      netAmount: amount / 100,
      currency,
      fees: resolvedFees,
      chain: pending.chain,
    };

    // Stored on metadata.fairSettlement since listings don't have an orders table.
    await saveSettlementSnapshot(listingId, sessionId, fairSettlement);
    log.info({ listingId }, '[settle] .fair settlement snapshot saved to listing metadata');
  } catch (snapshotError) {
    log.warn({ err: String(snapshotError) }, '[settle] Failed to snapshot .fair to listing (non-fatal)');
  }
}

export async function settleListingPurchase(params: SettleListingPurchaseParams): Promise<void> {
  const { listingId, pending } = params;

  try {
    const token = await getAppServiceToken();
    const response = await fetch(`${process.env.PAY_SERVICE_URL}/api/settle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        transaction_id: pending.transactionId,
        fair_manifest: { chain: pending.chain },
        total_amount: pending.amountCents / 100,
        metadata: { listingId },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      log.error({ listingId, status: response.status, text }, '[settle] pay /api/settle returned error');
      return;
    }

    const result = (await response.json()) as SettleResponse;
    if (result.alreadySettled) {
      log.info({ listingId, batchId: result.batchId }, '[settle] Listing purchase was already settled');
    } else {
      log.info({ listingId, batchId: result.batchId }, '[settle] Settlement complete for listing');
    }

    await saveReceipt(params);
  } catch (error) {
    log.error({ err: String(error) }, '[settle] Settlement request failed (non-fatal)');
  }
}
