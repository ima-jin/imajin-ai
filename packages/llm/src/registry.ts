import { AnthropicProvider } from './providers/anthropic';
import type { LLMProvider } from './types';

export function createProvider(config: { provider: string; apiKey: string }): LLMProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey: config.apiKey });
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

export function getDefaultProvider(): LLMProvider {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  return new AnthropicProvider({ apiKey });
}
