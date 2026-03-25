import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/src/db';
import { storedKeys } from '@/src/db/schema';
import { eq } from 'drizzle-orm';
import { verifySessionToken, getSessionCookieOptions } from '@/lib/jwt';
import { corsHeaders } from '@imajin/config';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * DELETE /api/keys/stored
 * Remove the stored encrypted key for the authenticated user.
 * Requires authentication only (no MFA — this is a destructive action
 * that the user should be able to perform if they lose their MFA device).
 */
export async function DELETE(request: NextRequest) {
  const cors = corsHeaders(request);

  try {
    const cookieConfig = getSessionCookieOptions();
    const token = request.cookies.get(cookieConfig.name)?.value;
    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: cors });
    }
    const session = await verifySessionToken(token);
    if (!session) {
      return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401, headers: cors });
    }

    const result = await db
      .delete(storedKeys)
      .where(eq(storedKeys.did, session.sub))
      .returning();

    if (result.length === 0) {
      return NextResponse.json({ error: 'No stored key found' }, { status: 404, headers: cors });
    }

    return NextResponse.json({ deleted: true }, { headers: cors });

  } catch (error) {
    console.error('[keys/stored] DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete stored key' }, { status: 500, headers: cors });
  }
}
