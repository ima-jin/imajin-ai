import { getVaultInternalApiKey } from '@imajin/auth';
import { createHash } from 'node:crypto';
import { createLogger } from '@imajin/logger';
import type { BrokerPipelineState } from '../types';

const log = createLogger('bus:broker:consent-request-notify');
/**
 * The bell's Approve/Deny path marks the notification read. Until then (or
 * the 24-hour request TTL), reuse that pending alert, including alerts made
 * before dedupe shipped. A nonblocking transaction-scoped lock drops racing
 * loads while one worker waits for the notify service's persisted insert.
 */
async function notifyOnce(request: BrokerPipelineState['request'], send: () => Promise<void>): Promise<void> {
  const fields = [...new Set(request.fields)].sort();
  const key = createHash('sha256')
    .update(JSON.stringify([request.requester, request.subject, request.purpose, fields]))
    .digest('hex');
  const { getClient } = await import('@imajin/db');
  const sql = getClient();
  await sql.begin(async (tx) => {
    const [lock] = await tx`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS acquired`;
    if (!lock.acquired) return;
    const existing = await tx`
      SELECT id FROM notify.notifications
      WHERE recipient_did = ${request.subject}
        AND scope = 'broker:consent-request'
        AND read = false
        AND created_at > NOW() - INTERVAL '24 hours'
        AND data->>'requesterDid' = ${request.requester}
        AND data->>'purpose' = ${request.purpose}
        AND COALESCE((
          SELECT jsonb_agg(field ORDER BY field)
          FROM (SELECT DISTINCT jsonb_array_elements_text(data->'fields') AS field) normalized
        ), '[]'::jsonb) = ${JSON.stringify(fields)}::jsonb
      LIMIT 1
    `;
    if (existing.length === 0) await send();
  });
}

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
  const secret = getVaultInternalApiKey();
  if (!notifyUrl || !secret) return;

  try {
    await notifyOnce(request, async () => {
      const response = await fetch(`${notifyUrl}/api/send`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
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
      if (!response.ok) throw new Error(`Notify service returned ${response.status}`);
    });
  } catch (err) {
    log.error({ err: String(err) }, 'sendConsentRequestNotification failed');
  }
}
