/**
 * Withdrawal intent core logic (#2172): reserve -> external -> confirm.
 *
 * Extracted from the withdraw route (mirrors `settle-core.ts`'s split from
 * `POST /api/settle`) so this transactional shape is unit-testable without
 * the Next.js route wrapper, and so a future caller (e.g. an operator retry
 * tool) can invoke it directly.
 *
 * Crash-safety, restated from the issue design:
 * - Crash before/during the reservation transaction -> nothing happened
 *   anywhere (guarded debit + intent insert are one committed transaction).
 * - Crash after the reservation commits, before the rail call -> a durable
 *   `pending` intent with the reservation held; the reconciliation sweep
 *   (`reconciliation.ts`) classifies it (never auto-releases it — applying
 *   a compensation is an operator-approved action, out of scope here).
 * - Crash after the rail call succeeds, before the confirm transaction
 *   commits -> a durable `pending` intent whose rail-side existence is
 *   deterministic via `idempotencyKey` (a retry can never mint a second
 *   external transfer) and which the reconciliation sweep classifies as
 *   external-without-ledger.
 * - The rail call throws -> the reservation is released synchronously, in
 *   the same request, before the route returns.
 */
import { eq } from 'drizzle-orm';
import { db, transactions, withdrawalIntents } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { createLogger } from '@imajin/logger';
import {
  type Unit,
  debitUnitIfSufficient,
  creditUnit,
  InsufficientBalanceError,
} from './ledger';
import type { WithdrawRail, WithdrawalIntent } from './rails/types';
import { emitReconciliationDiscrepancy } from './reconciliation';

const log = createLogger('kernel');

export interface ReserveWithdrawalParams {
  did: string;
  unit: Unit;
  amount: number | string;
  rail: string;
  /** Runtime-only hints threaded onto the returned `WithdrawalIntent` for `rail.execute()` — never persisted (see `rails/types.ts`). */
  currency?: string;
  destination?: string;
}

/**
 * Tx 1 (reservation): the guarded debit (#2166's `debitUnitIfSufficient`,
 * reused unmodified — never forked) and the intent insert commit together.
 * The intent id doubles as the rail's idempotency key. Throws
 * `InsufficientBalanceError` and writes nothing when the guard fails.
 */
export async function reserveWithdrawal(params: ReserveWithdrawalParams): Promise<WithdrawalIntent> {
  const { did, unit, amount, rail, currency, destination } = params;
  const id = generateId('wdi');
  const amountStr = String(amount);

  await db.transaction(async (tx) => {
    const debitResult = await debitUnitIfSufficient(tx, did, unit, amount);
    if (!debitResult.ok) {
      throw new InsufficientBalanceError(unit);
    }

    await tx.insert(withdrawalIntents).values({
      id,
      did,
      unit,
      amount: amountStr,
      rail,
      idempotencyKey: id,
      status: 'pending',
    });
  });

  return { id, did, unit, amount: amountStr, rail, idempotencyKey: id, currency, destination };
}

/**
 * Tx 2 (confirm): intent -> `completed` with its `externalRef`, plus the
 * `pay.transactions` receipt row. `stripeId` is populated with the
 * (possibly non-Stripe) `externalRef` for backward-compatible indexing —
 * see `idx_transactions_stripe_id` — while `metadata.rail`/`externalRef`
 * carry the rail-agnostic record.
 */
export async function confirmWithdrawal(intent: WithdrawalIntent, externalRef: string): Promise<string> {
  const txId = generateId('tx');

  await db.transaction(async (tx) => {
    await tx
      .update(withdrawalIntents)
      .set({ status: 'completed', externalRef, updatedAt: new Date() })
      .where(eq(withdrawalIntents.id, intent.id));

    await tx.insert(transactions).values({
      id: txId,
      service: 'pay',
      type: 'withdrawal',
      fromDid: intent.did,
      toDid: intent.destination ?? intent.did,
      amount: intent.amount,
      currency: (intent.currency ?? 'CAD').toUpperCase(),
      unit: intent.unit,
      sourceKind: 'receipt',
      status: 'completed',
      source: 'fiat',
      stripeId: externalRef,
      metadata: { rail: intent.rail, externalRef, intentId: intent.id },
    });
  });

  return txId;
}

/**
 * Compensating release when the rail call itself throws: intent -> `failed`,
 * the reservation is credited back, and a `withdrawal_release` transaction
 * row records the reversal (every other balance mutation in this codebase
 * gets a `pay.transactions` row — a released reservation is no exception).
 */
export async function releaseWithdrawal(intent: WithdrawalIntent, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(withdrawalIntents)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(eq(withdrawalIntents.id, intent.id));

    await creditUnit(tx, intent.did, intent.unit, intent.amount, { currency: intent.currency });

    await tx.insert(transactions).values({
      id: generateId('tx'),
      service: 'pay',
      type: 'withdrawal_release',
      fromDid: null,
      toDid: intent.did,
      amount: intent.amount,
      currency: (intent.currency ?? 'CAD').toUpperCase(),
      unit: intent.unit,
      sourceKind: 'transfer',
      status: 'completed',
      source: 'fiat',
      metadata: { intentId: intent.id, reason },
    });
  });
}

