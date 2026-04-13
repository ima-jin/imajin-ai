import { pgTable, text, timestamp, jsonb, index, integer, boolean, pgSchema, uniqueIndex } from 'drizzle-orm/pg-core';

export const profileSchema = pgSchema('profile');

export interface FeatureToggles {
  inference_enabled?: boolean;
  show_market_items?: boolean;
  show_events?: boolean;
  links?: string | null;
  coffee?: string | null;
  dykil?: string | null;
  learn?: string | null;
}

/**
 * Profiles - public identity pages linked to DIDs
 */
export const profiles = profileSchema.table('profiles', {
  did: text('did').primaryKey(),                              // did:imajin:xxx
  handle: text('handle').unique(),                            // unique handle (e.g., "jin", "ryan")
  displayName: text('display_name').notNull(),
  avatar: text('avatar'),                                     // URL or emoji
  avatarAssetId: text('avatar_asset_id'),                     // asset_xxx from media service
  banner: text('banner'),                                     // banner image URL
  bannerAssetId: text('banner_asset_id'),                     // asset_xxx from media service
  bio: text('bio'),
  contactEmail: text('contact_email'),                          // where to send receipts/tickets/notifications
  phone: text('phone'),                                       // contact phone
  visibility: text('visibility').notNull().default('public'),   // 'public' | 'incognito'
  nextInviteAvailableAt: timestamp('next_invite_available_at', { withTimezone: true }),
  metadata: jsonb('metadata').default({}),                    // location, website, etc.
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }), // Online presence tracking
  featureToggles: jsonb('feature_toggles').$type<FeatureToggles>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  claimedBy: text('claimed_by'),                              // owner DID, null = unclaimed stub
  claimStatus: text('claim_status'),                          // 'unclaimed' | 'pending' | 'claimed'
}, (table) => ({
  handleIdx: index('idx_profiles_handle').on(table.handle),
  claimStatusIdx: index('idx_profiles_claim_status').on(table.claimStatus),
}));

/**
 * Follows - lightweight follow relationships (not trust-gated)
 */
export const follows = profileSchema.table('follows', {
  id: text('id').primaryKey(),                                // follow_xxx
  followerDid: text('follower_did').notNull(),
  followedDid: text('followed_did').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  followerDidIdx: index('idx_follows_follower').on(table.followerDid),
  followedDidIdx: index('idx_follows_followed').on(table.followedDid),
  uniqueFollowIdx: uniqueIndex('idx_follows_unique').on(table.followerDid, table.followedDid),
}));

/**
 * Query logs - tracks inference requests for cost accounting
 */
export const queryLogs = profileSchema.table('query_logs', {
  id: text('id').primaryKey(),
  requesterDid: text('requester_did').notNull(),
  targetDid: text('target_did').notNull(),
  model: text('model').notNull(),
  promptTokens: integer('prompt_tokens').notNull().default(0),
  completionTokens: integer('completion_tokens').notNull().default(0),
  costUsd: text('cost_usd').notNull().default('0'),
  settled: boolean('settled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  requesterIdx: index('idx_query_logs_requester').on(table.requesterDid),
  targetIdx: index('idx_query_logs_target').on(table.targetDid),
}));

/**
 * Forest Config — per-group service toggles and landing page
 */
export const forestConfig = profileSchema.table('forest_config', {
  groupDid: text('group_did').primaryKey(),
  enabledServices: text('enabled_services').array().notNull().default([]),
  landingService: text('landing_service'),
  theme: jsonb('theme').default({}),
  scopeFeeBps: integer('scope_fee_bps').default(25),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

/**
 * Profile Images — gallery images for stub business profiles
 */
export const profileImages = profileSchema.table('profile_images', {
  id: text('id').primaryKey(),                                // img_xxx
  did: text('did').notNull(),                                 // references profiles.did
  url: text('url').notNull(),
  caption: text('caption'),
  sortOrder: integer('sort_order').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  createdBy: text('created_by').notNull(),                    // uploader DID
}, (table) => ({
  didIdx: index('idx_profile_images_did').on(table.did),
}));

// Types
export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
export type Follow = typeof follows.$inferSelect;
export type NewFollow = typeof follows.$inferInsert;
export type QueryLog = typeof queryLogs.$inferSelect;
export type NewQueryLog = typeof queryLogs.$inferInsert;
export type ForestConfig = typeof forestConfig.$inferSelect;
export type NewForestConfig = typeof forestConfig.$inferInsert;
export type ProfileImage = typeof profileImages.$inferSelect;
export type NewProfileImage = typeof profileImages.$inferInsert;
