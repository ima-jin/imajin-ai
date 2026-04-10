import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { requireAuth } from '@imajin/auth';
import { db, bumpSessions } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

const ALLOWED_EXPIRY_MINUTES = [1, 5, 15, 75] as const;
type ExpiryMinutes = typeof ALLOWED_EXPIRY_MINUTES[number];

/**
 * POST /registry/api/bump/activate
 * Open a bump session for the caller on a specific node.
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  let body: { nodeId?: string; expiryMinutes?: number; location?: { lat: number; lng: number } };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { nodeId, expiryMinutes, location } = body;

  if (!nodeId || typeof nodeId !== 'string') {
    return NextResponse.json({ error: 'nodeId is required' }, { status: 400, headers: cors });
  }

  if (!ALLOWED_EXPIRY_MINUTES.includes(expiryMinutes as ExpiryMinutes)) {
    return NextResponse.json(
      { error: `expiryMinutes must be one of: ${ALLOWED_EXPIRY_MINUTES.join(', ')}` },
      { status: 400, headers: cors },
    );
  }

  const did = authResult.identity.actingAs || authResult.identity.id;
  const sessionId = generateId('bsess');
  const expiresAt = new Date(Date.now() + (expiryMinutes as number) * 60 * 1000);

  try {
    await db.insert(bumpSessions).values({
      id: sessionId,
      did,
      nodeId,
      location: location ?? null,
      expiresAt,
    });

    return NextResponse.json({ sessionId, nodeId, expiresAt }, { headers: cors });
  } catch (err) {
    console.error('[bump/activate] error:', err);
    return NextResponse.json({ error: 'Failed to create session' }, { status: 500, headers: cors });
  }
}
