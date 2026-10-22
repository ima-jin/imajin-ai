import { NextRequest, NextResponse } from 'next/server';
import { requireCronAuth } from '@/src/cron/auth';
import { expireApprovals } from '@/src/lib/notify/approval-expiry';
import { createLogger } from '@imajin/logger';

export const dynamic = 'force-dynamic';
const log = createLogger('kernel:approval-expiry');

export async function GET(request: NextRequest) {
  const denied = await requireCronAuth(request);
  if (denied) return denied;
  try {
    return NextResponse.json({ ok: true, expired: await expireApprovals() });
  } catch {
    log.error({}, 'Approval expiry failed; unsigned state changes are refused');
    return NextResponse.json({ error: 'Approval expiry unavailable' }, { status: 500 });
  }
}
