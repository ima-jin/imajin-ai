import { requireAuth } from '@imajin/auth';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { listReachInbox } from '@/src/lib/auth/reach-reply-store';
import { isReachPrincipal } from '@/src/lib/auth/reach-reply-service';

const log = createLogger('kernel:reach');
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const headers = corsHeaders(request);
  const auth = await requireAuth(request, { sessionOnly: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  if (!isReachPrincipal(auth.identity)) {
    return NextResponse.json({ error: 'A direct human session is required' }, { status: 403, headers });
  }
  try {
    const envelopes = await listReachInbox({ principalDid: auth.identity.id });
    return NextResponse.json({ principalDid: auth.identity.id, envelopes }, { headers });
  } catch (error) {
    log.error({ err: String(error) }, 'Reach inbox read failed');
    return NextResponse.json({ error: 'Unable to load reach inbox' }, { status: 500, headers });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
