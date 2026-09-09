/**
 * Atomic WS-send claim/release, and ack-confirmed `delivered_at`, for
 * notification redelivery (#2044, #2099).
 *
 * `delivered_at` on `notify.notifications` means "the recipient's plugin
 * confirmed this with a `{ type: 'notification_ack' }` frame" -- distinct
 * from `read`, which the recipient controls by opening it in the UI. It is
 * set in exactly one place, {@link ackNotificationDelivery}, and nowhere
 * else: a WS `.send()` call succeeding only means the frame was handed to a
 * socket that reported `readyState === OPEN`, which is also true for a
 * socket whose peer already crashed without a clean close (#2098's
 * Candidate A -- see docs/warp-notification-chain.md). Marking a row
 * delivered at that point, as the pre-#2099 `claimNotificationForDelivery`
 * did, could permanently strand it: `getNotificationBacklog`'s
 * `delivered_at IS NULL` filter would never offer it again.
 *
 * A WS send *attempt* is tracked separately, on `ws_sent_at` / `ws_attempts`,
 * by {@link claimNotificationForWsSend}. This is the mutual-exclusion guard
 * between the two paths that can attempt a send:
 *
 *   - a live push, right when the notification is created
 *     (`pushNotificationToDid`, ws-push.ts)
 *   - a backlog replay, right after the recipient's socket reconnects
 *     (`getNotificationBacklog`, backlog.ts)
 *
 * A claimed-but-unacked row becomes eligible for another attempt once its
 * `ws_sent_at` is older than {@link WS_ACK_TIMEOUT_MS}, or immediately when
 * {@link releaseWsClaimsForDid} is called for its recipient (the heartbeat's
 * reaction to a socket that missed too many pongs) -- both without ever
 * touching `delivered_at`. {@link rollbackWsClaim} undoes a claim that never
 * actually reached a live socket at all, so a doomed attempt neither costs
 * one of the row's limited re-offers nor makes it wait out the ack timeout.
 * `ws_attempts` caps re-offers at {@link WS_MAX_ATTEMPTS} so an old plugin
 * that never sends the ack frame cannot be re-offered the same notification
 * forever across reconnects.
 */
import { db, notifications } from '@/src/db';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

/**
 * An un-acked WS send older than this is presumed lost and becomes eligible
 * for another attempt (#2099).
 */
export const WS_ACK_TIMEOUT_MS = 30_000;

/**
 * Per-row cap on WS send attempts (#2099) -- bounds how many times a
 * never-acking plugin can be re-offered the same notification across
 * reconnects.
 */
export const WS_MAX_ATTEMPTS = 3;

export interface WsClaimResult {
  claimed: boolean;
  /** Attempt count after this claim. Only meaningful when `claimed` is true. */
  attempts: number;
}

/**
 * Atomically claim `id` for a WS send attempt. Eligible when the row has
 * never been acked, has not exhausted {@link WS_MAX_ATTEMPTS}, and its last
 * attempt (if any) is older than {@link WS_ACK_TIMEOUT_MS} -- i.e. its ack is
 * overdue. Records the attempt (`wsSentAt`, `wsAttempts`) but never touches
 * `deliveredAt`.
 *
 * Returns `{ claimed: false, attempts: 0 }` when the row was already claimed
 * by a concurrent attempt, already acked, still within its ack grace period,
 * or has exhausted its re-offer cap.
 */
export async function claimNotificationForWsSend(id: string): Promise<WsClaimResult> {
  const cutoff = new Date(Date.now() - WS_ACK_TIMEOUT_MS);
  const rows = await db
    .update(notifications)
    .set({
      wsSentAt: new Date(),
      wsAttempts: sql`${notifications.wsAttempts} + 1`,
    })
    .where(and(
      eq(notifications.id, id),
      isNull(notifications.deliveredAt),
      lt(notifications.wsAttempts, WS_MAX_ATTEMPTS),
      or(isNull(notifications.wsSentAt), lt(notifications.wsSentAt, cutoff)),
    ))
    .returning({ wsAttempts: notifications.wsAttempts });
  if (rows.length === 0) return { claimed: false, attempts: 0 };
  return { claimed: true, attempts: rows[0].wsAttempts };
}

/**
 * Undo a claim that never actually reached a live socket (#2099) -- e.g. no
 * open socket was found for the recipient, or the internal push route
 * itself failed. Restores the row to its pre-claim state so it neither
 * spends one of its limited re-offers on an attempt that never left the
 * server, nor has to wait out {@link WS_ACK_TIMEOUT_MS} to become eligible
 * again.
 */
export async function rollbackWsClaim(id: string): Promise<void> {
  await db
    .update(notifications)
    .set({
      wsSentAt: null,
      wsAttempts: sql`GREATEST(${notifications.wsAttempts} - 1, 0)`,
    })
    .where(eq(notifications.id, id));
}

/**
 * Release every un-acked WS claim for `did` (#2099). Called immediately when
 * the heartbeat terminates a socket that missed too many pongs, so a
 * reconnect's backlog replay does not have to wait out
 * {@link WS_ACK_TIMEOUT_MS} before it re-offers a notification that was sent
 * to the socket that just died. Deliberately leaves `wsAttempts` untouched:
 * that send genuinely reached a socket the server believed was live, so it
 * still counts as one of the row's limited re-offers.
 */
export async function releaseWsClaimsForDid(did: string): Promise<void> {
  await db
    .update(notifications)
    .set({ wsSentAt: null })
    .where(and(eq(notifications.recipientDid, did), isNull(notifications.deliveredAt)));
}

/**
 * Mark `id` delivered -- the only place `deliveredAt` is ever set (#2099).
 * Driven exclusively by the plugin's `{ type: 'notification_ack' }` frame,
 * never by a WS send merely reaching a live socket. Scoped to `did`, the
 * acking socket's own authenticated DID (defense in depth, PR #2101
 * review): the WHERE clause only ever matches a row addressed to that
 * recipient, so an authenticated peer cannot ack -- and thus retire from
 * backlog replay -- a notification it does not own, even given its id. A
 * no-op, not a throw, for an unknown id, a row already acked, or a row
 * belonging to a different DID -- all three look identical from here (zero
 * rows matched) and are handled the same way.
 */
export async function ackNotificationDelivery(id: string, did: string): Promise<boolean> {
  const rows = await db
    .update(notifications)
    .set({ deliveredAt: new Date() })
    .where(and(
      eq(notifications.id, id),
      eq(notifications.recipientDid, did),
      isNull(notifications.deliveredAt),
    ))
    .returning({ id: notifications.id });
  return rows.length > 0;
}
