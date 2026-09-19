/**
 * POST /typesafe/api/decide (#2197)
 *
 * `{ state, questions, model? }` → TypeSafe's `answers` + `usage` passed
 * through VERBATIM (probabilities/confidence/legend intact, untouched) plus
 * `requestId` from `x-typesafe-request-id`. Gated by an active
 * `typesafe:decide` grant (the connector's fail-closed
 * `requireGrantAndKey`), not `infer:completions` — this is a service-connector
 * capability, not the inference passthrough, and it is never reachable via
 * `/infer/*`.
 *
 * `model` defaults to `jev-latest` when omitted. Upstream error bodies
 * (including 422 — a caller bug, never retried) are surfaced opaque, with
 * the upstream status, straight through — never re-derived, so nothing here
 * can accidentally echo the sealed key. 429/529 are retried with backoff
 * inside `postSystemOne`, capped at 3 attempts.
 *
 * One `usage.incurred` row is written per call for cost visibility
 * (provider `typesafe`, the resolved model, token counts, cost = input
 * tokens × $0.042/Mtok, output free) — no spend-cap check and no
 * `BRAIN_CONNECTORS` coupling.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { resolveConnectorOwnerDid } from '@/src/lib/kernel/connector-owner-did';
import { requireGrantAndKey, TYPESAFE_DECIDE_SCOPE } from '@/src/lib/typesafe/connector';
import {
  postSystemOne,
  TypesafeUpstreamError,
  type TypesafeModelId,
  type TypesafeQuestion,
  type TypesafeQuestionType,
} from '@/src/lib/typesafe/client';
import { recordTypesafeUsage } from '@/src/lib/typesafe/usage';

const log = createLogger('kernel');

/** Response header carrying `x-typesafe-request-id` back to the caller, on both success and upstream-error paths. */
const REQUEST_ID_HEADER = 'x-typesafe-request-id';

const DEFAULT_MODEL: TypesafeModelId = 'jev-latest';
const VALID_MODELS: readonly TypesafeModelId[] = [DEFAULT_MODEL, 'jev-1.13.0', 'jev-preview'];
const VALID_QUESTION_TYPES: readonly TypesafeQuestionType[] = ['noul', 'choice', 'score'];

/** Fail-closed grant-gate error prefixes thrown by `requireGrantAndKey` (`createConnectorTokenPaste`). */
const GRANT_ERROR_NO_GRANT = 'typesafe_no_grant';
const GRANT_ERROR_CREDENTIAL_PENDING = 'typesafe_credential_pending';
const GRANT_ERROR_NO_KEY = 'typesafe_no_key';

/** Attach `x-typesafe-request-id` to a headers object when present, leaving it untouched otherwise. */
function withRequestIdHeader(headers: Record<string, string>, requestId: string | null): Record<string, string> {
  return requestId ? { ...headers, [REQUEST_ID_HEADER]: requestId } : headers;
}

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

interface DecideRequestBody {
  state: string | Record<string, unknown> | unknown[];
  model?: TypesafeModelId;
  questions: Record<string, TypesafeQuestion>;
}

type ValidationResult =
  | { ok: true; value: DecideRequestBody }
  | { ok: false; error: string };

function isValidState(state: unknown): state is DecideRequestBody['state'] {
  return typeof state === 'string' || (typeof state === 'object' && state !== null);
}

function isValidQuestion(question: unknown): question is TypesafeQuestion {
  if (typeof question !== 'object' || question === null) return false;
  const q = question as Partial<TypesafeQuestion>;
  if (!VALID_QUESTION_TYPES.includes(q.type as TypesafeQuestionType)) return false;
  if (typeof q.instructions !== 'string' || q.instructions.trim().length === 0) return false;
  // criteria is required for choice/score, absent for noul.
  if ((q.type === 'choice' || q.type === 'score') && q.criteria === undefined) return false;
  return true;
}

function validateQuestions(raw: unknown): { ok: true; questions: Record<string, TypesafeQuestion> } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'questions must be an object mapping question id to a question definition' };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) {
    return { ok: false, error: 'questions must contain at least one question' };
  }
  const invalidIds = entries.filter(([, q]) => !isValidQuestion(q)).map(([id]) => id);
  if (invalidIds.length > 0) {
    return { ok: false, error: `invalid question definition(s): ${invalidIds.join(', ')}` };
  }
  return { ok: true, questions: raw as Record<string, TypesafeQuestion> };
}

