/**
 * `rail` + `external_ref` on `pay.transactions` (#2176, step 4 of the #2173
 * pay-rail boundary).
 *
 * A transaction row records WHICH rail moved the money (`rail`) and that
 * rail's opaque reference for it (`external_ref`). `stripe_id` survives as a
 * DEPRECATED ALIAS of `external_ref` until step 5 (#2650) drops it:
 *
 *   - readers key on `external_ref` (via {@link whereExternalRef}) — never `stripe_id`;
 *   - writers set both columns (via {@link externalRefColumns}), so the DROP
 *     in #2650 is safe: nothing reads the alias and nothing is left holding a
 *     value only the alias carries.
 *
 * Lookups pair `rail` with `external_ref` because the supporting index is
 * `(rail, external_ref)` (`idx_transactions_rail_external_ref`) — an
 * `external_ref`-only predicate could not use it.
 */
import { and, eq, type SQL } from 'drizzle-orm';
import { transactions } from '@/src/db';

/** Rail name stored in `pay.transactions.rail` for Stripe-backed rows. */
export const STRIPE_RAIL = 'stripe';

/**
 * The columns a writer spreads into a `pay.transactions` insert so `rail`,
 * `external_ref` and the deprecated `stripe_id` alias always agree.
 */
export function externalRefColumns(
  externalRef: string,
  rail: string = STRIPE_RAIL,
): { rail: string; externalRef: string; stripeId: string } {
  return { rail, externalRef, stripeId: externalRef };
}

/** `WHERE` predicate matching the transaction a rail knows by `externalRef`. */
export function whereExternalRef(externalRef: string, rail: string = STRIPE_RAIL): SQL {
  return and(eq(transactions.rail, rail), eq(transactions.externalRef, externalRef)) as SQL;
}
