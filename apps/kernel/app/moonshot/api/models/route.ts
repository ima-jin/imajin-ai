/**
 * GET + PUT /moonshot/api/models (#1930, following the #1769 precedent)
 *
 * Backs the Moonshot connector card's model picker.
 *
 * The Moonshot entry in `BRAIN_CONNECTORS` deliberately declares NO
 * `defaultModelId`. #1769 established why: a hardcoded model id goes stale
 * silently — `gemini-2.0-flash` was shut down while still hardcoded in
 * `brain.ts`, and a decommissioned model can come back as a 429 rather than a
 * clean 404, indistinguishable from a rate limit (#1764). Kimi's model ids
 * turn over too, so the owner picks a live one here and it is sealed as
 * `modelId`. Without a picker, "no default" would mean "unusable from the
 * card", so this route is the other half of that decision.
 *
 * The GET/PUT scaffolding — auth, sealed-key resolution, body validation, and
 * error mapping — lives in `createConnectorModelPickerRoute` (#1928), shared
 * with the Gemini, xAI and OpenAI connectors' model pickers. Moonshot's own
 * API shape — `listModels`/`probeModel` against `/v1/models` — is the same
 * OpenAI-compatible shape xAI/OpenAI speak, so both come from
 * `createOpenAiCompatibleModelHandlers` (#1927) rather than a second
 * hand-copy of the fetch/list/probe trio.
 *
 * Security invariant: the API key never leaves the server, in either
 * direction — not in the GET response, and not echoed back on PUT. Upstream
 * response bodies are never surfaced either, only their status code.
 */
import { createConnectorModelPickerRoute } from '@/src/lib/kernel/connector-model-picker-route';
import { createOpenAiCompatibleModelHandlers } from '@/src/lib/kernel/openai-compatible-model-picker';
import {
  loadMoonshotSealedCredentials,
  moonshotKeyPending,
  setModelId,
  MOONSHOT_BASE_URL,
  type MoonshotCredentials,
} from '@/src/lib/moonshot/connector';

const { listModels, probeModel } = createOpenAiCompatibleModelHandlers<MoonshotCredentials>(MOONSHOT_BASE_URL);

export const { GET, PUT, OPTIONS } = createConnectorModelPickerRoute({
  id: 'moonshot',
  displayName: 'Moonshot AI',
  loadSealedCredentials: loadMoonshotSealedCredentials,
  keyPending: moonshotKeyPending,
  setModelId,
  listModels,
  probeModel,
});
