/**
 * Shared `listModels`/`probeModel` for providers exposing an OpenAI-compatible
 * `/v1/models` API (#1927).
 *
 * xAI (#1924) and OpenAI (#1927) both speak the exact same list + retrieve-by-id
 * shape at `/v1/models` — xAI's surface is explicitly OpenAI-compatible, and
 * OpenAI's is the shape it's compatible WITH — so the two connectors'
 * `listModels`/`probeModel` (the pair `createConnectorModelPickerRoute`,
 * #1928, needs from each) had been hand-copied down to the malformed-entry
 * filter. Declaring the shape once here means the next OpenAI-compatible
 * provider with a model picker (#1930, #1931) supplies only its own base URL.
 */
import type { ModelListResult, ModelProbeResult } from '@/src/lib/kernel/connector-model-picker-route';

/** The minimum sealed-credential shape this helper needs to call the API. */
export interface OpenAiCompatibleCredentials {
  apiKey: string;
  baseUrl?: string;
}

/** An entry in an OpenAI-compatible `/v1/models` response, narrowed to what is read. */
interface RawOpenAiCompatibleModel {
  id?: string;
}

export interface OpenAiCompatibleModelHandlers<C extends OpenAiCompatibleCredentials> {
  listModels(creds: C): Promise<ModelListResult>;
  probeModel(creds: C, modelId: string): Promise<ModelProbeResult>;
}

/**
 * Build `listModels` + `probeModel` for a provider whose API is the
 * OpenAI `/v1/models` shape, pointed at `defaultBaseUrl` unless the owner's
 * sealed credentials carry their own override.
 */
export function createOpenAiCompatibleModelHandlers<C extends OpenAiCompatibleCredentials>(
  defaultBaseUrl: string,
): OpenAiCompatibleModelHandlers<C> {
  /** Call the provider's models API with the owner's sealed key. The key only ever rides the header. */
  function fetchModels(creds: C, path = ''): Promise<Response> {
    const baseUrl = creds.baseUrl ?? defaultBaseUrl;
    return fetch(`${baseUrl}/models${path}`, {
      headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: 'application/json' },
    });
  }

  async function listModels(creds: C): Promise<ModelListResult> {
    const res = await fetchModels(creds);
    if (!res.ok) {
      return { ok: false, status: res.status, statusText: res.statusText };
    }
    const raw = (await res.json()) as { data?: RawOpenAiCompatibleModel[] };
    const models = (raw.data ?? [])
      .filter((model): model is { id: string } => typeof model.id === 'string' && model.id.length > 0)
      .map((model) => ({ id: model.id, name: model.id }));
    return { ok: true, models };
  }

  /**
   * Validation is a retrieve of that exact model with the owner's own key: a
   * 404 means the id is not servable for this key (retired, or never existed).
   */
  async function probeModel(creds: C, modelId: string): Promise<ModelProbeResult> {
    const res = await fetchModels(creds, `/${encodeURIComponent(modelId)}`);
    if (res.ok) {
      return { ok: true };
    }
    if (res.status === 404) {
      return { ok: false, deprecated: true };
    }
    return { ok: false, deprecated: false, status: res.status, statusText: res.statusText };
  }

  return { listModels, probeModel };
}
