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

const { mockResolveVaultPath } = vi.hoisted(() => ({
  mockResolveVaultPath: vi.fn().mockReturnValue('/tmp/vault-instrumentation-test.json'),
}));

vi.mock('@/src/lib/vault/vault-path', () => ({
  resolveVaultPath: mockResolveVaultPath,
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
  mockResolveVaultPath.mockClear();
});

describe('kernel instrumentation register()', () => {
  it('resolves VAULT_PATH at boot in the nodejs runtime', async () => {
    setRuntime('nodejs');

    await register();

    expect(mockResolveVaultPath).toHaveBeenCalledTimes(1);
  });

  it('propagates a VAULT_PATH resolution failure so the server refuses to start', async () => {
    setRuntime('nodejs');
    mockResolveVaultPath.mockImplementationOnce(() => {
      throw new Error('VAULT_PATH is required in production: refusing to fall back');
    });

    await expect(register()).rejects.toThrow(/VAULT_PATH is required in production/);
  });

  it('does not resolve VAULT_PATH outside the nodejs runtime (e.g. edge)', async () => {
    setRuntime('edge');

    await register();

    expect(mockResolveVaultPath).not.toHaveBeenCalled();
  });
});
