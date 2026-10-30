import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { requireCronAuth } from '@/src/cron/auth';
import { sweepAppAuthorizationCodes } from '@/src/lib/auth/app-authorization-code-retention';

const log = createLogger('kernel');

export const dynamic = 'force-dynamic';

/** GET /api/cron/app-authorization-code-cleanup — every ten minutes, vault cron auth only. */
export async function GET(request: NextRequest) {
  const denied = await requireCronAuth(request);
  if (denied) return denied;

  try {
    const deleted = await sweepAppAuthorizationCodes();
    log.info({ deleted }, 'App authorization code cleanup sweep complete');
    return NextResponse.json({ ok: true, deleted });
  } catch {
    // Never log database errors: they may contain bearer-related row data.
    log.error({}, 'App authorization code cleanup sweep failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
