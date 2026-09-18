/**
 * `listModels`/`probeModel` for the OpenRouter connector's model picker
 * (#2188).
 *
 * OpenRouter serves the same OpenAI-compatible `GET /models` list shape
 * every other brain connector's picker already speaks via
 * `createOpenAiCompatibleModelHandlers` (#1927) — but OpenRouter's
 * single-model lookup is `GET /model/{author}/{slug}` (singular, two path
 * segments: the model id split on its own `/`), NOT the OpenAI-shaped
 * `GET /models/{id}` that shared helper probes. Reusing it verbatim would
 * URL-encode OpenRouter's `provider/model` ids (e.g. `typesafe/jev-1.13` →
 * `typesafe%2Fjev-1.13`) and probe a path that 404s unconditionally,
 * refusing every real model at seal time.
 *
 * `probeModel` here instead re-uses the already-fetched list: an id present
 * in `GET /models` is servable, and one absent is either retired or never
 * existed — the same `model_deprecated` semantics `createConnectorModelPickerRoute`
 * expects (#1769), without depending on OpenRouter's differently-shaped
 * single-model endpoint.
 *
 * Built as a factory over `defaultBaseUrl` — the same shape
 * `createOpenAiCompatibleModelHandlers` uses — rather than importing
 * `OPENROUTER_BASE_URL` directly from `./connector`: that module pulls in
 * the vault/DB stack transitively (`createConnectorTokenPaste`), which this
 * module must stay free of so its own unit tests need no DB.
 */
import type { ModelListResult, ModelProbeResult } from '@/src/lib/kernel/connector-model-picker-route';
import type { OpenAiCompatibleCredentials } from '@/src/lib/kernel/openai-compatible-model-picker';

/** An entry in OpenRouter's `GET /models` response, narrowed to what is read. */
interface RawOpenrouterModel {
  id?: string;
}

export interface OpenrouterModelHandlers {
  listModels(creds: OpenAiCompatibleCredentials): Promise<ModelListResult>;
  probeModel(creds: OpenAiCompatibleCredentials, modelId: string): Promise<ModelProbeResult>;
}

/** Narrow one list-endpoint response into the ids it actually names, dropping malformed entries. */
function knownModelIds(raw: { data?: RawOpenrouterModel[] }): string[] {
  return (raw.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export function createOpenrouterModelHandlers(defaultBaseUrl: string): OpenrouterModelHandlers {
  /** Call OpenRouter's `/models` list with the owner's sealed key. The key only ever rides the header. */
  function fetchModelList(creds: OpenAiCompatibleCredentials): Promise<Response> {
    const baseUrl = creds.baseUrl ?? defaultBaseUrl;
    return fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: 'application/json' },
    });
  }

  async function listModels(creds: OpenAiCompatibleCredentials): Promise<ModelListResult> {
    const res = await fetchModelList(creds);
    if (!res.ok) {
      return { ok: false, status: res.status, statusText: res.statusText };
    }
    const raw = (await res.json()) as { data?: RawOpenrouterModel[] };
    const models = knownModelIds(raw).map((id) => ({ id, name: id }));
    return { ok: true, models };
  }

  /**
   * Validation is membership in the owner's own `GET /models` list, not a
   * per-model retrieve: OpenRouter's own single-model shape
   * (`GET /model/{author}/{slug}`) does not compose with a `provider/model`
   * id passed as one opaque string, and its 404 there is unrelated to a
   * `data` array. A model absent from the list this key can see is not
   * servable to it — retired, or never existed — matching the `deprecated`
   * contract every other connector's probe reports for a 404.
   */
  async function probeModel(creds: OpenAiCompatibleCredentials, modelId: string): Promise<ModelProbeResult> {
    const res = await fetchModelList(creds);
    if (!res.ok) {
      return { ok: false, deprecated: false, status: res.status, statusText: res.statusText };
    }
    const raw = (await res.json()) as { data?: RawOpenrouterModel[] };
    return knownModelIds(raw).includes(modelId) ? { ok: true } : { ok: false, deprecated: true };
  }

  return { listModels, probeModel };
}
