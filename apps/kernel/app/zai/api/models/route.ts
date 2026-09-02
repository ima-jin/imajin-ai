/**
 * GET + PUT /zai/api/models (#1931, following the #1769 precedent)
 *
 * Backs the Z.ai connector card's model picker.
 *
 * The Z.ai entry in `BRAIN_CONNECTORS` deliberately declares NO
 * `defaultModelId`. #1769 established why: a hardcoded model id goes stale
 * silently — `gemini-2.0-flash` was shut down while still hardcoded in
 * `brain.ts`, and a decommissioned model can come back as a 429 rather than a
 * clean 404, indistinguishable from a rate limit (#1764). GLM model ids turn
 * over too (glm-4.5 → glm-4.6 → glm-4.7 → glm-5.x within the same year), so
 * the owner picks a live one here and it is sealed as `modelId`. Without a
 * picker, "no default" would mean "unusable from the card", so this route is
 * the other half of that decision.
 *
 * The GET/PUT scaffolding — auth, sealed-key resolution, body validation, and
 * error mapping — lives in `createConnectorModelPickerRoute` (#1928), shared
 * with the Gemini, xAI, OpenAI, and Moonshot connectors' model pickers. Z.ai's
 * own API shape — `listModels`/`probeModel` against `/models` — is the same
 * OpenAI-compatible shape those connectors speak, so both come from
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
  loadZaiSealedCredentials,
  zaiKeyPending,
  setModelId,
  ZAI_BASE_URL,
  type ZaiCredentials,
} from '@/src/lib/zai/connector';

const { listModels, probeModel } = createOpenAiCompatibleModelHandlers<ZaiCredentials>(ZAI_BASE_URL);

export const { GET, PUT, OPTIONS } = createConnectorModelPickerRoute({
  id: 'zai',
  displayName: 'Z.ai',
  loadSealedCredentials: loadZaiSealedCredentials,
  keyPending: zaiKeyPending,
  setModelId,
  listModels,
  probeModel,
});
