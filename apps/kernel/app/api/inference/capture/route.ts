import { NextRequest, NextResponse } from 'next/server';
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
import { resolveInferenceAuth } from '@/src/lib/inference/auth';
import { mapBrainErrorToHttp } from '@/src/lib/inference/brain-http-errors';

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

  const auth = await resolveInferenceAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const { ownerDid, appDid } = auth.context;

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
      ...(appDid ? { appDid } : {}),
      vocabularyName: vocabName,
    });

    // 2. Gather context (transcribe + telemetry).
    const ctx = await gatherContext(captureEvent.sessionId, captureEvent.assetId, ownerDid);

    // 3. Run inference policy. The model comes from a sealed connector card
    //    (#1621): the owner's own first, then the invoking app/org DID if it is
    //    subsidising the compute (#1624). Consent and attribution stay with the
    //    owner either way.
    const candidates = await infer(ctx, vocab, appDid ? { ownerDid, appDid } : { ownerDid });
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
    return handlePipelineError(err, ownerDid, cors);
  }
}

/**
 * Map a pipeline failure to a typed HTTP response (#1764).
 *
 * The kernel used to fold every pipeline error into one generic 500, which
 * made "no model connected", "upstream rate limited", and "credentials
 * pending owner approval" all indistinguishable from a genuine crash — both
 * to the caller (no machine-readable signal to branch on) and to whoever was
 * debugging the incident. Each recognized case gets its own status and
 * `error` code via the shared `mapBrainErrorToHttp` (#1925 extracted this out
 * of this route so the completions passthrough does not clone it); only an
 * unrecognized failure still falls through to the generic 500 here.
 */
function handlePipelineError(
  err: unknown,
  ownerDid: string,
  cors: Record<string, string>,
): NextResponse {
  const mapped = mapBrainErrorToHttp(err);
  if (mapped) {
    log.warn({ ownerDid, error: mapped.body['error'], detail: mapped.body['detail'] }, 'Inference capture: pipeline error');
    return NextResponse.json(mapped.body, { status: mapped.status, headers: cors });
  }

  log.error({ err: String(err), ownerDid }, 'Inference capture pipeline failed');
  return NextResponse.json(
    {
      error: 'pipeline_failed',
      message: 'Inference pipeline failed',
      detail: String(err),
    },
    { status: 500, headers: cors },
  );
}
