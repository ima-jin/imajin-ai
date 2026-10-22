import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { requireCronAuth } from '@/src/cron/auth';
import { expireRegistryApps } from '@/src/lib/apps/registry-app-expiry';

const log = createLogger('kernel');
export const dynamic = 'force-dynamic';

/** GET /api/cron/registry-app-expiry — bounded, signed 7-day DCR expiry. */
export async function GET(request: NextRequest) {
  const denied = await requireCronAuth(request);
  if (denied) return denied;
  try {
    const outcome = await expireRegistryApps();
    log.info(outcome, 'Registry app expiry complete');
    return NextResponse.json({ ok: true, ...outcome });
  } catch {
    log.error('Registry app expiry failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
