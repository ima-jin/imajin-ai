/**
 * GET /infer/v1/models (#1959, sub-issue of #1922).
 *
 * Part of the verified Claude Agent SDK / Claude Code CLI endpoint surface —
 * see `../messages/route.ts`'s header for the full citation. Only reached
 * when a caller opts into `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`
 * (off by default) to populate the `/model` picker from the gateway's own
 * list instead of the CLI's built-in one — implemented here for
 * completeness rather than left as a gap a future NanoClaw config change
 * would rediscover the hard way.
 *
 * Same auth and Anthropic-only brain resolution as the other routes in this
 * family; raw byte forward of both the query string (Anthropic's
 * `after_id` pagination) and the response body. Unmetered and uncapped —
 * listing models spends nothing.
 */
import { NextRequest } from 'next/server';
import { corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { forwardAnthropicModelsList } from '@/src/lib/inference/anthropic-messages/forward';
import {
  guardAnthropicAuth,
  mapAnthropicPipelineError,
  resolveAnthropicBrain,
  withCorsHeaders,
} from '@/src/lib/inference/anthropic-messages/route-support';

const log = createLogger('kernel:inference:anthropic-models-route');

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest) {
  const guarded = await guardAnthropicAuth(request);
  if (!guarded.ok) return guarded.response;
  const { cors, ownerDid, appDid } = guarded.value;

  try {
    const brain = await resolveAnthropicBrain(ownerDid, appDid);
    const querySuffix = new URL(request.url).search;

    const upstreamResponse = await forwardAnthropicModelsList(brain, querySuffix);

    return withCorsHeaders(upstreamResponse, cors);
  } catch (err) {
    return mapAnthropicPipelineError(err, ownerDid, cors, log, 'anthropic models passthrough', {
      error: 'models_failed',
      message: 'Anthropic models passthrough failed',
    });
  }
}
