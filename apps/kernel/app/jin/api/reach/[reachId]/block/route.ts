import { requireAuth } from '@imajin/auth';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { blockReachSender, getReachEnvelope } from '@/src/lib/auth/reach-envelope-store';
import { isReachPrincipal } from '@/src/lib/auth/reach-reply-service';
import { blockForeignAgentStub } from '@/src/lib/auth/foreign-agent-stub';

const log = createLogger('kernel:reach:block');
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, props: Readonly<{ params: Promise<{ reachId: string }> }>) {
  const headers = corsHeaders(request);
  const auth = await requireAuth(request, { sessionOnly: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  if (!isReachPrincipal(auth.identity)) {
    return NextResponse.json({ error: 'A direct human session is required' }, { status: 403, headers });
  }
  try {
    const { reachId } = await props.params;
    const envelope = await getReachEnvelope({ principalDid: auth.identity.id, reachId });
    if (!envelope) return NextResponse.json({ error: 'Reach envelope not found' }, { status: 404, headers });
    await blockForeignAgentStub(envelope.requesterDid, auth.identity.id);
    await blockReachSender({ principalDid: auth.identity.id, requesterDid: envelope.requesterDid });
    return NextResponse.json({ blocked: true }, { headers });
  } catch (error) {
    log.error({ err: String(error) }, 'Reach sender block failed');
    return NextResponse.json({ error: 'Unable to block reach sender' }, { status: 503, headers });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
