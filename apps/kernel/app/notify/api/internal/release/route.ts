/**
 * POST /notify/api/internal/release
 *
 * Internal-only endpoint (guarded by AUTH_INTERNAL_API_KEY via the
 * `x-internal-key` header, same convention as `/notify/api/internal/backlog`
 * and `/notify/api/internal/ack`) that releases every un-acked WS claim for
 * one DID (#2099). `ws-server.js`'s heartbeat calls this the moment it
 * terminates a socket that missed too many pongs — immediately, rather than
 * waiting for the 30s ack timeout to elapse on its own — so a fast reconnect
 * for that DID gets its backlog replayed right away instead of stalling
 * until each claim ages out.
 *
 * Fails closed on an unauthenticated caller; degrades to "nothing released
 * this time" on a lookup failure rather than throwing — a missed release
 * here just means the row waits out its own ack timeout instead, never a
 * reason to break the heartbeat's cleanup of a dead socket.
 */
import { NextRequest, NextResponse } from 'next/server';
import { releaseWsClaimsForDid } from '@/src/lib/notify/delivery';
import { requireInternalKey, parseJsonBody, requireStringField } from '@/src/lib/notify/internal-route-guards';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function POST(request: NextRequest) {
  const unauthorized = requireInternalKey(request);
  if (unauthorized) return unauthorized;

  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;

  const didField = requireStringField(parsed.body, 'did');
  if (!didField.ok) return didField.response;

  try {
    await releaseWsClaimsForDid(didField.value);
    return NextResponse.json({ ok: true });
  } catch (err) {
    log.error({ did: didField.value, err: String(err) }, 'Notification WS claim release failed');
    return NextResponse.json({ ok: false, error: 'Release failed' }, { status: 500 });
  }
}
