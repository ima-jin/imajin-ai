/**
 * Shared settlement core for `.fair` multi-party settlements (#1073).
 *
 * Extracted verbatim from `apps/kernel/app/pay/api/settle/route.ts` so the
 * canonical `POST /api/settle` route can delegate to a single reusable
 * `settlePayment()` primitive, and so `verifySettlementSignature` can also
 * be reused by the Stripe webhook's settlement path
 * (`apps/kernel/src/lib/pay/webhook-handlers.ts`) as a non-blocking gate.
 *
 * `settlePayment()` itself — the dollar-amount chain, `balances`/
 * `transactions` crediting, and attestation emission — is used ONLY by the
 * canonical route today. The webhook path settles a structurally different
 * manifest shape (fractional shares of a Stripe checkout total, credited
 * to `feeLedger`/`balanceRollups`) and intentionally keeps that mechanism
 * separate — see `docs/guide/canonical-patterns.md` "Known divergences".
 */
import { db, transactions, identities, identityChains } from '@/src/db';
import { eq, inArray } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import { verifyManifest } from '@imajin/fair';
import type { FairManifest, FairManifestV11 } from '@imajin/fair';
import { createDbResolver } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { verifyIntroAttributionManifestForSettlement } from '@/src/lib/fair/intro-attribution';
import {
  ACCEPTED_UNITS_DEFAULT,
  MJN,
  amountOf,
  assertUnitAccepted,
  creditUnit,
  debitUnit,
  getBalanceRow,
  type Unit,
} from './ledger';

const log = createLogger('kernel');

async function verifyChainStatus(did: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ did: identityChains.did })
      .from(identityChains)
      .where(eq(identityChains.did, did))
      .limit(1);
    return !!row;
  } catch {
    return false;
  }
}

interface FairManifestChainItem {
  did: string;
  amount: number;
  role: string;
}

type SettlementValidationResult =
  | { error: string; status: number }
  | { signatureVerified: boolean };

function validateChain(chain: unknown, total_amount: number): { error: string; status: number } | { chainTotal: number } {
  if (!chain || !Array.isArray(chain)) {
    return { error: 'fair_manifest.chain must be an array', status: 400 };
  }
  let chainTotal = 0;
  for (const item of chain as FairManifestChainItem[]) {
    if (!item.did || !item.amount || !item.role) {
      return { error: 'Each chain item must have did, amount, and role', status: 400 };
    }
    chainTotal += item.amount;
  }
  if (Math.abs(chainTotal - total_amount) > 0.01) {
    return { error: `Chain total (${chainTotal}) does not match total_amount (${total_amount})`, status: 400 };
  }
  return { chainTotal };
}

/**
 * Verify a fair_manifest's optional Ed25519 signature for non-funded
 * settlements. Funded (external/Stripe) settlements skip verification —
 * the manifest came from our own service. `fair_manifest` is unvalidated
 * JSON from the request body — typed `Record<string, unknown>` here (never
 * `any`) and cast at the one call site that needs the full `FairManifest`
 * shape, same looseness the route has always had.
 *
 * Reused by the Stripe webhook path (`webhook-handlers.ts`) as a
 * non-blocking gate — see `verifyWebhookManifestSignature` there.
 */
export async function verifySettlementSignature(params: {
  fair_manifest: Record<string, unknown>;
  from_did: string;
  service: string;
}): Promise<{ error: string; status: number } | { signatureVerified: boolean }> {
  const { fair_manifest, from_did, service } = params;
  if (fair_manifest.signature === undefined) {
    // Unsigned manifest — allow but warn (transitional period)
    log.warn({ fromDid: from_did, service }, 'Settlement received unsigned fair_manifest');
    return { signatureVerified: false };
  }
  const resolver = createDbResolver(db, identities);
  const wrappedResolver = async (did: string): Promise<string> => {
    const identity = await resolver(did);
    if (!identity) throw new Error(`Could not resolve public key for DID: ${did}`);
    return identity.publicKey;
  };
  const result = await verifyManifest(fair_manifest as unknown as FairManifest, wrappedResolver);
  if (!result.valid) {
    return { error: `fair_manifest signature verification failed: ${result.error}`, status: 400 };
  }
  return { signatureVerified: true };
}

/**
 * Pre-mutation validation for `settlePayment()`: chain shape/sum, the
 * #1886 intro-attribution money-rule guard, and (for non-funded
 * settlements) signature verification.
 */
async function validateSettlementRequest(params: {
  fair_manifest: Record<string, unknown>;
  total_amount: number;
  from_did: string;
  service: string;
  funded: boolean;
}): Promise<SettlementValidationResult> {
  const { fair_manifest, total_amount, from_did, service, funded } = params;

  const chainCheck = validateChain(fair_manifest.chain, total_amount);
  if ('error' in chainCheck) return chainCheck;

  // #1886 money-rule guard: a no-op for every manifest that isn't the
  // intro-attribution template. For that template, resolves
  // fair_manifest.provenance[] against real auth.attestations rows and
  // enforces the shared trigger gate (money points at facts; a dangling
  // ref, a missing intro_made anchor, an uncountersigned value_realized
  // claim, or an expired attribution window all refuse the settlement
  // outright, before any balance is touched).
  const introAttributionCheck = await verifyIntroAttributionManifestForSettlement(
    fair_manifest as unknown as Partial<FairManifestV11>,
  );
  if (!introAttributionCheck.ok) {
    return { error: introAttributionCheck.error, status: 400 };
  }

  if (funded) return { signatureVerified: false };
  return verifySettlementSignature({ fair_manifest, from_did, service });
}

