/**
 * `rail` + `external_ref` on `pay.transactions` (#2176, step 4 of the #2173
 * pay-rail boundary; #2650 is step 5).
 *
 * A transaction row records WHICH rail moved the money (`rail`) and that
 * rail's opaque reference for it (`external_ref`). These two columns are the
 * ONLY place a rail reference lives on the ledger: the Stripe-named
 * `stripe_id` column (and its index) was dropped by migration 0181 (#2650).
 *
 *   - readers key on `external_ref` (via {@link whereExternalRef});
 *   - writers set `rail` + `external_ref` (via {@link externalRefColumns}).
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
 * Rail name stored in `pay.transactions.rail` for a charge that ran on an
 * issuer's OWN Stripe account through the BYO restricted-key connector (#2754).
 * Distinct from `'stripe'` (the platform account) on purpose: the platform's
 * `rail = 'stripe'` rows are the ones its webhook handlers and reconciliation
 * act on, and a BYO charge must never be mistaken for one.
 */
export const STRIPE_BYO_RAIL = 'stripe-byo';

/**
 * The columns a writer spreads into a `pay.transactions` insert so a row
 * always carries both its `rail` and that rail's `external_ref`.
 */
export function externalRefColumns(
  externalRef: string,
  rail: string = STRIPE_RAIL,
): { rail: string; externalRef: string } {
  return { rail, externalRef };
}

/** `WHERE` predicate matching the transaction a rail knows by `externalRef`. */
export function whereExternalRef(externalRef: string, rail: string = STRIPE_RAIL): SQL {
  return and(eq(transactions.rail, rail), eq(transactions.externalRef, externalRef)) as SQL;
}
