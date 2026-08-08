import { pgSchema, text, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * QuickBooks `realmId → { ownerDid, appDid }` reverse-lookup index (xprize #35).
 *
 * The Intuit `realmId` (QBO company id) is sealed inside each supplier's token
 * blob (`quickbooks-oauth:${ownerDid}`), which is only readable forward (owner
 * → realmId). A webhook delivery from Intuit carries only `realmId`, so the
 * kernel needs the reverse direction — realmId → ownerDid — without unsealing
 * every supplier's vault entry to find a match.
 *
 * `appDid` is the DID whose sealed `quickbooks-config:${appDid}` owns the
 * Intuit client credentials (and, per xprize #35, the webhook verifier token)
 * used for this owner's connection — i.e. the `configDid` passed to
 * `exchangeCodeAndStore` (#1704), or `ownerDid` itself for the original
 * BYO-app model. Recording it here lets the webhook and cron-reconcile paths
 * resolve both halves of `settlePaidInvoices(ownerDid, appDid)` from a single
 * row keyed by `realmId`.
 *
 * One row per `realmId`. A supplier reconnecting — either re-authorizing the
 * same QBO company or connecting a different one — upserts this row so it
 * always reflects the current mapping (never a stale one).
 */
export const quickbooksSchema = pgSchema('kernel');

export const quickbooksRealmIndex = quickbooksSchema.table('quickbooks_realm_index', {
  realmId: text('realm_id').primaryKey(),
  ownerDid: text('owner_did').notNull(),
  appDid: text('app_did').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  ownerIdx: index('idx_quickbooks_realm_index_owner').on(table.ownerDid),
}));

export type QuickBooksRealmIndexRow = typeof quickbooksRealmIndex.$inferSelect;
export type NewQuickBooksRealmIndexRow = typeof quickbooksRealmIndex.$inferInsert;
