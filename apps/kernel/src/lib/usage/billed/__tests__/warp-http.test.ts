import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { key, log } = vi.hoisted(() => ({
  key: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/src/lib/warp/connector', () => ({ requireAgentKey: key }));
vi.mock('@/src/lib/warp/environment', () => ({ readEnvironmentId: vi.fn() }));
vi.mock('@/src/lib/kernel/lookup', () => ({ lookupIdentity: vi.fn() }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: vi.fn() }));
vi.mock('@/src/lib/kernel/corpus-client', () => ({ searchCorpus: vi.fn(), CorpusServiceError: class extends Error {} }));
vi.mock('@imajin/bus', () => ({ publish: vi.fn() }));
vi.mock('@imajin/logger', () => ({ createLogger: () => log }));
vi.mock('@imajin/db', () => ({ getClient: vi.fn() }));

import { readWarpBilledRuns } from '../warp';

const OWNER = 'did:imajin:owner';
const NOW = new Date('2026-10-20T00:00:00Z');
// Synthetic marker only; never an external credential.
const MARKER = 'synthetic-test-only-marker';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  key.mockResolvedValue(MARKER);
});
afterEach(() => vi.unstubAllGlobals());

describe('Warp billed reader over the shared client', () => {
  it('authenticates using the dispatch key and reads every HTTP page including environment-less children', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        runs: [{ run_id: 'parent', state: 'SUCCEEDED', created_at: '2026-10-19T12:00:00Z',
          request_usage: { inference_cost: 100, compute_cost: 2, platform_cost: 1 } }],
        page_info: { has_next_page: true, next_cursor: 'second-page' },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        runs: [{ run_id: 'child', parent_run_id: 'parent', state: 'FAILED', created_at: '2026-10-19T12:00:00Z',
          request_usage: { inference_cost: 50, compute_cost: null, platform_cost: null } }],
        page_info: { has_next_page: false },
      })));
    const lines = await readWarpBilledRuns(OWNER, NOW);
    expect(lines.map((line) => [line.runId, line.credits])).toEqual([['parent', 103], ['child', 50]]);
    expect(key).toHaveBeenNthCalledWith(1, OWNER);
    expect(key).toHaveBeenNthCalledWith(2, OWNER);
    const [url, options] = vi.mocked(fetch).mock.calls[1];
    const parsed = new URL(String(url));
    expect(parsed.searchParams.get('created_after')).toBe('2026-10-19T00:00:00.000Z');
    expect(parsed.searchParams.get('cursor')).toBe('second-page');
    expect(parsed.searchParams.has('environment_id')).toBe(false);
    expect(options?.headers).toMatchObject({ Authorization: `Bearer ${MARKER}` });
    expect(JSON.stringify([lines, log.info.mock.calls, log.error.mock.calls])).not.toContain(MARKER);
  });
  it.each(['invalid', false, -1])('does not invent billed charges from malformed usage (%s)', async (computeCost) => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      runs: [{ run_id: 'invalid-usage', state: 'SUCCEEDED', created_at: '2026-10-19T12:00:00Z',
        request_usage: { inference_cost: 100, compute_cost: computeCost, platform_cost: 0 } }],
      page_info: { has_next_page: false },
    })));
    expect(await readWarpBilledRuns(OWNER, NOW)).toEqual([]);
  });

  it.each([401, 403, 500])('does not expose echoed HTTP problem data on %s', async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      title: MARKER, error: MARKER, detail: MARKER, trace_id: MARKER,
    }), { status }));
    const error = await readWarpBilledRuns(OWNER, NOW).catch((err: unknown) => err);
    expect(error).toMatchObject({ status, message: 'Warp billed usage unavailable' });
    expect(String(error)).not.toContain(MARKER);
    expect(JSON.stringify([error, log.warn.mock.calls, log.error.mock.calls])).not.toContain(MARKER);
  });

  it('does not expose transport or credential resolution exceptions', async () => {
    key.mockRejectedValueOnce(new Error(MARKER));
    await expect(readWarpBilledRuns(OWNER, NOW)).rejects.toThrow('Warp billed usage unavailable');
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockRejectedValue(new Error(MARKER));
    await expect(readWarpBilledRuns(OWNER, NOW)).rejects.toThrow('Warp billed usage unavailable');
  });
});
