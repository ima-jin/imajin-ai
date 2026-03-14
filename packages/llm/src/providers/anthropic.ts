import Anthropic from '@anthropic-ai/sdk';
import type { CompletionRequest, CompletionResponse, LLMProvider } from '../types';

// Rates in USD per million tokens
const MODEL_RATES: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-haiku-3-20250307': { input: 0.25, output: 1.25 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
};

const DEFAULT_RATES = MODEL_RATES['claude-sonnet-4-20250514'];

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor({ apiKey }: { apiKey: string }) {
    this.client = new Anthropic({ apiKey });
  }

  estimateCost(model: string, promptTokens: number, completionTokens: number): number {
    const rates = MODEL_RATES[model] ?? DEFAULT_RATES;
    return (promptTokens * rates.input + completionTokens * rates.output) / 1_000_000;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    try {
      const response = await this.client.messages.create({
        model: request.model,
        max_tokens: request.maxTokens ?? 1024,
        system: request.system,
        messages: request.messages,
        ...(request.temperature !== undefined && { temperature: request.temperature }),
      });

      const content = response.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as { type: 'text'; text: string }).text)
        .join('');

      const promptTokens = response.usage.input_tokens;
      const completionTokens = response.usage.output_tokens;

      return {
        content,
        usage: { promptTokens, completionTokens },
        model: response.model,
        cost: this.estimateCost(response.model, promptTokens, completionTokens),
      };
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        throw new LLMError(`Anthropic API error ${err.status}: ${err.message}`, err);
      }
      throw new LLMError('Unexpected error calling Anthropic API', err);
    }
  }
}
