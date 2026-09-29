import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileVaultRepository } from '../src/repository.js';
import { VaultFileMissingError } from '../src/errors.js';
import { VAULT_ENTRY_VERSION_V1 } from '../src/models.js';

describe('FileVaultRepository fail-loud load (#2412)', () => {
    let tempDirectory: string;
    let vaultPath: string;

    beforeEach(() => {
        tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-core-repository-'));
        vaultPath = path.join(tempDirectory, 'vault.prod.json');
    });

    afterEach(() => {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    });

    it('throws when a configured vault file does not exist', async () => {
        const repository = new FileVaultRepository({ vaultPath });

        await expect(repository.load()).rejects.toBeInstanceOf(VaultFileMissingError);
        await expect(repository.load()).rejects.toThrow(vaultPath);
        expect(fs.existsSync(vaultPath)).toBe(false);
    });

    it('does not record a load when the configured file is missing', async () => {
        const repository = new FileVaultRepository({ vaultPath });

        await expect(repository.load()).rejects.toThrow(VaultFileMissingError);

        expect(repository.getStatus()).toEqual({
            path: vaultPath,
            entryCount: null,
            lastLoadedAt: null,
            bootstrapped: false
        });
    });

    it('allows an empty store when the explicit bootstrap flag is set', async () => {
        const repository = new FileVaultRepository({ vaultPath, allowBootstrap: true });

        const vault = await repository.load();

        expect(vault).toEqual({ version: VAULT_ENTRY_VERSION_V1, entries: [] });
        expect(repository.getStatus().bootstrapped).toBe(true);
        expect(repository.getStatus().entryCount).toBe(0);
    });

    it('creates the file on first save after a bootstrap and then loads it strictly', async () => {
        const bootstrapping = new FileVaultRepository({ vaultPath, allowBootstrap: true });
        const vault = await bootstrapping.load();
        await bootstrapping.save(vault);

        const strict = new FileVaultRepository({ vaultPath });
        await expect(strict.load()).resolves.toEqual({ version: VAULT_ENTRY_VERSION_V1, entries: [] });
        expect(strict.getStatus().bootstrapped).toBe(false);
    });

    it('loads an existing configured file without needing the bootstrap flag', async () => {
        fs.writeFileSync(
            vaultPath,
            JSON.stringify({ version: VAULT_ENTRY_VERSION_V1, entries: [] }),
            'utf8'
        );
        const repository = new FileVaultRepository({ vaultPath });

        await expect(repository.load()).resolves.toEqual({ version: VAULT_ENTRY_VERSION_V1, entries: [] });
    });

    it('reports entry count, path and last load time after a load', async () => {
        const entries = [{ field: 'A' }, { field: 'B' }, { field: 'C' }];
        fs.writeFileSync(vaultPath, JSON.stringify({ version: VAULT_ENTRY_VERSION_V1, entries }), 'utf8');
        const repository = new FileVaultRepository({ vaultPath });
        const before = Date.now();

        await repository.load();

        const status = repository.getStatus();
        expect(status.path).toBe(vaultPath);
        expect(status.entryCount).toBe(3);
        expect(status.bootstrapped).toBe(false);
        expect(Date.parse(status.lastLoadedAt ?? '')).toBeGreaterThanOrEqual(before);
    });

    it('exposes only path, count, load time and bootstrap state — never entry content', async () => {
        fs.writeFileSync(
            vaultPath,
            JSON.stringify({ version: VAULT_ENTRY_VERSION_V1, entries: [{ field: 'SECRET_FIELD', encrypted: 'ciphertext' }] }),
            'utf8'
        );
        const repository = new FileVaultRepository({ vaultPath });
        await repository.load();

        const serialised = JSON.stringify(repository.getStatus());

        expect(Object.keys(repository.getStatus()).sort((a, b) => a.localeCompare(b))).toEqual([
            'bootstrapped',
            'entryCount',
            'lastLoadedAt',
            'path'
        ]);
        expect(serialised).not.toContain('SECRET_FIELD');
        expect(serialised).not.toContain('ciphertext');
    });

    it('keeps the built-in default path bootstrapping (no configured path)', async () => {
        const homedir = fs.mkdtempSync(path.join(tempDirectory, 'home-'));
        const originalHome = process.env.HOME;
        const originalUserProfile = process.env.USERPROFILE;
        process.env.HOME = homedir;
        process.env.USERPROFILE = homedir;
        try {
            const repository = new FileVaultRepository();
            await expect(repository.load()).resolves.toEqual({ version: VAULT_ENTRY_VERSION_V1, entries: [] });
        } finally {
            if (originalHome === undefined) {
                delete process.env.HOME;
            } else {
                process.env.HOME = originalHome;
            }
            if (originalUserProfile === undefined) {
                delete process.env.USERPROFILE;
            } else {
                process.env.USERPROFILE = originalUserProfile;
            }
        }
    });
});
