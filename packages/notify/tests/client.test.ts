import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureNotify, send, broadcast, interest } from '../src';

const mocks = vi.hoisted(() => ({ vault: vi.fn(), fetch: vi.fn() }));
vi.mock('@imajin/auth', () => ({ getVaultInternalApiKey: mocks.vault }));
beforeEach(() => {
  vi.clearAllMocks();
  configureNotify({ serviceUrl: 'https://kernel.test/notify' });
  mocks.vault.mockReturnValue('fake-vault-internal-key');
  mocks.fetch.mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());
it('shares boot configuration across separately loaded server bundles', async () => {
  configureNotify({ serviceUrl: 'https://configured.test/notify', appTokenProvider: async () => 'fake-configured-token' });
  vi.resetModules();
  const reloaded = await import('../src');
  await reloaded.send({ to: 'did:imajin:fake-recipient', scope: 'test.notification' });
  expect(mocks.fetch).toHaveBeenCalledWith('https://configured.test/notify/api/send', expect.objectContaining({
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fake-configured-token' },
  }));
});

const calls = [
  ['send', () => send({ to: 'did:imajin:fake-recipient', scope: 'test.notification' })],
  ['broadcast', () => broadcast({ scope: 'test', subject: 'Test', html: '<p>Test</p>' })],
  ['interest', () => interest({ did: 'did:imajin:fake-recipient', attestationType: 'test.event' })],
] as const;
describe.each(calls)('%s', (endpoint, call) => {
  it('keeps existing signatures using the boot-provided vault key', async () => {
    await call();
    expect(mocks.fetch).toHaveBeenCalledWith(`https://kernel.test/notify/api/${endpoint}`, expect.objectContaining({
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fake-vault-internal-key' },
    }));
  });
  it('uses an async app token callback instead of the internal credential', async () => {
    configureNotify({ serviceUrl: 'https://kernel.test/notify', appTokenProvider: async () => 'fake-app-service-token' });
    await call();
    expect(mocks.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer fake-app-service-token');
    expect(mocks.vault).not.toHaveBeenCalled();
  });
  it('supports a vault internal-secret callback', async () => {
    configureNotify({ serviceUrl: 'https://kernel.test/notify', internalSecretProvider: async () => 'fake-callback-key' });
    await call();
    expect(mocks.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer fake-callback-key');
  });
  it('does not silently downgrade an unavailable app token to a privileged internal key', async () => {
    configureNotify({ serviceUrl: 'https://kernel.test/notify', appTokenProvider: async () => undefined });
    await call();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.vault).not.toHaveBeenCalled();
  });
  it('retains best-effort delivery when a provider throws', async () => {
    configureNotify({ serviceUrl: 'https://kernel.test/notify', appTokenProvider: async () => { throw new Error('unavailable'); } });
    await expect(call()).resolves.toBeUndefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('skips without a vault credential', async () => {
    mocks.vault.mockReturnValue(undefined);
    await call();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
