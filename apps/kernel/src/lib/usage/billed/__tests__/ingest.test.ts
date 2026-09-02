import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSql, mockGetClient } = vi.hoisted(() => {
  const mockSql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
    Promise.resolve({ text: strings.join('?'), values }));
  (mockSql as unknown as { json: (v: unknown) => unknown }).json = vi.fn((v: unknown) => ({ __json: v }));
  return { mockSql, mockGetClient: vi.fn(() => mockSql) };
});

vi.mock('@imajin/db', () => ({ getClient: mockGetClient }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));

import { ingestBilledUsage } from '../ingest';

const PERIOD = { start: new Date('2026-08-01T00:00:00Z'), end: new Date('2026-08-02T00:00:00Z') };

describe('ingestBilledUsage', () => {
  beforeEach(() => {
    mockSql.mockClear();
    (mockSql as unknown as { json: ReturnType<typeof vi.fn> }).json.mockClear();
  });

  it('issues one upsert per line, targeting the COALESCE(model, \'\') unique index', async () => {
    const rowsWritten = await ingestBilledUsage({
      principalDid: 'did:imajin:owner',
      provider: 'anthropic',
      period: PERIOD,
      granularity: 'day',
      lines: [
        { model: 'claude-opus-5', tokensIn: 100, tokensOut: 20, billedUsd: 1.5, raw: { a: 1 } },
        { model: null, tokensIn: null, tokensOut: null, billedUsd: 2, raw: { b: 2 } },
      ],
    });

    expect(rowsWritten).toBe(2);
    expect(mockSql).toHaveBeenCalledTimes(2);

    const firstCallText = (mockSql.mock.calls[0][0] as TemplateStringsArray).join('');
    expect(firstCallText).toContain('INSERT INTO usage.billed');
    expect(firstCallText).toContain("ON CONFLICT (principal_did, provider, period_start, granularity, COALESCE(model, ''))");
    expect(firstCallText).toContain('DO UPDATE SET');
  });

  it('rounds billedUsd to 8 decimal places, and passes null through untouched', async () => {
    await ingestBilledUsage({
      principalDid: 'did:imajin:owner',
      provider: 'openai',
      period: PERIOD,
      granularity: 'month',
      lines: [
        { model: 'gpt-5.5', tokensIn: 1, tokensOut: 1, billedUsd: 1 / 3, raw: {} },
        { model: null, tokensIn: null, tokensOut: null, billedUsd: null, raw: {} },
      ],
    });

    const values0 = mockSql.mock.calls[0].slice(1) as unknown[];
    expect(values0).toContain((1 / 3).toFixed(8));

    const values1 = mockSql.mock.calls[1].slice(1) as unknown[];
    expect(values1).toContain(null);
  });

  it('serializes raw through sql.json for the jsonb column', async () => {
    const jsonMock = (mockSql as unknown as { json: ReturnType<typeof vi.fn> }).json;
    await ingestBilledUsage({
      principalDid: 'did:imajin:owner',
      provider: 'anthropic',
      period: PERIOD,
      granularity: 'day',
      lines: [{ model: 'claude-opus-5', tokensIn: 1, tokensOut: 1, billedUsd: 1, raw: { usage: [1, 2, 3] } }],
    });

    expect(jsonMock).toHaveBeenCalledWith({ usage: [1, 2, 3] });
  });
});
