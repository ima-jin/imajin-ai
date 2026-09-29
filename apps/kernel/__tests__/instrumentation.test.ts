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
});
