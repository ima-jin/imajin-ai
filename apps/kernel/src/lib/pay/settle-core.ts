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
import { createDbResolver } from '@imajin/auth/resolve-db';
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

/** A resolved trust-liability tax credit (#2419) — dollar `amount`, kept OUT of `chain` (see `resolveSettlementChain`'s `taxCredits`). */
interface FairManifestTaxCredit {
  did: string;
  amount: number;
  jurisdiction: string;
  kind: string;
  rateBps: number;
  remitTo: string;
  registrationNumber?: string;
}

type SettlementValidationResult =
  | { error: string; status: number }
  | { signatureVerified: boolean };

/**
 * Validate + sum `fair_manifest.taxCredits` (#2419), split out of
 * `validateChain` purely to keep that function's cognitive complexity
 * under budget — not because this validation is reusable elsewhere.
 */
function validateTaxCreditsSum(taxCredits: unknown): { error: string; status: number } | { taxTotal: number } {
  if (taxCredits === undefined) return { taxTotal: 0 };
  if (!Array.isArray(taxCredits)) {
    return { error: 'fair_manifest.taxCredits must be an array when present', status: 400 };
  }

  let taxTotal = 0;
  for (const credit of taxCredits as FairManifestTaxCredit[]) {
    // #2419 fix (review): checked separately from `amount` so a
    // non-negative ZERO amount (e.g. rateBps: 0, which validate.ts
    // already allows) isn't rejected by a truthy check.
    if (!credit.did || !credit.jurisdiction || !credit.kind || !credit.remitTo) {
      return { error: 'Each taxCredits item must have did, amount, jurisdiction, kind, and remitTo', status: 400 };
    }
    // #2419 fix (review): a string/NaN amount previously slipped through
    // `!credit.amount` (a non-empty numeric string is truthy) and turned
    // `chainTotal + taxTotal` into string concatenation or NaN, at which
    // point `Math.abs(NaN) > 0.01` is false and the tolerance check below
    // silently passes. `/pay/api/settle` takes `fair_manifest` straight
    // from an API-key caller, so this must be a hard 400.
    if (typeof credit.amount !== 'number' || !Number.isFinite(credit.amount) || credit.amount < 0) {
      return { error: 'Each taxCredits item amount must be a finite number >= 0', status: 400 };
    }
    taxTotal += credit.amount;
  }
  return { taxTotal };
}

/**
 * Validate `fair_manifest.chain` shape/sum against `total_amount`.
 *
 * #2419: when `taxCredits` is present/non-empty, the invariant widens from
 * "chain sums to total_amount" to "chain + taxCredits sums to
 * total_amount" — tax is real money moved in the same settlement batch,
 * just kept out of `chain` so it never enters fee-skim math. Exported for
 * direct unit testing (no DB needed — this is pure validation).
 */
export function validateChain(
  chain: unknown,
  total_amount: number,
  taxCredits?: unknown,
): { error: string; status: number } | { chainTotal: number; taxTotal: number } {
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

  const taxCheck = validateTaxCreditsSum(taxCredits);
  if ('error' in taxCheck) return taxCheck;
  const { taxTotal } = taxCheck;

  if (Math.abs(chainTotal + taxTotal - total_amount) > 0.01) {
    return taxTotal > 0
      ? { error: `Chain total + tax total (${chainTotal} + ${taxTotal}) does not match total_amount (${total_amount})`, status: 400 }
      : { error: `Chain total (${chainTotal}) does not match total_amount (${total_amount})`, status: 400 };
  }
  return { chainTotal, taxTotal };
}

/** Role set whose funded-settlement members already received money directly via Stripe Connect. Declared here (used by both pre-mutation validation and the crediting loops further below). */
const SELLER_ROLES = new Set(['seller', 'creator', 'event']);

