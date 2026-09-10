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
import { and, eq, sql } from 'drizzle-orm';

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
