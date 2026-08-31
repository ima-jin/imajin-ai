/**
 * GET + PUT /gemini/api/models (#1769, live-probe #1818)
 *
 * Backs the Gemini connector card's model picker. Google retires/renames
 * Gemini model ids often enough that a hardcoded `defaultModelId` goes stale
 * silently (gemini-2.0-flash shut down 2026-06-01 while still hardcoded in
 * `brain.ts` — see #1764), so the owner now picks a live model from this
 * route instead of the kernel guessing one.
 *
 *   GET  — lists models the owner's sealed API key can actually use, filtered
 *          to those supporting `generateContent`. The key is sent to Google
 *          server-side and never returned to the browser — only
 *          `{ id, name }` pairs come back.
 *   PUT  — fires a minimal (1-output-token) `generateContent` probe against
 *          the chosen model with the owner's own sealed key, and only seals
 *          `{ modelId }` (`setModelId`, #1769) if that probe succeeds. This
 *          is required because Google's `ListModels` API (what GET reads)
 *          keeps listing models well after they are retired (#1818) — the
 *          picker can offer a corpse, and only a real generate call proves
 *          the model is actually servable right now.
 *
 * Security invariant: the API key never leaves the server, in either
 * direction — not in the GET response, and not echoed back on PUT.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { resolveConnectorOwnerDid } from '@/src/lib/kernel/connector-owner-did';
import {
  loadGeminiSealedCredentials,
  geminiKeyPending,
  setModelId,
  type GeminiCredentials,
} from '@/src/lib/gemini/connector';

const log = createLogger('kernel');

const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/** One selectable model, as returned to the browser. Never carries the key. */
export interface GeminiModelOption {
  id: string;
  name: string;
}

/** Shape of a single entry in Google's `ListModels` response, narrowed to what this route reads. */
interface RawGeminiModel {
  name?: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

/** Strip Google's `models/` resource prefix, e.g. `models/gemini-3.6-flash` → `gemini-3.6-flash`. */
function stripModelsPrefix(name: string): string {
  return name.startsWith('models/') ? name.slice('models/'.length) : name;
}

/** Filter + normalise Google's raw model list down to what the picker needs. */
function toModelOptions(raw: readonly RawGeminiModel[]): GeminiModelOption[] {
  const options: GeminiModelOption[] = [];
  for (const model of raw) {
    if (typeof model.name !== 'string' || model.name.length === 0) continue;
    if (!Array.isArray(model.supportedGenerationMethods)) continue;
    if (!model.supportedGenerationMethods.includes('generateContent')) continue;
    const id = stripModelsPrefix(model.name);
    options.push({ id, name: model.displayName ?? id });
  }
  return options;
}

/**
 * Result of {@link requireSealedGeminiKey}: either the sealed credentials, or
 * a ready-to-return response for the "nothing usable sealed yet" cases.
 */
type SealedKeyLookup =
  | { ok: true; creds: GeminiCredentials }
  | { ok: false; response: NextResponse };

/**
 * Resolve the caller's sealed Gemini key, or the typed failure response for
 * `gemini_no_key` (400) / `gemini_credential_pending` (409) — shared by GET
 * and PUT so both routes report identically on "nothing sealed yet" instead
 * of drifting apart (#1818).
 *
 * `gemini_no_key` when nothing is sealed yet — the owner must seal a key on
 * the connector card (step 1) before there is anything to list/validate
 * models against. `gemini_credential_pending` when a key IS sealed but still
 * awaiting the owner agent's Tier 1 grant approval — a different, temporary
 * state that a flat "no key sealed" would misreport.
 */
async function requireSealedGeminiKey(
  ownerDid: string,
  cors: Record<string, string>,
): Promise<SealedKeyLookup> {
  const creds = await loadGeminiSealedCredentials(ownerDid);
  if (creds) {
    return { ok: true, creds };
  }
  if (await geminiKeyPending(ownerDid)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            'gemini_credential_pending: Gemini API key is sealed but awaiting owner grant approval',
        },
        { status: 409, headers: cors },
      ),
    };
  }
  return {
    ok: false,
    response: NextResponse.json(
      {
        error:
          'gemini_no_key: no Gemini API key sealed for this identity — seal one on the Gemini connector card first',
      },
      { status: 400, headers: cors },
    ),
  };
}

/** Outcome of {@link probeModelLive} against Google's `generateContent` API. */
type ModelProbeResult =
  | { ok: true }
  | { ok: false; deprecated: true }
  | { ok: false; deprecated: false; status: number; statusText: string };

