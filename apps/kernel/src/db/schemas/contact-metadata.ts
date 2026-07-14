import { pgSchema, text, timestamp, unique, index } from 'drizzle-orm/pg-core';

/**
 * Contact metadata — per-subject, per-recipient labels and relationship types
 * for the disclosure dashboard phase 2 (Issue #1220).
 *
 * One row per (subject, did) pair. The subject sets a human-readable label
 * (e.g. "Acme Restaurant") and a relationship category so the By Contact tab
 * can group recipients instead of showing a flat DID list.
 *
 * Relationship types mirror the four categories from the issue:
 *   'business' | 'group' | 'person' | 'collective'
 *
 * Contacts with no metadata row (or null relationship_type) appear in "Other".
 */
export const contactMetadataSchema = pgSchema('kernel');

export const contactMetadata = contactMetadataSchema.table(
  'contact_metadata',
  {
    id: text('id').primaryKey(),
    subject: text('subject').notNull(),   // DID of the data subject (owner)
    did: text('did').notNull(),            // DID of the contact (recipient)
    label: text('label'),                  // free-text display name, e.g. "Acme Restaurant"
    relationshipType: text('relationship_type'), // 'business' | 'group' | 'person' | 'collective'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    subjectDidUnique: unique('uq_contact_metadata_subject_did').on(table.subject, table.did),
    subjectIdx: index('idx_contact_metadata_subject').on(table.subject),
  }),
);

export type ContactMetadata = typeof contactMetadata.$inferSelect;
export type NewContactMetadata = typeof contactMetadata.$inferInsert;
