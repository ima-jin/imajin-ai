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
