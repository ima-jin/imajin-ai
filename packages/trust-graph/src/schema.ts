import { pgTable, text, timestamp, integer, index, primaryKey, uniqueIndex, pgSchema } from 'drizzle-orm/pg-core';

export const connectionsSchema = pgSchema('connections');

export const pods = connectionsSchema.table('pods', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  avatar: text('avatar'),
  ownerDid: text('owner_did').notNull(),
  type: text('type', { enum: ['personal', 'shared', 'event'] }).notNull().default('personal'),
  visibility: text('visibility', { enum: ['private', 'trust-bound'] }).notNull().default('private'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  ownerIdx: index('trust_pods_owner_idx').on(table.ownerDid),
}));

export const podMembers = connectionsSchema.table('pod_members', {
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

export const podLinks = connectionsSchema.table('pod_links', {
  parentPodId: text('parent_pod_id').notNull().references(() => pods.id, { onDelete: 'cascade' }),
  childPodId: text('child_pod_id').notNull().references(() => pods.id, { onDelete: 'cascade' }),
  linkedBy: text('linked_by'),
  linkedAt: timestamp('linked_at').defaultNow().notNull(),
  unlinkedAt: timestamp('unlinked_at'),
}, (table) => ({
  pk: primaryKey({ columns: [table.parentPodId, table.childPodId] }),
}));

export const podKeys = connectionsSchema.table('pod_keys', {
  podId: text('pod_id').notNull().references(() => pods.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  rotatedAt: timestamp('rotated_at').defaultNow().notNull(),
  rotatedBy: text('rotated_by'),
}, (table) => ({
  pk: primaryKey({ columns: [table.podId, table.version] }),
}));

export const podMemberKeys = connectionsSchema.table('pod_member_keys', {
  podId: text('pod_id').notNull(),
  version: integer('version').notNull(),
  did: text('did').notNull(),
  encryptedPodKey: text('encrypted_pod_key').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.podId, table.version, table.did] }),
}));

export const invites = connectionsSchema.table('invites', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(),
  fromDid: text('from_did').notNull(),
  fromHandle: text('from_handle'),
  toEmail: text('to_email'),
  toDid: text('to_did'),
  note: text('note'),
  delivery: text('delivery', { enum: ['link', 'email'] }).notNull().default('link'),
  status: text('status', { enum: ['pending', 'accepted', 'expired', 'revoked'] }).notNull().default('pending'),
  maxUses: integer('max_uses').notNull().default(1),
  usedCount: integer('used_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  consumedBy: text('consumed_by'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  role: text('role'),
}, (table) => ({
  codeIdx: index('idx_invites_code').on(table.code),
  fromDidIdx: index('idx_invites_from_did').on(table.fromDid),
  toEmailIdx: index('idx_invites_to_email').on(table.toEmail),
  statusIdx: index('idx_invites_status').on(table.status),
}));
