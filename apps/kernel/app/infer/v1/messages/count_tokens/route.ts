/**
 * POST /infer/v1/messages/count_tokens (#1959, sub-issue of #1922).
 *
 * Part of the verified Claude Agent SDK / Claude Code CLI endpoint surface —
 * see `../route.ts`'s header for the full citation and enumeration. Same
 * auth, brain resolution, and sealed-model override as `POST
 * /infer/v1/messages`, minus metering and the spend-cap check: token
 * counting is not a billed Anthropic call, and #1959's metering contract is
 * explicit that `count_tokens` calls are never `usage.incurred` events (Jin's
 * review note 4 scopes metering to the `/v1/messages` usage object only).
 */
import { NextRequest, NextResponse } from 'next/server';
import { corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { applySealedModel, forwardAnthropicCountTokens } from '@/src/lib/inference/anthropic-messages/forward';
import {
  guardAnthropicRequest,
  mapAnthropicPipelineError,
  resolveAnthropicBrain,
  withCorsHeaders,
} from '@/src/lib/inference/anthropic-messages/route-support';

const log = createLogger('kernel:inference:anthropic-count-tokens-route');

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function POST(request: NextRequest) {
  const guarded = await guardAnthropicRequest(request);
  if (!guarded.ok) return guarded.response;
  const { cors, ownerDid, appDid, bodyText } = guarded.value;

  try {
    const brain = await resolveAnthropicBrain(ownerDid, appDid);

    const prepared = applySealedModel(bodyText, brain.modelId);
    if (!prepared.ok) {
      return NextResponse.json({ error: prepared.error }, { status: 400, headers: cors });
    }

    const upstreamResponse = await forwardAnthropicCountTokens(brain, prepared.value.value, {
      anthropicVersion: request.headers.get('anthropic-version') ?? undefined,
      anthropicBeta: request.headers.get('anthropic-beta') ?? undefined,
    });

    return withCorsHeaders(upstreamResponse, cors);
  } catch (err) {
    return mapAnthropicPipelineError(err, ownerDid, cors, log, 'count_tokens passthrough', {
      error: 'count_tokens_failed',
      message: 'Anthropic count_tokens passthrough failed',
    });
  }
}
