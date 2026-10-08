import { text, timestamp, jsonb, integer, numeric, boolean, index, uniqueIndex, primaryKey, pgSchema } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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
  currency: text('currency').notNull().default('CAD'),
  // #2016: the wallet unit this row moves — 'MJN' (receipt-backed,
  // withdrawable) | 'MJNx' (emitted, in-platform, never withdrawable) | a
  // reserved ISO-4217-shaped code for a future fiat-native row. Distinct
  // from `currency` above, which stays the fiat reference/denomination.
  unit: text('unit').notNull().default('MJN'),
  // #2016: provenance kind — 'receipt' (backed by a rail receipt, minted or
  // burned), 'emission' (protocol mint against an attestation), or
  // 'transfer' (internal ledger movement, no new receipt or mint).
  sourceKind: text('source_kind').notNull().default('transfer'),
  // #2016: the auth.attestations row an emission was minted against. Only
  // ever populated for sourceKind='emission' rows going forward — historical
  // rows and non-emission rows are NULL (never captured before this issue).
  attestationId: text('attestation_id'),
  // #2017: provenance of an emission — the `kernel.bus_chain_configs` row id and
  // row `version` whose schedule minted it. With `attestationId` above, every
  // emission row is traceable to (attestation id, config version). NULL on
  // non-emission rows.
  emissionConfigId: text('emission_config_id'),
  emissionConfigVersion: integer('emission_config_version'),
  // #2017: caller-supplied dedupe key (the bus `mjn` reactor sends
  // `emission:<attestationId>:<ruleIndex>:<role>`). Partial UNIQUE index below,
  // so a retried emission can never credit twice. NULL = not idempotent.
  idempotencyKey: text('idempotency_key'),
  status: text('status').notNull().default('pending'),   // pending | completed | failed | refunded | partially_refunded
  source: text('source').notNull().default('fiat'),      // 'fiat' | 'credit' | 'mixed'
  // #2176: which rail moved the money ('stripe' | 'emt' | ...) and that rail's opaque reference for it.
  // The former `stripe_id` column was dropped in #2650 (migration 0181) — `externalRef` is the only reference.
  rail: text('rail'),
  externalRef: text('external_ref'),                     // payment intent / invoice / checkout session (Stripe today)
  metadata: jsonb('metadata').default({}),
  fairManifest: jsonb('fair_manifest'),                  // .fair attribution chain
  batchId: text('batch_id'),                             // for batched settlements
  credentialIssued: boolean('credential_issued').default(false),
  // #2642: app binding for app-authenticated checkout (migration 0182). `appDid` is the
  // registered app whose app-service token created the checkout — NULL for user/anonymous
  // checkout and every legacy row, which are never settleable via the app path.
  // `payeeManifest` is the manifest the app declared at checkout; settle verifies the
  // posted chain against it. `settledAt`/`settleBatchId` are the settled marker (set
  // atomically with the settlement, so a second settle is an idempotent replay).
  appDid: text('app_did'),
  payeeManifest: jsonb('payee_manifest'),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  settleBatchId: text('settle_batch_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  fromDidIdx: index('idx_transactions_from_did').on(table.fromDid),
  appDidIdx: index('idx_transactions_app_did').on(table.appDid).where(sql`${table.appDid} IS NOT NULL`),
  toDidIdx: index('idx_transactions_to_did').on(table.toDid),
  serviceIdx: index('idx_transactions_service').on(table.service),
  statusIdx: index('idx_transactions_status').on(table.status),
  createdIdx: index('idx_transactions_created').on(table.createdAt),
  railExternalRefIdx: index('idx_transactions_rail_external_ref').on(table.rail, table.externalRef),
  unitIdx: index('idx_transactions_unit').on(table.unit),
  attestationIdIdx: index('idx_transactions_attestation_id').on(table.attestationId),
  idempotencyKeyUniq: uniqueIndex('uniq_transactions_idempotency_key').on(table.idempotencyKey).where(sql`${table.idempotencyKey} IS NOT NULL`),
}));

/**
 * Balances - one row per (did, unit) (#2016).
 *
 * Before #2016 this table had one row per DID with `cashAmount` (fiat,
 * withdrawable) and `creditAmount` (emitted, spendable) sharing one
 * `currency` column. It is now row-per-(did, unit): a DID has up to one
 * 'MJN' row (receipt-backed, withdrawable) and one 'MJNx' row (emitted,
 * in-platform, never withdrawable, never silently convertible to MJN).
 * See migrations 0133/0134 for the additive backfill + destructive
 * column-drop split.
 */
