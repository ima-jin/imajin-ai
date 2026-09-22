/**
 * Delegate-grant bearer credential (#2252) — outbound shape for static-header
 * foreign clients (Meta Muse consumer connector / Muse Code) that cannot
 * complete our OAuth+PKCE dance. Never a PAT (NOT-PAT rule, #1340): a scoped,
 * revocable, sliding-expiry bearer minted only after an operator-countersigned
 * approval (#2084 signing roles, mirroring the vault:* proposal chain,
 * #2247's approvals-execution.ts).
 *
 * Two tables, matching the KNOCK -> APPROVE lifecycle:
 *
 *   `delegate_grant_requests` — the KNOCK. A pending request bound to
 *   {principalDid, clientLabel, purpose, scopes, surfaces}, expiring in 24h
 *   if never decided (Ryan's 2026-09-22 ruling). Transport for the operator
 *   decision itself is the existing generic `operator_approvals` rail
 *   (source: 'access', kind: 'access:bearer-grant') — this table is the
 *   durable domain record the knock/approve/expire lifecycle actually lives
 *   in, independent of that transport row.
 *
 *   `delegate_grant_bearers` — the CREDENTIAL + the RELATION, deliberately
 *   one object (per the ruling: "static-header clients cannot refresh — so
 *   the bearer lives exactly as long as the grant"). `tokenHash` is a plain
 *   sha256 of a 32-byte random secret — matching the existing opaque-token
 *   pattern for OAuth authorization codes/refresh tokens
 *   (`apps/kernel/src/lib/mcp/oauth-config.ts`'s `generateOpaqueToken` /
 *   `hashToken`): the secret's own 256 bits of entropy is the brute-force
 *   defense, not a slow KDF, matching how this codebase already treats
 *   other high-entropy bearer secrets. Revocation is a TOMBSTONE: the row
 *   survives (so the record remembers a credential existed) but
 *   `tokenHash` is erased to NULL, so a lookup by the old plaintext can
 *   never resolve again — the same soft-tombstone shape as
 *   `vault_minted_keys` (#2242).
 */
import { pgSchema, text, timestamp, integer, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const accessSchema = pgSchema('auth');

export const delegateGrantRequests = accessSchema.table('delegate_grant_requests', {
  id: text('id').primaryKey(),                              // dgr_{hex}
  principalDid: text('principal_did').notNull(),             // the human whose data/surfaces are being reached
  clientLabel: text('client_label').notNull(),                // free-form, e.g. 'Muse Code'
  purpose: text('purpose').notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
  surfaces: jsonb('surfaces').$type<string[]>().notNull().default([]), // e.g. ['mcp']
  slidingWindowDays: integer('sliding_window_days').notNull().default(90), // 30 | 90 | 180 | 365
  // 'pending' -> 'approved' | 'denied' | 'withdrawn' | 'expired'. The
  // operator's actual decision lives on the linked operator_approvals row
  // (approvalId); this mirrors it onto the domain record so knock-expiry
  // (24h, checked at decide time) doesn't depend on that transport row's
  // own (source-agnostic, no built-in expiry) shape.
  status: text('status').notNull().default('pending'),
  approvalId: text('approval_id'),                            // operator_approvals.proposal_id once raised
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), // createdAt + 24h — the knock's own pending TTL
}, (table) => ({
  principalIdx: index('idx_delegate_grant_requests_principal').on(table.principalDid, table.status),
  approvalIdx: index('idx_delegate_grant_requests_approval').on(table.approvalId),
}));

export type DelegateGrantRequestRow = typeof delegateGrantRequests.$inferSelect;
export type NewDelegateGrantRequestRow = typeof delegateGrantRequests.$inferInsert;

export const delegateGrantBearers = accessSchema.table('delegate_grant_bearers', {
  id: text('id').primaryKey(),                                // dgb_{hex}
  requestId: text('request_id').notNull().references(() => delegateGrantRequests.id),
  principalDid: text('principal_did').notNull(),
  clientLabel: text('client_label').notNull(),
  purpose: text('purpose').notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
  surfaces: jsonb('surfaces').$type<string[]>().notNull().default([]),
  // sha256(hex) of the plaintext bearer, revealed exactly once in the
  // approve response and never again. NULL once tombstoned (revoked) — see
  // module docs above.
  tokenHash: text('token_hash'),
  slidingWindowDays: integer('sliding_window_days').notNull().default(90),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  // Sliding: extended on every valid use to lastUsedAt (or issuedAt) +
  // slidingWindowDays, but never past hardCapAt (see resolveDelegateGrantBearer).
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  // Fixed at issuance: issuedAt + 90 days, always — dead after this instant
  // regardless of use, regardless of slidingWindowDays.
  hardCapAt: timestamp('hard_cap_at', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('active'),          // 'active' | 'revoked'
  approvalId: text('approval_id').notNull(),                    // the countersigned operator_approvals row that authorized issuance
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: text('revoked_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tokenHashUniq: uniqueIndex('uniq_delegate_grant_bearers_token_hash').on(table.tokenHash),
  principalIdx: index('idx_delegate_grant_bearers_principal').on(table.principalDid, table.status),
  requestIdx: index('idx_delegate_grant_bearers_request').on(table.requestId),
}));

export type DelegateGrantBearerRow = typeof delegateGrantBearers.$inferSelect;
export type NewDelegateGrantBearerRow = typeof delegateGrantBearers.$inferInsert;
