import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { db, inferenceSessions } from '@/src/db';
import { eq } from 'drizzle-orm';
import { confirmIntent } from '@/src/lib/inference/consent';
import { resolveIntent } from '@/src/lib/inference/resolve';
import { getVocabulary } from '@/src/lib/inference/vocabulary';
import { resolveInferenceAuth } from '@/src/lib/inference/auth';

const log = createLogger('kernel:inference:confirm-route');

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * POST /api/inference/confirm/:sessionId
 *
 * The human deliberate confirmation tap. Advances the session from
 * 'pending_confirm' → 'resolving' → 'resolved' and returns the attestation.
 *
 * The human's explicit tap on this endpoint IS the consent gate for all
 * 'deliberate' intents (e.g. AgriFortress supply.received). Nothing is
 * sent / spent / disclosed without this call succeeding.
 *
 * Auth must accept the exact same authenticated callers that
 * `/api/inference/capture` accepted for this session (#1782) — the human (or
 * delegating app) who captured the gesture is the one who confirms it, so
 * this resolves auth via the shared `resolveInferenceAuth` helper rather than
 * a plain `requireAuth` call.
 */
export async function POST(request: NextRequest, props: { params: Promise<{ sessionId: string }> }) {
  const params = await props.params;
  const cors = corsHeaders(request);
  const { sessionId } = params;

  const auth = await resolveInferenceAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const { ownerDid } = auth.context;

  try {
    // Validate ownership + status, advance to 'resolving'.
    await confirmIntent(sessionId, ownerDid);

    // Load the session to get the vocabulary name.
    const [session] = await db
      .select()
      .from(inferenceSessions)
      .where(eq(inferenceSessions.id, sessionId))
      .limit(1);

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404, headers: cors });
    }

    const vocab = getVocabulary(session.vocabularyName);
    if (!vocab) {
      return NextResponse.json(
        { error: `Vocabulary '${session.vocabularyName}' is not registered` },
        { status: 500, headers: cors },
      );
    }

    // Execute the intent and write the attestation.
    const result = await resolveIntent(sessionId, ownerDid, vocab);

    log.info({ sessionId, attestationId: result.attestationId, ownerDid }, 'confirmed and resolved');

    return NextResponse.json(
      {
        sessionId,
        status: 'resolved',
        attestationId: result.attestationId,
        intentType: result.intentType,
        primitiveType: result.primitiveType,
        externalId: result.externalId,
        resolvedAt: result.resolvedAt,
      },
      { status: 200, headers: cors },
    );
  } catch (err) {
    log.error({ err: String(err), sessionId, ownerDid }, 'Confirm + resolve failed');
    return NextResponse.json(
      { error: String(err) },
      { status: 400, headers: cors },
    );
  }
}
