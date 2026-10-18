import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { requireCronAuth } from '@/src/cron/auth';
import { recheckDomains } from '@/src/lib/domains/service';

export const dynamic = 'force-dynamic';
const log = createLogger('kernel:domains');

export async function GET(request: NextRequest) {
  const denied = await requireCronAuth(request);
  if (denied) return denied;
  try {
    return NextResponse.json({ ok: true, ...await recheckDomains() });
  } catch {
    log.error({}, 'Domain recheck failed');
    return NextResponse.json({ error: 'Domain recheck failed' }, { status: 500 });
  }
}
