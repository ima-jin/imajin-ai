import { requireAuth } from '@imajin/auth';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { isReachPrincipal, parseReachReplyInput, replyToReach } from '@/src/lib/auth/reach-reply-service';

const log = createLogger('kernel:reach:reply');
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, props: Readonly<{ params: Promise<{ reachId: string }> }>) {
  const headers = corsHeaders(request);
  const auth = await requireAuth(request, { sessionOnly: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  if (!isReachPrincipal(auth.identity)) {
    return NextResponse.json({ error: 'A direct human session is required' }, { status: 403, headers });
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON' }, { status: 400, headers });
  }
  const input = parseReachReplyInput(raw);
  if (!input) return NextResponse.json({ error: 'A message, issuedAt and Ed25519 signature are required' }, { status: 400, headers });
  try {
    const { reachId } = await props.params;
    const result = await replyToReach({ identity: auth.identity, reachId, input });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers });
    return NextResponse.json({ reply: result.reply }, { headers });
  } catch (error) {
    log.error({ err: String(error) }, 'Reach reply publication failed');
    return NextResponse.json({ error: 'Reply publication failed; retry the same signed reply' }, { status: 503, headers });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
