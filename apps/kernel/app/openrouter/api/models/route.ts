/**
 * GET + PUT /openrouter/api/models (#2188, following the #1769 precedent)
 *
 * Backs the OpenRouter connector card's model picker.
 *
 * The OpenRouter entry in `BRAIN_CONNECTORS` deliberately declares NO
 * `defaultModelId`. #1769 established why: a hardcoded model id goes stale
 * silently — `gemini-2.0-flash` was shut down while still hardcoded in
 * `brain.ts`, and a decommissioned model can come back as a 429 rather than a
 * clean 404, indistinguishable from a rate limit (#1764). OpenRouter's own
 * catalog turns over even faster than a single provider's (it fronts every
 * provider's models plus its own, e.g. `typesafe/jev-1.13`), so the owner
 * picks a live `provider/model` id here and it is sealed as `modelId`, then
 * forwarded to OpenRouter untouched by the passthrough. Without a picker,
 * "no default" would mean "unusable from the card", so this route is the
 * other half of that decision.
 *
 * The GET/PUT scaffolding — auth, sealed-key resolution, body validation, and
 * error mapping — lives in `createConnectorModelPickerRoute` (#1928), shared
 * with the Gemini, xAI, OpenAI, Moonshot, and Z.ai connectors' model pickers.
 * OpenRouter's OWN `listModels`/`probeModel` (`./model-handlers.ts`) are
 * deliberately NOT `createOpenAiCompatibleModelHandlers` (#1927): that
 * helper probes `GET {baseUrl}/models/{id}`, the OpenAI single-model shape,
 * but OpenRouter's real single-model endpoint is `GET /model/{author}/{slug}`
 * — a different path shape entirely, which would 404 every
 * `provider/model` id (e.g. `typesafe/jev-1.13`) and refuse every real
 * model at seal time. See `model-handlers.ts` for the list-membership probe
 * this connector uses instead.
 *
 * Security invariant: the API key never leaves the server, in either
 * direction — not in the GET response, and not echoed back on PUT. Upstream
 * response bodies are never surfaced either, only their status code.
 */
import { createConnectorModelPickerRoute } from '@/src/lib/kernel/connector-model-picker-route';
import { createOpenrouterModelHandlers } from '@/src/lib/openrouter/model-handlers';
import {
  loadOpenrouterSealedCredentials,
  openrouterKeyPending,
  setModelId,
  OPENROUTER_BASE_URL,
} from '@/src/lib/openrouter/connector';

const { listModels, probeModel } = createOpenrouterModelHandlers(OPENROUTER_BASE_URL);

export const { GET, PUT, OPTIONS } = createConnectorModelPickerRoute({
  id: 'openrouter',
  displayName: 'OpenRouter',
  loadSealedCredentials: loadOpenrouterSealedCredentials,
  keyPending: openrouterKeyPending,
  setModelId,
  listModels,
  probeModel,
});
