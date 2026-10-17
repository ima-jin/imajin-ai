import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP } from '@imajin/config';
import { KNOCK_IP_RATE_LIMIT, KNOCK_IP_RATE_WINDOW, KNOCK_TARGET_RATE_LIMIT, KNOCK_TARGET_RATE_WINDOW } from '@imajin/auth';
import { issueReachBearer, parseReachKnock, resolveReachRecipient } from '@/src/lib/access/reach-bearer';
import { readReachBody, ReachBodyTooLarge } from '@/src/lib/auth/reach-abuse-guard';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

function limited(limit: ReturnType<typeof rateLimit>) {
  return NextResponse.json({ error: 'Too many knocks', retryAfter: limit.retryAfter },
    { status: 429, headers: { ...headers, 'Retry-After': String(limit.retryAfter) } });
}

export async function POST(request: NextRequest, props: Readonly<{ params: Promise<{ handle: string }> }>) {
  const ip = rateLimit(`knock:ip:${getClientIP(request)}`, KNOCK_IP_RATE_LIMIT, KNOCK_IP_RATE_WINDOW);
  if (ip.limited) return limited(ip);
  try {
    const parsed = parseReachKnock(await readReachBody(request));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers });
    const { handle } = await props.params;
    const principal = await resolveReachRecipient(handle);
    if (!principal) return NextResponse.json({ error: 'Reach recipient not found' }, { status: 404, headers });
    const target = rateLimit(`knock:target:${principal.id}`, KNOCK_TARGET_RATE_LIMIT, KNOCK_TARGET_RATE_WINDOW);
    if (target.limited) return limited(target);
    const result = await issueReachBearer(principal.id, parsed.input);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers });
    return NextResponse.json({
      bearer: result.bearer, bearerId: result.bearerId, requestId: result.requestId,
      requesterDid: result.requesterDid, audience: result.audience, scopes: result.scopes,
      surfaces: result.surfaces, claimVerified: result.claimVerified,
      expiresAt: result.expiresAt, hardCapAt: result.hardCapAt,
    }, { status: 201, headers });
  } catch (error) {
    if (error instanceof ReachBodyTooLarge) return NextResponse.json({ error: 'body_too_large' }, { status: 413, headers });
    // Deliberately never log errors from issuance: DB errors can include query parameters.
    const status = error instanceof SyntaxError ? 400 : 503;
    return NextResponse.json({ error: status === 400 ? 'Invalid JSON' : 'Unable to issue reach credential' }, { status, headers });
  }
}
