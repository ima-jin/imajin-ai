/**
 * Fail-loud vault boot + health status (#2412).
 *
 * Incident: v0.8.8 shipped VAULT_PATH=~/.imajin/vault.prod.json while the file
 * did not exist; the repository returned an empty vault on ENOENT, so prod ran
 * ~9h with every sealed secret unresolved while /health reported green.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VAULT_ENTRY_VERSION_V1, VaultFileMissingError } from '@imajin/vault-core';

const { mockInfo, mockWarn, mockError } = vi.hoisted(() => ({
  mockInfo: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: mockInfo, warn: mockWarn, error: mockError }),
}));

import { getVaultHealth, loadVaultAtBoot, _resetVaultRepositoryForTests } from '../vault-repository.js';
import { _resetVaultPathCacheForTests } from '../vault-path.js';

const ENV_KEYS = ['VAULT_PATH', 'VAULT_ALLOW_BOOTSTRAP'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let tempDirectory: string;
let vaultPath: string;

function writeVault(entryCount: number): void {
  const entries = Array.from({ length: entryCount }, (_, index) => ({
    field: `SECRET_FIELD_${index}`,
    encrypted: 'ciphertext-should-never-surface',
  }));
  fs.writeFileSync(vaultPath, JSON.stringify({ version: VAULT_ENTRY_VERSION_V1, entries }), 'utf8');
}

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-vault-repository-'));
  vaultPath = path.join(tempDirectory, 'vault.prod.json');
  process.env.VAULT_PATH = vaultPath;
  delete process.env.VAULT_ALLOW_BOOTSTRAP;
  _resetVaultPathCacheForTests();
  _resetVaultRepositoryForTests();
  mockInfo.mockClear();
  mockWarn.mockClear();
  mockError.mockClear();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = originalEnv[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
  _resetVaultPathCacheForTests();
  _resetVaultRepositoryForTests();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

describe('loadVaultAtBoot', () => {
  it('throws when VAULT_PATH names a file that does not exist', async () => {
    await expect(loadVaultAtBoot()).rejects.toBeInstanceOf(VaultFileMissingError);
    expect(fs.existsSync(vaultPath)).toBe(false);
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(String(mockError.mock.calls[0]?.[1])).toContain('VAULT_ALLOW_BOOTSTRAP');
  });

  it('logs `vault: loaded N entries from <path>` when the file exists', async () => {
    writeVault(3);

    await loadVaultAtBoot();

    expect(mockInfo).toHaveBeenCalledWith(
      { vaultPath, entryCount: 3 },
      `vault: loaded 3 entries from ${vaultPath}`,
    );
    expect(mockError).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('allows an empty store when VAULT_ALLOW_BOOTSTRAP=1 and warns that it bootstrapped', async () => {
    process.env.VAULT_ALLOW_BOOTSTRAP = '1';

    await loadVaultAtBoot();

    expect(mockInfo).toHaveBeenCalledWith(
      { vaultPath, entryCount: 0 },
      `vault: loaded 0 entries from ${vaultPath}`,
    );
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(String(mockWarn.mock.calls[0]?.[1])).toContain('bootstrapping an empty vault');
  });

  it('does not treat VAULT_ALLOW_BOOTSTRAP=0 as a bootstrap request', async () => {
    process.env.VAULT_ALLOW_BOOTSTRAP = '0';

    await expect(loadVaultAtBoot()).rejects.toBeInstanceOf(VaultFileMissingError);
  });

  it('keeps the unconfigured dev default bootstrapping (no VAULT_PATH, non-production)', async () => {
    delete process.env.VAULT_PATH;
    const originalHome = process.env.HOME;
    process.env.HOME = tempDirectory;
    try {
      // vault-path.ts computes its default from os.homedir() at import time, so
      // re-import it fresh under the temp HOME rather than touching the real one.
      vi.resetModules();
      const fresh = await import('../vault-repository.js');

      await expect(fresh.loadVaultAtBoot()).resolves.toBeUndefined();
      const defaultPath = path.join(tempDirectory, '.imajin', 'vault.json');
      expect(mockInfo).toHaveBeenCalledWith(
        { vaultPath: defaultPath, entryCount: 0 },
        `vault: loaded 0 entries from ${defaultPath}`,
      );
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});

describe('getVaultHealth', () => {
  it('reflects the loaded entry count, path and load time', async () => {
    writeVault(4);
    const before = Date.now();

    const health = await getVaultHealth();

    expect(health.status).toBe('ok');
    expect(health.path).toBe(vaultPath);
    expect(health.entryCount).toBe(4);
    expect(health.bootstrapped).toBe(false);
    expect(Date.parse(health.lastLoadedAt ?? '')).toBeGreaterThanOrEqual(before);
    expect(health.error).toBeUndefined();
  });

  it('reports `empty` for a loaded vault with zero entries', async () => {
    writeVault(0);

    const health = await getVaultHealth();

    expect(health.status).toBe('empty');
    expect(health.entryCount).toBe(0);
  });

  it('reports `error` with a stable code when the configured file is missing', async () => {
    const health = await getVaultHealth();

    expect(health).toMatchObject({
      status: 'error',
      path: vaultPath,
      entryCount: null,
      lastLoadedAt: null,
      error: 'VAULT_FILE_MISSING',
    });
  });

  it('reports a bootstrapped empty vault when the flag is set', async () => {
    process.env.VAULT_ALLOW_BOOTSTRAP = 'true';

    const health = await getVaultHealth();

    expect(health.status).toBe('empty');
    expect(health.bootstrapped).toBe(true);
  });

  it('reports `error` instead of throwing when VAULT_PATH cannot be resolved in production', async () => {
    delete process.env.VAULT_PATH;
    const originalNodeEnv = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    try {
      const health = await getVaultHealth();

      expect(health.status).toBe('error');
      expect(health.path).toBeNull();
      expect(health.error).toBe('VAULT_PATH_UNRESOLVED');
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    }
  });

  it('never exposes vault field names or ciphertext', async () => {
    writeVault(2);

    const serialised = JSON.stringify(await getVaultHealth());

    expect(serialised).not.toContain('SECRET_FIELD');
    expect(serialised).not.toContain('ciphertext-should-never-surface');
  });
});
