import { pgTable, text, timestamp, integer, index, primaryKey } from 'drizzle-orm/pg-core';

export const pods = pgTable('trust_pods', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  avatar: text('avatar'),
  ownerDid: text('owner_did').notNull(),
  type: text('type', { enum: ['personal', 'shared'] }).notNull().default('personal'),
  visibility: text('visibility', { enum: ['private', 'trust-bound'] }).notNull().default('private'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  ownerIdx: index('trust_pods_owner_idx').on(table.ownerDid),
}));

export const podMembers = pgTable('trust_pod_members', {
  podId: text('pod_id').notNull().references(() => pods.id, { onDelete: 'cascade' }),
  did: text('did').notNull(),
  role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull().default('member'),
  addedBy: text('added_by'),
  joinedAt: timestamp('joined_at').defaultNow().notNull(),
  removedAt: timestamp('removed_at'),
}, (table) => ({
  pk: primaryKey({ columns: [table.podId, table.did] }),
  didIdx: index('trust_pod_members_did_idx').on(table.did),
}));

export const podLinks = pgTable('trust_pod_links', {
  parentPodId: text('parent_pod_id').notNull().references(() => pods.id, { onDelete: 'cascade' }),
  childPodId: text('child_pod_id').notNull().references(() => pods.id, { onDelete: 'cascade' }),
  linkedBy: text('linked_by'),
  linkedAt: timestamp('linked_at').defaultNow().notNull(),
  unlinkedAt: timestamp('unlinked_at'),
}, (table) => ({
  pk: primaryKey({ columns: [table.parentPodId, table.childPodId] }),
}));

export const podKeys = pgTable('trust_pod_keys', {
  podId: text('pod_id').notNull().references(() => pods.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  rotatedAt: timestamp('rotated_at').defaultNow().notNull(),
  rotatedBy: text('rotated_by'),
}, (table) => ({
  pk: primaryKey({ columns: [table.podId, table.version] }),
}));

export const podMemberKeys = pgTable('trust_pod_member_keys', {
  podId: text('pod_id').notNull(),
  version: integer('version').notNull(),
  did: text('did').notNull(),
  encryptedPodKey: text('encrypted_pod_key').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.podId, table.version, table.did] }),
}));
