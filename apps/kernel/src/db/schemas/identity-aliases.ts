import { pgSchema, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Identity aliases — partner-scoped natural-key lookup for lazy get-or-create
 * identity minting (Issue #1230).
 *
 * Tripian (and other partners) reference entities by their own external ids
 * rather than DIDs. Each row maps a partner-scoped `(namespace, ref)` pair to a
 * canonical `did:imajin:` DID so the same external reference always resolves to
 * the same DID — the "no cache needed" idempotency guarantee behind
 * `POST /registry/identity`.
 *
 * The partner namespace is metadata, NOT a new DID method: DIDs stored here are
 * always `did:imajin:`. The unique `(namespace, ref)` constraint is what makes
 * concurrent first-references collapse to a single minted DID.
 */
export const identityAliasesSchema = pgSchema('kernel');

export const identityAliases = identityAliasesSchema.table('identity_aliases', {
  namespace: text('namespace').notNull(),                              // partner namespace, e.g. 'tripian'
  ref: text('ref').notNull(),                                          // partner-scoped external id, e.g. 'restaurant:kai-honolulu'
  did: text('did').notNull(),                                          // canonical did:imajin: DID this ref resolves to
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  namespaceRefUniq: uniqueIndex('idx_identity_aliases_namespace_ref').on(table.namespace, table.ref),
  didIdx: index('idx_identity_aliases_did').on(table.did),
}));

export type IdentityAlias = typeof identityAliases.$inferSelect;
export type NewIdentityAlias = typeof identityAliases.$inferInsert;