export const balances = paySchema.table('balances', {
  did: text('did').notNull(),
  // 'MJN' | 'MJNx' | a reserved ISO-4217-shaped code (ADD'l fiat-native unit,
  // not populated today). See migration 0133's CHECK constraint.
  unit: text('unit').notNull(),
  amount: numeric('amount', { precision: 20, scale: 8 }).notNull().default('0'),
  // Fiat reference currency this balance is denominated/pegged against.
  // Meaningful on the MJN row; carried on the MJNx row too for schema
  // simplicity but not used in any MJNx code path.
  currency: text('currency').notNull().default('CAD'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  // Only ever true on the MJN row — MJNx can never be withdrawn regardless
  // of this flag's value on that row.
  withdrawalsEnabled: boolean('withdrawals_enabled').notNull().default(false),
}, (table) => ({
  pk: primaryKey({ columns: [table.did, table.unit] }),
  unitIdx: index('idx_balances_unit').on(table.unit),
}));

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

/**
 * Fee Ledger - per-entry attribution from .fair manifest subdivision
 */
export const feeLedger = paySchema.table('fee_ledger', {
  id: text('id').primaryKey(),
  transactionId: text('transaction_id').notNull(),
  recipientDid: text('recipient_did').notNull(),
  role: text('role').notNull(),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull(),
  status: text('status').notNull().default('accrued'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  txIdx: index('idx_fee_ledger_tx').on(table.transactionId),
  recipientIdx: index('idx_fee_ledger_recipient').on(table.recipientDid, table.status),
}));

/**
 * Withdrawal Requests - manual EMT withdrawal requests from users
 */
export const withdrawalRequests = paySchema.table('withdrawal_requests', {
  id: text('id').primaryKey(),
  did: text('did').notNull(),
  amount: numeric('amount', { precision: 20, scale: 8 }).notNull(),
  currency: text('currency').notNull().default('CAD'),
  emtEmail: text('emt_email').notNull(),
  status: text('status').notNull().default('requested'),
  adminNotes: text('admin_notes'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
}, (table) => ({
  didIdx: index('idx_withdrawal_requests_did').on(table.did),
  statusIdx: index('idx_withdrawal_requests_status').on(table.status),
}));

export type WithdrawalRequest = typeof withdrawalRequests.$inferSelect;
export type NewWithdrawalRequest = typeof withdrawalRequests.$inferInsert;

/**
 * Payment Requests - invoice / money request as a first-class receivable on
 * the business DID (#2206/#2207).
 *
 * `kind`/`status` are plain `text` + a CHECK constraint (migration
 * 0143_pay_payment_requests.sql) rather than a Postgres native ENUM,
 * matching the convention already used by `withdrawal_intents.status`
 * above (migration 0142) — additive-only, no `ALTER TYPE` needed to widen.
 *
 * Exactly one of `recipientDid` / `recipientStubId` must be set at create
 * time (enforced by the migration's CHECK constraint AND, redundantly, at
 * the route layer — see #2207's "document the choice" note). Once a stub
 * claims, `recipientStubId` resolves to `recipientDid` via a
 * `payment_request.recipient_claimed` event (#2210, out of scope here).
 */
export const paymentRequestKindValues = ['invoice', 'request'] as const;
export type PaymentRequestKind = typeof paymentRequestKindValues[number];

// #2665: `emt_pending` = the payer chose to pay by Interac e-Transfer and the issuer has not yet confirmed receipt (migration 0173).
export const paymentRequestStatusValues = ['issued', 'emt_pending', 'paid', 'settled_manual', 'void'] as const;
export type PaymentRequestStatus = typeof paymentRequestStatusValues[number];

export const paymentRequests = paySchema.table('payment_request', {
  id: text('id').primaryKey(),                           // pr_xxx
  kind: text('kind').notNull().default('invoice'),        // 'invoice' | 'request'
  issuerDid: text('issuer_did').notNull(),                // the business DID owed
  payeeAccount: text('payee_account').notNull(),          // Stripe connected account id / business DID
  recipientDid: text('recipient_did'),                    // NULLABLE — exactly one of this / recipientStubId
  recipientStubId: text('recipient_stub_id'),             // NULLABLE — resolved to recipientDid on claim
  // #2656: the DID the payer chose to pay as (own DID, or an org/business DID they control). NULL = no choice — settles as the recipient. Migration 0175.
  paidByDid: text('paid_by_did'),
  lineItems: jsonb('line_items').notNull(),                // Array<{ name, description?, amount, quantity }>
  currency: text('currency').notNull().default('CAD'),
  // #2421: totalAmount is the GRAND total (subtotalAmount + taxTotalAmount, exactly);
  // see migrations/0168_pay_payment_request_tax_amounts.sql.
  totalAmount: integer('total_amount').notNull(),          // minor units, per packages/money
  subtotalAmount: integer('subtotal_amount').notNull(),    // pre-tax line-items sum (the .fair tax basis), minor units
  taxTotalAmount: integer('tax_total_amount').notNull().default(0), // Σ fair_manifest.taxes[].amount, minor units
  fairManifest: jsonb('fair_manifest').notNull(),          // .fair manifest — every payment_request carries one
  dueAt: timestamp('due_at', { withTimezone: true }),
  allowOnPlatform: boolean('allow_on_platform').notNull().default(true),
  status: text('status').notNull().default('issued'),      // issued | emt_pending | paid | settled_manual | void
  settlementRef: jsonb('settlement_ref'),                  // stripe session id | mjnx tx | manual {note, asserted_by}
  contentHash: text('content_hash').notNull(),              // attestations bind this, never bytes
  // #2210: opaque, unguessable "pay link" handle — GET
  // /pay/api/payment-requests/by-handle/:handle keys off this rather than
  // the internal id, so an unauthenticated payer (no DID/session yet, per
  // the pay-first ordering) can read the minimum needed to pay without any
  // recipient PII ever entering the response.
  payHandle: text('pay_handle').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  issuerDidIdx: index('idx_payment_request_issuer_did').on(table.issuerDid),
  recipientDidIdx: index('idx_payment_request_recipient_did').on(table.recipientDid),
  recipientStubIdIdx: index('idx_payment_request_recipient_stub_id').on(table.recipientStubId),
  statusIdx: index('idx_payment_request_status').on(table.status),
  payHandleIdx: index('idx_payment_request_pay_handle').on(table.payHandle),
}));

export type PaymentRequest = typeof paymentRequests.$inferSelect;
export type NewPaymentRequest = typeof paymentRequests.$inferInsert;

/**
 * Withdrawal Intents - reserve -> external -> confirm durability record for
 * the withdraw path (#2172).
 *
 * Rail-agnostic per #2172's design amendment: no Stripe-named column.
 * `rail` names the WithdrawRail adapter that owns `externalRef`'s meaning
 * (opaque to the kernel). The intent id doubles as the rail's native
 * idempotency key, so a retry against an already-reserved intent can never
 * produce a second external transfer. Distinct from `withdrawalRequests`
 * above, which is the manual EMT withdrawal flow (migration 0030) — a
 * different rail, not a superset/subset of this table.
 */
export const withdrawalIntents = paySchema.table('withdrawal_intents', {
  id: text('id').primaryKey(),
  did: text('did').notNull(),
  unit: text('unit').notNull(),
  amount: numeric('amount', { precision: 20, scale: 8 }).notNull(),
  rail: text('rail').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  externalRef: text('external_ref'),
  status: text('status').notNull().default('pending'),   // pending | completed | failed | released
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  didIdx: index('idx_pay_withdrawal_intents_did').on(table.did),
  statusIdx: index('idx_pay_withdrawal_intents_status').on(table.status),
  railIdx: index('idx_pay_withdrawal_intents_rail').on(table.rail),
  externalRefIdx: index('idx_pay_withdrawal_intents_external_ref').on(table.externalRef),
}));

/**
 * Reconciliation Watermarks - one row per registered WithdrawRail, tracking
 * how far the reconciliation cron sweep has scanned that rail's transfer
 * feed (#2172). Prevents both re-scanning a rail's entire history on every
 * run and silently skipping the window between runs.
 */
export const reconciliationWatermarks = paySchema.table('reconciliation_watermarks', {
  rail: text('rail').primaryKey(),
  lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export type WithdrawalIntentRow = typeof withdrawalIntents.$inferSelect;
export type NewWithdrawalIntentRow = typeof withdrawalIntents.$inferInsert;
export type ReconciliationWatermark = typeof reconciliationWatermarks.$inferSelect;
export type NewReconciliationWatermark = typeof reconciliationWatermarks.$inferInsert;

// Types
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type Balance = typeof balances.$inferSelect;
export type NewBalance = typeof balances.$inferInsert;
export type BalanceRollup = typeof balanceRollups.$inferSelect;
export type NewBalanceRollup = typeof balanceRollups.$inferInsert;
export type ConnectedAccount = typeof connectedAccounts.$inferSelect;
export type NewConnectedAccount = typeof connectedAccounts.$inferInsert;
