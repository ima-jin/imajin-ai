/**
 * GET /auth/api/events/subscriptions/catchup — cursor-based catch-up for the
 * grant-bound event-subscription surface (#1884).
 *
 * Session-authenticated (same challenge-response-issued session/token any
 * identity — including a #1883 knock-minted agent — already uses): the
 * caller can only ever catch up on its own DID's entitlements, resolved
 * fresh from its currently active grants (#1882). There is no separate
 * subscription ACL to authorize against.
 *
 * Query params:
 *   cursor — last seq the caller has processed (default: 0, i.e. from the
 *            start of the retention window).
 *   limit  — optional page size (default/max: EVENT_SUBSCRIPTION_CATCHUP_PAGE_SIZE).
 *
 * Returns: { events, nextCursor, entitledEventTypes }
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { catchUpSubscriptionEvents } from '@/src/lib/auth/event-subscriptions';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const agentDid = authResult.identity.actingAs ?? authResult.identity.id;

  const { searchParams } = new URL(request.url);

  const cursorParam = searchParams.get('cursor');
  let cursor: bigint;
  try {
    cursor = cursorParam ? BigInt(cursorParam) : BigInt(0);
    if (cursor < BigInt(0)) throw new Error('negative cursor');
  } catch {
    return NextResponse.json({ error: 'cursor must be a non-negative integer' }, { status: 400 });
  }

  const limitParam = searchParams.get('limit');
  let limit: number | undefined;
  if (limitParam !== null) {
    limit = Number.parseInt(limitParam, 10);
    if (!Number.isFinite(limit) || limit <= 0) {
      return NextResponse.json({ error: 'limit must be a positive integer' }, { status: 400 });
    }
  }

  try {
    const result = await catchUpSubscriptionEvents({ agentDid, cursor, limit });
    return NextResponse.json(result);
  } catch (err) {
    log.error({ err: String(err), agentDid }, 'Event-subscription catch-up lookup failed');
    return NextResponse.json({ error: 'Catch-up lookup failed' }, { status: 500 });
  }
}
