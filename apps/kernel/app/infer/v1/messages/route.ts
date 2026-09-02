/**
 * POST /infer/v1/messages (#1959, sub-issue of #1922; mirrors #1925's
 * `/infer/v1/chat/completions`).
 *
 * Anthropic Messages API RAW BYTE passthrough — for harnesses that speak the
 * Anthropic wire format natively via `ANTHROPIC_BASE_URL` (the Claude Agent
 * SDK, the Claude Code CLI; today NanoClaw, #1932, whose deviation onto a
 * direct Anthropic key this route closes — see the comment on #1932). Unlike
 * the OpenAI-compatible sibling's `forwardAnthropic` (which round-trips
 * through the AI SDK), this is a byte-for-byte forward to
 * `https://api.anthropic.com/v1/messages`: swap the auth header, forward the
 * body, stream the SSE bytes back unchanged (Jin's review note 1 on #1959).
 * The only body mutation is overriding `model` with the sealed connector's
 * `modelId` — see `applySealedModel` in `anthropic-messages/forward.ts` — the
 * same precedent `forwardOpenAiCompatible` already sets (#1925): the sealed
 * key chose its model, the client's `model` field never overrides it.
 *
 * ## Verified Claude Agent SDK / Claude Code CLI endpoint surface
 * Per Anthropic's own LLM gateway protocol reference
 * (code.claude.com/docs/en/llm-gateway-protocol, verified 2026-09-02 against
 * the "Anthropic Messages" format row and its "Optional endpoints and
 * startup traffic" section — cited on #1959):
 *
 *   - `POST /v1/messages` — the one endpoint every caller needs. Implemented
 *     here.
 *   - `POST /v1/messages/count_tokens` — documented as optional (Claude Code
 *     falls back to a local/inference-endpoint estimate without it), but
 *     Jin's review flagged it as effectively load-bearing: some SDK flows
 *     fail on their first tool turn without it. Implemented at
 *     `./count_tokens/route.ts` — unmetered, see that file's header.
 *   - `GET /v1/models` — only called when the caller opts into
 *     `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` (off by default).
 *     Implemented at `../models/route.ts` for completeness, since a NanoClaw
 *     deploy could still enable it.
 *   - `HEAD /api/hello` — a best-effort connection-warming probe the
 *     protocol doc explicitly says a gateway "can reject without breaking
 *     anything" (Claude Code already skips it behind a proxy/client cert).
 *     Deliberately NOT implemented — there is nothing this route can
 *     usefully warm, and an unhandled `HEAD` here 404s harmlessly.
 *   - The "fast mode" availability check and the WebFetch domain-safety
 *     check both call `api.anthropic.com` directly, bypassing
 *     `ANTHROPIC_BASE_URL` entirely by design — out of scope for any
 *     gateway, not a gap in this one.
 *   - `anthropic-version`/`anthropic-beta` request headers are forwarded
 *     unchanged (never allowlisted to specific beta values, since the set
 *     changes every Claude Code release) — see `applySealedModel`'s sibling
 *     header-building in `anthropic-messages/forward.ts`.
 *
 * ## Auth
 * The same short-lived (10-minute) app-token JWT and `infer:completions`
 * scope as #1925 — no new scope, no TTL extension. The SDK/CLI send the
 * credential as `x-api-key`, never `Authorization: Bearer` (Jin's review
 * note 3) — `resolveInferenceAuth` accepts either header for exactly this
 * reason; see that module's `withApiKeyBearerFallback`.
 *
 * ## Resolution
 * Forced to the `anthropic` connector only
 * (`resolveBrain(..., { connectors: ['anthropic'] })`) — this route speaks
 * Anthropic's wire format and nothing else, so a principal whose only
 * sealed brain is e.g. xAI must fail closed here (422 `no_brain`) rather
 * than silently resolving a credential that cannot serve Anthropic-shaped
 * bytes.
 *
 * ## Metering
 * One `usage.incurred` row per call (never for `count_tokens`), parsed from
 * the Anthropic-shaped `usage` object — split across `message_start`
 * (`input_tokens` + the two cache fields) and `message_delta`
 * (`output_tokens`) on the stream. See `anthropic-messages/forward.ts`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { applySealedModel, forwardAnthropicMessages } from '@/src/lib/inference/anthropic-messages/forward';
import {
  guardAnthropicRequest,
  mapAnthropicPipelineError,
  resolveAnthropicBrain,
  withCorsHeaders,
} from '@/src/lib/inference/anthropic-messages/route-support';
import type { CompletionsRequestMetadata } from '@/src/lib/inference/completions/types';
import { enforceSpendCap } from '@/src/lib/inference/spend-cap';
import { connectorRegistryId, readConnectorRegistration } from '@/src/lib/kernel/connector-registry-store';

const log = createLogger('kernel:inference:anthropic-messages-route');

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function POST(request: NextRequest) {
  const guarded = await guardAnthropicRequest(request);
  if (!guarded.ok) return guarded.response;
  const { cors, ownerDid, appDid, bodyText } = guarded.value;

  const meta: CompletionsRequestMetadata = {
    sessionId: request.headers.get('x-session-id') ?? undefined,
    turnId: request.headers.get('x-turn-id') ?? undefined,
    agentDid: appDid,
  };

  try {
    const brain = await resolveAnthropicBrain(ownerDid, appDid);

    const prepared = applySealedModel(bodyText, brain.modelId);
    if (!prepared.ok) {
      return NextResponse.json({ error: prepared.error }, { status: 400, headers: cors });
    }

    log.info(
      {
        ownerDid,
        appDid: appDid ?? null,
        sessionId: meta.sessionId ?? null,
        turnId: meta.turnId ?? null,
        connector: brain.connector,
        model: brain.modelId,
        stream: prepared.value.stream,
      },
      'anthropic messages passthrough: dispatching',
    );

    // #1923: kernel-side spend-cap check, BEFORE forwarding — same pattern
    // as the OpenAI-compatible route (see its header for the full rationale
    // on `credentialDid` vs `ownerDid`).
    const registration = await readConnectorRegistration(brain.credentialDid, brain.connector);
    const connectorId = registration?.id ?? connectorRegistryId(brain.credentialDid, brain.connector);
    await enforceSpendCap(connectorId, registration?.spendCap);

    const upstreamResponse = await forwardAnthropicMessages(brain, prepared.value, meta, {
      anthropicVersion: request.headers.get('anthropic-version') ?? undefined,
      anthropicBeta: request.headers.get('anthropic-beta') ?? undefined,
    });

    return withCorsHeaders(upstreamResponse, cors);
  } catch (err) {
    return mapAnthropicPipelineError(err, ownerDid, cors, log, 'anthropic messages passthrough', {
      error: 'messages_failed',
      message: 'Anthropic Messages passthrough failed',
    });
  }
}
