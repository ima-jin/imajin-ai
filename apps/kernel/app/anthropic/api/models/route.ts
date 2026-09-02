/**
 * GET + PUT /anthropic/api/models (#1953, following the #1769/#1928 precedent)
 *
 * Backs the Anthropic connector card's model picker. Anthropic was the
 * kernel's original inference connector (pre-Gemini) and, until now, the
 * only one still missing this: `brain.ts` carried a hardcoded
 * `defaultModelId` — a dated snapshot (`claude-sonnet-4-20250514`) that goes
 * stale the same way `gemini-2.0-flash` did while hardcoded (#1764), and a
 * retired model can come back as something other than a clean 404 upstream.
 * The owner now picks a live model here instead, and `brain.ts` fails closed
 * via `NoModelSelectedError` when none is chosen — see its Anthropic entry.
 *
 * The GET/PUT scaffolding — auth, sealed-key resolution, body validation, and
 * error mapping — lives in `createConnectorModelPickerRoute` (#1928), shared
 * with every other token-paste connector's model picker. Only Anthropic's
 * own API shape is declared here:
 *
 *   listModels  — `GET /v1/models`, paginated (`has_more`/`last_id`), using
 *                 the owner's own sealed key.
 *   probeModel  — `GET /v1/models/{model_id}`: a 404 means the id is not
 *                 servable for this key (retired, or never existed); any
 *                 other non-2xx is an unrelated upstream fault.
 *
 * Anthropic authenticates with `x-api-key` + `anthropic-version` headers
 * rather than a bearer token, which is why this hand-declares
 * `listModels`/`probeModel` here instead of using
 * `createOpenAiCompatibleModelHandlers` (#1927) the way OpenAI/xAI do —
 * Gemini takes the same hand-declared approach for the same reason (its own
 * API shape, not OpenAI-compatible either).
 *
 * Security invariant: the API key never leaves the server, in either
 * direction — not in the GET response, and not echoed back on PUT. Upstream
 * response bodies are never surfaced either, only their status code.
 */
import {
  createConnectorModelPickerRoute,
  type ModelListResult,
  type ModelProbeResult,
} from '@/src/lib/kernel/connector-model-picker-route';
import {
  loadAnthropicSealedCredentials,
  anthropicKeyPending,
  setModelId,
  ANTHROPIC_BASE_URL,
  type AnthropicCredentials,
} from '@/src/lib/anthropic/connector';

/** Pinned the same way `lib/usage/billed/anthropic.ts` pins it for the Admin API. */
const ANTHROPIC_VERSION = '2023-06-01';

/** Defends against a runaway `has_more` loop from a misbehaving upstream. */
const MAX_LIST_PAGES = 20;

/** Shape of one entry in Anthropic's `/v1/models` response, narrowed to what this route reads. */
interface RawAnthropicModel {
  id?: string;
  display_name?: string;
}

/** Shape of one page of Anthropic's `/v1/models` response. */
interface RawAnthropicModelsPage {
  data?: RawAnthropicModel[];
  has_more?: boolean;
  last_id?: string | null;
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, Accept: 'application/json' };
}

/**
 * List every model the owner's sealed key can see, walking Anthropic's
 * `has_more`/`last_id` pagination to completion (capped at
 * `MAX_LIST_PAGES` pages) rather than reporting just the first page.
 */
async function listModels(creds: AnthropicCredentials): Promise<ModelListResult> {
  const baseUrl = creds.baseUrl ?? ANTHROPIC_BASE_URL;
  const models: { id: string; name: string }[] = [];
  let afterId: string | undefined;

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const url = afterId ? `${baseUrl}/models?after_id=${encodeURIComponent(afterId)}` : `${baseUrl}/models`;
    const res = await fetch(url, { headers: anthropicHeaders(creds.apiKey) });
    if (!res.ok) {
      return { ok: false, status: res.status, statusText: res.statusText };
    }
    const raw = (await res.json()) as RawAnthropicModelsPage;
    for (const model of raw.data ?? []) {
      if (typeof model.id === 'string' && model.id.length > 0) {
        models.push({ id: model.id, name: model.display_name ?? model.id });
      }
    }
    if (!raw.has_more || !raw.last_id) break;
    afterId = raw.last_id;
  }

  return { ok: true, models };
}

/**
 * Validate one model id against Anthropic with the owner's own key. A 404
 * means the id is not servable for this key (retired, or never existed); any
 * other non-2xx is an unrelated upstream fault, matching `listModels`'s
 * treatment of upstream failures.
 */
async function probeModel(creds: AnthropicCredentials, modelId: string): Promise<ModelProbeResult> {
  const baseUrl = creds.baseUrl ?? ANTHROPIC_BASE_URL;
  const res = await fetch(`${baseUrl}/models/${encodeURIComponent(modelId)}`, {
    headers: anthropicHeaders(creds.apiKey),
  });
  if (res.ok) {
    return { ok: true };
  }
  if (res.status === 404) {
    return { ok: false, deprecated: true };
  }
  return { ok: false, deprecated: false, status: res.status, statusText: res.statusText };
}

export const { GET, PUT, OPTIONS } = createConnectorModelPickerRoute({
  id: 'anthropic',
  displayName: 'Anthropic',
  loadSealedCredentials: loadAnthropicSealedCredentials,
  keyPending: anthropicKeyPending,
  setModelId,
  listModels,
  probeModel,
});
