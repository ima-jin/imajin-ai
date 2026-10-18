import { sql } from 'drizzle-orm';
import { index, jsonb, pgSchema, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

const domainSchema = pgSchema('auth');

export const domainBindings = domainSchema.table('domain_bindings', {
  id: text('id').primaryKey(),
  domain: text('domain').notNull(),
  zoneOwner: text('zone_owner').notNull(),
  siteOwner: text('site_owner').notNull(),
  appDid: text('app_did'),
  method: text('method').$type<'dns-txt' | 'imajin-issued' | 'legacy'>().notNull(),
  status: text('status').$type<'pending' | 'verified' | 'revoked' | 'legacy'>().notNull().default('pending'),
  attestation: jsonb('attestation').$type<Record<string, unknown> | null>(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  claimUniq: uniqueIndex('uniq_domain_binding_claim').on(table.domain, table.zoneOwner),
  verifiedUniq: uniqueIndex('uniq_domain_binding_verified').on(table.domain)
    .where(sql`${table.status} IN ('verified', 'legacy')`),
  zoneOwnerIdx: index('idx_domain_bindings_zone_owner').on(table.zoneOwner),
  siteOwnerIdx: index('idx_domain_bindings_site_owner').on(table.siteOwner),
  recheckIdx: index('idx_domain_bindings_recheck').on(table.checkedAt)
    .where(sql`${table.status} = 'verified' AND ${table.method} = 'dns-txt'`),
}));

export type DomainBindingRow = typeof domainBindings.$inferSelect;
