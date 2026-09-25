import { createLogger } from '@imajin/logger';
import type { BrokerPipelineState } from '../types';

const log = createLogger('bus:broker:consent-request-notify');

/**
 * Notify the subject of an inbound consent request that was rejected due to
 * `no_consent` (#1220).
 *
 * Fires a `broker:consent-request` notification via the notify service so the
 * subject can approve or deny inline from the notification bell, without
 * opening the disclosure dashboard.
 *
 * ## Who the alert names (#2366)
 * `requester` alone is not enough to identify the acting party. On the
 * app-token lane (#1926) an app acts with `azp` = itself and `sub` = the
 * principal, so a request whose `requester` resolved to the subject rendered
 * the owner's own DID as both requester and subject — the delegate vanished
 * from the one surface meant to name it. The request's `appDid` (the `azp`)
 * and the `subject` are therefore both carried into the notification `data`,
 * so the template can render the ACTING party plus an on-behalf-of clause.
 * `appDid` is omitted from the payload entirely when absent, keeping a true
 * first-party request byte-identical to its pre-#2366 shape.
 *
 * Fire-and-forget — never throws. Skipped in preview and shadow modes.
 */
export async function sendConsentRequestNotification(
  request: BrokerPipelineState['request'],
  reason: string,
): Promise<void> {
  // Only notify for genuine no_consent rejections; skip everything else.
  if (reason !== 'no_consent') return;
  // Skip preview and shadow; they are not real requests.
  if (request.preview || request.mode === 'shadow') return;

  const notifyUrl = process.env.NOTIFY_SERVICE_URL;
  const secret = process.env.NOTIFY_WEBHOOK_SECRET;
  if (!notifyUrl || !secret) return;

  try {
    await fetch(`${notifyUrl}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secret },
      body: JSON.stringify({
        to: request.subject,
        scope: 'broker:consent-request',
        urgency: 'urgent',
        data: {
          requesterDid: request.requester,
          // The `{did, appDid}` pair every owner-facing alert renders from:
          // `did` is the principal (this notification's recipient), `appDid`
          // the delegate that actually acted (#2366).
          did: request.subject,
          ...(request.appDid ? { appDid: request.appDid } : {}),
          purpose: request.purpose,
          fields: request.fields,
          requestedAt: new Date().toISOString(),
        },
      }),
    });
  } catch (err) {
    log.error({ err: String(err) }, 'sendConsentRequestNotification fetch failed');
  }
}
