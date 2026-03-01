import { pgTable, text, timestamp, jsonb, integer, boolean, index } from 'drizzle-orm/pg-core';

/**
 * Coffee Pages - tip pages linked to DIDs
 */
export const coffeePages = pgTable('coffee_pages', {
  id: text('id').primaryKey(),                                // page_xxx
  did: text('did').notNull().unique(),                        // Owner DID
  handle: text('handle').notNull().unique(),                  // URL slug
  title: text('title').notNull(),                             // "Buy Ryan a coffee"
  bio: text('bio'),                                           // Short description
  avatar: text('avatar'),                                     // Image URL or emoji
  theme: jsonb('theme').default({}),                          // { primaryColor, backgroundColor }
  paymentMethods: jsonb('payment_methods').notNull(),         // { stripe: {...}, solana: {...} }
  presets: integer('presets').array().default([100, 500, 1000]), // cents: $1, $5, $10
  allowCustomAmount: boolean('allow_custom_amount').default(true),
  allowMessages: boolean('allow_messages').default(true),
  isPublic: boolean('is_public').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  handleIdx: index('idx_coffee_pages_handle').on(table.handle),
  didIdx: index('idx_coffee_pages_did').on(table.did),
}));

/**
 * Tips - individual tip transactions
 */
export const tips = pgTable('tips', {
  id: text('id').primaryKey(),                                // tip_xxx
  pageId: text('page_id').references(() => coffeePages.id).notNull(),
  fromDid: text('from_did'),                                  // null for anonymous
  fromName: text('from_name'),                                // Display name (optional)
  amount: integer('amount').notNull(),                        // cents (USD) or lamports (SOL)
  currency: text('currency').notNull().default('USD'),        // USD, SOL, etc.
  message: text('message'),                                   // Optional message
  paymentMethod: text('payment_method').notNull(),            // 'stripe' | 'solana'
  paymentId: text('payment_id').notNull(),                    // Stripe charge ID or Solana tx
  status: text('status').notNull().default('pending'),        // pending, completed, failed
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pageIdx: index('idx_tips_page').on(table.pageId),
  statusIdx: index('idx_tips_status').on(table.status),
  createdIdx: index('idx_tips_created').on(table.createdAt),
}));

// Types
export type CoffeePage = typeof coffeePages.$inferSelect;
export type NewCoffeePage = typeof coffeePages.$inferInsert;
export type Tip = typeof tips.$inferSelect;
export type NewTip = typeof tips.$inferInsert;
