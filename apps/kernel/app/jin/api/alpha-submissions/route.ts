import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { getOperatorDid, isOperatorIdentity } from '@/src/lib/notify/operator-approvals';
import { isAlphaIntent } from '@/src/lib/alpha/contract';
import { listAlphaSubmissions } from '@/src/lib/alpha/store';

export const dynamic = 'force-dynamic';
const HEADERS = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status, headers: HEADERS });
  const operator = await getOperatorDid();
  // Reuse the direct operator gate. Org act-as never grants operator access,
  // including when the personal session belongs to the node operator.
  if (!operator || auth.identity.actingAs || !isOperatorIdentity(auth.identity, operator)) {
    return NextResponse.json({ error: 'Node operator required in personal context' }, { status: 403, headers: HEADERS });
  }
  const intent = request.nextUrl.searchParams.get('intent');
  const offsetRaw = request.nextUrl.searchParams.get('offset') ?? '0';
  const offset = Number(offsetRaw);
  if ((intent !== null && !isAlphaIntent(intent)) || !/^\d{1,9}$/.test(offsetRaw) || !Number.isSafeInteger(offset)) {
    return NextResponse.json({ error: 'Invalid intent or offset' }, { status: 400, headers: HEADERS });
  }
  try {
    return NextResponse.json(await listAlphaSubmissions(intent ?? undefined, offset), { headers: HEADERS });
  } catch {
    return NextResponse.json({ error: 'Alpha requests unavailable' }, { status: 503, headers: HEADERS });
  }
}
