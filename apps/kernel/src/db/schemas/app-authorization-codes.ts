import { sql } from 'drizzle-orm';
import { index, text, timestamp } from 'drizzle-orm/pg-core';
import { authSchema } from './auth';

/** Single-use sign-in records retained through a short grace window; hashes only. */
export const appAuthorizationCodes = authSchema.table('app_authorization_codes', {
  codeHash: text('code_hash').primaryKey(),
  appDid: text('app_did').notNull(),
  subjectDid: text('subject_did').notNull(),
  attestationId: text('attestation_id').notNull(),
  callbackUrl: text('callback_url').notNull(),
  state: text('state').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_app_authorization_codes_retention')
    .on(sql`coalesce(${table.consumedAt}, ${table.expiresAt})`),
]);
