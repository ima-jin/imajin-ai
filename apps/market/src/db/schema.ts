import { pgTable, text, timestamp, jsonb, integer, boolean, index, pgSchema } from 'drizzle-orm/pg-core';

export const marketSchema = pgSchema('market');

/**
 * Market Listings - items and services for sale
 */
export const listings = marketSchema.table('listings', {
  id: text('id').primaryKey(),                                          // lst_xxx
  sellerDid: text('seller_did').notNull(),                             // Seller DID
  title: text('title').notNull(),                                       // Listing title
  description: text('description'),                                     // Full description
  price: integer('price').notNull(),                                    // Smallest currency unit
  currency: text('currency').default('CAD'),                           // ISO 4217
  category: text('category'),                                           // Freeform category
  images: jsonb('images').default([]),                                  // Array of media asset IDs (max 8)
  quantity: integer('quantity').default(1),                             // null = unlimited/service
  status: text('status').default('active'),                            // active | paused | sold | removed
  sellerTier: text('seller_tier').notNull().default('public_offplatform'), // public_offplatform | public_onplatform | trust_gated
  contactInfo: jsonb('contact_info'),                                   // Required for Tier 1: { phone, email, whatsapp }
  trustThreshold: jsonb('trust_threshold'),                             // For Tier 3/Phase 2
  rangeKm: integer('range_km').default(50),                            // Discovery radius in km
  metadata: jsonb('metadata').default({}),                             // tags, condition, etc.
  fairManifest: jsonb('fair_manifest'),                                // .fair attribution for the sale
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  sellerDidIdx: index('idx_market_listings_seller_did').on(table.sellerDid),
  categoryStatusIdx: index('idx_market_listings_category_status').on(table.category, table.status),
  statusCreatedIdx: index('idx_market_listings_status_created').on(table.status, table.createdAt),
}));

/**
 * Market Disputes - Phase 2 dispute resolution
 */
export const disputes = marketSchema.table('disputes', {
  id: text('id').primaryKey(),
  listingId: text('listing_id').references(() => listings.id).notNull(),
  transactionId: text('transaction_id').notNull(),
  buyerDid: text('buyer_did').notNull(),
  sellerDid: text('seller_did').notNull(),
  type: text('type').notNull(),                                         // chargeback | not_received | not_as_described
  status: text('status').notNull().default('open'),                    // open | evidence | resolved
  resolution: text('resolution'),                                       // buyer_favor | seller_favor | split | inconclusive
  buyerEvidence: jsonb('buyer_evidence').default([]),
  sellerEvidence: jsonb('seller_evidence').default([]),
  evidenceDeadline: timestamp('evidence_deadline', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

/**
 * Seller Settings - profile integration preferences
 */
export const sellerSettings = marketSchema.table('seller_settings', {
  did: text('did').primaryKey(),
  showMarketItems: boolean('show_market_items').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// Types
export type Listing = typeof listings.$inferSelect;
export type NewListing = typeof listings.$inferInsert;
export type Dispute = typeof disputes.$inferSelect;
export type NewDispute = typeof disputes.$inferInsert;
export type SellerSettings = typeof sellerSettings.$inferSelect;
export type NewSellerSettings = typeof sellerSettings.$inferInsert;