/**
 * Fire a minimal (1-output-token) `generateContent` call against `modelId`
 * with the owner's own sealed key (#1818 item 2) — the only reliable way to
 * know a model is actually servable right now, since Google's `ListModels`
 * API (what GET reads) keeps listing models well after they are retired.
 *
 * A 404 means the model id itself is gone (`deprecated: true`). Any other
 * non-OK status is an unrelated upstream failure (invalid key, quota, region
 * restriction, etc.) and is reported as such rather than misclassified as a
 * dead model.
 */
async function probeModelLive(apiKey: string, modelId: string): Promise<ModelProbeResult> {
  const res = await fetch(
    `${GEMINI_MODELS_URL}/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
    },
  );
  if (res.ok) {
    return { ok: true };
  }
  if (res.status === 404) {
    return { ok: false, deprecated: true };
  }
  return { ok: false, deprecated: false, status: res.status, statusText: res.statusText };
}

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * List models available to the caller's sealed Gemini key.
 *
 * This reads the key via `loadGeminiSealedCredentials`, which does NOT
 * require an active `gemini:infer` grant (#1773) — the owner is asking what
 * their own key can do, typically before they have reached the "grant
 * scopes" step, not spending the credential on inference.
 *
 * `gemini_no_key` (400) / `gemini_credential_pending` (409) come from
 * {@link requireSealedGeminiKey} — see its doc comment. Upstream failures map
 * to 502: they are Google's fault, not the caller's.
 */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const auth = await resolveConnectorOwnerDid(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const { ownerDid } = auth;

  const lookup = await requireSealedGeminiKey(ownerDid, cors);
  if (!lookup.ok) {
    return lookup.response;
  }
  const { creds } = lookup;

  let raw: { models?: RawGeminiModel[] };
  try {
    const res = await fetch(`${GEMINI_MODELS_URL}?key=${encodeURIComponent(creds.apiKey)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      // The response body is never surfaced: Google's error pages can echo
      // back the query string, which would leak the key into the log/response.
      log.warn({ ownerDid, status: res.status }, 'gemini models: upstream list failed');
      return NextResponse.json(
        { error: `gemini_models: upstream ${res.status} ${res.statusText}` },
        { status: 502, headers: cors },
      );
    }
    raw = (await res.json()) as { models?: RawGeminiModel[] };
  } catch (err) {
    log.error({ err: String(err), ownerDid }, 'gemini models: fetch failed');
    return NextResponse.json({ error: 'gemini_models: failed to reach Google' }, { status: 502, headers: cors });
  }

  const models = toModelOptions(raw.models ?? []);
  return NextResponse.json(
    { models, currentModelId: creds.modelId ?? null },
    { headers: cors },
  );
}

/**
 * Validate, then seal, the owner's chosen model id, without touching the
 * sealed API key.
 *
 * `model_deprecated` (422) when the live probe 404s — the model id is gone
 * upstream even though it may still appear in `ListModels` (#1818). Any other
 * probe failure maps to 502, matching GET's treatment of upstream failures.
 * `setModelId` is only called once the probe succeeds.
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

  const lookup = await requireSealedGeminiKey(ownerDid, cors);
  if (!lookup.ok) {
    return lookup.response;
  }
  const { creds } = lookup;

  let probe: ModelProbeResult;
  try {
    probe = await probeModelLive(creds.apiKey, modelId);
  } catch (err) {
    log.error({ err: String(err), ownerDid }, 'gemini models: liveness probe failed to reach Google');
    return NextResponse.json({ error: 'gemini_models: failed to reach Google' }, { status: 502, headers: cors });
  }

  if (!probe.ok) {
    if (probe.deprecated) {
      log.warn({ ownerDid, modelId }, 'gemini models: rejected selection of a model retired upstream');
      return NextResponse.json(
        {
          error: 'model_deprecated',
          message: `Gemini model '${modelId}' was not found — it has likely been retired. Choose a different model.`,
          modelId,
        },
        { status: 422, headers: cors },
      );
    }
    // The response body is never surfaced, matching GET: Google's error pages
    // can echo back the query string, which would leak the key.
    log.warn({ ownerDid, status: probe.status }, 'gemini models: liveness probe failed');
    return NextResponse.json(
      { error: `gemini_models: upstream ${probe.status} ${probe.statusText}` },
      { status: 502, headers: cors },
    );
  }

  try {
    await setModelId(ownerDid, modelId);
  } catch (err) {
    log.error({ err: String(err), ownerDid }, 'gemini models: failed to seal modelId');
    return NextResponse.json({ error: 'Failed to store the selected Gemini model' }, { status: 500, headers: cors });
  }

  return NextResponse.json({ modelId }, { headers: cors });
}
