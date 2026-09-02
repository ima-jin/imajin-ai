/**
 * Shared HTTP mapping for brain-resolution failures (#1764/#1773/#1818, #1925).
 *
 * `NoBrainSealedError`, `NoModelSelectedError`, and `ModelDeprecatedError` (brain
 * resolution), an exhausted upstream retry loop (`RetryError`, rate limiting),
 * and a sealed credential still pending owner approval (`VaultDelegationError`)
 * are outcomes every route that calls `resolveBrain` needs to translate into a
 * typed HTTP response THE SAME WAY. This mapping was hand-written once already
 * in `POST /api/inference/capture` (#1764) before the completions passthrough
 * (#1925) needed the identical translation — extracted here so the passthrough
 * does not clone the scaffolding. PR #1928 (#1922 Phase 1) was flagged by the
 * SonarCloud duplication gate for exactly this shape of copy; this module is
 * how Phase 2 avoids repeating it.
 *
 * Deliberately narrow: only errors that name an actionable, expected runtime
 * outcome are mapped. Callers still own their own generic 500 fallback, since
 * "unrecognized failure" is a route-local decision (e.g. whether to log
 * `ownerDid` alongside it).
 */
import { RetryError } from 'ai';
import { NoBrainSealedError, NoModelSelectedError, ModelDeprecatedError } from './brain';
import { VaultDelegationError } from '@/src/lib/vault/errors';
import { SpendCapExceededError } from './spend-cap';

export interface MappedHttpError {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Map a brain-resolution/pipeline failure to a typed HTTP response, or
 * `undefined` when `err` is not one of the recognized cases — the caller
 * should fall through to its own generic failure response.
 */
export function mapBrainErrorToHttp(err: unknown): MappedHttpError | undefined {
  // #1621 removed the env-key fallback, so "nobody sealed a brain" is a real
  // runtime outcome. The response must never carry credential material — the
  // resolver names only DIDs and connectors, never keys.
  if (err instanceof NoBrainSealedError) {
    return {
      status: 422,
      body: {
        error: 'no_brain',
        message: 'No AI model connected — connect Gemini, Anthropic, or xAI',
        detail: err.message,
      },
    };
  }

  // #1773: a connector can be fully connected (grant + key both resolved)
  // with no model chosen yet — distinct from `NoBrainSealedError` (nothing
  // connected at all). The fix is to pick a model on the connector card, not
  // to try a different credential.
  if (err instanceof NoModelSelectedError) {
    return {
      status: 422,
      body: {
        error: 'no_model_selected',
        message: 'Connected, but no model is selected — choose one on the connector card',
        detail: err.message,
      },
    };
  }

  // #1818: the model sealed on a connector card can be retired upstream
  // after selection — pick-time validation narrows this window but cannot
  // close it. Distinct from `no_model_selected`: a model IS chosen, it just
  // no longer exists upstream.
  if (err instanceof ModelDeprecatedError) {
    return {
      status: 422,
      body: {
        error: 'model_deprecated',
        message: `Your selected ${err.connector} model '${err.modelId}' was retired upstream — pick a new one`,
        connector: err.connector,
        modelId: err.modelId,
        detail: err.message,
      },
    };
  }

  // #1764: a single request can amplify into multiple upstream 429s via the
  // AI SDK's own retry loop. Matched on message content, not just the
  // RetryError type, because a RetryError can also wrap non-rate-limit
  // failures (timeouts, 5xxs) that belong on the caller's generic fallback.
  if (RetryError.isInstance(err) && /too many requests|429/i.test(err.message)) {
    return {
      status: 429,
      body: {
        error: 'rate_limited',
        message: 'Model rate limit hit — try again shortly',
        detail: err.message,
      },
    };
  }

  // #1923: the connector's declared spend cap has already been reached this
  // window — a refusal, not a crash. 402 Payment Required is the one status
  // in the mapping that names "you must pay/raise your budget to proceed"
  // rather than "something about the request or credential is wrong".
  if (err instanceof SpendCapExceededError) {
    return {
      status: 402,
      body: {
        error: 'spend_cap_exceeded',
        message: 'Spend cap reached for this connector — raise the cap or wait for the window to reset',
        spentUsd: err.spentUsd,
        capUsd: err.cap.amountUsd,
        period: err.cap.period,
        detail: err.message,
      },
    };
  }

  // A sealed key still awaiting the owner's Tier 1 delegation approval is a
  // temporary, actionable state — not a crash.
  if (err instanceof VaultDelegationError) {
    return {
      status: 503,
      body: {
        error: 'credential_pending',
        message: 'Model credentials pending approval',
        detail: err.message,
      },
    };
  }

  return undefined;
}
