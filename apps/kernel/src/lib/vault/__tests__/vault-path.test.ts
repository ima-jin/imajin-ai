/**
 * Tests for `resolveVaultPath` (#2357).
 *
 * Pins the per-env VAULT_PATH split: prod-jin and dev-jin must never resolve
 * to the same on-disk vault file. See vault-path-boot-guard.test.ts for the
 * companion "importing the module never throws, only a real vault op does"
 * behaviour (mirroring production-key-guard.test.ts for AUTH_PRIVATE_KEY).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: mockWarn, error: vi.fn() }),
}));

import { resolveVaultPath, _resetVaultPathCacheForTests } from '../vault-path.js';

const originalNodeEnv = process.env.NODE_ENV;
const originalVaultPath = process.env.VAULT_PATH;

function setNodeEnv(value: string | undefined): void {
  if (value === undefined) {
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
    return;
  }
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

beforeEach(() => {
  _resetVaultPathCacheForTests();
  mockWarn.mockClear();
  delete process.env.VAULT_PATH;
});

afterEach(() => {
  _resetVaultPathCacheForTests();
  if (originalVaultPath === undefined) {
    delete process.env.VAULT_PATH;
  } else {
    process.env.VAULT_PATH = originalVaultPath;
  }
  setNodeEnv(originalNodeEnv);
});

describe('resolveVaultPath', () => {
  it('returns VAULT_PATH unchanged when it is an absolute path', () => {
    process.env.VAULT_PATH = '/srv/imajin/vault.prod.json';

    expect(resolveVaultPath()).toBe('/srv/imajin/vault.prod.json');
  });

  it('expands a leading ~/ to the home directory (pm2 ecosystem configs use this literally)', () => {
    process.env.VAULT_PATH = '~/.imajin/vault.prod.json';

    expect(resolveVaultPath()).toBe(path.join(os.homedir(), '.imajin', 'vault.prod.json'));
  });

  it('expands a bare ~ to the home directory', () => {
    process.env.VAULT_PATH = '~';

    expect(resolveVaultPath()).toBe(os.homedir());
  });

  it('trims surrounding whitespace before resolving', () => {
    process.env.VAULT_PATH = '  /srv/imajin/vault.dev.json  ';

    expect(resolveVaultPath()).toBe('/srv/imajin/vault.dev.json');
  });

  it('throws a clear error in production when VAULT_PATH is unset', () => {
    setNodeEnv('production');

    expect(() => resolveVaultPath()).toThrow(/VAULT_PATH is required in production/);
  });

  it('throws in production when VAULT_PATH is set to an empty string', () => {
    setNodeEnv('production');
    process.env.VAULT_PATH = '   ';

    expect(() => resolveVaultPath()).toThrow(/VAULT_PATH is required in production/);
  });

  it('succeeds in production when VAULT_PATH is set', () => {
    setNodeEnv('production');
    process.env.VAULT_PATH = '/srv/imajin/vault.prod.json';

    expect(() => resolveVaultPath()).not.toThrow();
    expect(resolveVaultPath()).toBe('/srv/imajin/vault.prod.json');
  });

  it('falls back to the shared default outside production, with a loud warning', () => {
    setNodeEnv('development');

    const result = resolveVaultPath();

    expect(result).toBe(path.join(os.homedir(), '.imajin', 'vault.json'));
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0]?.[1]).toMatch(/VAULT_PATH is not set/);
  });

  it('caches the resolved path across repeated calls within a process', () => {
    process.env.VAULT_PATH = '/srv/imajin/vault.dev.json';

    const first = resolveVaultPath();
    process.env.VAULT_PATH = '/srv/imajin/vault.other.json';
    const second = resolveVaultPath();

    expect(first).toBe('/srv/imajin/vault.dev.json');
    expect(second).toBe('/srv/imajin/vault.dev.json');
  });

  it('_resetVaultPathCacheForTests clears the cache so a new value takes effect', () => {
    process.env.VAULT_PATH = '/srv/imajin/vault.dev.json';
    expect(resolveVaultPath()).toBe('/srv/imajin/vault.dev.json');

    process.env.VAULT_PATH = '/srv/imajin/vault.other.json';
    _resetVaultPathCacheForTests();

    expect(resolveVaultPath()).toBe('/srv/imajin/vault.other.json');
  });

  it('does not cache a thrown production failure, so a later retry with VAULT_PATH set succeeds', () => {
    setNodeEnv('production');
    expect(() => resolveVaultPath()).toThrow();

    process.env.VAULT_PATH = '/srv/imajin/vault.prod.json';
    expect(resolveVaultPath()).toBe('/srv/imajin/vault.prod.json');
  });
});
