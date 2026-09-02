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
    expect(resolveRoute(ROUTES, 'openai', 'grok-4')?.id).toBe('openai');
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
