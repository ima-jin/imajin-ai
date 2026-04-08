import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { db, interests } from '@/src/db';
import { eq } from 'drizzle-orm';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * GET /api/interests/[scope]
 * Get interest metadata + triggers for a specific scope
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ scope: string }> }
) {
  const cors = corsHeaders(request);

  try {
    const { scope } = await params;

    const [interest] = await db
      .select()
      .from(interests)
      .where(eq(interests.scope, scope))
      .limit(1);

    if (!interest) {
      return NextResponse.json({ error: 'Interest not found' }, { status: 404, headers: cors });
    }

    return NextResponse.json({ interest }, { headers: cors });
  } catch (error) {
    console.error('[interests/scope] get error:', error);
    return NextResponse.json({ error: 'Failed to get interest' }, { status: 500, headers: cors });
  }
}
