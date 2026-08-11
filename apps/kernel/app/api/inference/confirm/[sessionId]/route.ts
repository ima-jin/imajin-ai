import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { db, inferenceSessions } from '@/src/db';
import { eq } from 'drizzle-orm';
import { confirmIntent } from '@/src/lib/inference/consent';
import { resolveIntent } from '@/src/lib/inference/resolve';
import { getVocabulary } from '@/src/lib/inference/vocabulary';
import { resolveInferenceAuth } from '@/src/lib/inference/auth';
import { validateConfirmedMetadata } from '@/src/lib/inference/metadata-validation';

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
 *
 * Body (#1789): OPTIONAL JSON object — the edited/confirmed intent payload
 * (the intent's metadata shape, e.g. `{recipient, lot, notes, lines[]}` for a
 * delivery-type intent). When present, it is validated against the resolved
 * intent's expected shape and, if valid, becomes what gets resolved and
 * signed — approving on the canvas IS the signing event, so the signed
 * record must be what the human confirmed, not the original AI guess. On
 * validation failure the request fails closed with 400 and the session is
 * left completely untouched. No body — or an empty body — is exactly the
 * pre-existing behavior: confirms the inferred payload as-is.
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

  // Parse the optional confirmed/edited payload BEFORE touching any session
  // state, so a malformed or invalid body always leaves the session untouched
  // (#1789). An empty body is treated identically to no body at all.
  let confirmedMetadata: Record<string, unknown> | undefined;
  const rawBody = await request.text();
  if (rawBody.trim().length > 0) {
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
    }

    const [sessionForValidation] = await db
      .select()
      .from(inferenceSessions)
      .where(eq(inferenceSessions.id, sessionId))
      .limit(1);

    if (!sessionForValidation) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404, headers: cors });
    }

    const vocabForValidation = getVocabulary(sessionForValidation.vocabularyName);
    if (!vocabForValidation) {
      return NextResponse.json(
        { error: `Vocabulary '${sessionForValidation.vocabularyName}' is not registered` },
        { status: 500, headers: cors },
      );
    }

    const validation = validateConfirmedMetadata(
      vocabForValidation,
      sessionForValidation.chosenIntentType ?? '',
      parsedBody,
    );
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400, headers: cors });
    }
    confirmedMetadata = validation.metadata;
  }

  try {
    // Validate ownership + status, advance to 'resolving'. Carries the
    // confirmed/edited payload (if any) into the signed authorization (#1789).
    await confirmIntent(sessionId, ownerDid, confirmedMetadata);

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
