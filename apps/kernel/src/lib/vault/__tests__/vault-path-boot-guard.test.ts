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
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
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

let vaultImport: Promise<typeof import('../index.js')>;
let resetVaultState: () => void;

function setProductionEnv(): void {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('VAULT_PATH', undefined);
  vi.stubEnv('AUTH_PRIVATE_KEY', randomBytes(32).toString('hex'));
}

// Pay for the real cold graph once, with mocks already registered and the
// guarded production env in place. A timed-out test does not cancel import():
// re-entering this cyclic graph can expose vite-node's unfinished exports.
// Await setup before either test, and reuse its promise rather than re-import.
beforeAll(async () => {
  setProductionEnv();
  try {
    vaultImport = import('../index.js');
    await vaultImport;
    const { _resetSealingCache } = await import('../sealing.js');
    const { _resetVaultRepositoryForTests } = await import('../vault-repository.js');
    resetVaultState = () => {
      _resetSealingCache();
      _resetVaultRepositoryForTests();
    };
  } finally {
    vi.unstubAllEnvs();
  }
}, 30_000); // Cold transformation budget only; assertion timeouts stay at 5s.

beforeEach(() => {
  resetVaultState();
  setProductionEnv();
});

afterEach(() => {
  resetVaultState();
  vi.unstubAllEnvs();
});

describe('VAULT_PATH boot guardrail', () => {
  it('does not throw merely by importing the vault module, even in production with VAULT_PATH unset', async () => {
    // Mirrors production-key-guard.test.ts's identical assertion for
    // AUTH_PRIVATE_KEY: `next build` must not be turned into a boot-time
    // failure just because it imports this module.
    await expect(vaultImport).resolves.toBeDefined();
  });

  it('refuses the first real vault operation in production when VAULT_PATH is unset', async () => {
    const { sealAndStore } = await vaultImport;

    await expect(sealAndStore('vault-path-guard-field', 'secret')).rejects.toThrow(
      /VAULT_PATH is required in production/,
    );
  });
});
