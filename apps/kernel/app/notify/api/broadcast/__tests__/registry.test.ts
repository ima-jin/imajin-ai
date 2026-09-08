/**
 * `fetchAudienceFromRegistry()` / `checkRegistryPreferences()` (#2061):
 * each hits the registry via the shared `registryServiceUrl()` helper and
 * degrades safely (empty audience / optimistic eligibility) when neither
 * `REGISTRY_SERVICE_URL` nor the deprecated `REGISTRY_URL` is configured.
 */
import { describe, it, expect, vi } from 'vitest';
import { stubRegistryResolverEnv } from '@/src/lib/__tests__/registry-resolver-env';

const mocks = vi.hoisted(() => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => mocks.log,
}));

stubRegistryResolverEnv();

const SECRET = 'webhook-secret';

describe('fetchAudienceFromRegistry', () => {
  it('warns and returns an empty list without calling fetch when the registry URL is not configured', async () => {
    const { fetchAudienceFromRegistry } = await import('../registry');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchAudienceFromRegistry('events', SECRET)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
  });

  it('fetches the resolved audience URL and returns the dids when configured', async () => {
    process.env.REGISTRY_SERVICE_URL = 'http://localhost:7000/registry';
    const { fetchAudienceFromRegistry } = await import('../registry');
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ dids: ['did:imajin:a', 'did:imajin:b'] }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchAudienceFromRegistry('events', SECRET)).toEqual(['did:imajin:a', 'did:imajin:b']);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:7000/registry/api/audience/events?channel=email',
      expect.objectContaining({ headers: { 'x-webhook-secret': SECRET } }),
    );
  });

  it('returns an empty list and logs an error on a non-2xx response', async () => {
    process.env.REGISTRY_SERVICE_URL = 'http://localhost:7000/registry';
    const { fetchAudienceFromRegistry } = await import('../registry');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));

    expect(await fetchAudienceFromRegistry('events', SECRET)).toEqual([]);
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
  });
});

describe('checkRegistryPreferences', () => {
  it('is optimistic (true) without calling fetch when the registry URL is not configured', async () => {
    const { checkRegistryPreferences } = await import('../registry');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await checkRegistryPreferences('did:imajin:jin', 'events', SECRET)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches the resolved preferences URL and returns false when globally opted out', async () => {
    process.env.REGISTRY_SERVICE_URL = 'http://localhost:7000/registry';
    const { checkRegistryPreferences } = await import('../registry');
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ globalMarketing: false }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    expect(await checkRegistryPreferences('did:imajin:jin', 'events', SECRET)).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:7000/registry/api/preferences/did%3Aimajin%3Ajin',
      expect.objectContaining({ headers: { 'x-webhook-secret': SECRET } }),
    );
  });

  it('returns true when configured but the scope has no opt-out', async () => {
    process.env.REGISTRY_SERVICE_URL = 'http://localhost:7000/registry';
    const { checkRegistryPreferences } = await import('../registry');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ interests: [{ scope: 'events', marketing: true, email: true }] }),
      { status: 200 },
    )));

    expect(await checkRegistryPreferences('did:imajin:jin', 'events', SECRET)).toBe(true);
  });
});
