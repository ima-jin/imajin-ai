import { createLogger } from '@imajin/logger';
import { randomUUID } from 'node:crypto';
import type { ReactorHandler } from '../types';

const log = createLogger('bus:reactor:notify-match-delivery');

/**
 * Notify-match-delivery reactor.
 *
 * Registered for `availability.match.surfaced`. When the match engine surfaces
 * a match it publishes this event per recipient. This reactor writes a row to
 * `kernel.match_notifications` so the broker agent can poll and deliver to chat.
 *
 * Designed to be non-blocking and fail-safe — delivery failure should never
 * block the bus pipeline. Errors are logged and swallowed.
 */
export const notifyMatchDeliveryReactor: ReactorHandler = async (event) => {
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  const matchId = typeof payload.matchId === 'string' ? payload.matchId : null;
  const recipientDid = typeof payload.recipientDid === 'string' ? payload.recipientDid : null;
  const overlapTags = Array.isArray(payload.overlapTags) ? (payload.overlapTags as string[]) : [];
  const isSensitive = payload.isSensitive === true;
  const deliveryPolicy = typeof payload.deliveryPolicy === 'string' ? payload.deliveryPolicy : 'staged';

  // otherDid: empty string for sensitive_staged (never reveal identity);
  // non-empty for named_nudge / staged (arriver can see the match exists).
  const otherDidRaw = typeof payload.otherDid === 'string' ? payload.otherDid : '';
  const otherDid = otherDidRaw === '' ? null : otherDidRaw;

  if (!matchId || !recipientDid) {
    log.warn({ payload }, 'notify-match-delivery: missing matchId or recipientDid');
    return;
  }

  if (overlapTags.length === 0) {
    log.info({ matchId, recipientDid }, 'notify-match-delivery: no overlap tags, skipping');
    return;
  }

  try {
    const { getClient } = await import('@imajin/db');
    const sql = getClient();

    await sql`
      INSERT INTO kernel.match_notifications
        (id, match_id, recipient_did, other_did, overlap_tags, is_sensitive, delivery_policy)
      VALUES (
        ${randomUUID()},
        ${matchId},
        ${recipientDid},
        ${otherDid},
        ${overlapTags},
        ${isSensitive},
        ${deliveryPolicy}
      )
      ON CONFLICT DO NOTHING
    `;

    log.info({ matchId, recipientDid, deliveryPolicy }, 'Match notification written for bot delivery');
  } catch (err) {
    log.error({ err: String(err), matchId, recipientDid }, 'notify-match-delivery: DB write failed (non-fatal)');
    // Swallow — notification delivery is best-effort; the match itself already fired.
  }
};
