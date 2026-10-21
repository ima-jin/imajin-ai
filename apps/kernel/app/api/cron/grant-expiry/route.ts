import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/src/cron/auth';
import { notifyExpiringOperatorGrants } from '@/src/lib/notify/grant-expiry';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const denied = await requireCronAuth(request);
  if (denied) return denied;
  try {
    return NextResponse.json({ ok: true, ...await notifyExpiringOperatorGrants() });
  } catch {
    return NextResponse.json({ error: 'Grant expiry notifications unavailable' }, { status: 500 });
  }
}
