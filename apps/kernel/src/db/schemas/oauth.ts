import { text, timestamp, index } from 'drizzle-orm/pg-core';
import { authSchema } from './auth';

/**
 * OAuth 2.1 authorization codes (#1166 MCP connector).
 *
 * Short-lived, single-use, PKCE-bound. The code itself is never stored — only
 * its SHA-256 hash. Bound to the resource-owner DID, the pre-registered client,
 * the exact redirect_uri, the granted scope, and the app.authorized attestation
 * that backs the grant (so /auth/apps + /api/auth/revoke remain the revoke story).
 *
 * Lives in the existing `auth` Postgres schema (authSchema) alongside tokens.
 */
export const oauthAuthorizationCodes = authSchema.table('oauth_authorization_codes', {
  id: text('id').primaryKey(),                                   // oac_<nanoid>
  codeHash: text('code_hash').notNull().unique(),               // sha256(code)
  clientId: text('client_id').notNull(),                        // registry.apps.id
  userDid: text('user_did').notNull(),                          // resource owner (session DID)
  redirectUri: text('redirect_uri').notNull(),
  scope: text('scope').notNull(),                               // space-delimited granted scopes
  codeChallenge: text('code_challenge').notNull(),              // PKCE S256 challenge
  codeChallengeMethod: text('code_challenge_method').notNull().default('S256'),
  resource: text('resource'),                                   // RFC 8707 audience (optional)
  attestationId: text('attestation_id').notNull(),             // app.authorized linkage
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  expiresIdx: index('idx_oauth_codes_expires').on(table.expiresAt),
}));

/**
 * OAuth 2.1 refresh tokens — opaque, rotating, hashed at rest. Public client
 * (Claude), so no client secret; rotation + the attestation-revocation check at
 * the token endpoint bound the lifetime. `rotatedTo` chains a consumed token to
 * its successor for reuse detection.
 */
export const oauthRefreshTokens = authSchema.table('oauth_refresh_tokens', {
  id: text('id').primaryKey(),                                   // ort_<nanoid>
  tokenHash: text('token_hash').notNull().unique(),             // sha256(token)
  clientId: text('client_id').notNull(),
  userDid: text('user_did').notNull(),
  scope: text('scope').notNull(),
  attestationId: text('attestation_id').notNull(),
  rotatedTo: text('rotated_to'),                                // successor id after rotation
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (table) => ({
  userIdx: index('idx_oauth_refresh_user').on(table.userDid),
}));

export type OauthAuthorizationCode = typeof oauthAuthorizationCodes.$inferSelect;
export type NewOauthAuthorizationCode = typeof oauthAuthorizationCodes.$inferInsert;
export type OauthRefreshToken = typeof oauthRefreshTokens.$inferSelect;
export type NewOauthRefreshToken = typeof oauthRefreshTokens.$inferInsert;
