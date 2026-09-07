/**
 * `ingestToRelay()` / `checkRelayChain()` (#2061):
 * - Both are non-fatal wrappers around the registry's relay endpoints,
 *   resolved via the shared `registryServiceUrl()` helper from `@imajin/config`.
 * - When neither `REGISTRY_SERVICE_URL` nor the deprecated `REGISTRY_URL` is
 *   configured, both skip the network call (`hasRegistryServiceUrl()` false)
 *   instead of hitting the PORT-based localhost fallback — ingest logs a
 *   warning and returns false; the chain check silently returns false.
 * - When configured, they hit the exact expected registry URL and surface
 *   non-2xx responses / thrown errors as `false` without throwing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => mocks.log,
}));

// dfos.ts pulls in the kernel db + node-identity modules at import time, both
// of which call @imajin/db's getClient() eagerly — stub the package so import
// doesn't require a real DATABASE_URL.
vi.mock('@imajin/db', () => ({
  getClient: () => vi.fn(),
  createDb: () => ({}),
}));

vi.mock('@/src/db', () => ({
  db: {},
  identities: {},
  identityChains: {},
  credentials: {},
}));

const ENV_KEYS = ['REGISTRY_SERVICE_URL', 'REGISTRY_URL', 'PORT'] as const;
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

describe('ingestToRelay', () => {
  it('skips the relay call and warns when the registry URL is not configured', async () => {
    const { ingestToRelay } = await import('../dfos');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await ingestToRelay(['jws-token'])).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
    expect(mocks.log.warn.mock.calls[0][1]).toContain('REGISTRY_SERVICE_URL not set');
  });

  it('POSTs the chain log to the resolved registry URL and returns true on success', async () => {
    process.env.REGISTRY_SERVICE_URL = 'http://localhost:7000/registry';
    const { ingestToRelay } = await import('../dfos');
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await ingestToRelay(['jws-token'])).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:7000/registry/relay/operations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ operations: ['jws-token'] }),
      }),
    );
  });

  it('falls back to the deprecated REGISTRY_URL and returns false on a non-2xx response', async () => {
    process.env.REGISTRY_URL = 'http://localhost:7000/registry';
    const { ingestToRelay } = await import('../dfos');
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await ingestToRelay(['jws-token'])).toBe(false);
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
  });

  it('returns false when the fetch throws', async () => {
    process.env.REGISTRY_SERVICE_URL = 'http://localhost:7000/registry';
    const { ingestToRelay } = await import('../dfos');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connection refused');
    }));

    expect(await ingestToRelay(['jws-token'])).toBe(false);
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
  });
});

describe('checkRelayChain', () => {
  it('returns false without calling fetch when the registry URL is not configured', async () => {
    const { checkRelayChain } = await import('../dfos');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await checkRelayChain('did:dfos:jin')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches the resolved identities URL and returns true on a 200 response', async () => {
    process.env.REGISTRY_SERVICE_URL = 'http://localhost:7000/registry';
    const { checkRelayChain } = await import('../dfos');
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await checkRelayChain('did:dfos:jin')).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:7000/registry/relay/identities/did%3Adfos%3Ajin');
  });

  it('returns false when the fetch throws', async () => {
    process.env.REGISTRY_SERVICE_URL = 'http://localhost:7000/registry';
    const { checkRelayChain } = await import('../dfos');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connection refused');
    }));

    expect(await checkRelayChain('did:dfos:jin')).toBe(false);
  });
});
