import { describe, expect, it, vi } from 'vitest';
import { chunkRows, postIncurredBatch } from '../../src/usage-emitter/client.js';
import type { MappedUsageRow } from '../../src/usage-emitter/mapper.js';

const row: MappedUsageRow = {
  source: 'harness:nanoclaw',
  resource: 'model:anthropic/claude-sonnet-4-5',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  tokens_in: 10,
  tokens_out: 5,
  external_id: 'msg-1',
  ts: '2026-09-02T12:00:00.000Z',
};

describe('chunkRows', () => {
  it('splits into chunks no larger than the given size', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ ...row, external_id: `msg-${i}` }));
    const chunks = chunkRows(rows, 2);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(2);
    expect(chunks[2]).toHaveLength(1);
  });
});

describe('postIncurredBatch', () => {
  it('posts to /usage/api/incurred with a bearer token and returns the parsed response', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://kernel.example.com/usage/api/incurred');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer token-abc');
      const body = JSON.parse(String(init?.body)) as MappedUsageRow[];
      expect(body).toEqual([row]);
      return new Response(JSON.stringify({ inserted: 1, skipped: 0, rejected: [] }), { status: 202 });
    });

    const result = await postIncurredBatch(
      { kernelUrl: 'https://kernel.example.com', token: 'token-abc', fetchImpl: fetchMock as unknown as typeof fetch },
      [row],
    );
    expect(result).toEqual({ inserted: 1, skipped: 0, rejected: [] });
  });

  it('throws with the kernel error message on failure', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'unknown emitter source' }), { status: 403 }));
    await expect(
      postIncurredBatch({ kernelUrl: 'https://kernel.example.com', token: 't', fetchImpl: fetchMock as unknown as typeof fetch }, [row]),
    ).rejects.toThrow(/unknown emitter source/);
  });
});
