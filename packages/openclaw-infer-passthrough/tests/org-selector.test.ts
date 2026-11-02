import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAnthropicRequest } from '../src/anthropic-handler.js';
import { handleCompletions } from '../src/handle-completions.js';
import { handleModels } from '../src/handle-models.js';
import { CatalogRouter } from '../src/catalog-router.js';
import { HealthTracker } from '../src/health.js';
import { fakeTokenSource } from './dispatch-test-support.js';

const route = { id: 'anthropic', principalDid: 'did:imajin:member', actingAs: 'did:imajin:org', modelPrefixes: ['claude-'] };
function deps() {
  return {
    route, routes: [route], kernelBaseUrl: 'https://kernel.test', kernelTimeoutMs: 1000, directTimeoutMs: 1000,
    getTokenProvider: () => fakeTokenSource(['test-token']),
    resolveDirectApiKey: vi.fn(), health: new HealthTracker(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('org selector stays separate from app token and member principal', () => {
  it.each(['messages', 'count_tokens', 'completions', 'models'])('sends a selector on %s with the existing token', async lane => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('x-acting-as')).toBe(route.actingAs);
      expect(headers.get('x-api-key') ?? headers.get('authorization')).toMatch(/test-token/);
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const context = deps();
    if (lane === 'messages' || lane === 'count_tokens') {
      await handleAnthropicRequest(context, { endpoint: lane, bodyText: '{}' });
    } else if (lane === 'models') {
      await handleModels(context, 'anthropic');
    } else {
      await handleCompletions(context, { providerIdFromPath: 'anthropic', bodyText: '{"model":"claude-test"}' });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([403, 502])('never tries a direct key after kernel status %s', async status => {
    const context = deps();
    const fetchMock = vi.fn(async () => Response.json({ error: 'denied' }, { status }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await handleAnthropicRequest(context, { endpoint: 'messages', bodyText: '{}' });
    expect(result.status).toBe(status);
    expect(context.resolveDirectApiKey).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('never tries a direct key after a network outage', async () => {
    const context = deps();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect((await handleAnthropicRequest(context, { endpoint: 'messages', bodyText: '{}' })).status).toBe(502);
    expect(context.resolveDirectApiKey).not.toHaveBeenCalled();
  });
  it('preserves org selection on derived catalog routes instead of selecting a personal override', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      data: [{ id: 'claude-test', imajin: { connector: 'anthropic', servable: true } }],
    })));
    const context = deps();
    const seat = { ...route, id: 'openai', modelPrefixes: undefined };
    const register = vi.fn();
    const router = new CatalogRouter({ ...context, routes: [seat, { ...route, actingAs: undefined }] }, register);
    expect(await router.resolve('openai', 'claude-test')).toMatchObject({ principalDid: route.principalDid, actingAs: route.actingAs });
    expect(register).toHaveBeenCalledOnce();
  });
});
