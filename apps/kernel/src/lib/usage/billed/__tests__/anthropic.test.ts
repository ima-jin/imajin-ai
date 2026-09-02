import { describe, it, expect, vi } from 'vitest';
import { createAnthropicBilledUsageReader } from '../anthropic';
import { BillingApiError } from '../types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const PERIOD = { start: new Date('2026-08-01T00:00:00Z'), end: new Date('2026-08-02T00:00:00Z') };

describe('createAnthropicBilledUsageReader', () => {
  it('normalizes usage + cost buckets into one line per model', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/usage_report/messages')) {
        return jsonResponse({
          data: [{
            starting_at: '2026-08-01T00:00:00Z',
            ending_at: '2026-08-02T00:00:00Z',
            results: [
              { model: 'claude-opus-5', uncached_input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 5 } },
            ],
          }],
          has_more: false,
          next_page: null,
        });
      }
      return jsonResponse({
        data: [{
          starting_at: '2026-08-01T00:00:00Z',
          ending_at: '2026-08-02T00:00:00Z',
          results: [{ amount: '250.00', model: 'claude-opus-5', description: 'Claude Opus 5 Usage - Input Tokens', cost_type: 'tokens' }],
        }],
        has_more: false,
        next_page: null,
      });
    });

    const reader = createAnthropicBilledUsageReader({ adminApiKey: 'sk-ant-admin-test', fetchImpl: fetchImpl as unknown as typeof fetch });
    const lines = await reader.fetch(PERIOD, 'day');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      model: 'claude-opus-5',
      tokensIn: 1000 + 50 + 10 + 5,
      tokensOut: 200,
      billedUsd: 2.5, // 250.00 / 100
    });
  });

  it('paginates through has_more/next_page for both endpoints', async () => {
    let usageCalls = 0;
    let costCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/usage_report/messages')) {
        usageCalls += 1;
        if (usageCalls === 1) {
          expect(url).not.toContain('page=');
          return jsonResponse({
            data: [{ starting_at: 'a', ending_at: 'b', results: [{ model: 'claude-haiku-4-5', uncached_input_tokens: 10, output_tokens: 1 }] }],
            has_more: true,
            next_page: 'cursor_1',
          });
        }
        expect(url).toContain('page=cursor_1');
        return jsonResponse({
          data: [{ starting_at: 'b', ending_at: 'c', results: [{ model: 'claude-haiku-4-5', uncached_input_tokens: 5, output_tokens: 2 }] }],
          has_more: false,
          next_page: null,
        });
      }
      costCalls += 1;
      return jsonResponse({ data: [], has_more: false, next_page: null });
    });

    const reader = createAnthropicBilledUsageReader({ adminApiKey: 'sk-ant-admin-test', fetchImpl: fetchImpl as unknown as typeof fetch });
    const lines = await reader.fetch(PERIOD, 'month');

    expect(usageCalls).toBe(2);
    expect(costCalls).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ model: 'claude-haiku-4-5', tokensIn: 15, tokensOut: 3, billedUsd: null });
  });

  it.each([401, 403])('throws a typed BillingApiError on %d (missing/insufficient admin key)', async (status) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, status));
    const reader = createAnthropicBilledUsageReader({ adminApiKey: 'bad-key', fetchImpl: fetchImpl as unknown as typeof fetch });

    const err = await reader.fetch(PERIOD, 'day').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingApiError);
    expect((err as BillingApiError).provider).toBe('anthropic');
    expect((err as BillingApiError).status).toBe(status);
    expect((err as BillingApiError).isAuthError).toBe(true);
  });

  it('throws a non-auth BillingApiError on a 500', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'oops' }, 500));
    const reader = createAnthropicBilledUsageReader({ adminApiKey: 'sk-ant-admin-test', fetchImpl: fetchImpl as unknown as typeof fetch });

    const err = await reader.fetch(PERIOD, 'day').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingApiError);
    expect((err as BillingApiError).isAuthError).toBe(false);
  });
});
