import { pgTable, text, timestamp, jsonb, integer, boolean, index } from 'drizzle-orm/pg-core';

/**
 * Link Pages - bio link pages linked to DIDs
 */
export const linkPages = pgTable('link_pages', {
  id: text('id').primaryKey(),                                // page_xxx
  did: text('did').notNull().unique(),                        // Owner DID
  handle: text('handle').notNull().unique(),                  // URL slug
  title: text('title').notNull(),                             // Display name
  bio: text('bio'),                                           // Short description
  avatar: text('avatar'),                                     // Image URL or emoji
  theme: jsonb('theme').notNull().default({}),                // Theme settings
  socialLinks: jsonb('social_links').default({}),             // Social media handles
  isPublic: boolean('is_public').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  handleIdx: index('idx_link_pages_handle').on(table.handle),
  didIdx: index('idx_link_pages_did').on(table.did),
}));

/**
 * Links - individual links on a page
 */
export const links = pgTable('links', {
  id: text('id').primaryKey(),                                // link_xxx
  pageId: text('page_id').references(() => linkPages.id, { onDelete: 'cascade' }).notNull(),
  title: text('title').notNull(),
  url: text('url').notNull(),
  icon: text('icon'),                                         // Emoji or icon name
  thumbnail: text('thumbnail'),                               // Image URL
  position: integer('position').notNull().default(0),
  isActive: boolean('is_active').default(true),
  clicks: integer('clicks').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pageIdx: index('idx_links_page').on(table.pageId),
  positionIdx: index('idx_links_position').on(table.pageId, table.position),
}));

/**
 * Link Clicks - minimal click tracking (no PII)
 */
export const linkClicks = pgTable('link_clicks', {
  id: text('id').primaryKey(),
  linkId: text('link_id').references(() => links.id, { onDelete: 'cascade' }).notNull(),
  clickedAt: timestamp('clicked_at', { withTimezone: true }).defaultNow(),
  referrer: text('referrer'),                                 // Referrer domain only
  country: text('country'),                                   // Country from IP (not stored)
}, (table) => ({
  linkIdx: index('idx_link_clicks_link').on(table.linkId),
  dateIdx: index('idx_link_clicks_date').on(table.clickedAt),
}));

// Types
export type LinkPage = typeof linkPages.$inferSelect;
export type NewLinkPage = typeof linkPages.$inferInsert;
export type Link = typeof links.$inferSelect;
export type NewLink = typeof links.$inferInsert;
export type LinkClick = typeof linkClicks.$inferSelect;
