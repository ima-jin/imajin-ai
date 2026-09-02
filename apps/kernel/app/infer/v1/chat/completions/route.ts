/**
 * POST /infer/v1/chat/completions (#1925, Phase 2 of the #1922 inference
 * connectors epic).
 *
 * OpenAI-compatible completions passthrough. An agent (e.g. OpenClaw/Jin)
 * calls this `onBehalfOf` its principal using a short-lived app-token JWT
 * (`infer:completions` scope, minted via `POST /auth/api/apps/token` —
 * client mints and refreshes on the existing 10-minute TTL; there is no TTL
 * extension here, that is a deliberate, separately-reviewed decision per the
 * epic). The kernel resolves the sealed provider key from the PRINCIPAL's own
 * sealed connector card via the existing `resolveBrain` walk (#1621) — the
 * exact same abstraction `POST /api/inference/capture` already uses — and
 * forwards the call. The sealed key never reaches the caller: there is no
 * raw-key release path here, matching the rest of the connector surface.
 *
 * Two adapters cover the whole `BRAIN_CONNECTORS` table:
 *   - `forwardOpenAiCompatible` — Gemini, xAI, and future OpenAI/Moonshot
 *     entries. A raw byte passthrough: nothing to translate.
 *   - `forwardAnthropic` — translates through the AI SDK, reusing brain.ts's
 *     existing Anthropic connector exactly as the issue specifies.
 *
 * `NoModelSelectedError` (#1769: no hardcoded default models) is a client
 * error (422), never a 500 — handled by the shared `mapBrainErrorToHttp`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { rateLimit, getClientIP } from '@imajin/config';
import { createLogger } from '@imajin/logger';
import { resolveInferenceAuth } from '@/src/lib/inference/auth';
import { resolveBrain } from '@/src/lib/inference/brain';
import { mapBrainErrorToHttp } from '@/src/lib/inference/brain-http-errors';
import { mapUpstreamErrorToHttp } from '@/src/lib/inference/completions/errors';
import { forwardAnthropic } from '@/src/lib/inference/completions/anthropic-adapter';
import { forwardOpenAiCompatible } from '@/src/lib/inference/completions/openai-compatible-adapter';
import type { ChatCompletionsRequestBody, CompletionsRequestMetadata } from '@/src/lib/inference/completions/types';
import { enforceSpendCap } from '@/src/lib/inference/spend-cap';
import { connectorRegistryId, readConnectorRegistration } from '@/src/lib/kernel/connector-registry-store';

const log = createLogger('kernel:inference:completions-route');

/** Named so a grant for capture/confirm (`infer:provide`) can never be reused here. */
const COMPLETIONS_SCOPE = 'infer:completions';

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 30, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } },
    );
  }

  const auth = await resolveInferenceAuth(request, COMPLETIONS_SCOPE);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const { ownerDid, appDid } = auth.context;

  const body = await parseRequestBody(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: 400, headers: cors });
  }

  // Per-turn metering context (#1922 target architecture component 3,
  // #1923): every adapter writes one usage.incurred row from this once the
  // call resolves.
  const meta: CompletionsRequestMetadata = {
    sessionId: request.headers.get('x-session-id') ?? undefined,
    turnId: request.headers.get('x-turn-id') ?? undefined,
    agentDid: appDid,
  };

  try {
    const brain = await resolveBrain(appDid ? { ownerDid, appDid } : ownerDid);

    log.info(
      {
        ownerDid,
        appDid: appDid ?? null,
        sessionId: meta.sessionId ?? null,
        turnId: meta.turnId ?? null,
        connector: brain.connector,
        model: brain.modelId,
        stream: Boolean(body.value.stream),
      },
      'completions passthrough: dispatching',
    );

    // #1923 (Phase 3 of #1922): kernel-side spend-cap check, BEFORE
    // forwarding — never trusted to the client. `credentialDid` (not
    // `ownerDid`) is whose card the cap actually lives on: `resolveBrain`
    // can hand back the app/org registrant's credential (#1624), and the cap
    // belongs to whoever's connector registration is being spent against.
    const registration = await readConnectorRegistration(brain.credentialDid, brain.connector);
    const connectorId = registration?.id ?? connectorRegistryId(brain.credentialDid, brain.connector);
    await enforceSpendCap(connectorId, registration?.spendCap);

    const upstreamResponse = brain.provider === 'anthropic'
      ? await forwardAnthropic(brain, body.value, meta)
      : await forwardOpenAiCompatible(brain, body.value, meta);

    return withCorsHeaders(upstreamResponse, cors);
  } catch (err) {
    return handleCompletionsError(err, ownerDid, cors);
  }
}

async function parseRequestBody(
  request: NextRequest,
): Promise<{ ok: true; value: ChatCompletionsRequestBody } | { ok: false; error: string }> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { ok: false, error: 'Invalid JSON body' };
  }
  const body = parsed as Partial<ChatCompletionsRequestBody> | null;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, error: 'messages is required and must be a non-empty array' };
  }
  return { ok: true, value: body as ChatCompletionsRequestBody };
}

function withCorsHeaders(response: Response, cors: Record<string, string>): Response {
  for (const [key, value] of Object.entries(cors)) {
    response.headers.set(key, value);
  }
  return response;
}

/**
 * Maps a completions-passthrough failure to a typed HTTP response (#1764
 * precedent, #1925 extends it): brain-resolution failures go through the
 * shared `mapBrainErrorToHttp` (identical mapping to `/api/inference/capture`
 * — see that module's header for why this is factored out rather than
 * hand-copied), upstream-call failures through `mapUpstreamErrorToHttp`, and
 * anything else is an unrecognized crash.
 */
function handleCompletionsError(err: unknown, ownerDid: string, cors: Record<string, string>): NextResponse {
  const mapped = mapBrainErrorToHttp(err) ?? mapUpstreamErrorToHttp(err);
  if (mapped) {
    log.warn({ ownerDid, error: mapped.body['error'], detail: mapped.body['detail'] }, 'completions passthrough: pipeline error');
    return NextResponse.json(mapped.body, { status: mapped.status, headers: cors });
  }

  log.error({ err: String(err), ownerDid }, 'completions passthrough: pipeline failed');
  return NextResponse.json(
    { error: 'completions_failed', message: 'Completions passthrough failed', detail: String(err) },
    { status: 500, headers: cors },
  );
}
