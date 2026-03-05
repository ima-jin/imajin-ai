import {
  pgTable,
  text,
  timestamp,
  jsonb,
  integer,
  index,
  pgSchema,
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
