import { pgSchema, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Stripe webhook routing index (#1785).
 *
 * BYO-restricted-key connector: each identity provisions their OWN Stripe
 * webhook endpoint (`POST /v1/webhook_endpoints`, called with their own
 * restricted key) rather than sharing the platform's Stripe Connect webhook.
 * Multiple owners' endpoints can legitimately point at the exact same ingress
 * URL, and a direct-account Stripe event carries no owner-identifying field —
 * unlike a Connect event's `account`, or QuickBooks' `realmId` — so the
 * kernel cannot recover which owner's signing secret to verify a delivery
 * against from the payload alone.
 *
 * The fix is the same shape as `quickbooks_realm_index` (#88, xprize #35):
 * mint an opaque `routing_id` at connect time, embed it in the webhook URL
 * we register with Stripe (`/stripe/api/webhook/{routingId}`), and index it
 * here so a delivery resolves back to `ownerDid` before anything is trusted.
 * `endpointId` is Stripe's own `we_...` object id, kept so disconnect can
 * deprovision the exact endpoint it created.
 *
 * One row per owner: reconnecting (key rotation) upserts by `ownerDid` so a
 * stale routing id from a superseded endpoint can never resolve again.
 */
export const stripeSchema = pgSchema('kernel');

export const stripeWebhookIndex = stripeSchema.table('stripe_webhook_index', {
  /** Opaque id embedded in the registered webhook URL — the delivery-time lookup key. */
  routingId: text('routing_id').primaryKey(),
  ownerDid: text('owner_did').notNull(),
  /** Stripe's `we_...` webhook endpoint object id, for deprovisioning on disconnect. */
  endpointId: text('endpoint_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  ownerUnique: uniqueIndex('uniq_stripe_webhook_index_owner').on(table.ownerDid),
}));

export type StripeWebhookIndexRow = typeof stripeWebhookIndex.$inferSelect;
export type NewStripeWebhookIndexRow = typeof stripeWebhookIndex.$inferInsert;
