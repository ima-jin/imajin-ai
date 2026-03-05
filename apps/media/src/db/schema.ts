import { pgSchema, text, timestamp, integer, boolean, jsonb } from 'drizzle-orm/pg-core';

export const mediaSchema = pgSchema('media');

/**
 * Assets — stored media files with DID-based ownership
 */
export const assets = mediaSchema.table('assets', {
  id: text('id').primaryKey(),                          // asset_xxx
  ownerDid: text('owner_did').notNull(),                // DID of the owner
  type: text('type').notNull(),                         // 'image' | 'video' | 'audio' | 'document'
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  width: integer('width'),                              // pixels (images/video)
  height: integer('height'),                            // pixels (images/video)
  durationSeconds: integer('duration_seconds'),         // audio/video
  storagePath: text('storage_path').notNull(),          // /mnt/media/{did}/assets/{filename}
  thumbPath: text('thumb_path'),                        // /mnt/media/{did}/thumbs/{filename}
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

/**
 * Fair manifests — .fair attribution for assets
 */
export const fairManifests = mediaSchema.table('fair_manifests', {
  id: text('id').primaryKey(),                          // fair_xxx
  assetId: text('asset_id').notNull().references(() => assets.id),
  creatorDid: text('creator_did').notNull(),
  terms: jsonb('terms'),                                // { license, attribution, usage }
  metadata: jsonb('metadata'),                          // arbitrary creator metadata
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

/**
 * Delivery logs — audit trail for authenticated asset delivery
 */
export const deliveryLogs = mediaSchema.table('delivery_logs', {
  id: text('id').primaryKey(),                          // dl_xxx
  assetId: text('asset_id').notNull().references(() => assets.id),
  requesterDid: text('requester_did').notNull(),
  granted: boolean('granted').notNull(),
  ruleMatched: text('rule_matched'),                    // which access rule allowed/denied
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type Asset = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;
export type FairManifest = typeof fairManifests.$inferSelect;
export type NewFairManifest = typeof fairManifests.$inferInsert;
export type DeliveryLog = typeof deliveryLogs.$inferSelect;
export type NewDeliveryLog = typeof deliveryLogs.$inferInsert;
