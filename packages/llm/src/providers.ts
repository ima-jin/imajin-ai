/**
 * Provider factory — returns Vercel AI SDK provider instances.
 *
 * Usage:
 *   import { getModel } from '@imajin/llm';
 *   const model = getModel('anthropic', 'claude-sonnet-4-20250514', { apiKey });
 *   const { text } = await generateText({ model, system: '...', prompt: '...' });
 *
 * Credentials are ALWAYS passed in — this factory never reads an API key from
 * the environment. Ambient `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` fallbacks were
 * removed in #1621: inference credentials are sealed per-DID and resolved from
 * the acting identity's connector cards, so an env fallback would silently run a
 * user's inference on a shared node key. Callers resolve the credential first
 * (see `resolveBrain` in the kernel) and hand it over explicitly.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV1 } from 'ai';

export type ProviderName = 'anthropic' | 'openai' | 'ollama';

interface ProviderConfig {
  provider: ProviderName;
  apiKey?: string;
  baseURL?: string;
}

/**
 * Thrown when a key-bearing provider is asked for a model without a credential.
 *
 * Deliberately loud: the previous behaviour was to pass `undefined` through to
 * the SDK, which then failed at request time with an opaque upstream 401 that
 * looked like a provider outage rather than a missing connection.
 */
export class MissingApiKeyError extends Error {
  constructor(provider: ProviderName) {
    super(
      `llm_missing_api_key: provider '${provider}' requires an explicit apiKey — ` +
      `resolve the caller's sealed credential and pass it to getModel(). ` +
      `Environment API keys are not consulted.`,
    );
    this.name = 'MissingApiKeyError';
  }
}

function requireApiKey(provider: ProviderName, apiKey: string | undefined): string {
  if (!apiKey) {
    throw new MissingApiKeyError(provider);
  }
  return apiKey;
}

/**
 * Get a Vercel AI SDK model instance.
 *
 * For Anthropic/OpenAI: `config.apiKey` is REQUIRED (see MissingApiKeyError).
 * For Ollama: points to a local inference server, no API key needed.
 */
export function getModel(
  provider: ProviderName,
  model: string,
  config?: Partial<ProviderConfig>
): LanguageModelV1 {
  switch (provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({
        apiKey: requireApiKey(provider, config?.apiKey),
        ...(config?.baseURL && { baseURL: config.baseURL }),
      });
      return anthropic(model);
    }
    case 'openai': {
      const openai = createOpenAI({
        apiKey: requireApiKey(provider, config?.apiKey),
        ...(config?.baseURL && { baseURL: config.baseURL }),
      });
      return openai(model);
    }
    case 'ollama': {
      const baseURL = config?.baseURL ?? process.env.OLLAMA_BASE_URL;
      if (!baseURL) {
        throw new Error('OLLAMA_BASE_URL is required for the ollama provider');
      }
      // Ollama uses OpenAI-compatible API
      const ollama = createOpenAI({
        apiKey: 'ollama', // Ollama doesn't need a real key
        baseURL,
      });
      return ollama(model);
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

