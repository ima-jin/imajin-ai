import { describe, it, expect } from 'vitest';
import { resolveRoute } from '../src/router.js';
import type { ProviderRouteConfig } from '../src/types.js';

const ROUTES: ProviderRouteConfig[] = [
  { id: 'xai', principalDid: 'did:imajin:ryan', attestationId: 'att-xai', modelPrefixes: ['grok-'] },
  { id: 'openai', principalDid: 'did:imajin:ryan', attestationId: 'att-openai', modelPrefixes: ['gpt-', 'o1-'] },
  { id: 'anthropic', principalDid: 'did:imajin:ryan', attestationId: 'att-anthropic', modelPrefixes: ['claude-'] },
];

describe('resolveRoute', () => {
  it('selects by explicit path segment regardless of model', () => {
    expect(resolveRoute(ROUTES, 'xai', 'gpt-4o')?.id).toBe('xai');
    expect(resolveRoute(ROUTES, 'openai', 'gpt-4o')?.id).toBe('openai');
  });

  it("lets the model win on the generic 'openai' seat so grok-4 reaches the xai route (#2453)", () => {
    expect(resolveRoute(ROUTES, 'openai', 'grok-4')?.id).toBe('xai');
  });

  it("keeps the 'openai' seat for a model no route claims, leaving the kernel to decide", () => {
    expect(resolveRoute(ROUTES, 'openai', 'mystery-model')?.id).toBe('openai');
  });

  it("falls back to the model's route when 'openai' is not configured", () => {
    const withoutOpenai = ROUTES.filter((r) => r.id !== 'openai');
    expect(resolveRoute(withoutOpenai, 'openai', 'grok-4')?.id).toBe('xai');
    expect(resolveRoute(withoutOpenai, 'openai', 'mystery-model')).toBeUndefined();
  });

  it('returns undefined for an unknown path segment', () => {
    expect(resolveRoute(ROUTES, 'unknown-provider', 'grok-4')).toBeUndefined();
  });

  it('falls back to matching model prefixes when no path segment is given', () => {
    expect(resolveRoute(ROUTES, undefined, 'grok-4-fast')?.id).toBe('xai');
    expect(resolveRoute(ROUTES, undefined, 'gpt-4o')?.id).toBe('openai');
    expect(resolveRoute(ROUTES, undefined, 'o1-mini')?.id).toBe('openai');
  });

  it('returns undefined when no route matches the model and no path segment was given', () => {
    expect(resolveRoute(ROUTES, undefined, 'gemini-2.5')).toBeUndefined();
  });

  it('returns undefined when model is missing and no path segment was given', () => {
    expect(resolveRoute(ROUTES, undefined, undefined)).toBeUndefined();
  });
});
