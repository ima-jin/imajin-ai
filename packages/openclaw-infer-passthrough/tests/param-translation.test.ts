import { describe, it, expect } from 'vitest';
import { translateOpenAiParams } from '../src/param-translation.js';

describe('translateOpenAiParams — max_tokens → max_completion_tokens', () => {
  it('rewrites max_tokens for a gpt-* model', () => {
    const body = JSON.stringify({ model: 'gpt-6-astra', max_tokens: 512, messages: [] });

    const result = translateOpenAiParams('gpt-6-astra', body);

    expect(JSON.parse(result)).toEqual({ model: 'gpt-6-astra', max_completion_tokens: 512, messages: [] });
  });

  it('rewrites max_tokens for an o1-* model', () => {
    const body = JSON.stringify({ model: 'o1-mini', max_tokens: 256, messages: [] });

    const result = translateOpenAiParams('o1-mini', body);

    expect(JSON.parse(result)).toEqual({ model: 'o1-mini', max_completion_tokens: 256, messages: [] });
  });

  it('does not rewrite when max_completion_tokens is already present', () => {
    const body = JSON.stringify({ model: 'gpt-6-astra', max_tokens: 512, max_completion_tokens: 256, messages: [] });

    const result = translateOpenAiParams('gpt-6-astra', body);

    expect(result).toBe(body);
  });

  it('does not rewrite for a grok-* model — xAI accepts max_tokens unchanged', () => {
    const body = JSON.stringify({ model: 'grok-4', max_tokens: 512, messages: [] });

    const result = translateOpenAiParams('grok-4', body);

    expect(result).toBe(body);
  });

  it('does not rewrite for a claude-* model', () => {
    const body = JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 512, messages: [] });

    const result = translateOpenAiParams('claude-opus-4-6', body);

    expect(result).toBe(body);
  });

  it('leaves the body untouched when max_tokens is absent', () => {
    const body = JSON.stringify({ model: 'gpt-6-astra', messages: [] });

    const result = translateOpenAiParams('gpt-6-astra', body);

    expect(result).toBe(body);
  });

  it('returns the body unchanged when model is undefined', () => {
    const body = JSON.stringify({ max_tokens: 512, messages: [] });

    const result = translateOpenAiParams(undefined, body);

    expect(result).toBe(body);
  });

  it('returns the body unchanged when it is not valid JSON', () => {
    const body = 'not json';

    const result = translateOpenAiParams('gpt-6-astra', body);

    expect(result).toBe(body);
  });
});

describe('translateOpenAiParams — drop reasoning_effort when tools is present (#2201 follow-up)', () => {
  it('drops reasoning_effort for a gpt-* model when tools is present', () => {
    const body = JSON.stringify({
      model: 'gpt-6-astra',
      reasoning_effort: 'medium',
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      messages: [],
    });

    const result = translateOpenAiParams('gpt-6-astra', body);

    const parsed = JSON.parse(result);
    expect(parsed).not.toHaveProperty('reasoning_effort');
    expect(parsed.tools).toEqual([{ type: 'function', function: { name: 'lookup' } }]);
  });

  it('leaves reasoning_effort untouched for a gpt-* model when tools is absent', () => {
    const body = JSON.stringify({ model: 'gpt-6-astra', reasoning_effort: 'medium', messages: [] });

    const result = translateOpenAiParams('gpt-6-astra', body);

    expect(result).toBe(body);
  });

  it('does not drop reasoning_effort for a grok-* model, even with tools present', () => {
    const body = JSON.stringify({
      model: 'grok-4',
      reasoning_effort: 'medium',
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      messages: [],
    });

    const result = translateOpenAiParams('grok-4', body);

    expect(result).toBe(body);
  });

  it('applies both rewrites together when both conditions are met', () => {
    const body = JSON.stringify({
      model: 'gpt-6-astra',
      max_tokens: 512,
      reasoning_effort: 'medium',
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      messages: [],
    });

    const result = translateOpenAiParams('gpt-6-astra', body);
    const parsed = JSON.parse(result);

    expect(parsed).not.toHaveProperty('reasoning_effort');
    expect(parsed).not.toHaveProperty('max_tokens');
    expect(parsed.max_completion_tokens).toBe(512);
  });
});