function validateBody(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'Invalid JSON body' };
  }
  const body = raw as Partial<DecideRequestBody>;

  if (!isValidState(body.state)) {
    return { ok: false, error: 'state must be a non-empty string, object, or array' };
  }

  const questionsResult = validateQuestions(body.questions);
  if (!questionsResult.ok) {
    return { ok: false, error: questionsResult.error };
  }

  if (body.model !== undefined && !VALID_MODELS.includes(body.model)) {
    return { ok: false, error: `model must be one of: ${VALID_MODELS.join(', ')}` };
  }

  return {
    ok: true,
    value: { state: body.state, model: body.model ?? DEFAULT_MODEL, questions: questionsResult.questions },
  };
}

/** Map the connector's fail-closed grant-gate error to a typed HTTP response, or `undefined` if unrecognized. */
function mapGrantErrorToHttp(err: unknown): { status: number; body: Record<string, unknown> } | undefined {
  if (!(err instanceof Error)) return undefined;
  if (err.message.startsWith(GRANT_ERROR_NO_GRANT)) {
    return { status: 403, body: { error: GRANT_ERROR_NO_GRANT, message: 'No active typesafe:decide grant', detail: err.message } };
  }
  if (err.message.startsWith(GRANT_ERROR_CREDENTIAL_PENDING)) {
    return { status: 409, body: { error: GRANT_ERROR_CREDENTIAL_PENDING, message: 'TypeSafe.ai API key is sealed but awaiting owner grant approval', detail: err.message } };
  }
  if (err.message.startsWith(GRANT_ERROR_NO_KEY)) {
    return { status: 400, body: { error: GRANT_ERROR_NO_KEY, message: 'No TypeSafe.ai API key sealed for this identity', detail: err.message } };
  }
  return undefined;
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const auth = await resolveConnectorOwnerDid(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const { ownerDid } = auth;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  const validated = validateBody(rawBody);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400, headers: cors });
  }

  let apiKey: string;
  try {
    apiKey = await requireGrantAndKey(ownerDid, TYPESAFE_DECIDE_SCOPE);
  } catch (err) {
    const mapped = mapGrantErrorToHttp(err);
    if (mapped) {
      return NextResponse.json(mapped.body, { status: mapped.status, headers: cors });
    }
    log.error({ err: String(err), ownerDid }, 'typesafe decide: grant gate failed unexpectedly');
    return NextResponse.json({ error: 'typesafe_gate_failed' }, { status: 500, headers: cors });
  }

  try {
    const { data, requestId } = await postSystemOne(apiKey, validated.value);

    // Non-streaming, single JSON round trip — the whole body is already in
    // hand, so awaiting metering here adds no latency a passthrough wasn't
    // already going to pay (mirrors the completions passthrough's
    // non-streaming path).
    await recordTypesafeUsage({
      ownerDid,
      model: data.model,
      tokensIn: data.usage?.input_tokens,
      tokensOut: data.usage?.output_tokens,
      sessionId: request.headers.get('x-session-id') ?? undefined,
      turnId: request.headers.get('x-turn-id') ?? undefined,
    });

    return NextResponse.json(
      { answers: data.answers, usage: data.usage, model: data.model, requestId },
      { status: 200, headers: withRequestIdHeader(cors, requestId) },
    );
  } catch (err) {
    if (err instanceof TypesafeUpstreamError) {
      log.warn({ ownerDid, status: err.status }, 'typesafe decide: upstream rejected the request');
      // Opaque passthrough of the upstream body — never re-derived, never
      // logged, and never carries the key (it only ever rode the outgoing
      // Authorization header).
      return NextResponse.json(
        err.body ?? { error: 'typesafe_upstream_error' },
        { status: err.status, headers: withRequestIdHeader(cors, err.requestId) },
      );
    }
    log.error({ err: String(err), ownerDid }, 'typesafe decide: pipeline failed');
    return NextResponse.json({ error: 'typesafe_decide_failed', detail: String(err) }, { status: 502, headers: cors });
  }
}
