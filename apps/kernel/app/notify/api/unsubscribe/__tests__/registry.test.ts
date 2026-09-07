/**
 * `updateRegistryPreference()` (#2061): hits the registry via the shared
 * `registryServiceUrl()` helper and silently skips (warn + return) when
 * neither `REGISTRY_SERVICE_URL` nor the deprecated `REGISTRY_URL` is set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => mocks.log,
}));

const ENV_KEYS = ['REGISTRY_SERVICE_URL', 'REGISTRY_URL', 'PORT', 'NOTIFY_WEBHOOK_SECRET'] as const;
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

describe('updateRegistryPreference', () => {
  it('warns and skips the request without calling fetch when the registry URL is not configured', async () => {
    const { updateRegistryPreference } = await import('../registry');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await updateRegistryPreference('did:imajin:jin', 'events');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
  });

  it('PUTs the opt-out to the resolved registry URL when configured', async () => {
    process.env.REGISTRY_SERVICE_URL = 'http://localhost:7000/registry';
    process.env.NOTIFY_WEBHOOK_SECRET = 'notify-secret';
    const { updateRegistryPreference } = await import('../registry');
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await updateRegistryPreference('did:imajin:jin', 'events');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:7000/registry/api/preferences/did%3Aimajin%3Ajin/interests/events',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ 'x-webhook-secret': 'notify-secret' }),
        body: JSON.stringify({ marketing: false, email: false }),
      }),
    );
  });

  it('falls back to the deprecated REGISTRY_URL and logs an error on a non-2xx response', async () => {
    process.env.REGISTRY_URL = 'http://localhost:7000/registry';
    const { updateRegistryPreference } = await import('../registry');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));

    await updateRegistryPreference('did:imajin:jin', 'events');

    expect(mocks.log.error).toHaveBeenCalledTimes(1);
  });

  it('logs an error when the fetch throws', async () => {
    process.env.REGISTRY_SERVICE_URL = 'http://localhost:7000/registry';
    const { updateRegistryPreference } = await import('../registry');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connection refused');
    }));

    await updateRegistryPreference('did:imajin:jin', 'events');

    expect(mocks.log.error).toHaveBeenCalledTimes(1);
  });
});
