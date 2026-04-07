import { NextRequest } from 'next/server';
import { db, conversationReadsV2 } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse } from '@/src/lib/kernel/utils';
import { corsOptions, corsHeaders } from "@/src/lib/kernel/cors";

/**
 * OPTIONS /api/d/:did/read - CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * POST /api/d/:did/read - Mark a DID-keyed conversation as read
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status, cors);
  }

  const { identity } = authResult;
  const effectiveDid = identity.actingAs || identity.id;
  const { did } = await params;

  try {
    await db.insert(conversationReadsV2).values({
      conversationDid: did,
      did: effectiveDid,
      lastReadAt: new Date(),
    }).onConflictDoUpdate({
      target: [conversationReadsV2.conversationDid, conversationReadsV2.did],
      set: { lastReadAt: new Date() },
    });

    return jsonResponse({ ok: true }, 200, cors);
  } catch (error) {
    console.error('Failed to mark as read:', error);
    return errorResponse('Failed to mark as read', 500, cors);
  }
}
