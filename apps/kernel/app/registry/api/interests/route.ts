import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { db, interests } from '@/src/db';
import { asc } from 'drizzle-orm';
import { withLogger } from '@imajin/logger';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * GET /api/interests
 * List all registered interest scopes
 */
export const GET = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  try {
    const all = await db
      .select()
      .from(interests)
      .orderBy(asc(interests.scope));

    return NextResponse.json({ interests: all }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, '[interests] list error');
    return NextResponse.json({ error: 'Failed to list interests' }, { status: 500, headers: cors });
  }
});
