import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { getOperatorDid, isOperatorIdentity } from '@/src/lib/notify/operator-approvals';
import { listRegisteredApps } from '@/src/lib/apps/registered-apps';

export const dynamic = 'force-dynamic';
const HEADERS = { 'Cache-Control': 'no-store' };

/** Operator-only metadata. Deliberately no mutation handlers. */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: HEADERS });
  }
  const operator = await getOperatorDid();
  if (!operator || !isOperatorIdentity(auth.identity, operator)) {
    return NextResponse.json({ error: 'Node operator required' }, { status: 403, headers: HEADERS });
  }
  try {
    return NextResponse.json({ apps: await listRegisteredApps() }, { headers: HEADERS });
  } catch {
    return NextResponse.json({ error: 'Registered apps unavailable' }, { status: 503, headers: HEADERS });
  }
}
