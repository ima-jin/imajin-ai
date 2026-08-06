/**
 * Presence brain resolution (#1621).
 *
 * A presence answers on its owner's behalf, so it runs on the OWNER's sealed
 * connector card — their brain, their credential, their bill. Both presence
 * surfaces (`/query` and `/stream`) need the same three steps: resolve the
 * owner's brain, build the model from it, and map a failure to an HTTP shape.
 *
 * This returns plain data rather than a Response so each route can answer in its
 * own idiom (`NextResponse.json` vs a streaming `Response`) without duplicating
 * the resolution or the status mapping.
 */
import { getModel } from '@imajin/llm';
import type { LanguageModelV1 } from '@imajin/llm';
import { resolveBrain, NoBrainSealedError } from './brain';

export type PresenceBrainResult =
  | { ok: true; model: LanguageModelV1; modelId: string; connector: string }
  | { ok: false; status: number; error: string; cause: string };

/**
 * Resolve the presence owner's model.
 *
 * Failure is data, not an exception, and is deliberately split in two:
 *   409 — the owner has sealed no brain. Actionable by the owner, not a fault.
 *   503 — resolution itself broke (vault/DB). Transient, retryable.
 *
 * A `NoBrainSealedError` that carries connector `failures` lands in the SECOND
 * bucket, not the first (#1637). `resolveBrain` now skips a connector that
 * throws instead of aborting the whole walk, so "nothing resolved" no longer
 * implies "nothing is connected" — telling an owner with a sealed-but-pending
 * card to go connect a model would be both wrong and unactionable.
 *
 * `cause` is for server-side logging only. It must not be returned to a caller:
 * an upstream message can carry credential material.
 */
export async function resolvePresenceBrain(ownerDid: string): Promise<PresenceBrainResult> {
  try {
    const brain = await resolveBrain(ownerDid);
    return {
      ok: true,
      modelId: brain.modelId,
      connector: brain.connector,
      model: getModel(brain.provider, brain.modelId, {
        apiKey: brain.apiKey,
        ...(brain.baseURL === undefined ? {} : { baseURL: brain.baseURL }),
      }),
    };
  } catch (err) {
    if (err instanceof NoBrainSealedError && err.failures.length === 0) {
      return {
        ok: false,
        status: 409,
        error: 'This profile has not connected a model for inference',
        cause: String(err),
      };
    }
    return {
      ok: false,
      status: 503,
      error: 'Inference unavailable',
      cause: String(err),
    };
  }
}