interface SettlementSource {
  source: 'credit' | 'fiat' | 'external';
  burnAmount: number;
  settleCurrency: string;
}

/** 'MJN' settles from the withdrawable/receipt-backed bucket (legacy 'fiat' source label); 'MJNx' settles from the emitted bucket (legacy 'credit' source label). */
function sourceLabelForUnit(unit: Unit): 'credit' | 'fiat' {
  return unit === MJN ? 'fiat' : 'credit';
}

/**
 * Resolve how a non-funded settlement is paid for: the sender's balance in
 * the single requested `unit` (#2016 — no more credit-then-cash mixed
 * burn). Externally funded (e.g. Stripe) settlements skip this entirely —
 * no balance check, no debit — and the caller never invokes this function
 * for that case.
 */
async function resolveInternalSettlementSource(params: {
  from_did: string;
  total_amount: number;
  currency: string;
  unit: Unit;
}): Promise<SettlementSource | { error: string; status: number }> {
  const { from_did, total_amount, currency, unit } = params;
  const senderBalance = await getBalanceRow(db, from_did, unit);
  const available = amountOf(senderBalance);
  const settleCurrency = senderBalance?.currency || currency;

  if (available < total_amount) {
    return { error: `Insufficient ${unit} balance: ${available} < ${total_amount}`, status: 400 };
  }

  return { source: sourceLabelForUnit(unit), burnAmount: total_amount, settleCurrency };
}

interface EmitAttestationsParams {
  from_did: string;
  fair_manifest: { chain: Array<{ did: string; amount: number; role: string }> };
  batchId: string;
  txIds: string[];
  total_amount: number;
  source: string;
  payerChainVerified: boolean;
  payeeChainVerified: boolean;
}

async function emitAttestations(params: EmitAttestationsParams) {
  const { from_did, fair_manifest, batchId, txIds, total_amount, source, payerChainVerified, payeeChainVerified } = params;
  const attestationCalls: Promise<void>[] = [];

  // One "customer" attestation per recipient
  for (const recipient of fair_manifest.chain) {
    attestationCalls.push(
      publish('customer', {
        issuer: recipient.did,
        subject: from_did,
        scope: 'pay',
        payload: { role: recipient.role, context_id: batchId, context_type: 'service' },
      }).catch((err) => {
        log.error({ err: String(err), did: recipient.did }, `Attestation (customer) error for ${recipient.did}`);
      })
    );
  }

  // One "transaction.settled" attestation from the platform
  const platformDid = process.env.PLATFORM_DID;
  if (platformDid) {
    attestationCalls.push(
      publish('transaction.settled', {
        issuer: platformDid,
        subject: from_did,
        scope: 'pay',
        payload: { total_amount, recipients: fair_manifest.chain.length, source, payerChainVerified, payeeChainVerified, context_id: batchId, context_type: 'service' },
      }).catch((err) => {
        log.error({ err: String(err) }, 'Attestation (transaction.settled) error');
      })
    );
  } else {
    log.warn({}, 'Attestation (transaction.settled) skipped: PLATFORM_DID not set');
  }

  await Promise.all(attestationCalls);

  // Mark transactions as credential_issued
  if (txIds.length > 0) {
    await db
      .update(transactions)
      .set({ credentialIssued: true })
      .where(inArray(transactions.id, txIds))
      .catch((err) => {
        log.error({ err: String(err) }, 'Failed to mark credential_issued on transactions');
      });
  }
}

export interface SettlePaymentParams {
  from_did: string;
  total_amount: number;
  service: string;
  type: string;
  fair_manifest: Record<string, unknown> & { chain: Array<{ did: string; amount: number; role: string }> };
  funded?: boolean;
  funded_provider?: string;
  metadata?: Record<string, unknown>;
  currency?: string;
  /** The wallet unit this settlement moves. Defaults to 'MJN' (preserves every existing caller's behavior — none pass a unit today). */
  unit?: string;
  /** Units this settlement target (service/type) accepts. Defaults to MJN-only (#2016 decision 2) — pass e.g. ['MJN','MJNx'] to opt a line item into MJNx. */
  acceptedUnits?: readonly string[];
}

export type SettlePaymentResult =
  | { error: string; status: number }
  | {
      settled: true;
      batchId: string;
      transactions: string[];
      total_amount: number;
      recipients: number;
      source: string;
    };

