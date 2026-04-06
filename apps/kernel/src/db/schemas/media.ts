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

export type AssetReference = typeof assetReferences.$inferSelect;
export type NewAssetReference = typeof assetReferences.$inferInsert;
