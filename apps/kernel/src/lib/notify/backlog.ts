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
 * WS-send-attempt guard a live push uses (`delivery.ts`) before it is turned
 * into a frame, so a notification created at the exact instant its
 * recipient reconnects is attempted exactly once -- by whichever of the two
 * paths claims it first, never both. The claim also re-validates eligibility
 * (#2099): a row this SELECT finds is skipped, not replayed, when it is
 * still within its ack grace period or has exhausted its re-offer cap --
 * the same "lost the race" tolerance already applied to a claim a
 * concurrent live push won first.
 */
import { createLogger } from '@imajin/logger';
import { db, notifications } from '@/src/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { buildNotificationFrame, type NotificationWsFrame } from './ws-push';
import { claimNotificationForWsSend, WS_MAX_ATTEMPTS } from './delivery';

const log = createLogger('kernel');

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
 * Un-acked, unread notifications for `recipientDid`, oldest first, each
 * atomically claimed for a WS send attempt before being turned into a
 * frame. A row this call cannot claim -- lost the race to a concurrent live
 * push, still within its ack grace period, or has exhausted its re-offer
 * cap (#2099) -- is simply skipped, not retried, on this pass. Callers
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
    const { claimed, attempts } = await claimNotificationForWsSend(row.id);
    if (!claimed) continue;
    if (attempts >= WS_MAX_ATTEMPTS) {
      log.warn({ id: row.id, recipientDid, attempts }, 'Notification WS re-offer cap reached');
    }
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
