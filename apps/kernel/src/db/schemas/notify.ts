import { pgSchema, text, boolean, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const notifySchema = pgSchema("notify");

export const notifications = notifySchema.table("notifications", {
  id: text("id").primaryKey(),
  recipientDid: text("recipient_did").notNull(),
  senderDid: text("sender_did"),
  scope: text("scope").notNull(),
  urgency: text("urgency").notNull().default("normal"),
  title: text("title").notNull(),
  body: text("body"),
  data: jsonb("data").default({}),
  channelsSent: text("channels_sent").array().default([]),
  read: boolean("read").default(false),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => ({
  recipientIdx: index("idx_notifications_recipient").on(table.recipientDid, table.createdAt),
  unreadIdx: index("idx_notifications_unread").on(table.recipientDid),
}));

export const preferences = notifySchema.table("preferences", {
  id: text("id").primaryKey(),
  did: text("did").notNull(),
  scope: text("scope").notNull(),
  email: boolean("email").default(true),
  inapp: boolean("inapp").default(true),
}, (table) => ({
  didScopeUnique: index("idx_preferences_did_scope").on(table.did, table.scope),
}));

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type Preference = typeof preferences.$inferSelect;
export type NewPreference = typeof preferences.$inferInsert;
