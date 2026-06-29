import { pgSchema, text, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Consent grants — DB-backed store for the broker pipeline (Issue #1049).
 *
 * Each row is a grant from `subject` to a `grantedTo` DID (or `*` wildcard)
 * for a `purpose`, releasing `allowedFields`. The consent reactor resolves
 * active, non-expired grants here instead of the hardcoded fail-closed
 * defaults.
 *
 * `grantedToClass` is reserved for reach-ring class grants (#1189) and is
 * NULL for direct/wildcard grants.
 */
export const consentSchema = pgSchema('kernel');

export const consentGrants = consentSchema.table('consent_grants', {
  id: text('id').primaryKey(),
  subject: text('subject').notNull(),                               // owner DID granting consent
  grantedTo: text('granted_to'),                                    // specific DID or '*'; NULL when grantedToClass is set
  grantedToClass: text('granted_to_class'),                         // 'connections' | 'one_degree' | 'strangers' (future: #1189)
  purpose: text('purpose').notNull(),
  allowedFields: text('allowed_fields').array().notNull(),
  mode: text('mode').notNull().default('attestation'),              // 'attestation' | 'raw'
  status: text('status').notNull().default('active'),               // 'active' | 'revoked'
  consentRef: text('consent_ref').notNull(),                        // stable reference ID for audit trail
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  subjectIdx: index('idx_consent_grants_subject').on(table.subject),
  lookupIdx: index('idx_consent_grants_lookup')
    .on(table.subject, table.grantedTo, table.purpose)
    .where(sql`${table.status} = 'active'`),
  expiresIdx: index('idx_consent_grants_expires')
    .on(table.expiresAt)
    .where(sql`${table.expiresAt} IS NOT NULL`),
}));

export type ConsentGrant = typeof consentGrants.$inferSelect;
export type NewConsentGrant = typeof consentGrants.$inferInsert;
