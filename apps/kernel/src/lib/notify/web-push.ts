/**
 * Web Push (VAPID) fan-out for `operator.approval.requested` (#2291 —
 * phone push path).
 *
 * Fire-and-forget, additive alongside the existing real-time WS push
 * (`ws-push.ts`): the persisted `notify.notifications` / `operator.approvals`
 * rows remain the sole authority regardless of what happens here. Every
 * failure mode this module can hit — no VAPID keys yet, no active
 * subscriptions, an individual subscription rejected by its push service —
 * degrades silently. Callers should never `await` this on a request's hot
 * path; `recordApprovalRequested` calls it without awaiting for exactly
 * that reason. It is exported as a `Promise` only so tests can await it
 * deterministically.
 */
import webpush from 'web-push';
import { eq, and, isNull } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, pushSubscriptions, type PushSubscriptionRow } from '@/src/db';
import { getVapidKeys, resolveVapidSubject } from './vapid';

const log = createLogger('kernel:notify');

/** A gone push service registration (unsubscribed on the browser side, or expired) — never retried, and the row is revoked. */
const GONE_STATUS_CODES = new Set([404, 410]);

export interface WebPushNotificationPayload {
  title: string;
  body: string | null;
  /** App-relative deep link (e.g. `/jin?proposalId=...`) — resolved by the service worker's notificationclick handler. */
  url: string;
}

function statusCodeOf(err: unknown): number | undefined {
  return typeof err === 'object' && err !== null && 'statusCode' in err
    ? (err as { statusCode?: number }).statusCode
    : undefined;
}

async function revokeSubscription(id: string): Promise<void> {
  await db
    .update(pushSubscriptions)
    .set({ revokedAt: new Date() })
    .where(eq(pushSubscriptions.id, id))
    .catch((err: unknown) => {
      log.error({ err: String(err), subscriptionId: id }, 'web-push: failed to revoke a gone subscription (non-fatal)');
    });
}

async function sendToSubscription(sub: PushSubscriptionRow, payloadJson: string): Promise<void> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payloadJson,
    );
  } catch (err) {
    const statusCode = statusCodeOf(err);
    if (statusCode !== undefined && GONE_STATUS_CODES.has(statusCode)) {
      await revokeSubscription(sub.id);
      return;
    }
    log.error({ err: String(err), subscriptionId: sub.id }, 'web-push: send failed (non-fatal)');
  }
}

/**
 * Fan `payload` out to every active push subscription for `operatorDid`.
 * Never throws. No-ops (silently) when VAPID keys aren't provisioned yet
 * or the operator has no active subscription.
 */
export async function pushWebNotificationToOperator(
  operatorDid: string,
  payload: WebPushNotificationPayload,
): Promise<void> {
  try {
    const vapidKeys = await getVapidKeys();
    if (!vapidKeys) return;

    const subs = await db
      .select()
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.operatorDid, operatorDid), isNull(pushSubscriptions.revokedAt)));
    if (subs.length === 0) return;

    webpush.setVapidDetails(resolveVapidSubject(), vapidKeys.publicKey, vapidKeys.privateKey);
    const payloadJson = JSON.stringify(payload);
    await Promise.all(subs.map((sub) => sendToSubscription(sub, payloadJson)));
  } catch (err) {
    log.error({ err: String(err), operatorDid }, 'web-push: fan-out failed (non-fatal)');
  }
}
