/**
 * @imajin/llm — Thin wrapper around Vercel AI SDK with cost tracking.
 *
 * This package does NOT reinvent the LLM interface. It provides:
 * 1. Provider factory (Anthropic, OpenAI, Ollama) via Vercel AI SDK
 * 2. Cost calculation from token usage
 * 3. Config resolution from .imajin/config.json
 *
 * For actual inference, use the Vercel AI SDK directly:
 *   import { generateText, streamText } from 'ai';
 *   import { getModel, calculateCost } from '@imajin/llm';
 */

// Provider factory
export { getModel, resolveModel } from './providers';
export type { ProviderName } from './providers';

// Cost tracking
export { calculateCost, getModelRates } from './costs';
export type { ModelRates } from './costs';

// Re-export commonly used Vercel AI SDK functions for convenience
export { generateText, streamText } from 'ai';
export type { LanguageModelV1 } from 'ai';
