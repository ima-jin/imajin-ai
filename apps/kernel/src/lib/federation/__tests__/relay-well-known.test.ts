/**
 * `getRelayWellKnown()` (#2046):
 * - REGISTRY_SERVICE_URL includes the /registry path prefix like every
 *   other *_SERVICE_URL, so the fetch must append only
 *   /relay/.well-known/dfos-relay (no double /registry/registry prefix).
 * - the PORT-based fallback (env var unset) matches that same convention.
 * - non-2xx responses and fetch failures return null and log a warning
 *   with the exact URL hit, instead of failing silently.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => mocks.log,
}));

const ENV_KEYS = ['REGISTRY_SERVICE_URL', 'PORT'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe('getRelayWellKnown', () => {
  it('returns the parsed well-known doc on a 200 response', async () => {
    const { getRelayWellKnown } = await import('../relay-well-known');
    const doc = {
      did: 'did:dfos:jin',
      protocol: 'dfos',
      version: '0.13.5',
      capabilities: { relay: true },
      profile: 'core',
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(doc), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getRelayWellKnown()).toEqual(doc);
  });

  it('appends only /relay/.well-known/dfos-relay to a prefixed REGISTRY_SERVICE_URL (#2046)', async () => {
    process.env.REGISTRY_SERVICE_URL = 'http://localhost:7000/registry';
    const { getRelayWellKnown } = await import('../relay-well-known');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await getRelayWellKnown();

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe('http://localhost:7000/registry/relay/.well-known/dfos-relay');
    expect(calledUrl).not.toContain('/registry/registry');
  });

  it('falls back to the /registry-prefixed PORT-based URL when REGISTRY_SERVICE_URL is unset', async () => {
    process.env.PORT = '3000';
    const { getRelayWellKnown } = await import('../relay-well-known');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await getRelayWellKnown();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/registry/relay/.well-known/dfos-relay',
      expect.objectContaining({ cache: 'no-store' })
    );
  });

  it('returns null and warns with the URL hit on a non-2xx response', async () => {
    process.env.REGISTRY_SERVICE_URL = 'http://localhost:7000/registry';
    const { getRelayWellKnown } = await import('../relay-well-known');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getRelayWellKnown()).toBeNull();
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
    const [meta] = mocks.log.warn.mock.calls[0];
    expect(meta).toMatchObject({ url: 'http://localhost:7000/registry/relay/.well-known/dfos-relay', status: 503 });
  });

  it('returns null and warns when the fetch throws (network error)', async () => {
    const { getRelayWellKnown } = await import('../relay-well-known');
    const fetchMock = vi.fn(async () => {
      throw new Error('connection refused');
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await getRelayWellKnown()).toBeNull();
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
    const [meta] = mocks.log.warn.mock.calls[0];
    expect(meta).toMatchObject({ err: 'Error: connection refused' });
  });
});
