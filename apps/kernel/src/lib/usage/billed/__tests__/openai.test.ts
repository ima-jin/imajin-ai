import { describe, it, expect, vi } from 'vitest';
import { createOpenAIBilledUsageReader } from '../openai';
import { BillingApiError } from '../types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const PERIOD = { start: new Date('2026-08-01T00:00:00Z'), end: new Date('2026-08-02T00:00:00Z') };

describe('createOpenAIBilledUsageReader', () => {
  it('emits per-model token lines plus one aggregate org-wide cost line', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/usage/completions')) {
        return jsonResponse({
          object: 'page',
          data: [{
            object: 'bucket', start_time: 1, end_time: 2,
            results: [{ object: 'organization.usage.completions.result', input_tokens: 1000, output_tokens: 500, model: 'gpt-5.5', num_model_requests: 5 }],
          }],
          has_more: false,
          next_page: null,
        });
      }
      return jsonResponse({
        object: 'page',
        data: [{
          object: 'bucket', start_time: 1, end_time: 2,
          results: [{ object: 'organization.costs.result', amount: { value: 12.34, currency: 'usd' }, line_item: 'gpt-5.5 usage' }],
        }],
        has_more: false,
        next_page: null,
      });
    });

    const reader = createOpenAIBilledUsageReader({ adminApiKey: 'sk-admin-test', fetchImpl: fetchImpl as unknown as typeof fetch });
    const lines = await reader.fetch(PERIOD, 'day');

    expect(lines).toHaveLength(2);
    expect(lines).toContainEqual(expect.objectContaining({ model: 'gpt-5.5', tokensIn: 1000, tokensOut: 500, billedUsd: null }));
    expect(lines).toContainEqual(expect.objectContaining({ model: null, tokensIn: null, tokensOut: null, billedUsd: 12.34 }));
  });

  it('paginates through has_more/next_page for both endpoints and sends unix-second times', async () => {
    let usageCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (url.includes('/usage/completions')) {
        usageCalls += 1;
        expect(parsed.searchParams.get('start_time')).toBe(String(Math.floor(PERIOD.start.getTime() / 1000)));
        if (usageCalls === 1) {
          return jsonResponse({
            object: 'page',
            data: [{ object: 'bucket', start_time: 1, end_time: 2, results: [{ object: 'organization.usage.completions.result', input_tokens: 10, output_tokens: 1, model: 'gpt-5.6-sol' }] }],
            has_more: true,
            next_page: 'cursor_1',
          });
        }
        expect(parsed.searchParams.get('page')).toBe('cursor_1');
        return jsonResponse({
          object: 'page',
          data: [{ object: 'bucket', start_time: 2, end_time: 3, results: [{ object: 'organization.usage.completions.result', input_tokens: 5, output_tokens: 2, model: 'gpt-5.6-sol' }] }],
          has_more: false,
          next_page: null,
        });
      }
      return jsonResponse({ object: 'page', data: [], has_more: false, next_page: null });
    });

    const reader = createOpenAIBilledUsageReader({ adminApiKey: 'sk-admin-test', fetchImpl: fetchImpl as unknown as typeof fetch });
    const lines = await reader.fetch(PERIOD, 'month');

    expect(usageCalls).toBe(2);
    expect(lines).toContainEqual(expect.objectContaining({ model: 'gpt-5.6-sol', tokensIn: 15, tokensOut: 3 }));
  });

  it.each([401, 403])('throws a typed BillingApiError on %d (missing/insufficient admin key)', async (status) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, status));
    const reader = createOpenAIBilledUsageReader({ adminApiKey: 'bad-key', fetchImpl: fetchImpl as unknown as typeof fetch });

    const err = await reader.fetch(PERIOD, 'day').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingApiError);
    expect((err as BillingApiError).provider).toBe('openai');
    expect((err as BillingApiError).status).toBe(status);
    expect((err as BillingApiError).isAuthError).toBe(true);
  });

  it('throws a non-auth BillingApiError on a 500', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'oops' }, 500));
    const reader = createOpenAIBilledUsageReader({ adminApiKey: 'sk-admin-test', fetchImpl: fetchImpl as unknown as typeof fetch });

    const err = await reader.fetch(PERIOD, 'day').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingApiError);
    expect((err as BillingApiError).isAuthError).toBe(false);
  });
});
