import { requireAuth } from '@imajin/auth';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { blockReachBearerKnock } from '@/src/lib/access/reach-bearer';
import { isReachPrincipal } from '@/src/lib/auth/reach-reply-service';

const log = createLogger('kernel:reach:knock:block');
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, props: Readonly<{ params: Promise<{ requestId: string }> }>) {
  const headers = corsHeaders(request);
  const auth = await requireAuth(request, { sessionOnly: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  if (!isReachPrincipal(auth.identity)) {
    return NextResponse.json({ error: 'A direct human session is required' }, { status: 403, headers });
  }
  try {
    const { requestId } = await props.params;
    const blocked = await blockReachBearerKnock({ principalDid: auth.identity.id, requestId });
    if (!blocked) return NextResponse.json({ error: 'Reach knock not found' }, { status: 404, headers });
    return NextResponse.json({ blocked: true }, { headers });
  } catch (error) {
    log.error({ err: String(error) }, 'Reach knock sender block failed');
    return NextResponse.json({ error: 'Unable to block reach sender' }, { status: 503, headers });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
