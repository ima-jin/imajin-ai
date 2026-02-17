import { pgTable, uuid, text, timestamp, boolean, index, unique } from 'drizzle-orm/pg-core';

/**
 * Contacts - email addresses for updates/notifications
 * 
 * Can exist without an account. For early interest signup
 * before full profile registration is available.
 */
export const contacts = pgTable('www_contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  source: text('source').notNull().default('register'),  // 'register' | 'article' | 'manual'
  isVerified: boolean('is_verified').notNull().default(false),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  emailIdx: index('idx_www_contacts_email').on(table.email),
  uniqueEmail: unique('uniq_www_contacts_email').on(table.email),
}));

/**
 * Mailing Lists - different notification streams
 */
export const mailingLists = pgTable('www_mailing_lists', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  slugIdx: index('idx_www_mailing_lists_slug').on(table.slug),
  uniqueSlug: unique('uniq_www_mailing_lists_slug').on(table.slug),
}));

/**
 * Subscriptions - link contacts to lists
 */
export const subscriptions = pgTable('www_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  mailingListId: uuid('mailing_list_id').notNull().references(() => mailingLists.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('subscribed'),  // 'subscribed' | 'unsubscribed'
  subscribedAt: timestamp('subscribed_at', { withTimezone: true }).defaultNow(),
  unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
}, (table) => ({
  contactIdx: index('idx_www_subscriptions_contact').on(table.contactId),
  listIdx: index('idx_www_subscriptions_list').on(table.mailingListId),
  uniqueSub: unique('uniq_www_subscription').on(table.contactId, table.mailingListId),
}));

// Types
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type MailingList = typeof mailingLists.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
