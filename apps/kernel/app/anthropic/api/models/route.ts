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
 * API shape, not OpenAI-compatible either). `Content-Type: application/json`
 * rides alongside those two per Anthropic's own request-header contract
 * (verified against the Claude API overview docs, #2196) — every other
 * Anthropic call in this codebase (`anthropic-messages/forward.ts`,
 * `usage/billed/anthropic.ts`) already sends it; this route was the one gap.
 *
 * Security invariant: the API key never leaves the server, in either
 * direction — not in the GET response, and not echoed back on PUT. The raw
 * upstream response body is never surfaced — only Anthropic's own
 * `error.type`/`error.message` fields (#2196), which never carry the key,
 * so a prod failure is diagnosable from the card instead of a bare
 * `upstream 400 Bad Request`.
 */
import {
  createConnectorModelPickerRoute,
} from '@/src/lib/kernel/connector-model-picker-route';
import { listModels, probeModel } from '@/src/lib/anthropic/model-handlers';
import {
  loadAnthropicSealedCredentials,
  anthropicKeyPending,
  setModelId,
} from '@/src/lib/anthropic/connector';

export const { GET, PUT, OPTIONS } = createConnectorModelPickerRoute({
  id: 'anthropic',
  displayName: 'Anthropic',
  loadSealedCredentials: loadAnthropicSealedCredentials,
  keyPending: anthropicKeyPending,
  setModelId,
  listModels,
  probeModel,
});
