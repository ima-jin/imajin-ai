import { pgTable, pgSchema, index, text, timestamp, unique, integer, foreignKey, primaryKey } from "drizzle-orm/pg-core";

export const connectionsSchema = pgSchema("connections");

export const podsInConnections = connectionsSchema.table("pods", {
  id: text().primaryKey().notNull(),
  name: text().notNull(),
  description: text(),
  avatar: text(),
  ownerDid: text("owner_did").notNull(),
  type: text().default('personal').notNull(),
  visibility: text().default('private').notNull(),
  createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
  conversationDid: text("conversation_did"),
}, (table) => [
  index("trust_pods_conversation_did_idx").using("btree", table.conversationDid.asc().nullsLast().op("text_ops")),
  index("trust_pods_owner_idx").using("btree", table.ownerDid.asc().nullsLast().op("text_ops")),
]);

export const invitesInConnections = connectionsSchema.table("invites", {
  id: text().primaryKey().notNull(),
  code: text().notNull(),
  fromDid: text("from_did").notNull(),
  fromHandle: text("from_handle"),
  toEmail: text("to_email"),
  toPhone: text("to_phone"),
  note: text(),
  usedCount: integer("used_count").default(0).notNull(),
  maxUses: integer("max_uses").default(1).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true, mode: 'string' }),
  consumedBy: text("consumed_by"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
  toDid: text("to_did"),
  delivery: text().default('link').notNull(),
  status: text().default('pending').notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: 'string' }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
  role: text(),
}, (table) => [
  index("idx_invites_code").using("btree", table.code.asc().nullsLast().op("text_ops")),
  index("idx_invites_from_did").using("btree", table.fromDid.asc().nullsLast().op("text_ops")),
  index("idx_invites_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
  index("idx_invites_to_email").using("btree", table.toEmail.asc().nullsLast().op("text_ops")),
  index("idx_trust_invites_code").using("btree", table.code.asc().nullsLast().op("text_ops")),
  index("idx_trust_invites_from_did").using("btree", table.fromDid.asc().nullsLast().op("text_ops")),
  unique("trust_invites_code_unique").on(table.code),
]);

export const podKeysInConnections = connectionsSchema.table("pod_keys", {
  podId: text("pod_id").notNull(),
  version: integer().notNull(),
  rotatedAt: timestamp("rotated_at", { mode: 'string' }).defaultNow().notNull(),
  rotatedBy: text("rotated_by"),
}, (table) => [
  foreignKey({
    columns: [table.podId],
    foreignColumns: [podsInConnections.id],
    name: "trust_pod_keys_pod_id_trust_pods_id_fk"
  }).onDelete("cascade"),
  primaryKey({ columns: [table.podId, table.version], name: "trust_pod_keys_pod_id_version_pk" }),
]);

export const podMemberKeysInConnections = connectionsSchema.table("pod_member_keys", {
  podId: text("pod_id").notNull(),
  version: integer().notNull(),
  did: text().notNull(),
  encryptedPodKey: text("encrypted_pod_key").notNull(),
}, (table) => [
  primaryKey({ columns: [table.podId, table.version, table.did], name: "trust_pod_member_keys_pod_id_version_did_pk" }),
]);

export const podLinksInConnections = connectionsSchema.table("pod_links", {
  parentPodId: text("parent_pod_id").notNull(),
  childPodId: text("child_pod_id").notNull(),
  linkedBy: text("linked_by"),
  linkedAt: timestamp("linked_at", { mode: 'string' }).defaultNow().notNull(),
  unlinkedAt: timestamp("unlinked_at", { mode: 'string' }),
}, (table) => [
  foreignKey({
    columns: [table.childPodId],
    foreignColumns: [podsInConnections.id],
    name: "trust_pod_links_child_pod_id_trust_pods_id_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.parentPodId],
    foreignColumns: [podsInConnections.id],
    name: "trust_pod_links_parent_pod_id_trust_pods_id_fk"
  }).onDelete("cascade"),
  primaryKey({ columns: [table.parentPodId, table.childPodId], name: "trust_pod_links_parent_pod_id_child_pod_id_pk" }),
]);

export const podMembersInConnections = connectionsSchema.table("pod_members", {
  podId: text("pod_id").notNull(),
  did: text().notNull(),
  role: text().default('member').notNull(),
  addedBy: text("added_by"),
  joinedAt: timestamp("joined_at", { mode: 'string' }).defaultNow().notNull(),
  removedAt: timestamp("removed_at", { mode: 'string' }),
}, (table) => [
  index("trust_pod_members_did_idx").using("btree", table.did.asc().nullsLast().op("text_ops")),
  foreignKey({
    columns: [table.podId],
    foreignColumns: [podsInConnections.id],
    name: "trust_pod_members_pod_id_trust_pods_id_fk"
  }).onDelete("cascade"),
  primaryKey({ columns: [table.podId, table.did], name: "trust_pod_members_pod_id_did_pk" }),
]);

export const connections = connectionsSchema.table('connections', {
  didA: text('did_a').notNull(),
  didB: text('did_b').notNull(),
  connectedAt: timestamp('connected_at', { withTimezone: true }).defaultNow().notNull(),
  disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
}, (table) => ({
  pk: primaryKey({ columns: [table.didA, table.didB] }),
  didAIdx: index('connections_did_a_idx').on(table.didA),
  didBIdx: index('connections_did_b_idx').on(table.didB),
}));

export const nicknames = connectionsSchema.table('nicknames', {
  did: text('did').notNull(),
  target: text('target').notNull(),
  nickname: text('nickname').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.did, table.target] }),
}));
