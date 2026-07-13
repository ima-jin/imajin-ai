import { text, timestamp, pgSchema } from 'drizzle-orm/pg-core';

const contactSchema = pgSchema('profile');

/**
 * Contact hashes — SHA-256 of normalised (lowercased, trimmed) email/phone.
 *
 * Used for federation Sybil detection only. Hashes are never used to disclose
 * contact info; the plaintext lives exclusively in the vault.
 *
 * One row per DID; upserted whenever the owner saves or removes contact info.
 * Nulled fields mean no contact info of that type is stored.
 */
export const contactHashes = contactSchema.table('contact_hashes', {
  did: text('did').primaryKey(),
  emailHash: text('email_hash'),
  phoneHash: text('phone_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type ContactHash = typeof contactHashes.$inferSelect;
export type NewContactHash = typeof contactHashes.$inferInsert;
