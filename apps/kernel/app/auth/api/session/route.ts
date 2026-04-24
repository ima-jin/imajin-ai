import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { db, identities, identityChains, credentials } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { withLogger } from '@imajin/logger';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}


export const GET = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  try {
    const cookieConfig = getSessionCookieOptions();
    const token = request.cookies.get(cookieConfig.name)?.value;

    if (!token) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401, headers: cors }
      );
    }

    const session = await verifySessionToken(token);
    if (!session) {
      const response = NextResponse.json(
        { error: 'Invalid or expired session' },
        { status: 401, headers: cors }
      );
      response.cookies.delete(cookieConfig.name);
      return response;
    }

    const identity = await db.select().from(identities).where(eq(identities.id, session.sub)).limit(1);
    if (identity.length === 0) {
      const response = NextResponse.json(
        { error: 'Identity not found' },
        { status: 401, headers: cors }
      );
      response.cookies.delete(cookieConfig.name);
      return response;
    }

    const metadata = identity[0].metadata as Record<string, unknown> || {};
    const tier = (identity[0] as any).tier || 'soft';

    const [chain, emailCred] = await Promise.all([
      db.select({ did: identityChains.did })
        .from(identityChains)
        .where(eq(identityChains.did, session.sub))
        .limit(1),
      db.select({ value: credentials.value })
        .from(credentials)
        .where(and(eq(credentials.did, session.sub), eq(credentials.type, 'email')))
        .limit(1),
    ]);
    const chainVerified = chain.length > 0;

    return NextResponse.json({
      did: session.sub,
      handle: identity[0].handle || session.handle,
      scope: identity[0].scope || session.scope,
      subtype: identity[0].subtype || session.subtype || undefined,
      name: identity[0].name || session.name,
      email: emailCred[0]?.value ?? null,
      role: metadata.role || 'member',
      tier,
      chainVerified,
    }, { headers: cors });

  } catch (error) {
    log.error({ err: String(error) }, 'Session error');
    return NextResponse.json(
      { error: 'Failed to get session' },
      { status: 500, headers: cors }
    );
  }
});
