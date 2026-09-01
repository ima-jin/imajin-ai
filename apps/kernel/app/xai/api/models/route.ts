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
 * The GET/PUT scaffolding — auth, sealed-key resolution, body validation, and
 * error mapping — lives in `createConnectorModelPickerRoute` (#1928), shared
 * with the Gemini connector's model picker (#1818). Only xAI's own,
 * OpenAI-compatible API shape is declared here:
 *
 *   listModels — lists the models the owner's sealed key can actually see,
 *                straight from xAI's OpenAI-compatible `/v1/models`.
 *   probeModel — retrieves the chosen model id from the same API and reports
 *                it servable only when xAI confirms it exists. A 404 is
 *                reported as `model_deprecated`, matching the Gemini card's
 *                contract.
 *
 * Security invariant: the API key never leaves the server, in either
 * direction — not in the GET response, and not echoed back on PUT. Upstream
 * response bodies are never surfaced either, only their status code.
 */
import { createConnectorModelPickerRoute, type ModelListResult, type ModelProbeResult } from '@/src/lib/kernel/connector-model-picker-route';
import {
  loadXaiSealedCredentials,
  xaiKeyPending,
  setModelId,
  XAI_BASE_URL,
  type XaiCredentials,
} from '@/src/lib/xai/connector';

/** An entry in xAI's OpenAI-compatible `/v1/models` response, narrowed to what is read. */
interface RawXaiModel {
  id?: string;
}

/** Call xAI's models API with the owner's sealed key. The key only ever rides the header. */
function fetchXaiModels(creds: XaiCredentials, path = ''): Promise<Response> {
  const baseUrl = creds.baseUrl ?? XAI_BASE_URL;
  return fetch(`${baseUrl}/models${path}`, {
    headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: 'application/json' },
  });
}

async function listModels(creds: XaiCredentials): Promise<ModelListResult> {
  const res = await fetchXaiModels(creds);
  if (!res.ok) {
    return { ok: false, status: res.status, statusText: res.statusText };
  }
  const raw = (await res.json()) as { data?: RawXaiModel[] };
  const models = (raw.data ?? [])
    .filter((model): model is { id: string } => typeof model.id === 'string' && model.id.length > 0)
    .map((model) => ({ id: model.id, name: model.id }));
  return { ok: true, models };
}

/**
 * Validation is a retrieve of that exact model with the owner's own key: a
 * 404 means the id is not servable for this key (retired, or never existed).
 */
async function probeModel(creds: XaiCredentials, modelId: string): Promise<ModelProbeResult> {
  const res = await fetchXaiModels(creds, `/${encodeURIComponent(modelId)}`);
  if (res.ok) {
    return { ok: true };
  }
  if (res.status === 404) {
    return { ok: false, deprecated: true };
  }
  return { ok: false, deprecated: false, status: res.status, statusText: res.statusText };
}

export const { GET, PUT, OPTIONS } = createConnectorModelPickerRoute({
  id: 'xai',
  displayName: 'xAI',
  loadSealedCredentials: loadXaiSealedCredentials,
  keyPending: xaiKeyPending,
  setModelId,
  listModels,
  probeModel,
});
