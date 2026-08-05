import { describe, it, expect, afterEach } from 'vitest';
import { getModel, MissingApiKeyError } from '../src/providers';

afterEach(() => {
  // @ts-expect-error -- vitest augments globalThis; unstub via process for clarity
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OLLAMA_BASE_URL;
});

describe('getModel — explicit credentials only (#1621)', () => {
  it.each(['anthropic', 'openai'] as const)(
    'throws MissingApiKeyError when %s is given no apiKey',
    (provider) => {
      expect(() => getModel(provider, 'some-model')).toThrow(MissingApiKeyError);
    },
  );

  /**
   * The behaviour this replaces: `apiKey: config?.apiKey ?? process.env.X`.
   * With env keys being removed, an ambient key must NOT silently satisfy the
   * call — otherwise one user's inference runs on a shared node credential and
   * nothing in the code path says so.
   */
  it.each([
    ['anthropic', 'ANTHROPIC_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
  ] as const)('ignores %s ambient env key %s', (provider, envVar) => {
    process.env[envVar] = 'ambient-env-key';

    expect(() => getModel(provider, 'some-model')).toThrow(MissingApiKeyError);
  });

  it.each(['anthropic', 'openai'] as const)(
    'builds a %s model when an explicit key is supplied',
    (provider) => {
      expect(getModel(provider, 'some-model', { apiKey: 'sealed-key' })).toBeDefined();
    },
  );

  it('names the provider in the error so the caller knows what to resolve', () => {
    const err = (() => {
      try {
        getModel('anthropic', 'claude-sonnet-4-20250514');
        return undefined;
      } catch (e) {
        return e as MissingApiKeyError;
      }
    })();

    expect(err?.message).toContain('llm_missing_api_key');
    expect(err?.message).toContain('anthropic');
  });

  it('rejects an empty-string key rather than passing it through', () => {
    expect(() => getModel('openai', 'gpt-4o', { apiKey: '' })).toThrow(MissingApiKeyError);
  });
});

describe('getModel — ollama needs no credential', () => {
  it('builds a model from an explicit baseURL', () => {
    expect(getModel('ollama', 'llama3', { baseURL: 'http://localhost:11434/v1' })).toBeDefined();
  });

  it('still reads OLLAMA_BASE_URL — a local endpoint, not a secret', () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434/v1';

    expect(getModel('ollama', 'llama3')).toBeDefined();
  });

  it('throws when no endpoint is configured at all', () => {
    expect(() => getModel('ollama', 'llama3')).toThrow(/OLLAMA_BASE_URL/);
  });
});

describe('getModel — unknown provider', () => {
  it('fails loudly rather than defaulting to a provider', () => {
    // @ts-expect-error -- deliberately outside ProviderName
    expect(() => getModel('mystery', 'model', { apiKey: 'k' })).toThrow(/Unknown provider/);
  });
});
