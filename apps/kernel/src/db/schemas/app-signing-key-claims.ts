import { pgSchema, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * App signing-key claims (#2411, migration 0165_app_signing_key_claims.sql).
 *
 * One row per issued claim code — the one-time, short-TTL bootstrap
 * credential a third-party app exchanges at first boot for its own
 * app-signing-key delegation grant (see
 * `apps/kernel/src/lib/apps/signing-key-claims.ts`). Never holds secret
 * material: `codeHash` is a SHA-256 digest of the plaintext code, which is
 * generated in-process and returned exactly once in the operator-approval
 * decision response.
 */
export const kernelAppSigningKeyClaimsSchema = pgSchema('kernel');

export const appSigningKeyClaims = kernelAppSigningKeyClaimsSchema.table('app_signing_key_claims', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull(),
  appDid: text('app_did').notNull(),
  /** The `kernel.vault_delegation_grants.id` this claim authorizes the app to fetch. */
  grantId: text('grant_id').notNull(),
  /** SHA-256 hex digest of the plaintext claim code — never the code itself. */
  codeHash: text('code_hash').notNull(),
  status: text('status').notNull().default('pending'), // 'pending' | 'claimed' | 'expired'
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  /** Best-effort host hint the claiming app reported (e.g. hostname) — for the /jin timeline, not authorization. */
  claimedByHost: text('claimed_by_host'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  codeHashUniq: uniqueIndex('uniq_app_signing_key_claims_code_hash').on(table.codeHash),
  appDidStatusIdx: index('idx_app_signing_key_claims_app_did_status').on(table.appDid, table.status),
  statusIdx: index('idx_app_signing_key_claims_status').on(table.status),
}));

export type AppSigningKeyClaimRow = typeof appSigningKeyClaims.$inferSelect;
export type NewAppSigningKeyClaimRow = typeof appSigningKeyClaims.$inferInsert;

/** Literal union for app_signing_key_claims.status (#2411). */
export type AppSigningKeyClaimStatus = 'pending' | 'claimed' | 'expired';
