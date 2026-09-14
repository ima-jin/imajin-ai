/**
 * Unit-aware ledger helpers over `pay.balances` (#2016).
 *
 * `pay.balances` is row-per-`(did, unit)`: MJN (receipt-backed, withdrawable)
 * and MJNx (emitted, in-platform, never withdrawable, never silently
 * convertible to MJN) are always distinct rows. Every read/write in
 * `apps/kernel`'s pay routes should go through these helpers instead of
 * touching `balances` directly, so "which unit moved" is never ambiguous
 * and cross-unit movement is impossible by construction (#2016 decision 2).
 */
import { db, balances } from '@/src/db';
import { and, eq, gte, sql } from 'drizzle-orm';

/** The two wallet units this ledger understands today. ISO fiat codes are a reserved future unit (see migration 0133) but are not issued by any code path yet. */
export type Unit = 'MJN' | 'MJNx';

export const MJN: Unit = 'MJN';
export const MJNX: Unit = 'MJNx';

/** Default accepted-set for any line item / settlement target that doesn't declare its own — MJN-only, per #2016 decision 2. */
export const ACCEPTED_UNITS_DEFAULT: readonly Unit[] = [MJN];

export interface BalanceRow {
  did: string;
  unit: string;
  amount: string;
  currency: string;
  withdrawalsEnabled: boolean;
  updatedAt: Date | null;
}

/** Minimal shape every caller needs from either `db` or a `db.transaction()` callback's `tx`. */
type Executor = Pick<typeof db, 'select' | 'insert' | 'update'>;

/**
 * A payer/recipient declared unit is not in the accepted set for this line
 * item / settlement target. Returned as a stable 4xx body — never a
 * conversion (#2016 decision 2: "payer unit ∉ accepted → hard error").
 */
export interface UnitNotAcceptedError {
  error: string;
  status: 400;
}

/** Validate `unit` is a known wallet unit; returns a stable 400 body on failure. */
export function assertKnownUnit(unit: string): UnitNotAcceptedError | { unit: Unit } {
  if (unit === MJN || unit === MJNX) return { unit };
  return { error: `Unknown unit '${unit}' — must be one of: ${MJN}, ${MJNX}`, status: 400 };
}

/**
 * Validate `unit` is in `accepted` (defaults to MJN-only). Returns a stable
 * 400 body on mismatch — the caller must never fall back to converting or
 * silently substituting a different unit.
 */
export function assertUnitAccepted(
  unit: string,
  accepted: readonly string[] = ACCEPTED_UNITS_DEFAULT,
): UnitNotAcceptedError | { unit: Unit } {
  const known = assertKnownUnit(unit);
  if ('error' in known) return known;
  if (!accepted.includes(known.unit)) {
    return {
      error: `Unit '${known.unit}' is not accepted here (accepted: ${accepted.join(', ')})`,
      status: 400,
    };
  }
  return known;
}

/** Read a single (did, unit) balance row, or undefined if it doesn't exist yet. */
export async function getBalanceRow(
  executor: Executor,
  did: string,
  unit: Unit,
): Promise<BalanceRow | undefined> {
  const rows = await executor
    .select()
    .from(balances)
    .where(and(eq(balances.did, did), eq(balances.unit, unit)))
    .limit(1);
  return rows[0] as BalanceRow | undefined;
}

/** Read every unit row for a DID (up to one MJN + one MJNx row today). */
export async function getBalances(executor: Executor, did: string): Promise<BalanceRow[]> {
  return (await executor.select().from(balances).where(eq(balances.did, did))) as BalanceRow[];
}

export interface CreditOptions {
  currency?: string;
  withdrawalsEnabled?: boolean;
}

/** Upsert `(did, unit)` += amount. `amount` must be a non-negative numeric string or number. */
export async function creditUnit(
  executor: Executor,
  did: string,
  unit: Unit,
  amount: number | string,
  opts: CreditOptions = {},
): Promise<void> {
  const amountStr = String(amount);
  await executor
    .insert(balances)
    .values({
      did,
      unit,
      amount: amountStr,
      currency: opts.currency ?? 'CAD',
      withdrawalsEnabled: opts.withdrawalsEnabled ?? false,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [balances.did, balances.unit],
      set: {
        amount: sql`${balances.amount} + ${amountStr}`,
        updatedAt: new Date(),
      },
    });
}

export interface DebitOptions {
  /** Clamp the result at 0 instead of allowing a negative balance (matches refund.ts's prior GREATEST(...,0) behavior). */
  clampAtZero?: boolean;
}

