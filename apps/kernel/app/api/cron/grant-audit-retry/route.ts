import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/src/cron/auth';
import { retryGrantRevocationAudits } from '@/src/lib/auth/grants';

export const dynamic = 'force-dynamic';

/** Revocations already committed; retry only their signed history, never authority. */
export async function GET(request: Request) {
  const denied = await requireCronAuth(request);
  if (denied) return denied;
  try {
    return NextResponse.json({ ok: true, ...await retryGrantRevocationAudits() });
  } catch {
    return NextResponse.json({ error: 'Grant audit retry unavailable' }, { status: 500 });
  }
}
