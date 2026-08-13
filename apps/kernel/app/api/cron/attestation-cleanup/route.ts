import { NextRequest, NextResponse } from 'next/server';
import { and, isNotNull, lt } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, attestations } from '@/src/db';

const log = createLogger('kernel');

/**
 * This route mutates the database and must never be evaluated at build time.
 */
export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/attestation-cleanup — purge attestations whose expires_at has passed.
 *
 * Vercel Cron job (schedule: "0 0 * * *" — daily at midnight). Registered in vercel.json.
 * Protected by Authorization: Bearer {CRON_SECRET}.
 *
 * This is a generic cleanup sweep: any attestation row with expires_at set and
 * expired is deleted. Types opt in to automatic retention by setting expires_at
 * at creation time (e.g. agent.turn.usage with a 90-day rolling window).
 *
 * No bus events are emitted — deletion is a garbage-collection operation, not a
 * state transition that other services need to react to.
 */
export async function GET(request: NextRequest) {
  // Validate Vercel CRON_SECRET. When CRON_SECRET is unset (local dev),
  // any request is allowed so the route can be exercised manually.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const now = new Date();

    const deleted = await db
      .delete(attestations)
      .where(
        and(
          isNotNull(attestations.expiresAt),
          lt(attestations.expiresAt, now),
        ),
      )
      .returning({ id: attestations.id });

    log.info({ deleted: deleted.length }, 'Attestation cleanup sweep complete');

    return NextResponse.json({
      ok: true,
      deleted: deleted.length,
      ids: deleted.map((row) => row.id),
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Attestation cleanup sweep failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
