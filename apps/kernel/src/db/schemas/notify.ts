import { pgSchema, text, boolean, timestamp, jsonb, integer, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
  // Set ONLY by an explicit `{ type: 'notification_ack' }` frame from the
  // recipient's plugin (#2099) -- never merely because a WS `.send()` call
  // accepted the frame, since a socket whose peer already crashed still
  // reports readyState OPEN. Distinct from `read` -- a notification is
  // routinely delivered without ever being read. Also the mutual-exclusion
  // guard between a live push and a backlog replay racing the same row: see
  // apps/kernel/src/lib/notify/delivery.ts.
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  // Claim timestamp for the most recent WS send *attempt* (#2099) -- distinct
  // from `deliveredAt`, which now requires an ack. NULL means "never
  // attempted, or its claim was released" (either by the 30s ack timeout or
  // by a heartbeat finding the recipient's socket dead) -- both make the row
  // eligible for another attempt. See `claimNotificationForWsSend`.
  wsSentAt: timestamp("ws_sent_at", { withTimezone: true }),
  // Cumulative count of WS send attempts, capped at WS_MAX_ATTEMPTS (3) so a
  // plugin that never acks cannot be re-offered the same row indefinitely
  // across reconnects (#2099).
  wsAttempts: integer("ws_attempts").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => ({
  recipientIdx: index("idx_notifications_recipient").on(table.recipientDid, table.createdAt),
  unreadIdx: index("idx_notifications_unread").on(table.recipientDid),
  // Backs the backlog-on-reconnect query (getNotificationBacklog, backlog.ts).
  undeliveredIdx: index("idx_notifications_undelivered").on(table.recipientDid, table.createdAt)
    .where(sql`${table.deliveredAt} IS NULL AND ${table.read} = false`),
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