/** Debit `(did, unit)` -= amount. Does not check sufficiency — callers must verify balance first via `getBalanceRow`. */
export async function debitUnit(
  executor: Executor,
  did: string,
  unit: Unit,
  amount: number | string,
  opts: DebitOptions = {},
): Promise<void> {
  const amountStr = String(amount);
  const newAmount = opts.clampAtZero
    ? sql`GREATEST(${balances.amount} - ${amountStr}, 0)`
    : sql`${balances.amount} - ${amountStr}`;
  await executor
    .update(balances)
    .set({ amount: newAmount, updatedAt: new Date() })
    .where(and(eq(balances.did, did), eq(balances.unit, unit)));
}

/** Numeric helper: read a balance row's amount as a number, defaulting to 0 when the row doesn't exist. */
export function amountOf(row: BalanceRow | undefined): number {
  return row ? Number.parseFloat(row.amount) : 0;
}

export interface DebitIfSufficientResult {
  ok: boolean;
  /** The updated row, only present when `ok` is true. */
  row?: BalanceRow;
}

/**
 * Debit `(did, unit)` -= amount, but ONLY if the current balance is
 * >= amount — as a single guarded conditional
 * `UPDATE ... WHERE amount >= $x RETURNING *`.
 *
 * This is the atomicity primitive funded-transfer routes (#2018: gift,
 * event-topup) must use instead of "read the balance, compare in JS, then
 * issue an unconditional `debitUnit`": that two-step shape is a TOCTOU
 * race — two concurrent callers can both read a stale sufficient balance
 * and both proceed to debit, driving the balance negative, which is
 * exactly the unbacked mint #2018 exists to forbid. A single guarded
 * UPDATE is atomic at the database row level: the sufficiency check and
 * the debit are the same statement, so at most one concurrent caller can
 * ever succeed once the balance can no longer cover both.
 *
 * Returns `{ ok: false }` (zero rows matched/updated) when the balance is
 * insufficient — including when the `(did, unit)` row doesn't exist yet,
 * which reads as a balance of 0. Callers must run this inside
 * `db.transaction()` so they can roll back everything else on `ok: false`.
 */
export async function debitUnitIfSufficient(
  executor: Executor,
  did: string,
  unit: Unit,
  amount: number | string,
): Promise<DebitIfSufficientResult> {
  const amountStr = String(amount);
  const rows = await executor
    .update(balances)
    .set({ amount: sql`${balances.amount} - ${amountStr}`, updatedAt: new Date() })
    .where(and(eq(balances.did, did), eq(balances.unit, unit), gte(balances.amount, amountStr)))
    .returning();
  const row = (rows as BalanceRow[])[0];
  return row ? { ok: true, row } : { ok: false };
}

/**
 * Thrown by `debitFundedLegs` when a leg's balance is insufficient. Callers
 * should catch this specifically and map it to a 402 — never retry as a
 * mint, and never swallow it into a generic 500.
 */
export class InsufficientBalanceError extends Error {
  readonly unit: Unit;
  constructor(unit: Unit) {
    super(`Insufficient ${unit} balance`);
    this.name = 'InsufficientBalanceError';
    this.unit = unit;
  }
}

export interface FundedLeg {
  unit: Unit;
  amount: number;
}

/**
 * Debit `did` for every nonzero leg in `legs`, each via its own guarded
 * conditional UPDATE (`debitUnitIfSufficient`) — the shared "assert funded
 * in these units and debit them" primitive for #2018's funded-transfer
 * routes (gift, event-topup), so the guard logic and its atomicity
 * guarantee live in one place instead of being duplicated per route.
 *
 * Legs with `amount <= 0` are skipped (nothing to debit). Throws
 * `InsufficientBalanceError` on the first underfunded leg and does not
 * attempt any later leg. Must be called from inside `db.transaction()`:
 * the throw rolls back every earlier leg's debit in the same transaction
 * (and anything else committed there) instead of leaving a partial,
 * unbacked credit anywhere.
 */
export async function debitFundedLegs(
  executor: Executor,
  did: string,
  legs: readonly FundedLeg[],
): Promise<void> {
  for (const leg of legs) {
    if (leg.amount <= 0) continue;
    const result = await debitUnitIfSufficient(executor, did, leg.unit, leg.amount);
    if (!result.ok) {
      throw new InsufficientBalanceError(leg.unit);
    }
  }
}
