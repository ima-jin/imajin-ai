import { describe, it, expect, vi, afterEach } from 'vitest';
import { chunkRows, postIncurredBatch, MAX_BATCH_SIZE } from '../src/client';
import type { MappedUsageRow } from '../src/mapper';

function row(externalId: string): MappedUsageRow {
  return {
    source: 'adapter:claude-code',
    resource: 'model:anthropic/claude-sonnet-4-5',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    tokens_in: 1,
    tokens_out: 1,
    external_id: externalId,
    ts: '2026-01-01T00:00:00.000Z',
  };
}

describe('chunkRows', () => {
  it('returns a single chunk when under the limit', () => {
    const rows = [row('a'), row('b')];
    expect(chunkRows(rows, 10)).toEqual([rows]);
  });

  it('splits into multiple chunks at the given size', () => {
    const rows = [row('a'), row('b'), row('c')];
    expect(chunkRows(rows, 2)).toEqual([[row('a'), row('b')], [row('c')]]);
  });

  it('defaults to MAX_BATCH_SIZE when no size is given', () => {
    const rows = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => row(`id_${i}`));
    const chunks = chunkRows(rows);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(MAX_BATCH_SIZE);
    expect(chunks[1]).toHaveLength(1);
  });

  it('returns no chunks for an empty input', () => {
    expect(chunkRows([])).toEqual([]);
  });
});

describe('postIncurredBatch', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('posts to {kernelUrl}/usage/api/incurred with a bearer token and JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ inserted: 1, skipped: 0, rejected: [] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await postIncurredBatch({ kernelUrl: 'https://kernel.test', token: 'tok_123' }, [row('a')]);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://kernel.test/usage/api/incurred',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer tok_123', 'Content-Type': 'application/json' }),
      }),
    );
    expect(result).toEqual({ inserted: 1, skipped: 0, rejected: [] });
  });

  it('strips a trailing slash from kernelUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ inserted: 0, skipped: 0, rejected: [] }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await postIncurredBatch({ kernelUrl: 'https://kernel.test/', token: 'tok' }, [row('a')]);

    expect(fetchMock).toHaveBeenCalledWith('https://kernel.test/usage/api/incurred', expect.anything());
  });

  it('throws with the response status and error body on a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: 'Invalid app token' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(postIncurredBatch({ kernelUrl: 'https://kernel.test', token: 'bad' }, [row('a')])).rejects.toThrow(
      'usage.incurred ingest failed: 401 Invalid app token',
    );
  });

  it('falls back to statusText when the error body is not JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => { throw new Error('not json'); },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(postIncurredBatch({ kernelUrl: 'https://kernel.test', token: 'tok' }, [row('a')])).rejects.toThrow(
      'usage.incurred ingest failed: 500 Internal Server Error',
    );
  });
});
