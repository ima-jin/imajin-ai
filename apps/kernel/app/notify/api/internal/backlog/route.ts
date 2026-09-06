/**
 * POST /notify/api/internal/backlog
 *
 * Internal-only endpoint (guarded by AUTH_INTERNAL_API_KEY via the
 * `x-internal-key` header, same convention as
 * `/auth/api/internal/verify-delegation`) that answers: what has `did` not
 * yet been delivered? `ws-server.js`'s connection handler calls this
 * immediately after sending `{type: 'connected'}` and replays the returned
 * frames down the socket that just connected (#2044) — ws-server.js is
 * plain CJS running outside Next, so it reaches the database through this
 * route rather than importing drizzle directly, the same shape as
 * verify-delegation and the session/ws-token checks it already makes.
 *
 * Each returned frame has already been atomically claimed
 * (`getNotificationBacklog` -> `delivery.ts`'s `delivered_at IS NULL`
 * guard), so a notification created at the exact instant this fires is
 * delivered by exactly one of this replay or a concurrent live push, never
 * both.
 *
 * Fails closed and degrades gracefully: an unauthenticated caller gets 401;
 * a lookup failure returns an empty, non-truncated backlog rather than
 * throwing — a missed replay here is retried on the next reconnect, not a
 * reason to break the connection handshake.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getNotificationBacklog } from '@/src/lib/notify/backlog';
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

  const { did } = (body ?? {}) as Record<string, unknown>;
  if (typeof did !== 'string' || !did) {
    return NextResponse.json({ error: 'Missing did' }, { status: 400 });
  }

  try {
    const { frames, truncated } = await getNotificationBacklog(did);
    if (truncated) {
      log.warn({ did, count: frames.length }, 'Notification backlog truncated for recipient');
    }
    return NextResponse.json({ frames, truncated });
  } catch (err) {
    log.error({ did, err: String(err) }, 'Notification backlog lookup failed');
    return NextResponse.json({ frames: [], truncated: false, error: 'Lookup failed' }, { status: 500 });
  }
}
