/**
 * VAULT_PATH boot guardrail (#2357).
 *
 * Companion to production-key-guard.test.ts's AUTH_PRIVATE_KEY guard.
 * Incident being fixed: `FileVaultRepository` defaulted to
 * `~/.imajin/vault.json` and neither prod-jin nor dev-jin overrode it, so
 * both environments silently shared one vault file. These tests pin the fix
 * in both directions:
 *   - Merely IMPORTING apps/kernel/src/lib/vault/index.ts must never throw,
 *     even with NODE_ENV=production and VAULT_PATH unset — `next build`
 *     imports this module in exactly that shape while collecting page data
 *     on a build machine that legitimately has no VAULT_PATH configured.
 *   - The first REAL vault operation in production must still hard-refuse
 *     to fall back to the shared default file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('@/src/db', () => ({
  db: {},
  vaultDelegationGrants: {},
  vaultGrantRequests: {},
  vaultOwnerEnvelopes: {},
  channelLinks: {},
}));

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (p: string) => `${p}_test` }));

vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));

const originalNodeEnv = process.env.NODE_ENV;

function setNodeEnv(value: string | undefined): void {
  if (value === undefined) {
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
    return;
  }
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

beforeEach(() => {
  delete process.env.VAULT_PATH;
  process.env.AUTH_PRIVATE_KEY = randomBytes(32).toString('hex');
});

afterEach(() => {
  delete process.env.VAULT_PATH;
  delete process.env.AUTH_PRIVATE_KEY;
  setNodeEnv(originalNodeEnv);
});

describe('VAULT_PATH boot guardrail', () => {
  it('does not throw merely by importing the vault module, even in production with VAULT_PATH unset', async () => {
    // Mirrors production-key-guard.test.ts's identical assertion for
    // AUTH_PRIVATE_KEY: `next build` must not be turned into a boot-time
    // failure just because it imports this module.
    setNodeEnv('production');

    await expect(import('../index.js')).resolves.toBeDefined();
  });

  it('refuses the first real vault operation in production when VAULT_PATH is unset', async () => {
    setNodeEnv('production');
    const { sealAndStore } = await import('../index.js');

    await expect(sealAndStore('vault-path-guard-field', 'secret')).rejects.toThrow(
      /VAULT_PATH is required in production/,
    );
  });
});
