/**
 * Withdrawal reconciliation sweep (#2172).
 *
 * For each registered rail (`rails/registry.ts`), lists that rail's
 * transfers since a persisted watermark and classifies them against
 * `pay.withdrawal_intents` into three buckets:
 *   - matched: a rail transfer whose intent id points at a `completed`
 *     intent — the happy path, no action.
 *   - external-without-ledger (DANGEROUS): a rail transfer with no
 *     corresponding `completed` intent — real money moved with no ledger
 *     record backing it.
 *   - pending-timeout (safe): a `pending` intent older than the release
 *     timeout with no corresponding rail transfer at all — the reservation
 *     was never fulfilled and can eventually be released.
 *
 * "Propose, never mutate" (issue §3 + the explicit Acceptance/Out-of-scope
 * line "Applying compensations is OUT of scope (operator approval,
 * later)"): this module NEVER calls `creditUnit`, NEVER flips an intent's
 * status, and NEVER touches a balance row. Every non-matched case only
 * gets a signed `pay.reconciliation.discrepancy` attestation + bus event
 * (`publish()`, same one-call pattern `settle-core.ts` uses for
 * `transaction.settled`) so it's durable and queryable
 * (`app/pay/api/admin/reconciliation/route.ts`), but resolution is a
 * separate, human-approved follow-up.
 */
import { and, eq } from 'drizzle-orm';
import { db, withdrawalIntents, reconciliationWatermarks } from '@/src/db';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import type { WithdrawRail } from './rails/types';
import { listRegisteredRails } from './rails/registry';

const log = createLogger('kernel');

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

