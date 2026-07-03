import { pgSchema, text, timestamp, index, boolean } from 'drizzle-orm/pg-core';

/**
 * Broker audit log — append-only record of every broker release and rejection.
 * Written by the audit reactor (packages/bus) for every broker() call.
 * Queried by GET /api/broker/audit (Issue #1050).
 */
export const brokerAuditSchema = pgSchema('kernel');

export const brokerAuditLog = brokerAuditSchema.table('broker_audit_log', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),                                    // 'release' | 'rejection'
  requester: text('requester').notNull(),
  subject: text('subject').notNull(),
  purpose: text('purpose').notNull(),
  scope: text('scope').notNull(),
  fieldsRequested: text('fields_requested').array().notNull(),
  fieldsReleased: text('fields_released').array(),                 // null for rejections
  status: text('status').notNull(),                                // 'RELEASED' | 'DENIED'
  mode: text('mode'),                                              // 'attestation' | 'raw'
  consentRef: text('consent_ref'),
  reason: text('reason'),                                          // rejection reason
  shadow: boolean('shadow').notNull().default(false),              // true = shadow-mode (advisory) decision (#1231)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  subjectIdx: index('idx_broker_audit_subject').on(table.subject, table.createdAt),
  requesterIdx: index('idx_broker_audit_requester').on(table.requester, table.createdAt),
}));

export type BrokerAuditEntry = typeof brokerAuditLog.$inferSelect;
export type NewBrokerAuditEntry = typeof brokerAuditLog.$inferInsert;