/**
 * #2419 fix (review): on a Stripe-funded settlement, ALL the money — tax
 * included — was deposited into the seller's connected Stripe account, not
 * held by the platform. Crediting a tax `collectorDid` that ISN'T one of
 * this settlement's chain sellers would mint internal balance the platform
 * never actually received. Reject that combination outright, before any
 * balance is touched (unlike the funded-seller case, which is a safe
 * balance-credit *skip*, not an error). Unfunded settlements are
 * unaffected — `creditTaxRows` still credits any collector normally there,
 * since that money really did move through the internal ledger.
 */
function validateFundedTaxCollectors(
  fair_manifest: Record<string, unknown>,
  funded: boolean,
): { error: string; status: number } | null {
  if (!funded) return null;
  const taxCredits = fair_manifest.taxCredits;
  if (!Array.isArray(taxCredits) || taxCredits.length === 0) return null;

  const chain = Array.isArray(fair_manifest.chain) ? (fair_manifest.chain as FairManifestChainItem[]) : [];
  const chainSellerDids = new Set(chain.filter((r) => SELLER_ROLES.has(r.role)).map((r) => r.did));

  const unbacked = (taxCredits as FairManifestTaxCredit[]).find((credit) => !chainSellerDids.has(credit.did));
  if (unbacked) {
    return {
      error: `Funded settlement's tax collector '${unbacked.did}' is not one of this settlement's chain sellers — Stripe never sent money to that account`,
      status: 400,
    };
  }
  return null;
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

  const chainCheck = validateChain(fair_manifest.chain, total_amount, fair_manifest.taxCredits);
  if ('error' in chainCheck) return chainCheck;

  const taxCollectorCheck = validateFundedTaxCollectors(fair_manifest, funded);
  if (taxCollectorCheck) return taxCollectorCheck;

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

/** Minimal shape both crediting loops need from either `db` or a `db.transaction()` callback's `tx`. Mirrors `ledger.ts`'s private `Executor` type. */
type TxExecutor = Pick<typeof db, 'select' | 'insert' | 'update'>;

/** Shared per-settlement context both crediting loops read from — avoids threading nine individual params through each. */
interface CreditLoopContext {
  from_did: string;
  service: string;
  type: string;
  fair_manifest: SettlePaymentParams['fair_manifest'];
  funded: boolean;
  funded_provider?: string;
  metadata: Record<string, unknown>;
  unit: Unit;
  sourceKind: 'receipt' | 'transfer';
  source: string;
  settleCurrency: string;
  batchId: string;
  signatureVerified: boolean;
}

/**
 * Credit each `fair_manifest.chain` recipient (#2016 — single-unit, no
 * cash-laundering): insert one `transactions` audit row per recipient
 * (always), and skip the internal balance credit only for a funded
 * settlement's seller-role recipients (money already moved via Stripe
 * Connect). Returns the inserted transaction ids.
 */
async function creditChainRecipients(tx: TxExecutor, ctx: CreditLoopContext): Promise<string[]> {
  const { from_did, service, type, fair_manifest, funded, funded_provider, metadata, unit, sourceKind, source, settleCurrency, batchId, signatureVerified } = ctx;
  const txIds: string[] = [];

  for (const recipient of fair_manifest.chain) {
    const txId = generateId('tx');
    txIds.push(txId);

    const skipBalanceCredit = funded && SELLER_ROLES.has(recipient.role);

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

    if (!skipBalanceCredit) {
      await creditUnit(tx, recipient.did, unit, recipient.amount, { currency: settleCurrency });
    }
  }

  return txIds;
}

/**
 * Credit each `fair_manifest.taxCredits` row (#2419) — one extra
 * trust-liability ledger credit per `.fair` `taxes[]` row, tagged
 * `{ tax: true, jurisdiction, kind, rateBps, remitTo, trustLiability: true,
 * remitted: null }`. On a funded (Stripe) settlement, `validateFundedTaxCollectors`
 * (pre-mutation validation, above) has already guaranteed every credit's
 * `did` is one of this settlement's chain sellers — that DID already
 * received the tax money directly via the same Stripe Connect transfer
 * (the checkout's single connected-account destination), so the credit is
 * recorded here (audit trail) but not double-applied to the internal
 * balance, mirroring `creditChainRecipients`' seller skip. For an unfunded
 * settlement, any collector is credited internally, since that's a real
 * internal ledger move. Returns the inserted transaction ids.
 */
async function creditTaxRows(tx: TxExecutor, ctx: CreditLoopContext): Promise<string[]> {
  const { from_did, service, type, fair_manifest, funded, funded_provider, metadata, unit, sourceKind, source, settleCurrency, batchId, signatureVerified } = ctx;
  const txIds: string[] = [];
  const chainSellerDids = new Set(
    fair_manifest.chain.filter((r) => SELLER_ROLES.has(r.role)).map((r) => r.did),
  );

  for (const credit of fair_manifest.taxCredits ?? []) {
    const txId = generateId('tx');
    txIds.push(txId);

    const skipTaxBalanceCredit = funded && chainSellerDids.has(credit.did);

    await tx.insert(transactions).values({
      id: txId,
      service,
      type,
      fromDid: from_did,
      toDid: credit.did,
      amount: credit.amount.toString(),
      currency: settleCurrency,
      unit,
      sourceKind,
      status: 'completed',
      source,
      fairManifest: fair_manifest,
      batchId,
      metadata: {
        ...metadata,
        role: 'tax',
        tax: true,
        jurisdiction: credit.jurisdiction,
        kind: credit.kind,
        rateBps: credit.rateBps,
        remitTo: credit.remitTo,
        trustLiability: true,
        remitted: null,
        ...(funded && { funded: true, funded_provider: funded_provider || 'unknown' }),
        signature_verified: funded ? false : signatureVerified,
        ...(skipTaxBalanceCredit && { balance_skipped: true, reason: 'externally_funded_seller' }),
      },
    });

    if (!skipTaxBalanceCredit) {
      await creditUnit(tx, credit.did, unit, credit.amount, { currency: settleCurrency });
    }
  }

  return txIds;
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
  fair_manifest: Record<string, unknown> & {
    chain: Array<{ did: string; amount: number; role: string }>;
    /**
     * Resolved trust-liability tax credits (#2419), dollar-based, one per
     * `.fair` `taxes[]` row (see `resolveSettlementChain`'s `taxCredits`).
     * Kept OUT of `chain` — see `validateChain`'s widened invariant above.
     */
    taxCredits?: Array<{
      did: string;
      amount: number;
      jurisdiction: string;
      kind: string;
      rateBps: number;
      remitTo: string;
      registrationNumber?: string;
    }>;
  };
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
  let txIds: string[] = [];

  // Externally funded settlements are backed by a real Stripe receipt;
  // internal (from an existing balance) settlements are pure ledger moves.
  const sourceKind = funded ? 'receipt' : 'transfer';

  // Atomic settlement
  await db.transaction(async (tx) => {
    // Debit from_did's single-unit balance (skip for externally funded)
    if (!funded) {
      await debitUnit(tx, from_did, unit, burnAmount);
    }

    const creditCtx: CreditLoopContext = {
      from_did, service, type, fair_manifest, funded, funded_provider, metadata, unit, sourceKind, source, settleCurrency, batchId, signatureVerified,
    };
    // Credit each recipient in the SAME unit as the settlement (#2016 — no
    // more forced "earnings go to cash" laundering into a different bucket),
    // then each #2419 trust-liability tax credit — kept as two separate
    // loops/functions (`creditChainRecipients`/`creditTaxRows`) so neither
    // one's cognitive complexity creeps back up as new cases are added.
    const chainTxIds = await creditChainRecipients(tx, creditCtx);
    const taxTxIds = await creditTaxRows(tx, creditCtx);
    txIds = [...chainTxIds, ...taxTxIds];
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
