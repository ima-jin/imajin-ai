import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));

import { removeSubdomain } from '../cloudflare';

/** A Cloudflare API envelope: `{ success, result }` or `{ success: false, errors }`. */
function cfResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

describe('removeSubdomain — deletes matching DNS records one at a time', () => {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'token');
    vi.stubEnv('CLOUDFLARE_ZONE_ID', 'zone1');
    vi.stubEnv('CLOUDFLARE_BASE_DOMAIN', 'example.test');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('issues the DELETEs in record order, each only after the previous one finished', async () => {
    const events: string[] = [];
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === 'DELETE') {
        events.push(`start ${url.split('/').at(-1)}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`end ${url.split('/').at(-1)}`);
        return cfResponse({ success: true, result: { id: 'deleted' } });
      }
      return cfResponse({ success: true, result: [{ id: 'r1' }, { id: 'r2' }] });
    });

    await removeSubdomain('node1');

    expect(events).toEqual(['start r1', 'end r1', 'start r2', 'end r2']);
  });

  it('stops at the first failed DELETE and rejects, never attempting later records', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method === 'DELETE') {
        return cfResponse({ success: false, errors: [{ message: 'boom' }] });
      }
      return cfResponse({ success: true, result: [{ id: 'r1' }, { id: 'r2' }] });
    });

    await expect(removeSubdomain('node1')).rejects.toThrow('Cloudflare API error: boom');

    const deletes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(String(deletes[0][0])).toContain('/dns_records/r1');
  });

  it('is a no-op when the record is already gone', async () => {
    fetchMock.mockResolvedValue(cfResponse({ success: true, result: [] }));

    await removeSubdomain('node1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
