/**
 * GET + PUT /gemini/api/models (#1769)
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
 *   PUT  — seals `{ modelId }` as the owner's chosen model, without touching
 *          the sealed API key or base URL (`setModelId`, #1769).
 *
 * Security invariant: the API key never leaves the server, in either
 * direction — not in the GET response, and not echoed back on PUT.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { resolveConnectorOwnerDid } from '@/src/lib/kernel/connector-owner-did';
import { loadGeminiCredentials, setModelId } from '@/src/lib/gemini/connector';

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

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * List models available to the caller's sealed Gemini key.
 *
 * `gemini_no_key` (400) when nothing is sealed yet — the owner must seal a
 * key on the connector card (step 1) before there is anything to list models
 * for. Upstream failures map to 502: they are Google's fault, not the
 * caller's.
 */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const auth = await resolveConnectorOwnerDid(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const { ownerDid } = auth;

  const creds = await loadGeminiCredentials(ownerDid);
  if (!creds) {
    return NextResponse.json(
      {
        error:
          'gemini_no_key: no Gemini API key sealed for this identity — seal one on the Gemini connector card first',
      },
      { status: 400, headers: cors },
    );
  }

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
 * Seal the owner's chosen model id, without touching the sealed API key.
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

  try {
    await setModelId(ownerDid, modelId);
  } catch (err) {
    log.error({ err: String(err), ownerDid }, 'gemini models: failed to seal modelId');
    return NextResponse.json({ error: 'Failed to store the selected Gemini model' }, { status: 500, headers: cors });
  }

  return NextResponse.json({ modelId }, { headers: cors });
}
