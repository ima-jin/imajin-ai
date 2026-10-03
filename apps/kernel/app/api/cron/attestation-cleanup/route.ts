import { NextRequest, NextResponse } from 'next/server';
import { and, isNotNull, lt } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, attestations } from '@/src/db';
import { requireCronAuth } from '@/src/cron/auth';

const log = createLogger('kernel');

/**
 * This route mutates the database and must never be evaluated at build time.
 */
export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/attestation-cleanup — purge attestations whose expires_at has passed.
 *
 * Scheduled job (schedule: "0 0 * * *" — daily at midnight). Registered in src/cron/schedule.ts.
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
  // Fail closed (#2550): 503 when CRON_SECRET is unset, 401 on a wrong bearer.
  const denied = requireCronAuth(request);
  if (denied) return denied;

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
