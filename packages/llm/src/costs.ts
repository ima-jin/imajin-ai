/**
 * Token cost rates for LLM models.
 * Rates in USD per million tokens.
 *
 * Add new models here as providers are added.
 * Unknown models fall back to the default rate.
 */

export interface ModelRates {
  input: number;   // USD per million input tokens
  output: number;  // USD per million output tokens
}

const RATES: Record<string, ModelRates> = {
  // Anthropic
  'claude-sonnet-4-20250514':   { input: 3,     output: 15 },
  'claude-haiku-3-20250307':    { input: 0.25,  output: 1.25 },
  'claude-opus-4-20250514':     { input: 15,    output: 75 },
  // OpenAI
  'gpt-4o':                     { input: 2.5,   output: 10 },
  'gpt-4o-mini':                { input: 0.15,  output: 0.6 },
  'gpt-4.1':                    { input: 2,     output: 8 },
  'gpt-4.1-mini':               { input: 0.4,   output: 1.6 },
  'gpt-4.1-nano':               { input: 0.1,   output: 0.4 },
  // Ollama / self-hosted
  'ollama:*':                   { input: 0,     output: 0 },
};

const DEFAULT_RATES: ModelRates = { input: 3, output: 15 }; // Sonnet-tier fallback

/**
 * Get rates for a model. Tries exact match, then prefix match (e.g. "ollama:*").
 */
export function getModelRates(model: string): ModelRates {
  if (RATES[model]) return RATES[model];

  // Prefix match (e.g. ollama models are free on local GPU)
  const prefix = model.split(':')[0];
  if (RATES[`${prefix}:*`]) return RATES[`${prefix}:*`];

  return DEFAULT_RATES;
}

/**
 * Calculate the cost of a completion in USD.
 */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const rates = getModelRates(model);
  return (promptTokens * rates.input + completionTokens * rates.output) / 1_000_000;
}
