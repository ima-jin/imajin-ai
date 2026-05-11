import {
  pgTable,
  text,
  timestamp,
  jsonb,
  integer,
  index,
  pgSchema,
  boolean,
  primaryKey,
  unique,
} from "drizzle-orm/pg-core";

export const mediaSchema = pgSchema("media");

export const assets = mediaSchema.table(
  "assets",
  {
    id: text("id").primaryKey(),                               // asset_xxx
    ownerDid: text("owner_did").notNull(),                     // DID of uploader
    filename: text("filename").notNull(),                      // original filename
    mimeType: text("mime_type").notNull(),                     // image/jpeg, etc.
    size: integer("size").notNull(),                           // bytes
    storagePath: text("storage_path").notNull(),               // /mnt/media/{did}/assets/{id}.ext
    hash: text("hash").notNull(),                              // sha256 of file content

    // .fair manifest
    fairManifest: jsonb("fair_manifest").default({}),          // inline .fair JSON
    fairPath: text("fair_path"),                               // path to .fair.json file

    // DFOS federation anchor
    fairDfosEventId: text("fair_dfos_event_id"),               // DFOS event ID for signed manifest anchor

    // Organization
    folderId: text("folder_id"),                               // virtual folder (future #187)
    tags: jsonb("tags").default([]),

    // ML classification (future #186)
    classification: text("classification"),                    // photo, document, audio, video
    classificationConfidence: integer("classification_confidence"), // 0-100

    metadata: jsonb("metadata").default({}),

    // Status
    status: text("status").notNull().default("active"),        // active, deleted, processing

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    ownerIdx: index("idx_assets_owner").on(table.ownerDid),
    statusIdx: index("idx_assets_status").on(table.status),
    mimeIdx: index("idx_assets_mime").on(table.mimeType),
    folderIdx: index("idx_assets_folder").on(table.folderId),
    createdIdx: index("idx_assets_created").on(table.createdAt),
  })
);

export type Asset = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;

export const folders = mediaSchema.table("folders", {
  id: text("id").primaryKey(),                              // folder_xxx
  ownerDid: text("owner_did").notNull(),
  name: text("name").notNull(),
  parentId: text("parent_id"),                              // self-reference for tree
  icon: text("icon"),                                       // emoji
  isSystem: boolean("is_system").default(false),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => ({
  ownerIdx: index("idx_folders_owner").on(table.ownerDid),
  parentIdx: index("idx_folders_parent").on(table.parentId),
}));

export const assetFolders = mediaSchema.table("asset_folders", {
  assetId: text("asset_id").references(() => assets.id, { onDelete: "cascade" }).notNull(),
  folderId: text("folder_id").references(() => folders.id, { onDelete: "cascade" }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.assetId, table.folderId] }),
  assetIdx: index("idx_asset_folders_asset").on(table.assetId),
  folderIdx: index("idx_asset_folders_folder").on(table.folderId),
}));

export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;

export const assetReferences = mediaSchema.table("asset_references", {
  id: text("id").primaryKey(),
  assetId: text("asset_id").references(() => assets.id).notNull(),
  service: text("service").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => ({
  assetIdx: index("idx_asset_refs_asset").on(table.assetId),
  serviceIdx: index("idx_asset_refs_service").on(table.service),
  uniq: unique("uq_asset_reference").on(table.assetId, table.service, table.entityType, table.entityId),
}));

export const settlements = mediaSchema.table(
  "settlements",
  {
    id: text("id").primaryKey(),                              // stl_<nanoid>
    assetId: text("asset_id").notNull(),
    action: text("action").notNull(),                         // reproduction | streaming | derivative | syndication
    buyerDid: text("buyer_did"),                              // nullable (anonymous)
    amount: integer("amount").notNull(),                      // minor units
    currency: text("currency").notNull(),
    scheme: text("scheme").notNull(),                         // x402 | stripe-link | mjnx-direct | ...
    status: text("status").notNull().default("pending"),      // pending | completed
    receiptToken: text("receipt_token").notNull(),            // signed JWT
    externalReceiptId: text("external_receipt_id"),           // scheme-specific id (Stripe charge id, etc.)
    fairManifestDigest: text("fair_manifest_digest").notNull(), // sha256: of manifest at time of settle
    dfosEventId: text("dfos_event_id"),                       // if publishContentEvent succeeded
    settledAt: timestamp("settled_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    assetIdx: index("idx_settlements_asset").on(table.assetId),
    buyerIdx: index("idx_settlements_buyer").on(table.buyerDid),
    dfosIdx: index("idx_settlements_dfos").on(table.dfosEventId),
    settledAtIdx: index("idx_settlements_settled_at").on(table.settledAt),
  })
);

export type Settlement = typeof settlements.$inferSelect;
export type NewSettlement = typeof settlements.$inferInsert;

export const accessLog = mediaSchema.table(
  "access_log",
  {
    id: text("id").primaryKey(),                              // acc_<nanoid>
    assetId: text("asset_id").notNull(),
    action: text("action").notNull(),
    settlementId: text("settlement_id"),                      // nullable for free access
    buyerDid: text("buyer_did"),
    ip: text("ip"),                                           // hashed for privacy if desired
    userAgent: text("user_agent"),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    assetIdx: index("idx_access_log_asset").on(table.assetId),
    buyerIdx: index("idx_access_log_buyer").on(table.buyerDid),
    atIdx: index("idx_access_log_at").on(table.at),
  })
);

export type AccessLog = typeof accessLog.$inferSelect;
export type NewAccessLog = typeof accessLog.$inferInsert;

export type AssetReference = typeof assetReferences.$inferSelect;
export type NewAssetReference = typeof assetReferences.$inferInsert;
