import { pgSchema, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Google Workspace connector operational state (#2144).
 *
 * One row per connecting DID. Distinct from `auth.channel_links` (authoritative
 * for grants) and the vault (authoritative for the sealed refresh token): this
 * table holds small, non-secret cursors the connector needs between calls and
 * that have no other home —
 *
 *   - `gmailHistoryId` / `gmailWatchExpiration`: the Gmail `users.watch` push
 *     subscription's last-seen `historyId` and renewal deadline (Google expires
 *     a watch after 7 days; the renewal cron reads this column).
 *   - `drivePageToken`: the Drive `changes.list` page token for the on-demand
 *     `google_drive_list_changes` tool, so each call resumes where the last
 *     one left off instead of re-walking the whole change feed.
 *
 * Nothing here is credential-grade — losing this table costs a full resync,
 * not a security incident.
 */
export const googleSchema = pgSchema('kernel');

export const googleWorkspaceState = googleSchema.table('google_workspace_state', {
  id: text('id').primaryKey(),
  /** DID that connected the Google Workspace account. */
  ownerDid: text('owner_did').notNull(),
  /** Last-seen Gmail `historyId`, or null before the first `users.watch` call. */
  gmailHistoryId: text('gmail_history_id'),
  /** When the current Gmail push subscription expires; null before the first watch. */
  gmailWatchExpiration: timestamp('gmail_watch_expiration', { withTimezone: true }),
  /** Drive `changes.list` page token cursor, or null before the first call. */
  drivePageToken: text('drive_page_token'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  ownerDidUniq: uniqueIndex('uniq_google_workspace_state_owner').on(table.ownerDid),
}));

export type GoogleWorkspaceStateRow = typeof googleWorkspaceState.$inferSelect;
export type NewGoogleWorkspaceStateRow = typeof googleWorkspaceState.$inferInsert;
