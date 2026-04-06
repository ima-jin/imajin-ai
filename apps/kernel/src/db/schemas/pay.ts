import { pgTable, text, timestamp, jsonb, integer, numeric, boolean, index, primaryKey, pgSchema } from 'drizzle-orm/pg-core';

export const paySchema = pgSchema('pay');

/**
 * Transactions - ledger of all payments through the pay service
 */
export const transactions = paySchema.table('transactions', {
  id: text('id').primaryKey(),                          // tx_xxx
  service: text('service').notNull(),                    // 'coffee' | 'events' | 'inference' | 'shop' | 'transfer'
  type: text('type').notNull(),                          // 'tip' | 'ticket' | 'subscription' | 'query' | 'transfer' | 'topup'
  fromDid: text('from_did'),                             // who paid (null for anonymous/external)
  toDid: text('to_did').notNull(),                       // who received
  amount: numeric('amount', { precision: 20, scale: 8 }).notNull(),
  currency: text('currency').notNull().default('USD'),
  status: text('status').notNull().default('pending'),   // pending | completed | failed | refunded
  source: text('source').notNull().default('fiat'),      // 'fiat' | 'credit' | 'mixed'
  stripeId: text('stripe_id'),                           // payment intent / invoice / checkout session
  metadata: jsonb('metadata').default({}),
  fairManifest: jsonb('fair_manifest'),                  // .fair attribution chain
  batchId: text('batch_id'),                             // for batched settlements
  credentialIssued: boolean('credential_issued').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  fromDidIdx: index('idx_transactions_from_did').on(table.fromDid),
  toDidIdx: index('idx_transactions_to_did').on(table.toDid),
  serviceIdx: index('idx_transactions_service').on(table.service),
  statusIdx: index('idx_transactions_status').on(table.status),
  createdIdx: index('idx_transactions_created').on(table.createdAt),
  stripeIdIdx: index('idx_transactions_stripe_id').on(table.stripeId),
}));

/**
 * Balances - current balance for each DID
 */
export const balances = paySchema.table('balances', {
  did: text('did').primaryKey(),
  cashAmount: numeric('cash_amount', { precision: 20, scale: 8 }).notNull().default('0'),
  creditAmount: numeric('credit_amount', { precision: 20, scale: 8 }).notNull().default('0'),
  currency: text('currency').notNull().default('USD'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

/**
 * Balance Rollups - daily aggregated stats per DID per service
 */
export const balanceRollups = paySchema.table('balance_rollups', {
  did: text('did').notNull(),
  date: timestamp('date', { withTimezone: true, mode: 'date' }).notNull(),
  service: text('service').notNull(),
  earned: numeric('earned', { precision: 20, scale: 8 }).default('0'),
  spent: numeric('spent', { precision: 20, scale: 8 }).default('0'),
  txCount: integer('tx_count').default(0),
}, (table) => ({
  pk: primaryKey({ columns: [table.did, table.date, table.service] }),
  didIdx: index('idx_balance_rollups_did').on(table.did),
  dateIdx: index('idx_balance_rollups_date').on(table.date),
}));

/**
 * Connected Accounts - Stripe Connect accounts linked to DIDs
 */
export const connectedAccounts = paySchema.table('connected_accounts', {
  id: text('id').primaryKey(),                                                    // ca_xxx
  did: text('did').notNull().unique(),                                            // owner DID
  stripeAccountId: text('stripe_account_id').notNull().unique(),                  // acct_xxx
  chargesEnabled: boolean('charges_enabled').notNull().default(false),
  payoutsEnabled: boolean('payouts_enabled').notNull().default(false),
  detailsSubmitted: boolean('details_submitted').notNull().default(false),
  onboardingComplete: boolean('onboarding_complete').notNull().default(false),
  currentlyDue: jsonb('currently_due').default([]),
  eventuallyDue: jsonb('eventually_due').default([]),
  defaultCurrency: text('default_currency').default('CAD'),
  platformFeeBps: integer('platform_fee_bps'),                                    // null = use default (100 = 1%)
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  didIdx: index('idx_connected_accounts_did').on(table.did),
  stripeIdx: index('idx_connected_accounts_stripe').on(table.stripeAccountId),
}));

// Types
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type Balance = typeof balances.$inferSelect;
export type NewBalance = typeof balances.$inferInsert;
export type BalanceRollup = typeof balanceRollups.$inferSelect;
export type NewBalanceRollup = typeof balanceRollups.$inferInsert;
export type ConnectedAccount = typeof connectedAccounts.$inferSelect;
export type NewConnectedAccount = typeof connectedAccounts.$inferInsert;
