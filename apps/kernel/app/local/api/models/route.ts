/**
 * GET + PUT /local/api/models (#1957, following the #1769 precedent)
 *
 * Backs the local connector card's model picker. The `local` entry in
 * `BRAIN_CONNECTORS` declares no `defaultModelId` — same reasoning as every
 * other brain connector (#1769): the owner picks a live model from GET
 * /local/api/models and it is sealed as `modelId`; see `NoModelSelectedError`
 * for the fail-closed path when none is chosen yet.
 *
 * `GET` proxies `{baseUrl}/v1/models` (Ollama and vLLM both serve it); `PUT`
 * validates then seals the chosen `modelId`. Both go through
 * `loadLocalSealedCredentials`, which resolves whenever a `baseUrl` is
 * configured — no grant and no bearer token required (#1773 precedent: the
 * owner asking what their own endpoint can do is not "spending" anything).
 *
 * `listModels`/`probeModel` route every upstream call through the
 * egress-safe fetch (`../../../src/lib/local/model-handlers.ts`) rather than
 * the shared `createOpenAiCompatibleModelHandlers`, which calls bare
 * `fetch()` — safe for a hardcoded trusted host, wrong for an owner-supplied
 * one.
 */
import { createConnectorModelPickerRoute } from '@/src/lib/kernel/connector-model-picker-route';
import { listModels, probeModel } from '@/src/lib/local/model-handlers';
import { loadLocalSealedCredentials, setModelId, type LocalCredentials } from '@/src/lib/local/connector';

export const { GET, PUT, OPTIONS } = createConnectorModelPickerRoute<LocalCredentials>({
  id: 'local',
  displayName: 'Local Inference',
  upstreamName: 'the local endpoint',
  loadSealedCredentials: loadLocalSealedCredentials,
  // Readiness is baseUrl-based, not bearer-token-based (#1957) — there is no
  // Tier-1-pending state that meaningfully applies to the model picker here.
  keyPending: async () => false,
  setModelId,
  listModels,
  probeModel,
});
