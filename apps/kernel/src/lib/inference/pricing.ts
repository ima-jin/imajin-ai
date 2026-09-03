/**
 * Best-effort inference pricing (#1923, Phase 3 of #1922).
 *
 * The kernel never bills through these numbers — every brain connector is
 * BYOK (the owner's own sealed key, billed by the provider directly to the
 * owner's own account with that provider). This table exists only to give
 * `usage.incurred.cost_usd` and the burn-down dashboard a number to show,
 * and to give the spend-cap check something to compare against a declared
 * USD ceiling.
 *
 * Rates are USD per 1,000,000 tokens, published list pricing at the time
 * this landed. Providers change pricing and retire/rename models faster than
 * this table can track (the same reason `brain.ts` has no hardcoded default
 * model, #1769) — an unrecognized model falls back to the connector's
 * `DEFAULT_RATE` rather than guessing, and callers should treat `costUsd` as
 * an estimate, not an invoice. Keeping this list current is ordinary
 * maintenance, not a seam decision.
 */
import type { BrainConnectorId } from './brain';

export interface TokenRateUsd {
  /** USD per 1,000,000 input/prompt tokens. */
  inputPer1M: number;
  /** USD per 1,000,000 output/completion tokens. */
  outputPer1M: number;
}

/** Per-model overrides, keyed by the exact sealed `modelId`. */
const MODEL_RATES: Partial<Record<BrainConnectorId, Record<string, TokenRateUsd>>> = {
  anthropic: {
    'claude-sonnet-4-20250514': { inputPer1M: 3, outputPer1M: 15 },
    'claude-opus-4-20250514': { inputPer1M: 15, outputPer1M: 75 },
    'claude-3-5-haiku-20241022': { inputPer1M: 0.8, outputPer1M: 4 },
  },
  openai: {
    'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10 },
    'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
    'gpt-4.1': { inputPer1M: 2, outputPer1M: 8 },
    'gpt-4.1-mini': { inputPer1M: 0.4, outputPer1M: 1.6 },
  },
  gemini: {
    'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10 },
    'gemini-2.5-flash': { inputPer1M: 0.3, outputPer1M: 2.5 },
  },
  xai: {
    'grok-4': { inputPer1M: 3, outputPer1M: 15 },
    'grok-3': { inputPer1M: 3, outputPer1M: 15 },
    'grok-3-mini': { inputPer1M: 0.3, outputPer1M: 0.5 },
  },
  moonshot: {
    'kimi-k2-0711-preview': { inputPer1M: 0.6, outputPer1M: 2.5 },
  },
  zai: {
    'glm-4.6': { inputPer1M: 0.6, outputPer1M: 2.2 },
  },
};

/**
 * Connector-level fallback rate, used when the sealed `modelId` has no exact
 * entry above (a newer/renamed model the table has not caught up to yet).
 * Deliberately conservative-ish mid-tier estimates per connector rather than
 * one global number, since providers' price bands differ enough that a
 * single fallback would misrepresent every connector but one.
 */
const DEFAULT_RATE: Record<BrainConnectorId, TokenRateUsd> = {
  anthropic: { inputPer1M: 3, outputPer1M: 15 },
  openai: { inputPer1M: 2.5, outputPer1M: 10 },
  gemini: { inputPer1M: 1.25, outputPer1M: 10 },
  xai: { inputPer1M: 3, outputPer1M: 15 },
  moonshot: { inputPer1M: 0.6, outputPer1M: 2.5 },
  zai: { inputPer1M: 0.6, outputPer1M: 2.2 },
  // #1957: local inference is BYO-hardware, not BYOK — there is no provider
  // invoice behind it at all, so the rate is exactly 0 rather than an
  // estimate. Attribution (the token counts themselves) is still what
  // usage.incurred records; only the dollar figure is zero.
  local: { inputPer1M: 0, outputPer1M: 0 },
};

/**
 * Compute the estimated USD cost of one call, or `undefined` when either
 * token count is unknown (nothing to compute from) — never `0`, which would
 * misreport a genuinely free/unmeasured call as a $0 one on the burn-down.
 */
export function computeCostUsd(
  connector: BrainConnectorId,
  modelId: string,
  tokensIn: number | undefined,
  tokensOut: number | undefined,
): number | undefined {
  if (tokensIn === undefined || tokensOut === undefined) return undefined;

  const rate = MODEL_RATES[connector]?.[modelId] ?? DEFAULT_RATE[connector];
  const cost = (tokensIn / 1_000_000) * rate.inputPer1M + (tokensOut / 1_000_000) * rate.outputPer1M;
  // Round to 8 decimal places — matches usage.incurred.cost_usd's NUMERIC(20,8).
  return Math.round(cost * 1e8) / 1e8;
}
