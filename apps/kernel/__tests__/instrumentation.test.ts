/**
 * Tests for the kernel's `instrumentation.ts#register()` (#2357).
 *
 * `register()` is the one place that resolves VAULT_PATH eagerly, at actual
 * server boot — unlike importing apps/kernel/src/lib/vault/index.ts, which
 * `next build` also does (with NODE_ENV=production) while collecting page
 * data, register() only runs when a real Next.js server instance starts. So
 * this is where "the kernel refuses to start in production without
 * VAULT_PATH" must actually be wired up.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@imajin/logger/db', () => ({}));

const { mockLoadVaultAtBoot, mockProvideVaultInternalApiKey, mockEnsureSettleExecutor } = vi.hoisted(() => ({
  mockLoadVaultAtBoot: vi.fn().mockResolvedValue(undefined),
  mockProvideVaultInternalApiKey: vi.fn().mockResolvedValue(undefined),
  mockEnsureSettleExecutor: vi.fn(),
}));

vi.mock('@/src/lib/vault/vault-repository', () => ({
  loadVaultAtBoot: mockLoadVaultAtBoot,
}));
vi.mock('@/src/lib/auth/provide-vault-internal-api-key', () => ({
  provideVaultInternalApiKey: mockProvideVaultInternalApiKey,
}));
vi.mock('@/src/lib/pay/settle-executor', () => ({
  ensureSettleExecutorRegistered: mockEnsureSettleExecutor,
}));

import { register } from '../instrumentation';

const originalRuntime = process.env.NEXT_RUNTIME;

function setRuntime(value: string | undefined): void {
  if (value === undefined) {
    delete (process.env as Record<string, string | undefined>).NEXT_RUNTIME;
    return;
  }
  (process.env as Record<string, string | undefined>).NEXT_RUNTIME = value;
}

afterEach(() => {
  setRuntime(originalRuntime);
  mockLoadVaultAtBoot.mockClear();
  mockProvideVaultInternalApiKey.mockClear();
  mockEnsureSettleExecutor.mockClear();
});

describe('kernel instrumentation register()', () => {
  it('registers the in-process settle executor with the bus at boot (#2642)', async () => {
    setRuntime('nodejs');

    await register();

    expect(mockEnsureSettleExecutor).toHaveBeenCalledTimes(1);
  });

  it('resolves and loads the vault at boot in the nodejs runtime', async () => {
    setRuntime('nodejs');

    await register();

    expect(mockLoadVaultAtBoot).toHaveBeenCalledTimes(1);
  });

  it('propagates a VAULT_PATH resolution failure so the server refuses to start', async () => {
    setRuntime('nodejs');
    mockLoadVaultAtBoot.mockRejectedValueOnce(
      new Error('VAULT_PATH is required in production: refusing to fall back'),
    );

    await expect(register()).rejects.toThrow(/VAULT_PATH is required in production/);
  });

  it('propagates a missing configured vault file so the server refuses to start (#2412)', async () => {
    setRuntime('nodejs');
    mockLoadVaultAtBoot.mockRejectedValueOnce(
      new Error('Configured vault file not found at /tmp/vault.prod.json'),
    );

    await expect(register()).rejects.toThrow(/Configured vault file not found/);
  });

  it('hands @imajin/auth the vault-resolved ATTESTATION_INTERNAL_API_KEY after the vault loads (#2353 step 4)', async () => {
    setRuntime('nodejs');
    const order: string[] = [];
    mockLoadVaultAtBoot.mockImplementationOnce(async () => { order.push('vault'); });
    mockProvideVaultInternalApiKey.mockImplementationOnce(async () => { order.push('key'); });

    await register();

    expect(order).toEqual(['vault', 'key']);
  });

  it('does not hand over a key when the vault itself failed to load (boot refuses to start)', async () => {
    setRuntime('nodejs');
    mockLoadVaultAtBoot.mockRejectedValueOnce(new Error('Configured vault file not found'));

    await expect(register()).rejects.toThrow();

    expect(mockProvideVaultInternalApiKey).not.toHaveBeenCalled();
  });

  it('does not load the vault outside the nodejs runtime (e.g. edge)', async () => {
    setRuntime('edge');

    await register();

    expect(mockLoadVaultAtBoot).not.toHaveBeenCalled();
    expect(mockProvideVaultInternalApiKey).not.toHaveBeenCalled();
  });
});
