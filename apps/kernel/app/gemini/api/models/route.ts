/**
 * GET + PUT /gemini/api/models (#1769, live-probe #1818)
 *
 * Backs the Gemini connector card's model picker. Google retires/renames
 * Gemini model ids often enough that a hardcoded `defaultModelId` goes stale
 * silently (gemini-2.0-flash shut down 2026-06-01 while still hardcoded in
 * `brain.ts` — see #1764), so the owner now picks a live model from this
 * route instead of the kernel guessing one.
 *
 * The GET/PUT scaffolding — auth, sealed-key resolution, body validation, and
 * error mapping — lives in `createConnectorModelPickerRoute` (#1928), shared
 * with every other token-paste connector's model picker. Only Google's own
 * API shape is declared here:
 *
 *   listModels  — lists models the owner's sealed API key can actually use,
 *                 filtered to those supporting `generateContent`. The key is
 *                 sent to Google server-side and never returned to the
 *                 browser — only `{ id, name }` pairs come back.
 *   probeModel  — fires a minimal (1-output-token) `generateContent` probe
 *                 against the chosen model with the owner's own sealed key.
 *                 This is required because Google's `ListModels` API (what
 *                 `listModels` reads) keeps listing models well after they
 *                 are retired (#1818) — the picker can offer a corpse, and
 *                 only a real generate call proves the model is actually
 *                 servable right now.
 *
 * Security invariant: the API key never leaves the server, in either
 * direction — not in the GET response, and not echoed back on PUT.
 */
import { createConnectorModelPickerRoute } from '@/src/lib/kernel/connector-model-picker-route';
import { listModels, probeModel } from '@/src/lib/gemini/model-handlers';
import {
  loadGeminiSealedCredentials,
  geminiKeyPending,
  setModelId,
} from '@/src/lib/gemini/connector';

export const { GET, PUT, OPTIONS } = createConnectorModelPickerRoute({
  id: 'gemini',
  displayName: 'Gemini',
  upstreamName: 'Google',
  loadSealedCredentials: loadGeminiSealedCredentials,
  keyPending: geminiKeyPending,
  setModelId,
  listModels,
  probeModel,
});
