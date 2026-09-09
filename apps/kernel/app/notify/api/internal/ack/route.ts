/**
 * POST /notify/api/internal/ack
 *
 * Internal-only endpoint (guarded by AUTH_INTERNAL_API_KEY via the
 * `x-internal-key` header, same convention as `/notify/api/internal/backlog`
 * and `/auth/api/internal/verify-delegation`) that answers the plugin's
 * `{ type: 'notification_ack', id }` frame (#2099): the only place
 * `delivered_at` is ever set. `ws-server.js` calls this from its message
 * handler when a connected socket sends that frame — ws-server.js is plain
 * CJS running outside Next, so it reaches the database through this route
 * rather than importing drizzle directly, the same shape as `backlog` and
 * `release`.
 *
 * A no-op, not an error, for an unknown or already-acked id — the plugin
 * dedups by notification id on its own, so a duplicate or late ack for a
 * row this kernel no longer considers pending must never surface as a
 * failure back to a WS message handler that has nowhere useful to report
 * one anyway.
 *
 * Requires `did`, the acking socket's own authenticated DID (PR #2101
 * review): `ackNotificationDelivery` scopes its UPDATE to that DID, so an
 * authenticated peer can only ever ack its own notifications, never an
 * arbitrary id belonging to someone else -- `ws-server.js` passes
 * `meta.did` from the socket that sent the frame, never a value read out
 * of the frame itself.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ackNotificationDelivery } from '@/src/lib/notify/delivery';
import { requireInternalKey, parseJsonBody, requireStringField } from '@/src/lib/notify/internal-route-guards';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function POST(request: NextRequest) {
  const unauthorized = requireInternalKey(request);
  if (unauthorized) return unauthorized;

  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;

  const idField = requireStringField(parsed.body, 'id');
  if (!idField.ok) return idField.response;

  const didField = requireStringField(parsed.body, 'did');
  if (!didField.ok) return didField.response;

  try {
    const delivered = await ackNotificationDelivery(idField.value, didField.value);
    return NextResponse.json({ ok: true, delivered });
  } catch (err) {
    log.error({ id: idField.value, did: didField.value, err: String(err) }, 'Notification ack failed');
    return NextResponse.json({ ok: false, error: 'Ack failed' }, { status: 500 });
  }
}
