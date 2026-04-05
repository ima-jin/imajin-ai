import { pgSchema, text, timestamp, jsonb, serial, bigserial, index, primaryKey, customType, integer } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return 'bytea';
  },
});

export const relaySchema = pgSchema('relay');

export const relayOperations = relaySchema.table('relay_operations', {
  cid: text('cid').primaryKey(),
  jwsToken: text('jws_token').notNull(),
  chainType: text('chain_type').notNull(),
  chainId: text('chain_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const relayIdentityChains = relaySchema.table('relay_identity_chains', {
  did: text('did').primaryKey(),
  log: jsonb('log').$type<string[]>().notNull().default([]),
  state: jsonb('state').notNull(),
  headCid: text('head_cid'),
  lastCreatedAt: timestamp('last_created_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const relayContentChains = relaySchema.table('relay_content_chains', {
  contentId: text('content_id').primaryKey(),
  genesisCid: text('genesis_cid').notNull(),
  log: jsonb('log').$type<string[]>().notNull().default([]),
  state: jsonb('state').notNull(),
  lastCreatedAt: timestamp('last_created_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const relayBeacons = relaySchema.table('relay_beacons', {
  did: text('did').primaryKey(),
  jwsToken: text('jws_token').notNull(),
  beaconCid: text('beacon_cid').notNull(),
  state: jsonb('state').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const relayBlobs = relaySchema.table('relay_blobs', {
  creatorDid: text('creator_did').notNull(),
  documentCid: text('document_cid').notNull(),
  data: bytea('data').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.creatorDid, table.documentCid] }),
}));

export const relayCountersignatures = relaySchema.table('relay_countersignatures', {
  id: serial('id').primaryKey(),
  operationCid: text('operation_cid').notNull(),
  jwsToken: text('jws_token').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  operationCidIdx: index('idx_relay_countersignatures_operation_cid').on(table.operationCid),
}));

export const relayPendingOperations = relaySchema.table('relay_pending_operations', {
  cid: text('cid').primaryKey(),
  jwsToken: text('jws_token').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow(),
  attempts: integer('attempts').default(0).notNull(),
  lastError: text('last_error'),
  status: text('status').default('pending').notNull(),
});

export const relayPeerCursors = relaySchema.table('relay_peer_cursors', {
  peerUrl: text('peer_url').primaryKey(),
  cursor: text('cursor').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const relayOperationLog = relaySchema.table('relay_operation_log', {
  seq: bigserial('seq', { mode: 'bigint' }).primaryKey(),
  cid: text('cid').notNull(),
  jwsToken: text('jws_token').notNull(),
  kind: text('kind').notNull(),
  chainId: text('chain_id').notNull(),
}, (table) => ({
  cidIdx: index('idx_relay_operation_log_cid').on(table.cid),
}));
