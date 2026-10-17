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
  it('delivers a signed webhook to a registry-only third-party app', async () => {
    vi.stubEnv('AUTH_PRIVATE_KEY', authCrypto.generatePrivateKey());
    mocks.limit.mockResolvedValue([{
      ...app, slug: 'fixture-studio', tier: 'third_party',
      appDid: 'did:imajin:fixture-studio', entryUrl: 'https://studio.example.test',
    }]);
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await postKernelWebhook('https://studio.example.test/api/webhook', { type: 'test.completed' }, 'fixture-studio');
    expect(fetchMock).toHaveBeenCalledWith('https://studio.example.test/api/webhook', expect.objectContaining({
      redirect: 'error',
      headers: expect.objectContaining({
        'x-kernel-audience': 'did:imajin:fixture-studio',
        'x-kernel-signature': expect.stringMatching(/^[a-f0-9]{128}$/),
      }),
    }));
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });
  it('trusts a third-party entry origin without any app-specific env settings', async () => {
    const thirdParty = {
      ...app, slug: 'fixture-studio', tier: 'third_party', appDid: 'did:imajin:fixture-studio',
      callbackUrl: 'https://node.test/callback', entryUrl: 'https://studio.example.test',
    };
    mocks.limit.mockResolvedValue([thirdParty]);
    await expect(resolveKernelWebhookAudience('https://studio.example.test/api/webhook', { appSlug: 'fixture-studio' }))
      .resolves.toBe(thirdParty.appDid);
    vi.stubEnv('FIXTURE-STUDIO_SERVICE_URL', 'https://unregistered.test');
    await expect(resolveKernelWebhookAudience('https://unregistered.test/hook', { appSlug: 'fixture-studio' }))
      .rejects.toThrow('does not match');
  });

  it('resolves a relative registry entry against the configured node origin', async () => {
    vi.stubEnv('APP_URL', 'https://node.test');
    mocks.limit.mockResolvedValue([{ ...app, callbackUrl: '', entryUrl: '/fixture-studio' }]);
    await expect(resolveKernelWebhookAudience('https://node.test/fixture-studio/hook', { appSlug: 'events' }))
      .resolves.toBe(app.appDid);
  });

  it('does not grant first-party env settings any additional trust', async () => {
    vi.stubEnv('EVENTS_SERVICE_URL', 'http://events-internal:3006/base');
    await expect(resolveKernelWebhookAudience('http://events-internal:3006/api/webhook', { appSlug: 'events' }))
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