export interface ExecuteWithdrawalParams {
  did: string;
  unit: Unit;
  amount: number | string;
  rail: WithdrawRail;
  currency?: string;
  destination?: string;
}

export interface ExecuteWithdrawalResult {
  intent: WithdrawalIntent;
  externalRef: string;
  transactionId: string;
}

/**
 * The full reserve -> external -> confirm flow. Reused directly by the
 * withdraw route; also the shape a retry against an already-`pending`
 * intent would call again (idempotent on `intent.idempotencyKey` via the
 * rail's own `execute()` contract).
 */
export async function executeWithdrawal(params: ExecuteWithdrawalParams): Promise<ExecuteWithdrawalResult> {
  const { did, unit, amount, rail, currency, destination } = params;
  const intent = await reserveWithdrawal({ did, unit, amount, rail: rail.name, currency, destination });

  try {
    const { externalRef } = await rail.execute(intent);
    const transactionId = await confirmWithdrawal(intent, externalRef);
    return { intent, externalRef, transactionId };
  } catch (err) {
    await releaseWithdrawal(intent, 'rail_failed').catch((releaseErr) => {
      log.error(
        { err: String(releaseErr), intentId: intent.id },
        'withdrawal reservation release failed after rail error — intent left pending for the reconciliation sweep',
      );
    });
    throw err;
  }
}

/**
 * Statuses a late rail event must never be allowed to promote to
 * `completed`. Both are terminal, reservation-already-resolved-locally
 * states: `failed` (the rail call itself threw, see `releaseWithdrawal`)
 * and `released` (a future operator-approved reconciliation resolution
 * path — not written by this module today, but checked defensively since
 * it is a valid `pay.withdrawal_intents.status` value).
 */
const TERMINAL_NON_COMPLETED_STATUSES = new Set(['failed', 'released']);

/**
 * Webhook fast path (#2172 amendment point 2): resolve a rail-native event
 * to an intent id + external ref via `rail.confirmFromEvent`, then
 * idempotently confirm it. A no-op when the intent is missing, already
 * `completed` (replay), or the event isn't recognized.
 *
 * Never confirms an intent that's already `failed`/`released` locally
 * (#2172 review): a late webhook can otherwise resurrect an already-
 * released reservation as a completed, unbacked withdrawal — the rail
 * reports the transfer completed (e.g. after a local timeout mistakenly
 * treated it as failed), `releaseWithdrawal` already credited the
 * reservation back, and blindly confirming here would flip the intent to
 * `completed` and insert a receipt WITHOUT re-debiting: the ledger nets to
 * zero while real money left, and the reconciler would then see a
 * `completed` intent matching the transfer and call it "matched" — hiding
 * exactly the discrepancy it exists to catch. Instead, this surfaces a
 * `pay.reconciliation.discrepancy` (`external_completed_after_release`)
 * for operator review; applying any compensation is out of scope here.
 */
export async function confirmWithdrawalFromRailEvent(rail: WithdrawRail, payload: unknown): Promise<string | null> {
  const confirmed = await rail.confirmFromEvent(payload);
  if (!confirmed) return null;

  const [row] = await db
    .select()
    .from(withdrawalIntents)
    .where(eq(withdrawalIntents.id, confirmed.intentId))
    .limit(1);
  if (!row) {
    log.warn({ intentId: confirmed.intentId, rail: rail.name }, 'withdrawal webhook confirm: unknown intent id');
    return null;
  }
  if (row.status === 'completed') {
    return confirmed.intentId; // Idempotent replay — already confirmed (by this webhook or the route's own confirm).
  }
  if (TERMINAL_NON_COMPLETED_STATUSES.has(row.status)) {
    // `intentStatus`, not `status` — `LogContext.status` is reserved for a
    // numeric HTTP status code; this is the intent's (string) lifecycle status.
    log.error(
      { intentId: row.id, rail: rail.name, intentStatus: row.status, externalRef: confirmed.externalRef },
      'withdrawal webhook: rail reports a completed transfer for an already-released intent — refusing to resurrect it, emitting a discrepancy instead',
    );
    await emitReconciliationDiscrepancy({
      rail: rail.name,
      externalRef: confirmed.externalRef,
      intentId: row.id,
      amount: row.amount,
      unit: row.unit,
      bucket: 'external_completed_after_release',
      did: row.did,
    });
    return null;
  }

  const intent: WithdrawalIntent = {
    id: row.id,
    did: row.did,
    unit: row.unit as Unit,
    amount: row.amount,
    rail: row.rail,
    idempotencyKey: row.idempotencyKey,
  };
  await confirmWithdrawal(intent, confirmed.externalRef);
  return confirmed.intentId;
}
