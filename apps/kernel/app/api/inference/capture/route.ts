import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { rateLimit, getClientIP } from '@imajin/config';
import { createLogger } from '@imajin/logger';
import { inferMime, isAllowedMime } from '@/src/lib/media/create-asset';
import { captureGesture } from '@/src/lib/inference/capture';
import { gatherContext } from '@/src/lib/inference/context';
import { infer } from '@/src/lib/inference/policy';
import { resolveConsentGate } from '@/src/lib/inference/consent';
import { resolveIntent } from '@/src/lib/inference/resolve';
import { getVocabulary, listVocabularyNames } from '@/src/lib/inference/vocabulary';

const log = createLogger('kernel:inference:capture-route');

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * POST /api/inference/capture
 *
 * Accepts a multipart form with:
 *   file        Blob    — the audio/photo/file (required)
 *   vocabulary  string  — vocabulary name ('imajin' | 'agrifortress', default: 'imajin')
 *   filename    string  — override filename (optional)
 *
 * Runs the full pipeline synchronously:
 *   capture → context (transcribe + telemetry) → policy (LLM) → consent gate
 *
 * Returns:
 *   { sessionId, assetId, status, candidateIntents? }
 *
 * For 'silent' intents: resolves immediately and returns status 'resolved'.
 * For 'deliberate' intents: returns status 'pending_confirm' — caller must
 *   POST /api/inference/confirm/:sessionId to proceed.
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 20, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } },
    );
  }

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const ownerDid = resolveActingDid(authResult.identity);

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid multipart data' }, { status: 400, headers: cors });
  }

  const file = formData.get('file');
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json({ error: 'Missing file field' }, { status: 400, headers: cors });
  }

  const vocabName = (formData.get('vocabulary') as string | null) ?? 'imajin';
  const vocab = getVocabulary(vocabName);
  if (!vocab) {
    return NextResponse.json(
      { error: `Unknown vocabulary '${vocabName}'. Available: ${listVocabularyNames().join(', ')}` },
      { status: 400, headers: cors },
    );
  }

  const originalName =
    (formData.get('filename') as string | null) ?? (file as File).name ?? 'capture';
  const mimeType = inferMime(file.type, originalName);

  if (!isAllowedMime(mimeType)) {
    return NextResponse.json(
      { error: `MIME type ${mimeType} is not allowed` },
      { status: 415, headers: cors },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    // 1. Capture gesture → asset + session.
    const captureEvent = await captureGesture({
      buffer,
      filename: originalName,
      mimeType,
      ownerDid,
      vocabularyName: vocabName,
    });

    // 2. Gather context (transcribe + telemetry).
    const ctx = await gatherContext(captureEvent.sessionId, captureEvent.assetId, ownerDid);

    // 3. Run inference policy.
    const candidates = await infer(ctx, vocab);
    const topIntent = candidates[0];

    if (!topIntent) {
      return NextResponse.json(
        {
          sessionId: captureEvent.sessionId,
          assetId: captureEvent.assetId,
          status: 'failed',
          error: 'No candidate intents inferred',
        },
        { status: 200, headers: cors },
      );
    }

    // 4. Resolve the consent gate.
    const gateOutcome = await resolveConsentGate(captureEvent.sessionId, topIntent);

    // 5. For silent intents: resolve immediately.
    if (gateOutcome === 'proceed') {
      const result = await resolveIntent(captureEvent.sessionId, ownerDid, vocab);
      return NextResponse.json(
        {
          sessionId: captureEvent.sessionId,
          assetId: captureEvent.assetId,
          status: 'resolved',
          attestationId: result.attestationId,
          intentType: result.intentType,
          primitiveType: result.primitiveType,
          resolvedAt: result.resolvedAt,
        },
        { status: 200, headers: cors },
      );
    }

    // 6. Deliberate intents: surface candidate to the caller for confirmation.
    return NextResponse.json(
      {
        sessionId: captureEvent.sessionId,
        assetId: captureEvent.assetId,
        status: 'pending_confirm',
        candidateIntents: candidates,
      },
      { status: 200, headers: cors },
    );
  } catch (err) {
    log.error({ err: String(err), ownerDid }, 'Inference capture pipeline failed');
    return NextResponse.json(
      { error: 'Inference pipeline failed', detail: String(err) },
      { status: 500, headers: cors },
    );
  }
}
