/**
 * `bootstrapInternalApiKey` / `resolveInternalApiKey` / `postInternal` (#2353):
 * the userspace services' `ATTESTATION_INTERNAL_API_KEY` is fetched from the
 * vault at boot and is never read from `process.env`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setVaultInternalApiKey } from './support/internal-post-test-env';

const mocks = vi.hoisted(() => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  loadFromVault: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('../src/vault-client', () => ({ loadFromVault: mocks.loadFromVault }));

const VAULT_KEY = 'vault-sourced-key';

function vaultResult(values: Record<string, string>, ack = { used: vi.fn() }) {
  return { values, dids: {}, degraded: [], acks: { ATTESTATION_INTERNAL_API_KEY: ack } };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  setVaultInternalApiKey(undefined);
  delete process.env.ATTESTATION_INTERNAL_API_KEY;
  delete process.env.AUTH_INTERNAL_API_KEY;
  process.env.LEARN_VAULT_BOOTSTRAP_DID = 'did:imajin:learn-bootstrap';
  process.env.LEARN_VAULT_BOOTSTRAP_PRIVATE_KEY = 'aa'.repeat(32);
});

afterEach(() => {
  setVaultInternalApiKey(undefined);
  delete process.env.ATTESTATION_INTERNAL_API_KEY;
  delete process.env.AUTH_SERVICE_URL;
  delete process.env.LEARN_VAULT_BOOTSTRAP_DID;
  delete process.env.LEARN_VAULT_BOOTSTRAP_PRIVATE_KEY;
  vi.unstubAllGlobals();
});

describe('bootstrapInternalApiKey', () => {
  it('fetches the key by purpose with the service bootstrap identity and exposes it via resolveInternalApiKey', async () => {
    mocks.loadFromVault.mockResolvedValue(vaultResult({ ATTESTATION_INTERNAL_API_KEY: VAULT_KEY }));
    const { bootstrapInternalApiKey, resolveInternalApiKey } = await import('../src/internal-post');

    await bootstrapInternalApiKey('learn');

    expect(mocks.loadFromVault).toHaveBeenCalledWith(
      expect.objectContaining({
        resolveGrantByPurpose: 'kernel.attestation-internal-api-key',
        identity: { did: 'did:imajin:learn-bootstrap', privateKey: 'aa'.repeat(32) },
      }),
    );
    expect(resolveInternalApiKey()).toBe(VAULT_KEY);
  });

  it('sends the deferred used-ack exactly once, on first use', async () => {
    const ack = { used: vi.fn() };
    mocks.loadFromVault.mockResolvedValue(vaultResult({ ATTESTATION_INTERNAL_API_KEY: VAULT_KEY }, ack));
    const { bootstrapInternalApiKey, resolveInternalApiKey } = await import('../src/internal-post');

    await bootstrapInternalApiKey('learn');
    expect(ack.used).not.toHaveBeenCalled();
    resolveInternalApiKey();
    resolveInternalApiKey();

    expect(ack.used).toHaveBeenCalledTimes(1);
  });

  it('logs an error and leaves the key unset when the bootstrap identity is not configured', async () => {
    delete process.env.LEARN_VAULT_BOOTSTRAP_DID;
    const { bootstrapInternalApiKey, resolveInternalApiKey } = await import('../src/internal-post');

    await bootstrapInternalApiKey('learn');

    expect(mocks.loadFromVault).not.toHaveBeenCalled();
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
    expect(resolveInternalApiKey()).toBeUndefined();
  });

  it('logs an error and leaves the key unset when no active grant exists (degraded)', async () => {
    mocks.loadFromVault.mockResolvedValue(vaultResult({}));
    const { bootstrapInternalApiKey, resolveInternalApiKey } = await import('../src/internal-post');

    await bootstrapInternalApiKey('learn');

    expect(mocks.log.error).toHaveBeenCalledTimes(1);
    expect(resolveInternalApiKey()).toBeUndefined();
  });

  it('never throws when the vault fetch fails', async () => {
    mocks.loadFromVault.mockRejectedValue(new Error('vault unreachable'));
    const { bootstrapInternalApiKey, resolveInternalApiKey } = await import('../src/internal-post');

    await expect(bootstrapInternalApiKey('learn')).resolves.toBeUndefined();

    expect(mocks.log.error).toHaveBeenCalledTimes(1);
    expect(resolveInternalApiKey()).toBeUndefined();
  });
});

describe('postInternal without a vault-sourced key (fail closed)', () => {
  it('ignores a hand-set ATTESTATION_INTERNAL_API_KEY env var and skips the call', async () => {
    process.env.AUTH_SERVICE_URL = 'https://auth.kernel.test';
    process.env.ATTESTATION_INTERNAL_API_KEY = 'env-value-must-be-ignored';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { postInternal } = await import('../src/internal-post');

    await expect(postInternal('/api/x', {})).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the vault-sourced key as the Bearer token', async () => {
    process.env.AUTH_SERVICE_URL = 'https://auth.kernel.test';
    setVaultInternalApiKey(VAULT_KEY);
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { postInternal } = await import('../src/internal-post');

    await postInternal('/api/x', {});

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${VAULT_KEY}`);
  });
});
