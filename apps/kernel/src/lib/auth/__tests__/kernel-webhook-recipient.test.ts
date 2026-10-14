import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveKernelWebhookAudience } from '../kernel-webhook-recipient';
import { postKernelWebhook } from '../kernel-webhook';
import { crypto as authCrypto } from '@imajin/auth';

const mocks = vi.hoisted(() => ({ limit: vi.fn(), where: vi.fn() }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: mocks.where }) }) },
  registryApps: { status: 'status', slug: 'slug', appDid: 'appDid' },
}));
vi.mock('drizzle-orm', () => ({
  eq: (column: string, value: string) => ({ column, value }),
  and: (...conditions: unknown[]) => conditions,
}));

const app = {
  appDid: 'did:imajin:registered-events', slug: 'events', status: 'active',
  tier: 'first_party', callbackUrl: 'https://events.test/auth/callback',
  allowedRedirectHosts: [], redirectUris: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.where.mockReturnValue({ limit: mocks.limit });
  mocks.limit.mockResolvedValue([app]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('trusted kernel webhook recipient registry', () => {
  it('posts with the registered app DID, never a caller-controlled payload audience', async () => {
    vi.stubEnv('AUTH_PRIVATE_KEY', authCrypto.generatePrivateKey());
    vi.stubEnv('EVENTS_WEBHOOK_SECRET', '');
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await postKernelWebhook('https://events.test/api/webhook', { audience: 'did:imajin:forged' }, 'events');
    expect(fetchMock).toHaveBeenCalledWith('https://events.test/api/webhook', expect.objectContaining({
      headers: expect.objectContaining({ 'x-kernel-audience': app.appDid }),
    }));
    mocks.limit.mockResolvedValue([]);
    await expect(postKernelWebhook('https://events.test/api/webhook', {}, 'events')).rejects.toThrow('not registered');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('resolves an active slug to its real app DID, constrained by destination origin', async () => {
    await expect(resolveKernelWebhookAudience('https://events.test/api/webhook', { appSlug: 'events' }))
      .resolves.toBe(app.appDid);
    expect(mocks.where).toHaveBeenCalledWith([
      { column: 'status', value: 'active' }, { column: 'slug', value: 'events' },
    ]);
  });

  it('matches both supplied identities against the same active row', async () => {
    await resolveKernelWebhookAudience('https://events.test/hook', { appSlug: 'events', appDid: app.appDid });
    expect(mocks.where).toHaveBeenCalledWith([
      { column: 'status', value: 'active' }, { column: 'appDid', value: app.appDid },
      { column: 'slug', value: 'events' },
    ]);
    mocks.limit.mockResolvedValue([]);
    await expect(resolveKernelWebhookAudience('https://events.test/hook', { appSlug: 'market', appDid: app.appDid }))
      .rejects.toThrow('not registered');
  });

  it.each([[], [{ ...app, status: 'revoked' }], [{ ...app, appDid: 'not-a-did' }]])(
    'refuses missing, revoked or malformed registry identities %j', async (rows) => {
      mocks.limit.mockResolvedValue(rows);
      await expect(resolveKernelWebhookAudience('https://events.test/hook', { appSlug: 'events' })).rejects.toThrow();
    },
  );

  it.each([{}, { appDid: '' }, { appDid: 'not-a-did' }, { appSlug: '' },
    { appDid: '', appSlug: 'events' }, { appDid: app.appDid, appSlug: '' }, { appSlug: 'bad slug' }])(
    'rejects absent or malformed recipient configuration %j before DB access', async (recipient) => {
      await expect(resolveKernelWebhookAudience('https://events.test/hook', recipient)).rejects.toThrow();
      expect(mocks.where).not.toHaveBeenCalled();
    },
  );

  it('refuses signing events audience for a different app origin', async () => {
    await expect(resolveKernelWebhookAudience('https://market.test/api/webhook', { appSlug: 'events' }))
      .rejects.toThrow('does not match');
  });
  it.each(['coffee', 'events', 'learn', 'market'])(
    'supports actual provisioned %s rows with relative nav entries and bare redirect hosts', async (slug) => {
      mocks.limit.mockResolvedValue([{
        ...app, slug, tier: 'third_party', appDid: `did:imajin:provisioned-${slug}`,
        callbackUrl: `https://node.test/${slug}/api/auth/callback`,
        entryUrl: `/${slug}`, allowedRedirectHosts: [slug],
      }]);
      vi.stubEnv(`${slug.toUpperCase()}_SERVICE_URL`, `http://localhost:3006/${slug}`);
      await expect(resolveKernelWebhookAudience(`http://localhost:3006/${slug}/api/webhook`, { appSlug: slug }))
        .resolves.toBe(`did:imajin:provisioned-${slug}`);
      await expect(resolveKernelWebhookAudience(`https://node.test/${slug}/api/webhook`, { appSlug: slug }))
        .resolves.toBe(`did:imajin:provisioned-${slug}`);
    },
  );

  it('accepts only the matching known kernel-routed internal service URL', async () => {
    vi.stubEnv('EVENTS_SERVICE_URL', 'http://events-internal:3006/base');
    vi.stubEnv('MARKET_SERVICE_URL', 'http://market-internal:3009');
    await expect(resolveKernelWebhookAudience('http://events-internal:3006/api/webhook', { appSlug: 'events' }))
      .resolves.toBe(app.appDid);
    await expect(resolveKernelWebhookAudience('http://market-internal:3009/api/webhook', { appSlug: 'events' }))
      .rejects.toThrow('does not match');
    mocks.limit.mockResolvedValue([{ ...app, tier: 'third_party', slug: 'unrelated' }]);
    vi.stubEnv('UNRELATED_SERVICE_URL', 'http://events-internal:3006');
    await expect(resolveKernelWebhookAudience('http://events-internal:3006/api/webhook', { appSlug: 'unrelated' }))
      .rejects.toThrow('does not match');
  });

  it.each(['file:///tmp/hook', 'https://user:password@events.test/hook'])(
    'rejects invalid destinations %s', async (url) => {
      await expect(resolveKernelWebhookAudience(url, { appSlug: 'events' })).rejects.toThrow('destination');
    },
  );

  it('propagates registry unavailability without a fallback DID', async () => {
    mocks.limit.mockRejectedValue(new Error('registry unavailable'));
    await expect(resolveKernelWebhookAudience('https://events.test/hook', { appSlug: 'events' }))
      .rejects.toThrow('registry unavailable');
  });
});
