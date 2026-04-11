import { NextRequest, NextResponse } from 'next/server';
import { db, didPreferences, didInterests } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * GET /api/audience/[scope]
 * Internal endpoint — returns DIDs opted in for marketing for a given scope.
 *
 * A DID is included when:
 *   - did_preferences.global_marketing = true (or no row — default true)
 *   - did_interests.marketing = true for this scope
 *
 * Optional ?channel=email also requires did_interests.email = true.
 *
 * Auth: x-webhook-secret header (kernel services only)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ scope: string }> }
) {
  // Verify webhook secret
  const secret = request.headers.get('x-webhook-secret');
  if (!secret || secret !== process.env.NOTIFY_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { scope } = await params;
  const { searchParams } = new URL(request.url);
  const channel = searchParams.get('channel'); // optional: 'email' | 'inapp' | 'chat'

  try {
    // Build conditions for did_interests
    const interestConditions = [
      eq(didInterests.scope, scope),
      eq(didInterests.marketing, true),
    ];

    if (channel === 'email') {
      interestConditions.push(eq(didInterests.email, true));
    } else if (channel === 'inapp') {
      interestConditions.push(eq(didInterests.inapp, true));
    } else if (channel === 'chat') {
      interestConditions.push(eq(didInterests.chat, true));
    }

    // Get all DIDs subscribed to this scope with marketing on
    const scopeRows = await db
      .select({ did: didInterests.did })
      .from(didInterests)
      .where(and(...interestConditions));

    if (scopeRows.length === 0) {
      return NextResponse.json({ dids: [], scope });
    }

    const scopeDids = scopeRows.map(r => r.did);

    // Filter out DIDs that have explicitly set global_marketing = false
    // DIDs with no row in did_preferences default to global_marketing = true
    const optedOutRows = await db
      .select({ did: didPreferences.did })
      .from(didPreferences)
      .where(eq(didPreferences.globalMarketing, false));

    const optedOutSet = new Set(optedOutRows.map(r => r.did));
    const dids = scopeDids.filter(did => !optedOutSet.has(did));

    return NextResponse.json({ dids, scope, total: dids.length });
  } catch (error) {
    log.error({ err: String(error) }, '[audience/scope] get error');
    return NextResponse.json({ error: 'Failed to query audience' }, { status: 500 });
  }
}