/**
 * Execute a `.fair` multi-party settlement: validates chain shape/sum, the
 * #1886 intro-attribution guard, and (for non-funded settlements) the
 * manifest's Ed25519 signature; then atomically debits `from_did` (skipped
 * for externally-funded settlements) and credits each chain recipient's
 * balance row in the settlement's `unit` (#2016 — single-unit only, no
 * mixed-bucket burn), logging one `transactions` row per recipient.
 * Fires `customer` + `transaction.settled` attestations asynchronously.
 *
 * This is the canonical settlement primitive from `docs/guide/canonical-patterns.md`.
 * Extracted from `POST /api/settle`'s handler (#1073) so callers other than
 * the HTTP route can invoke the identical logic in-process.
 */
export async function settlePayment(params: SettlePaymentParams): Promise<SettlePaymentResult> {
  const {
    from_did,
    total_amount,
    service,
    type,
    fair_manifest,
    funded = false,
    funded_provider,
    metadata = {},
    currency = 'CAD',
    unit: rawUnit = MJN,
    acceptedUnits = ACCEPTED_UNITS_DEFAULT,
  } = params;

  const unitCheck = assertUnitAccepted(rawUnit, acceptedUnits);
  if ('error' in unitCheck) {
    return { error: unitCheck.error, status: unitCheck.status };
  }
  const unit = unitCheck.unit;

  // Externally funded (e.g. Stripe) settlements mint no new ledger unit —
  // Stripe already collected real fiat money, so the only unit that can be
  // credited here is MJN. There is no receipt path for an externally-funded
  // MJNx mint (#2016 decision 1/2).
  if (funded && unit !== MJN) {
    return { error: `Externally funded settlements must use unit '${MJN}' (got '${unit}')`, status: 400 };
  }

  const validation = await validateSettlementRequest({ fair_manifest, total_amount, from_did, service, funded });
  if ('error' in validation) {
    return { error: validation.error, status: validation.status };
  }
  const { signatureVerified } = validation;

  // Externally funded (e.g. Stripe checkout) skips balance check/debit
  // entirely; an internal settlement resolves which single-unit balance to burn.
  const sourceResolution: SettlementSource | { error: string; status: number } = funded
    ? { source: 'external', burnAmount: 0, settleCurrency: currency }
    : await resolveInternalSettlementSource({ from_did, total_amount, currency, unit });
  if ('error' in sourceResolution) {
    return { error: sourceResolution.error, status: sourceResolution.status };
  }
  const { source, burnAmount, settleCurrency } = sourceResolution;

  // Verify chain status for payer and all payees (non-blocking — don't fail payment)
  const payeeDids = [...new Set(fair_manifest.chain.map((r) => r.did))];
  const [payerChainVerified, ...payeeVerifications] = await Promise.all([
    verifyChainStatus(from_did),
    ...payeeDids.map((did) => verifyChainStatus(did)),
  ]);
  const payeeChainVerified = payeeVerifications.every(Boolean);

  const batchId = generateId('batch');
  const txIds: string[] = [];

  // Externally funded settlements are backed by a real Stripe receipt;
  // internal (from an existing balance) settlements are pure ledger moves.
  const sourceKind = funded ? 'receipt' : 'transfer';

  // Atomic settlement
  await db.transaction(async (tx) => {
    // Debit from_did's single-unit balance (skip for externally funded)
    if (!funded) {
      await debitUnit(tx, from_did, unit, burnAmount);
    }

    // Credit each recipient in the SAME unit as the settlement (#2016 — no
    // more forced "earnings go to cash" laundering into a different bucket).
    // For externally-funded payments (Stripe), the seller already received money
    // via Stripe Connect. Only credit platform/node/buyer_credit balances — NOT the seller.
    const SELLER_ROLES = new Set(['seller', 'creator', 'event']);

    for (const recipient of fair_manifest.chain) {
      const txId = generateId('tx');
      txIds.push(txId);

      const skipBalanceCredit = funded && SELLER_ROLES.has(recipient.role);

      // Insert transaction (always — for audit trail)
      await tx.insert(transactions).values({
        id: txId,
        service,
        type,
        fromDid: from_did,
        toDid: recipient.did,
        amount: recipient.amount.toString(),
        currency: settleCurrency,
        unit,
        sourceKind,
        status: 'completed',
        source,
        fairManifest: fair_manifest,
        batchId,
        metadata: {
          ...metadata,
          role: recipient.role,
          ...(funded && { funded: true, funded_provider: funded_provider || 'unknown' }),
          signature_verified: funded ? false : signatureVerified,
          ...(skipBalanceCredit && { balance_skipped: true, reason: 'externally_funded_seller' }),
        },
      });

      // Credit recipient's balance in the settlement's unit — skip for
      // sellers on funded payments (money already went to their Stripe
      // Connected account).
      if (!skipBalanceCredit) {
        await creditUnit(tx, recipient.did, unit, recipient.amount, { currency: settleCurrency });
      }
    }
  });

  // Fire attestations asynchronously — don't block settlement response
  emitAttestations({ from_did, fair_manifest, batchId, txIds, total_amount, source, payerChainVerified, payeeChainVerified }).catch((err) => {
    log.error({ err: String(err) }, 'Attestation emission error');
  });

  return {
    settled: true,
    batchId,
    transactions: txIds,
    total_amount,
    recipients: fair_manifest.chain.length,
    source,
  };
}
