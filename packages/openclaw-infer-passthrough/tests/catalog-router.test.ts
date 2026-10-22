import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogRouter } from '../src/catalog-router.js';
import { CatalogError } from '../src/router.js';
import { NoLiveGrantError } from '../src/token-provider.js';
import type { ProviderRouteConfig } from '../src/types.js';
import { fakeTokenSource } from './dispatch-test-support.js';

const principalDid = 'did:imajin:principal';
const seat = { id: 'openai', principalDid };
const row = (id: string, connector = 'xai', picked = false) => ({
  id, object: 'model', owned_by: connector,
  imajin: { connector, picked, servable: true, credentialDid: principalDid },
});

function setup(routes: ProviderRouteConfig[] = [seat]) {
  let now = 0;
  const register = vi.fn();
  const source = fakeTokenSource(['initial', 'fresh']);
  const getTokenProvider = vi.fn(() => source);
  const router = new CatalogRouter({
    routes, kernelBaseUrl: 'https://kernel.test', kernelTimeoutMs: 1000, getTokenProvider,
  }, register, () => now);
  return { router, register, source, getTokenProvider, advance: () => { now += 60_001; } };
}

afterEach(() => vi.unstubAllGlobals());

describe('usable catalog routing (#3041)', () => {
  it('routes every model including unpicked rows; reuses the 60-second cache', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://kernel.test/infer/v1/models/usable');
      return Response.json({ object: 'list', data: [row('picked', 'xai', true), row('other')] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { router, register, advance } = setup();
    expect(await router.resolve('openai', 'picked')).toMatchObject({ principalDid });
    expect(await router.resolve(undefined, 'other')).toMatchObject({ id: `catalog:${principalDid}:xai` });
    expect(register).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance();
    await router.resolve(undefined, 'other');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refreshes on miss and routes a connector added after the cache was warmed', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [row('old')] }))
      .mockResolvedValueOnce(Response.json({ data: [row('old'), row('new', 'moonshot')] }));
    vi.stubGlobal('fetch', fetchMock);
    const { router } = setup();
    await router.resolve(undefined, 'old');
    expect(await router.resolve('openai', 'new')).toEqual({ id: `catalog:${principalDid}:moonshot`, principalDid });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns no route for an unknown model only after refreshing', async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await setup().router.resolve(undefined, 'missing')).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses optional modelPrefixes as an override without fetching the catalog', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const override = { id: 'xai', principalDid, modelPrefixes: ['custom-'], directBaseUrl: 'https://direct.test/v1' };
    const { router } = setup([seat, override]);
    expect(await router.resolve('openai', 'custom-model')).toBe(override);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses matching connector config for break-glass without requiring modelPrefixes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [row('grok')] })));
    const override = { id: 'xai', principalDid, directBaseUrl: 'https://direct.test/v1' };
    expect(await setup([seat, override]).router.resolve(undefined, 'grok')).toBe(override);
  });

  it('does not share catalog entries or another principal’s break-glass key across seats', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [row('only-a')] }))
      .mockImplementation(async () => Response.json({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const other = { id: 'xai', principalDid: 'did:imajin:other', directBaseUrl: 'https://other.test' };
    const { router, getTokenProvider } = setup([seat, other]);
    expect(await router.resolve('openai', 'only-a')).toEqual({ id: `catalog:${principalDid}:xai`, principalDid });
    expect(await router.resolve('xai', 'only-a')).toBeUndefined();
    expect(getTokenProvider.mock.calls).toEqual([['openai'], ['xai'], ['xai']]);
  });

  it('coalesces concurrent catalog fetches', async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [row('known')] }));
    vi.stubGlobal('fetch', fetchMock);
    const { router } = setup();
    await Promise.all([router.resolve(undefined, 'known'), router.resolve('openai', 'known')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, { data: 'invalid' }])('rejects malformed catalog lists: %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)));
    await expect(setup().router.resolve(undefined, 'model')).rejects.toThrow('invalid list');
  });

  it.each([
    null, {}, { id: '' }, { id: 'model', imajin: { connector: '', servable: true } },
    { id: 'model', imajin: { connector: 'xai', servable: false } },
    { id: 'model', imajin: { connector: 'xai' } },
  ])('does not route malformed or unservable rows: %j', async (entry) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [entry] })));
    expect(await setup().router.resolve(undefined, 'model')).toBeUndefined();
  });

  it('preserves the kernel winner if duplicate model IDs are returned', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [row('model', 'xai'), row('model', 'openai')] })));
    expect(await setup().router.resolve(undefined, 'model')).toMatchObject({ id: `catalog:${principalDid}:xai` });
  });

  it('does not route unknown paths, MCP, or missing models through a catalog', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { router } = setup();
    expect(await router.resolve('unknown', 'model')).toBeUndefined();
    expect(await router.resolve('mcp', 'model')).toBeUndefined();
    expect(await router.resolve(undefined, undefined)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces catalog outages instead of misreporting an unknown model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'down' }, { status: 503 })));
    await expect(setup().router.resolve(undefined, 'model')).rejects.toBeInstanceOf(CatalogError);
  });

  it('drops revoked catalog auth and retries a fresh token on the next request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'Authorization has been revoked' }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ data: [row('model')] }));
    vi.stubGlobal('fetch', fetchMock);
    const { router, source } = setup();
    await expect(router.resolve(undefined, 'model')).rejects.toBeInstanceOf(NoLiveGrantError);
    expect(await router.resolve(undefined, 'model')).toMatchObject({ principalDid });
    expect(source.calls).toBe(2);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh');
  });
});
