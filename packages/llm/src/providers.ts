/**
 * Provider factory — returns Vercel AI SDK provider instances.
 *
 * Usage:
 *   import { getModel } from '@imajin/llm';
 *   const model = getModel('anthropic', 'claude-sonnet-4-20250514');
 *   const { text } = await generateText({ model, system: '...', prompt: '...' });
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
 * Get a Vercel AI SDK model instance.
 *
 * For Anthropic/OpenAI: reads API key from config or env (ANTHROPIC_API_KEY / OPENAI_API_KEY).
 * For Ollama: points to local inference server, no API key needed.
 */
export function getModel(
  provider: ProviderName,
  model: string,
  config?: Partial<ProviderConfig>
): LanguageModelV1 {
  switch (provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({
        apiKey: config?.apiKey ?? process.env.ANTHROPIC_API_KEY,
        ...(config?.baseURL && { baseURL: config.baseURL }),
      });
      return anthropic(model);
    }
    case 'openai': {
      const openai = createOpenAI({
        apiKey: config?.apiKey ?? process.env.OPENAI_API_KEY,
        ...(config?.baseURL && { baseURL: config.baseURL }),
      });
      return openai(model);
    }
    case 'ollama': {
      // Ollama uses OpenAI-compatible API
      const ollama = createOpenAI({
        apiKey: 'ollama', // Ollama doesn't need a real key
        baseURL: config?.baseURL ?? process.env.OLLAMA_BASE_URL ?? 'http://192.168.1.124:11434/v1',
      });
      return ollama(model);
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Resolve a model from .imajin/config.json settings.
 *
 * Config format: { model: "claude-sonnet-4-20250514", provider: "anthropic" }
 * Or shorthand: { model: "default" } → falls back to Anthropic Sonnet.
 */
export function resolveModel(presenceConfig: {
  model?: string;
  provider?: string;
  temperature?: number;
}): { model: LanguageModelV1; modelId: string; provider: ProviderName } {
  const provider = (presenceConfig.provider as ProviderName) ?? 'anthropic';
  const modelId = presenceConfig.model === 'default' || !presenceConfig.model
    ? 'claude-sonnet-4-20250514'
    : presenceConfig.model;

  return {
    model: getModel(provider, modelId),
    modelId,
    provider,
  };
}
