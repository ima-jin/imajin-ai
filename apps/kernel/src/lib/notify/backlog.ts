/**
 * Notification backlog replay on WS reconnect (#2044).
 *
 * `pushNotificationToDid` (ws-push.ts) is a live-only delivery path: a
 * notification created while the recipient's socket is down is persisted
 * (`notify.notifications`) but never redelivered on its own — see
 * `docs/warp-notification-chain.md` Hop 3. This module is the other half:
 * `ws-server.js`'s connection handler calls `getNotificationBacklog` (via
 * `POST /notify/api/internal/backlog`, since ws-server.js is plain CJS
 * outside the Next build) immediately after a DID's socket sends
 * `{type: 'connected'}`, and replays whatever it returns down that socket.
 *
 * Every candidate row is claimed one at a time with the same atomic
 * `delivered_at IS NULL` guard a live push uses (`delivery.ts`) before it is
 * turned into a frame, so a notification created at the exact instant its
 * recipient reconnects is delivered exactly once — by whichever of the two
 * paths claims it first, never both.
 */
import { db, notifications } from '@/src/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { buildNotificationFrame, type NotificationWsFrame } from './ws-push';
import { claimNotificationForDelivery } from './delivery';

/**
 * Cap on how many notifications one reconnect replays. Generous enough to
 * cover any realistic gap (an agent restarted overnight, a WS server
 * redeploy), while keeping one reconnect from ever having to push an
 * unbounded burst of frames.
 */
export const BACKLOG_LIMIT = 100;

export interface NotificationBacklog {
  frames: NotificationWsFrame[];
  /** True when more undelivered rows exist beyond {@link BACKLOG_LIMIT}. */
  truncated: boolean;
}

/**
 * Undelivered, unread notifications for `recipientDid`, oldest first, each
 * atomically claimed for delivery before being turned into a frame. A row
 * this call cannot claim (lost the race to a concurrent live push) is simply
 * skipped, not retried, since the other path is already delivering it. Callers
 * decide how to handle a thrown DB error — the internal route this backs
 * (`/notify/api/internal/backlog`) treats it as "nothing to replay this time".
 */
export async function getNotificationBacklog(recipientDid: string): Promise<NotificationBacklog> {
  // One extra row beyond the cap tells us whether more are waiting, without
  // a separate COUNT query.
  const candidates = await db
    .select()
    .from(notifications)
    .where(and(
      eq(notifications.recipientDid, recipientDid),
      isNull(notifications.deliveredAt),
      eq(notifications.read, false),
    ))
    .orderBy(asc(notifications.createdAt))
    .limit(BACKLOG_LIMIT + 1);

  const truncated = candidates.length > BACKLOG_LIMIT;
  const toClaim = candidates.slice(0, BACKLOG_LIMIT);

  const frames: NotificationWsFrame[] = [];
  for (const row of toClaim) {
    const claimed = await claimNotificationForDelivery(row.id);
    if (!claimed) continue;
    frames.push({
      ...buildNotificationFrame({
        id: row.id,
        scope: row.scope,
        title: row.title,
        body: row.body,
        data: (row.data ?? {}) as Record<string, unknown>,
        createdAt: row.createdAt ?? new Date(),
      }),
      replay: true,
    });
  }

  return { frames, truncated };
}
