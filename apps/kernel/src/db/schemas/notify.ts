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

/**
 * Data-driven notify templates (#1510) — one row per notification `scope`.
 * `getTemplate()` (apps/kernel/src/lib/notify/template-store.ts) reads this
 * table through a cached, bus-hot-reloadable lookup and falls back to the
 * in-code registry (apps/kernel/src/lib/notify/templates.ts) whenever no
 * row exists OR `enabled` is false — the latter is the deliberate rollout
 * gate: a row can be backfilled and reviewed with zero runtime effect until
 * an operator flips `enabled` (a config change, not a deploy).
 *
 * `subject_tpl` doubles as the in-app notification title AND the email
 * Subject line; `body_tpl` is the in-app body (and the fallback plain-text
 * source); `html_tpl` is the email body's inner HTML, nullable for scopes
 * with no email leg. All three are rendered by the SAFE interpolation
 * renderer in template-renderer.ts — `{{field}}` is entity-escaped by
 * default and the only other construct, `{{cta:field:Label}}`, is a fixed,
 * whitelisted CTA link/button. There is no raw-HTML passthrough and no code
 * eval, by construction (see that module's doc comment for the full
 * threat model).
 */
export const notifyTemplates = notifySchema.table("templates", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
  scope: text("scope").notNull().unique(),
  urgency: text("urgency").notNull().default("normal"),
  subjectTpl: text("subject_tpl").notNull(),
  bodyTpl: text("body_tpl").notNull(),
  htmlTpl: text("html_tpl"),
  enabled: boolean("enabled").notNull().default(true),
  // Audit trail (#1510) — DID (or 'system' for the migration backfill) of
  // whoever last created/edited this row. No admin UI ships in this PR
  // (issue's explicit stretch goal), so these are populated by the seed
  // migration today and by a future admin surface later.
  createdBy: text("created_by"),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  scopeIdx: index("idx_notify_templates_scope").on(table.scope),
}));

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type Preference = typeof preferences.$inferSelect;
export type NewPreference = typeof preferences.$inferInsert;
export type NotifyTemplateDbRow = typeof notifyTemplates.$inferSelect;
export type NewNotifyTemplateDbRow = typeof notifyTemplates.$inferInsert;
