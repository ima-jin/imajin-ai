/**
 * GET + PUT /gemini/api/models (#1769, live-probe #1818)
 *
 * Backs the Gemini connector card's model picker. Google retires/renames
 * Gemini model ids often enough that a hardcoded `defaultModelId` goes stale
 * silently (gemini-2.0-flash shut down 2026-06-01 while still hardcoded in
 * `brain.ts` — see #1764), so the owner now picks a live model from this
 * route instead of the kernel guessing one.
 *
 * The GET/PUT scaffolding — auth, sealed-key resolution, body validation, and
 * error mapping — lives in `createConnectorModelPickerRoute` (#1928), shared
 * with every other token-paste connector's model picker. Only Google's own
 * API shape is declared here:
 *
 *   listModels  — lists models the owner's sealed API key can actually use,
 *                 filtered to those supporting `generateContent`. The key is
 *                 sent to Google server-side and never returned to the
 *                 browser — only `{ id, name }` pairs come back.
 *   probeModel  — fires a minimal (1-output-token) `generateContent` probe
 *                 against the chosen model with the owner's own sealed key.
 *                 This is required because Google's `ListModels` API (what
 *                 `listModels` reads) keeps listing models well after they
 *                 are retired (#1818) — the picker can offer a corpse, and
 *                 only a real generate call proves the model is actually
 *                 servable right now.
 *
 * Security invariant: the API key never leaves the server, in either
 * direction — not in the GET response, and not echoed back on PUT.
 */
import { createConnectorModelPickerRoute, type ModelListResult, type ModelProbeResult } from '@/src/lib/kernel/connector-model-picker-route';
import {
  loadGeminiSealedCredentials,
  geminiKeyPending,
  setModelId,
  type GeminiCredentials,
} from '@/src/lib/gemini/connector';

const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

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
function toModelOptions(raw: readonly RawGeminiModel[]): { id: string; name: string }[] {
  const options: { id: string; name: string }[] = [];
  for (const model of raw) {
    if (typeof model.name !== 'string' || model.name.length === 0) continue;
    if (!Array.isArray(model.supportedGenerationMethods)) continue;
    if (!model.supportedGenerationMethods.includes('generateContent')) continue;
    const id = stripModelsPrefix(model.name);
    options.push({ id, name: model.displayName ?? id });
  }
  return options;
}

async function listModels(creds: GeminiCredentials): Promise<ModelListResult> {
  const res = await fetch(`${GEMINI_MODELS_URL}?key=${encodeURIComponent(creds.apiKey)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    return { ok: false, status: res.status, statusText: res.statusText };
  }
  const raw = (await res.json()) as { models?: RawGeminiModel[] };
  return { ok: true, models: toModelOptions(raw.models ?? []) };
}

/**
 * Fire a minimal (1-output-token) `generateContent` call against `modelId`
 * with the owner's own sealed key (#1818 item 2) — the only reliable way to
 * know a model is actually servable right now, since Google's `ListModels`
 * API keeps listing models well after they are retired.
 *
 * A 404 means the model id itself is gone (`deprecated: true`). Any other
 * non-OK status is an unrelated upstream failure (invalid key, quota, region
 * restriction, etc.) and is reported as such rather than misclassified as a
 * dead model.
 */
async function probeModel(creds: GeminiCredentials, modelId: string): Promise<ModelProbeResult> {
  const res = await fetch(
    `${GEMINI_MODELS_URL}/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(creds.apiKey)}`,
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

export const { GET, PUT, OPTIONS } = createConnectorModelPickerRoute({
  id: 'gemini',
  displayName: 'Gemini',
  upstreamName: 'Google',
  loadSealedCredentials: loadGeminiSealedCredentials,
  keyPending: geminiKeyPending,
  setModelId,
  listModels,
  probeModel,
});
