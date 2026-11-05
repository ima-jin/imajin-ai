import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendDisclosureReceipt } from '../src/reactors/audit';

const mocks = vi.hoisted(() => ({ key: vi.fn(), fetch: vi.fn() }));
vi.mock('@imajin/auth', () => ({ getVaultInternalApiKey: mocks.key }));
vi.mock('@imajin/db', () => ({
  getClient: () => ({
    begin: async (callback: (tx: (strings: TemplateStringsArray) => Promise<unknown[]>) => Promise<void>) =>
      callback(async strings => strings.join('').includes('pg_try_advisory_xact_lock') ? [{ acquired: true }] : []),
  }),
}));
vi.mock('../src/publish', () => ({ publish: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NOTIFY_SERVICE_URL', 'https://kernel.test/notify');
  mocks.key.mockReturnValue('fake-vault-internal-key');
  mocks.fetch.mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const callers = [
  ['disclosure receipt', () => sendDisclosureReceipt({
    subjectDid: 'did:imajin:fake-subject', requesterDid: 'did:imajin:fake-requester',
    purpose: 'test', fields: ['test'], releasedAt: '2026-10-14T00:00:00Z',
  })],
] as const;
describe.each(callers)('%s', (_name, send) => {
  it('uses the vault key in Authorization, never the legacy webhook header', async () => {
    await send();
    expect(mocks.fetch).toHaveBeenCalledWith('https://kernel.test/notify/api/send', expect.objectContaining({
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fake-vault-internal-key' },
    }));
  });
  it('skips when the vault key was not provisioned at boot', async () => {
    mocks.key.mockReturnValue(undefined);
    await send();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('skips when the notify URL is not configured', async () => {
    vi.stubEnv('NOTIFY_SERVICE_URL', '');
    await send();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
