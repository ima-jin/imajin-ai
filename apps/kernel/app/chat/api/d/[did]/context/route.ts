import { NextRequest } from 'next/server';
import { db, conversationsV2 } from '@/src/db';
import { eq, sql } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse } from '@/src/lib/kernel/utils';
import { corsOptions, corsHeaders } from '@/src/lib/kernel/cors';

/**
 * OPTIONS /api/d/:did/context - CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * PATCH /api/d/:did/context - Merge context into a conversation
 * Body: { context: Record<string, unknown> }
 *
 * Supports internal service auth (Bearer AUTH_INTERNAL_API_KEY)
 * or user auth via requireAuth.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const { did } = await params;
  const cors = corsHeaders(request);

  // Check internal auth first
  const internalApiKey = process.env.AUTH_INTERNAL_API_KEY;
  const authHeader = request.headers.get('authorization');
  const isInternal = internalApiKey && authHeader === `Bearer ${internalApiKey}`;

  if (!isInternal) {
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return errorResponse(authResult.error, authResult.status, cors);
    }
  }

  let body: { context: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON', 400, cors);
  }

  if (!body.context || typeof body.context !== 'object') {
    return errorResponse('context object is required', 400, cors);
  }

  // Merge into existing context
  await db
    .update(conversationsV2)
    .set({
      context: sql`COALESCE(${conversationsV2.context}, '{}')::jsonb || ${JSON.stringify(body.context)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(conversationsV2.did, did));

  return jsonResponse({ success: true }, 200, cors);
}
