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

const { mockLoadVaultAtBoot } = vi.hoisted(() => ({
  mockLoadVaultAtBoot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/src/lib/vault/vault-repository', () => ({
  loadVaultAtBoot: mockLoadVaultAtBoot,
}));

const { mockSetResolver, mockGetInternalSecret, mockLog } = vi.hoisted(() => ({
  mockSetResolver: vi.fn(),
  mockGetInternalSecret: vi.fn(),
  mockLog: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => mockLog }));

vi.mock('@imajin/auth', () => ({ setInternalApiKeyResolver: mockSetResolver }));
vi.mock('@/src/lib/vault/internal-secret', () => ({ getInternalSecret: mockGetInternalSecret }));
vi.mock('@/src/lib/auth/require-internal-api-key', () => ({
  ATTESTATION_INTERNAL_API_KEY_PURPOSE: 'kernel.attestation-internal-api-key',
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
  mockSetResolver.mockClear();
  mockGetInternalSecret.mockReset();
  mockLog.warn.mockClear();
});

describe('kernel instrumentation register()', () => {
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

  it('does not load the vault outside the nodejs runtime (e.g. edge)', async () => {
    setRuntime('edge');

    await register();

    expect(mockLoadVaultAtBoot).not.toHaveBeenCalled();
  });

  it('does not register the internal API key resolver outside the nodejs runtime', async () => {
    setRuntime('edge');

    await register();

    expect(mockSetResolver).not.toHaveBeenCalled();
  });
});

describe('kernel instrumentation register() — internal API key resolver (#2353)', () => {
  async function registeredResolver(): Promise<() => Promise<string | null | undefined>> {
    setRuntime('nodejs');
    await register();
    expect(mockSetResolver).toHaveBeenCalledTimes(1);
    return mockSetResolver.mock.calls[0][0];
  }

  it('resolves the key from the kernel vault by purpose, lazily', async () => {
    mockGetInternalSecret.mockResolvedValue('vault-key');
    const resolver = await registeredResolver();
    expect(mockGetInternalSecret).not.toHaveBeenCalled();

    await expect(resolver()).resolves.toBe('vault-key');
    expect(mockGetInternalSecret).toHaveBeenCalledWith('kernel.attestation-internal-api-key');
  });

  it('falls back to the deprecated env var only when the vault lookup fails', async () => {
    const legacyEnv = 'ATTESTATION_INTERNAL_API_KEY';
    const original = process.env[legacyEnv];
    process.env[legacyEnv] = 'legacy-env-key';
    mockGetInternalSecret.mockRejectedValue(new Error('vault down'));
    try {
      const resolver = await registeredResolver();

      await expect(resolver()).resolves.toBe('legacy-env-key');
    } finally {
      if (original === undefined) delete process.env[legacyEnv];
      else process.env[legacyEnv] = original;
    }
  });

  it('warns once, naming the purpose, when the vault lookup fails — not silently and not on every call', async () => {
    mockGetInternalSecret.mockRejectedValue(new Error('vault down'));
    const resolver = await registeredResolver();

    await resolver();
    await resolver();
    await resolver();

    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    const [meta, message] = mockLog.warn.mock.calls[0];
    expect(meta).toMatchObject({ purpose: 'kernel.attestation-internal-api-key', err: expect.stringContaining('vault down') });
    expect(message).toContain('kernel.attestation-internal-api-key');
  });

  it('does not warn when the vault lookup succeeds', async () => {
    mockGetInternalSecret.mockResolvedValue('vault-key');
    const resolver = await registeredResolver();

    await resolver();

    expect(mockLog.warn).not.toHaveBeenCalled();
  });
});
