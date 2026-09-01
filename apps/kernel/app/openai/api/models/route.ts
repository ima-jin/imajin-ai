/**
 * GET + PUT /openai/api/models (#1927, following the #1769 precedent)
 *
 * Backs the OpenAI connector card's model picker.
 *
 * The OpenAI entry in `BRAIN_CONNECTORS` deliberately declares NO
 * `defaultModelId`. #1769 established why: a hardcoded model id goes stale
 * silently — `gemini-2.0-flash` was shut down while still hardcoded in
 * `brain.ts`, and a decommissioned model can come back as a 429 rather than a
 * clean 404, indistinguishable from a rate limit (#1764). OpenAI's gpt-4.x /
 * gpt-5.x ids turn over too, so the owner picks a live one here and it is
 * sealed as `modelId`. Without a picker, "no default" would mean "unusable
 * from the card", so this route is the other half of that decision.
 *
 * The GET/PUT scaffolding — auth, sealed-key resolution, body validation, and
 * error mapping — lives in `createConnectorModelPickerRoute` (#1928), shared
 * with the Gemini and xAI connectors' model pickers. Only OpenAI's own API
 * shape is declared here:
 *
 *   listModels — lists the models the owner's sealed key can actually see,
 *                straight from OpenAI's `/v1/models`.
 *   probeModel — retrieves the chosen model id from the same API and reports
 *                it servable only when OpenAI confirms it exists. A 404 is
 *                reported as `model_deprecated`, matching the Gemini/xAI
 *                card's contract.
 *
 * Security invariant: the API key never leaves the server, in either
 * direction — not in the GET response, and not echoed back on PUT. Upstream
 * response bodies are never surfaced either, only their status code.
 */
import { createConnectorModelPickerRoute, type ModelListResult, type ModelProbeResult } from '@/src/lib/kernel/connector-model-picker-route';
import {
  loadOpenaiSealedCredentials,
  openaiKeyPending,
  setModelId,
  OPENAI_BASE_URL,
  type OpenAICredentials,
} from '@/src/lib/openai/connector';

/** An entry in OpenAI's `/v1/models` response, narrowed to what is read. */
interface RawOpenaiModel {
  id?: string;
}

/** Call OpenAI's models API with the owner's sealed key. The key only ever rides the header. */
function fetchOpenaiModels(creds: OpenAICredentials, path = ''): Promise<Response> {
  const baseUrl = creds.baseUrl ?? OPENAI_BASE_URL;
  return fetch(`${baseUrl}/models${path}`, {
    headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: 'application/json' },
  });
}

async function listModels(creds: OpenAICredentials): Promise<ModelListResult> {
  const res = await fetchOpenaiModels(creds);
  if (!res.ok) {
    return { ok: false, status: res.status, statusText: res.statusText };
  }
  const raw = (await res.json()) as { data?: RawOpenaiModel[] };
  const models = (raw.data ?? [])
    .filter((model): model is { id: string } => typeof model.id === 'string' && model.id.length > 0)
    .map((model) => ({ id: model.id, name: model.id }));
  return { ok: true, models };
}

/**
 * Validation is a retrieve of that exact model with the owner's own key: a
 * 404 means the id is not servable for this key (retired, or never existed).
 */
async function probeModel(creds: OpenAICredentials, modelId: string): Promise<ModelProbeResult> {
  const res = await fetchOpenaiModels(creds, `/${encodeURIComponent(modelId)}`);
  if (res.ok) {
    return { ok: true };
  }
  if (res.status === 404) {
    return { ok: false, deprecated: true };
  }
  return { ok: false, deprecated: false, status: res.status, statusText: res.statusText };
}

export const { GET, PUT, OPTIONS } = createConnectorModelPickerRoute({
  id: 'openai',
  displayName: 'OpenAI',
  loadSealedCredentials: loadOpenaiSealedCredentials,
  keyPending: openaiKeyPending,
  setModelId,
  listModels,
  probeModel,
});
