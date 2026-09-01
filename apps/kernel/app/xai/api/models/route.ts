/**
 * GET + PUT /xai/api/models (#1924, following the #1769 precedent)
 *
 * Backs the xAI connector card's model picker.
 *
 * The xAI entry in `BRAIN_CONNECTORS` deliberately declares NO
 * `defaultModelId`. #1769 established why: a hardcoded model id goes stale
 * silently — `gemini-2.0-flash` was shut down while still hardcoded in
 * `brain.ts`, and a decommissioned model can come back as a 429 rather than a
 * clean 404, indistinguishable from a rate limit (#1764). Grok ids turn over
 * at least as fast, so the owner picks a live one here and it is sealed as
 * `modelId`. Without a picker, "no default" would mean "unusable from the
 * card", so this route is the other half of that decision.
 *
 *   GET — lists the models the owner's sealed key can actually see, straight
 *         from xAI's OpenAI-compatible `/v1/models`.
 *   PUT — retrieves the chosen model id from the same API and only seals it
 *         (`setModelId`) when xAI confirms it exists. A 404 is reported as
 *         `model_deprecated`, matching the Gemini card's contract.
 *
 * Security invariant: the API key never leaves the server, in either
 * direction — not in the GET response, and not echoed back on PUT. Upstream
 * response bodies are never surfaced either, only their status code.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { resolveConnectorOwnerDid } from '@/src/lib/kernel/connector-owner-did';
import {
  loadXaiSealedCredentials,
  xaiKeyPending,
  setModelId,
  XAI_BASE_URL,
  type XaiCredentials,
} from '@/src/lib/xai/connector';

const log = createLogger('kernel');

/** One selectable model, as returned to the browser. Never carries the key. */
export interface XaiModelOption {
  id: string;
  name: string;
}

/** An entry in xAI's OpenAI-compatible `/v1/models` response, narrowed to what is read. */
interface RawXaiModel {
  id?: string;
}

/** Resolve the sealed credentials, or the typed response for the "nothing usable" cases. */
type SealedKeyLookup =
  | { ok: true; creds: XaiCredentials }
  | { ok: false; response: NextResponse };

/**
 * Read the caller's sealed xAI key without requiring an `xai:infer` grant
 * (#1773) — the owner is asking what their own key can do, typically before
 * they have reached the "grant scopes" step.
 *
 * `xai_no_key` (400) when nothing is sealed yet. `xai_credential_pending`
 * (409) when a key IS sealed but is awaiting the owner agent's Tier 1 grant —
 * a different, temporary state that a flat "no key" would misreport.
 */
async function requireSealedXaiKey(
  ownerDid: string,
  cors: Record<string, string>,
): Promise<SealedKeyLookup> {
  const creds = await loadXaiSealedCredentials(ownerDid);
  if (creds) {
    return { ok: true, creds };
  }
  if (await xaiKeyPending(ownerDid)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'xai_credential_pending: xAI API key is sealed but awaiting owner grant approval' },
        { status: 409, headers: cors },
      ),
    };
  }
  return {
    ok: false,
    response: NextResponse.json(
      { error: 'xai_no_key: no xAI API key sealed for this identity — seal one on the xAI connector card first' },
      { status: 400, headers: cors },
    ),
  };
}

/** Call xAI's models API with the owner's sealed key. The key only ever rides the header. */
function fetchXaiModels(creds: XaiCredentials, path = ''): Promise<Response> {
  const baseUrl = creds.baseUrl ?? XAI_BASE_URL;
  return fetch(`${baseUrl}/models${path}`, {
    headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: 'application/json' },
  });
}

/** `xai_models: upstream …` — the only shape an upstream failure is allowed to take. */
function upstreamFailure(res: Response, cors: Record<string, string>): NextResponse {
  return NextResponse.json(
    { error: `xai_models: upstream ${res.status} ${res.statusText}` },
    { status: 502, headers: cors },
  );
}

/** `xai_models: failed to reach xAI` — transport failure, never the raw error. */
function unreachable(cors: Record<string, string>): NextResponse {
  return NextResponse.json({ error: 'xai_models: failed to reach xAI' }, { status: 502, headers: cors });
}

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * List the models available to the caller's sealed xAI key.
 *
 * Upstream failures map to 502: they are xAI's fault, not the caller's. The
 * upstream body is never forwarded — an error page can echo the request back.
 */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const auth = await resolveConnectorOwnerDid(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const { ownerDid } = auth;

  const lookup = await requireSealedXaiKey(ownerDid, cors);
  if (!lookup.ok) {
    return lookup.response;
  }
  const { creds } = lookup;

  let raw: { data?: RawXaiModel[] };
  try {
    const res = await fetchXaiModels(creds);
    if (!res.ok) {
      log.warn({ ownerDid, status: res.status }, 'xai models: upstream list failed');
      return upstreamFailure(res, cors);
    }
    raw = (await res.json()) as { data?: RawXaiModel[] };
  } catch (err) {
    log.error({ err: String(err), ownerDid }, 'xai models: fetch failed');
    return unreachable(cors);
  }

  const models: XaiModelOption[] = (raw.data ?? [])
    .filter((model): model is { id: string } => typeof model.id === 'string' && model.id.length > 0)
    .map((model) => ({ id: model.id, name: model.id }));

  return NextResponse.json({ models, currentModelId: creds.modelId ?? null }, { headers: cors });
}

/**
 * Validate, then seal, the owner's chosen model id, without touching the
 * sealed API key.
 *
 * Validation is a retrieve of that exact model with the owner's own key: a 404
 * means the id is not servable for this key (retired, or never existed) and is
 * reported as `model_deprecated` (422), the same contract the Gemini card
 * already speaks. `setModelId` only runs once xAI confirms the model.
 */
export async function PUT(request: NextRequest) {
  const cors = corsHeaders(request);

  const auth = await resolveConnectorOwnerDid(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const { ownerDid } = auth;

  let body: { modelId?: unknown };
  try {
    body = (await request.json()) as { modelId?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
  if (!modelId) {
    return NextResponse.json({ error: 'modelId must be a non-empty string' }, { status: 400, headers: cors });
  }

  const lookup = await requireSealedXaiKey(ownerDid, cors);
  if (!lookup.ok) {
    return lookup.response;
  }
  const { creds } = lookup;

  let probe: Response;
  try {
    probe = await fetchXaiModels(creds, `/${encodeURIComponent(modelId)}`);
  } catch (err) {
    log.error({ err: String(err), ownerDid }, 'xai models: model probe failed to reach xAI');
    return unreachable(cors);
  }

  if (!probe.ok) {
    if (probe.status === 404) {
      log.warn({ ownerDid, modelId }, 'xai models: rejected selection of a model xAI does not serve');
      return NextResponse.json(
        {
          error: 'model_deprecated',
          message: `xAI model '${modelId}' was not found — it has likely been retired. Choose a different model.`,
          modelId,
        },
        { status: 422, headers: cors },
      );
    }
    log.warn({ ownerDid, status: probe.status }, 'xai models: model probe failed');
    return upstreamFailure(probe, cors);
  }

  try {
    await setModelId(ownerDid, modelId);
  } catch (err) {
    log.error({ err: String(err), ownerDid }, 'xai models: failed to seal modelId');
    return NextResponse.json({ error: 'Failed to store the selected xAI model' }, { status: 500, headers: cors });
  }

  return NextResponse.json({ modelId }, { headers: cors });
}
