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
 */
import { NextRequest, NextResponse } from 'next/server';
import { ackNotificationDelivery } from '@/src/lib/notify/delivery';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function POST(request: NextRequest) {
  const expectedKey = process.env.AUTH_INTERNAL_API_KEY;
  // An unset key must not degrade into "any caller matches undefined".
  if (!expectedKey || request.headers.get('x-internal-key') !== expectedKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { id } = (body ?? {}) as Record<string, unknown>;
  if (typeof id !== 'string' || !id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }

  try {
    const delivered = await ackNotificationDelivery(id);
    return NextResponse.json({ ok: true, delivered });
  } catch (err) {
    log.error({ id, err: String(err) }, 'Notification ack failed');
    return NextResponse.json({ ok: false, error: 'Ack failed' }, { status: 500 });
  }
}
