/**
 * Shared route scaffolding for the Anthropic Messages passthrough routes
 * (#1959): `POST /infer/v1/messages`, `POST /infer/v1/messages/count_tokens`,
 * and `GET /infer/v1/models`.
 *
 * These three routes share every concern EXCEPT the actual upstream call:
 * rate limiting, `infer:completions` auth, CORS, brain resolution forced to
 * the `anthropic` connector, and pipeline-error mapping. Factoring that out
 * here — rather than copying `/infer/v1/chat/completions`'s inline version
 * into three new files — is what keeps this feature's SonarCloud duplication
 * contribution near zero; the OpenAI-compatible route's own inline version
 * is intentionally left as-is (it has different dispatch logic and is not
 * this module's concern).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { Logger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { rateLimit, getClientIP } from '@imajin/config';
import { resolveInferenceAuth } from '../auth';
import { resolveBrain, type ResolvedBrain } from '../brain';
import { mapBrainErrorToHttp } from '../brain-http-errors';
import { mapUpstreamErrorToHttp } from '../completions/errors';

/** Same scope as #1925's completions passthrough — no new scope for this wire format. */
export const ANTHROPIC_MESSAGES_SCOPE = 'infer:completions';

/** Every route in this family speaks Anthropic's wire format exclusively — see `resolveAnthropicBrain`. */
const ANTHROPIC_ONLY = ['anthropic'] as const;

export interface GuardedAuth {
  cors: Record<string, string>;
  ownerDid: string;
  appDid?: string;
}

export type GuardResult<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

/** Rate limit + `infer:completions` auth, common to every route in this family. */
export async function guardAnthropicAuth(request: NextRequest): Promise<GuardResult<GuardedAuth>> {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 30, 60_000);
  if (rl.limited) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Too many requests', retryAfter: rl.retryAfter },
        { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } },
      ),
    };
  }

  const auth = await resolveInferenceAuth(request, ANTHROPIC_MESSAGES_SCOPE);
  if (!auth.ok) {
    return { ok: false, response: NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors }) };
  }

  return { ok: true, value: { cors, ownerDid: auth.context.ownerDid, appDid: auth.context.appDid } };
}

export interface GuardedRequest extends GuardedAuth {
  bodyText: string;
}

/** {@link guardAnthropicAuth}, plus reading (and requiring a non-empty) request body — for the two `POST` routes. */
export async function guardAnthropicRequest(request: NextRequest): Promise<GuardResult<GuardedRequest>> {
  const authResult = await guardAnthropicAuth(request);
  if (!authResult.ok) return authResult;

  const { cors } = authResult.value;
  const bodyText = await request.text();
  if (!bodyText) {
    return { ok: false, response: NextResponse.json({ error: 'Request body is required' }, { status: 400, headers: cors }) };
  }

  return { ok: true, value: { ...authResult.value, bodyText } };
}

/**
 * Resolve the sealed Anthropic connector for this caller, forced to the
 * `anthropic` connector only. This route family speaks Anthropic's wire
 * format exclusively, so a principal whose only sealed brain is a
 * different provider (e.g. xAI) must fail closed with `NoBrainSealedError`
 * here rather than silently resolving a credential that cannot serve
 * Anthropic-shaped bytes — see `resolveBrain`'s `ResolveBrainOptions` doc.
 */
export function resolveAnthropicBrain(ownerDid: string, appDid: string | undefined): Promise<ResolvedBrain> {
  return resolveBrain(appDid ? { ownerDid, appDid } : ownerDid, { connectors: ANTHROPIC_ONLY });
}

/** Attaches CORS headers to an adapter's response without altering its body/status. */
export function withCorsHeaders(response: Response, cors: Record<string, string>): Response {
  for (const [key, value] of Object.entries(cors)) {
    response.headers.set(key, value);
  }
  return response;
}

/**
 * Map a pipeline failure to a typed HTTP response, shared by every route in
 * this family — the same two-mapper composition
 * `/infer/v1/chat/completions`'s `handleCompletionsError` uses.
 */
export function mapAnthropicPipelineError(
  err: unknown,
  ownerDid: string,
  cors: Record<string, string>,
  log: Logger,
  logScope: string,
  fallback: { error: string; message: string },
): NextResponse {
  const mapped = mapBrainErrorToHttp(err) ?? mapUpstreamErrorToHttp(err);
  if (mapped) {
    log.warn({ ownerDid, error: mapped.body['error'], detail: mapped.body['detail'] }, `${logScope}: pipeline error`);
    return NextResponse.json(mapped.body, { status: mapped.status, headers: cors });
  }

  log.error({ err: String(err), ownerDid }, `${logScope}: pipeline failed`);
  return NextResponse.json(
    { error: fallback.error, message: fallback.message, detail: String(err) },
    { status: 500, headers: cors },
  );
}
