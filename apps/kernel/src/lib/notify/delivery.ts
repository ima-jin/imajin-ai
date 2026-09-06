/**
 * Atomic `delivered_at` claim/release for notification redelivery (#2044).
 *
 * `delivered_at` on `notify.notifications` means "this notification reached
 * a live WebSocket frame at least once" -- distinct from `read`, which the
 * recipient controls by opening it in the UI. It doubles as the mutual-
 * exclusion guard between the two paths that can deliver a frame:
 *
 *   - a live push, right when the notification is created
 *     (`pushNotificationToDid`, ws-push.ts)
 *   - a backlog replay, right after the recipient's socket reconnects
 *     (`getNotificationBacklog`, backlog.ts)
 *
 * Whichever claims a row first (`claimNotificationForDelivery`, an atomic
 * `UPDATE ... WHERE delivered_at IS NULL RETURNING`) is the only one that
 * proceeds to push it -- see docs/warp-notification-chain.md Hop 3. A push
 * that then fails to actually reach a socket must release the claim
 * (`releaseNotificationClaim`): `delivered_at` means "delivered", not
 * "attempted" -- an unreleased claim after a failed push would hide the row
 * from every future backlog replay forever.
 */
import { db, notifications } from '@/src/db';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * Atomically claim `id` for delivery. Returns false when it was already
 * claimed -- already delivered, or a concurrent claim (live push racing a
 * backlog replay for the same row) won it first.
 */
export async function claimNotificationForDelivery(id: string): Promise<boolean> {
  const rows = await db
    .update(notifications)
    .set({ deliveredAt: new Date() })
    .where(and(eq(notifications.id, id), isNull(notifications.deliveredAt)))
    .returning({ id: notifications.id });
  return rows.length > 0;
}

/**
 * Release a claim that did not result in an actual delivery, so the row
 * remains eligible for a future live push or backlog replay.
 */
export async function releaseNotificationClaim(id: string): Promise<void> {
  await db
    .update(notifications)
    .set({ deliveredAt: null })
    .where(eq(notifications.id, id));
}
