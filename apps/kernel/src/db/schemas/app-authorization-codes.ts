import { text, timestamp } from 'drizzle-orm/pg-core';
import { authSchema } from './auth';

/** Retained single-use sign-in records; plaintext codes never enter storage. */
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
});