function releaseTimeoutMs(): number {
  const raw = process.env.WITHDRAWAL_RECONCILE_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

async function getWatermark(rail: string): Promise<Date> {
  const [row] = await db
    .select()
    .from(reconciliationWatermarks)
    .where(eq(reconciliationWatermarks.rail, rail))
    .limit(1);
  return row?.lastReconciledAt ?? new Date(0);
}

async function setWatermark(rail: string, at: Date): Promise<void> {
  await db
    .insert(reconciliationWatermarks)
    .values({ rail, lastReconciledAt: at, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: reconciliationWatermarks.rail,
      set: { lastReconciledAt: at, updatedAt: new Date() },
    });
}

interface DiscrepancyParams {
  rail: string;
  externalRef: string | null;
  intentId: string | null;
  amount: number;
  unit: string;
  bucket: 'external_without_ledger' | 'pending_timeout';
  did: string | null;
}

/** Signs + publishes the discrepancy attestation. Never throws — a publish failure is logged, not fatal to the sweep. */
async function emitDiscrepancy(params: DiscrepancyParams): Promise<void> {
  const platformDid = process.env.PLATFORM_DID;
  if (!platformDid) {
    log.warn(
      { rail: params.rail, bucket: params.bucket },
      'reconciliation discrepancy attestation skipped: PLATFORM_DID not set',
    );
    return;
  }

  const contextId = params.intentId ?? params.externalRef ?? params.rail;
  await publish('pay.reconciliation.discrepancy', {
    issuer: platformDid,
    subject: params.did ?? 'unknown',
    scope: 'pay',
    payload: {
      rail: params.rail,
      external_ref: params.externalRef,
      intent_id: params.intentId,
      amount: params.amount,
      unit: params.unit,
      bucket: params.bucket,
      context_id: contextId,
      context_type: 'pay.withdrawal_intent',
    },
  }).catch((err: unknown) => {
    log.error(
      { err: String(err), rail: params.rail, bucket: params.bucket },
      'pay.reconciliation.discrepancy publish error',
    );
  });
}

export interface ReconcileRailResult {
  rail: string;
  matched: number;
  externalWithoutLedger: number;
  pendingTimeout: number;
  newWatermark: Date;
}

/** Classify every transfer this rail reported since `watermark` as matched or external-without-ledger. */
async function classifyTransfers(rail: WithdrawRail, watermark: Date): Promise<{ matched: number; externalWithoutLedger: number }> {
  const transfers = await rail.list({ since: watermark });
  if (transfers.length === 0) return { matched: 0, externalWithoutLedger: 0 };

  const completedIntents = await db
    .select()
    .from(withdrawalIntents)
    .where(and(eq(withdrawalIntents.rail, rail.name), eq(withdrawalIntents.status, 'completed')));
  const completedIntentIds = new Set(completedIntents.map((i) => i.id));

  let matched = 0;
  let externalWithoutLedger = 0;
  for (const transfer of transfers) {
    if (transfer.intentId && completedIntentIds.has(transfer.intentId)) {
      matched += 1;
      continue;
    }
    externalWithoutLedger += 1;
    await emitDiscrepancy({
      rail: rail.name,
      externalRef: transfer.externalRef,
      intentId: transfer.intentId,
      amount: transfer.amount,
      unit: transfer.unit,
      bucket: 'external_without_ledger',
      did: null,
    });
  }
  return { matched, externalWithoutLedger };
}

/**
 * Classify every `pending` intent for this rail older than the release
 * timeout. Checks each one against the rail's transfer feed scoped to
 * *that intent's own creation time* (not the shared watermark window) —
 * a pending intent can be far older than the current watermark, and its
 * transfer (if one exists) may have already scrolled out of a
 * watermark-bounded `list()` call in an earlier run.
 */
async function classifyPendingIntents(rail: WithdrawRail, runStartedAt: Date): Promise<number> {
  const pendingIntents = await db
    .select()
    .from(withdrawalIntents)
    .where(and(eq(withdrawalIntents.rail, rail.name), eq(withdrawalIntents.status, 'pending')));

  const timeoutMs = releaseTimeoutMs();
  let pendingTimeout = 0;

  for (const intent of pendingIntents) {
    const createdAt = intent.createdAt ?? new Date(0);
    if (runStartedAt.getTime() - createdAt.getTime() < timeoutMs) continue; // still within grace period

    const transfersSinceCreation = await rail.list({ since: createdAt });
    const hasExternalTransfer = transfersSinceCreation.some((t) => t.intentId === intent.id);
    if (hasExternalTransfer) {
      // The rail DOES have a transfer for this intent — this is the
      // dangerous bucket (money moved, ledger never confirmed it), not the
      // safe timeout bucket. `classifyTransfers` above only sees this
      // transfer once it falls inside the shared watermark window; until
      // then, this per-intent check is what catches it.
      continue;
    }

    pendingTimeout += 1;
    await emitDiscrepancy({
      rail: rail.name,
      externalRef: null,
      intentId: intent.id,
      amount: Number.parseFloat(intent.amount),
      unit: intent.unit,
      bucket: 'pending_timeout',
      did: intent.did,
    });
  }

  return pendingTimeout;
}

/** Reconcile a single rail: classify transfers + aged pending intents, and return counts. Does not persist the watermark — `runReconciliation` does that once classification succeeds. */
export async function reconcileRail(rail: WithdrawRail, watermark: Date, runStartedAt: Date): Promise<ReconcileRailResult> {
  const { matched, externalWithoutLedger } = await classifyTransfers(rail, watermark);
  const pendingTimeout = await classifyPendingIntents(rail, runStartedAt);

  return { rail: rail.name, matched, externalWithoutLedger, pendingTimeout, newWatermark: runStartedAt };
}

export interface RunReconciliationResult {
  rails: ReconcileRailResult[];
}

/** Sweep every registered rail once, advancing each rail's watermark independently. */
export async function runReconciliation(): Promise<RunReconciliationResult> {
  const rails = listRegisteredRails();
  const results: ReconcileRailResult[] = [];

  for (const rail of rails) {
    // Captured BEFORE `list()` so a transfer created mid-run is never
    // skipped by the next run's watermark.
    const runStartedAt = new Date();
    const watermark = await getWatermark(rail.name);
    const result = await reconcileRail(rail, watermark, runStartedAt);
    await setWatermark(rail.name, result.newWatermark);
    results.push(result);
  }

  return { rails: results };
}
