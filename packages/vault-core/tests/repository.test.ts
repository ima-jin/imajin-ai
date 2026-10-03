import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileVaultRepository } from '../src/repository.js';
import {
    VaultFileMalformedError,
    VaultFileMissingError,
    VaultFileUnreadableError,
    VaultSaveRefusedError
} from '../src/errors.js';
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

describe('FileVaultRepository never overwrites a file it failed to read (#2440)', () => {
    let tempDirectory: string;
    let vaultPath: string;
    const emptyVault = { version: VAULT_ENTRY_VERSION_V1, entries: [] };

    beforeEach(() => {
        tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-core-repository-2440-'));
        vaultPath = path.join(tempDirectory, 'vault.prod.json');
    });

    afterEach(() => {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    });

    it('throws VaultFileUnreadableError when the file exists but cannot be read', async () => {
        // A directory at the vault path makes readFile fail with EISDIR regardless of uid.
        fs.mkdirSync(vaultPath);
        const repository = new FileVaultRepository({ vaultPath });

        const failure = await repository.load().catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(VaultFileUnreadableError);
        expect((failure as VaultFileUnreadableError).code).toBe('VAULT_FILE_UNREADABLE');
        expect((failure as VaultFileUnreadableError).errno).toBe('EISDIR');
        expect((failure as VaultFileUnreadableError).vaultPath).toBe(vaultPath);
    });

    it('fails loud on an unreadable file even when bootstrap is allowed', async () => {
        fs.mkdirSync(vaultPath);
        const repository = new FileVaultRepository({ vaultPath, allowBootstrap: true });

        await expect(repository.load()).rejects.toBeInstanceOf(VaultFileUnreadableError);
        expect(repository.getStatus().lastLoadedAt).toBeNull();
    });

    it('throws VaultFileMalformedError (INVALID_JSON) on broken JSON and leaves the file untouched', async () => {
        const broken = '{"version":1,"entries":[{"field":"SECRET_FIELD"';
        fs.writeFileSync(vaultPath, broken, 'utf8');
        const repository = new FileVaultRepository({ vaultPath });

        const failure = await repository.load().catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(VaultFileMalformedError);
        expect((failure as VaultFileMalformedError).code).toBe('VAULT_FILE_MALFORMED');
        expect((failure as VaultFileMalformedError).reason).toBe('INVALID_JSON');
        expect(fs.readFileSync(vaultPath, 'utf8')).toBe(broken);
    });

    it('never puts file content in the malformed error message', async () => {
        fs.writeFileSync(vaultPath, '{"entries":[{"field":"SECRET_FIELD", oops', 'utf8');
        const repository = new FileVaultRepository({ vaultPath });

        const failure = await repository.load().catch((error: unknown) => error as Error);

        expect((failure as Error).message).not.toContain('SECRET_FIELD');
        expect((failure as VaultFileMalformedError).cause).toBeUndefined();
    });

    it.each([
        ['JSON null', 'null'],
        ['a JSON array', '[]'],
        ['an object without entries', '{"version":1}'],
        ['entries that is not an array', '{"version":1,"entries":{}}'],
        ['an empty file', '']
    ])('throws VaultFileMalformedError (INVALID_SHAPE or INVALID_JSON) for %s', async (_label, content) => {
        fs.writeFileSync(vaultPath, content, 'utf8');
        const repository = new FileVaultRepository({ vaultPath });

        await expect(repository.load()).rejects.toBeInstanceOf(VaultFileMalformedError);
        expect(fs.readFileSync(vaultPath, 'utf8')).toBe(content);
    });

    it('fails loud on malformed JSON even when bootstrap is allowed', async () => {
        fs.writeFileSync(vaultPath, 'not json', 'utf8');
        const repository = new FileVaultRepository({ vaultPath, allowBootstrap: true });

        await expect(repository.load()).rejects.toBeInstanceOf(VaultFileMalformedError);
    });

    it('fails loud on malformed JSON for the built-in default path too', async () => {
        const homedir = fs.mkdtempSync(path.join(tempDirectory, 'home-'));
        fs.mkdirSync(path.join(homedir, '.imajin'));
        fs.writeFileSync(path.join(homedir, '.imajin', 'vault.json'), '{broken', 'utf8');
        const originalHome = process.env.HOME;
        const originalUserProfile = process.env.USERPROFILE;
        process.env.HOME = homedir;
        process.env.USERPROFILE = homedir;
        try {
            await expect(new FileVaultRepository().load()).rejects.toBeInstanceOf(VaultFileMalformedError);
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

    it('refuses save() after a malformed load and does not modify the file', async () => {
        const broken = '{"entries": [';
        fs.writeFileSync(vaultPath, broken, 'utf8');
        const repository = new FileVaultRepository({ vaultPath });
        await expect(repository.load()).rejects.toBeInstanceOf(VaultFileMalformedError);

        const failure = await repository.save(emptyVault).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(VaultSaveRefusedError);
        expect((failure as VaultSaveRefusedError).code).toBe('VAULT_SAVE_REFUSED');
        expect(fs.readFileSync(vaultPath, 'utf8')).toBe(broken);
        expect(fs.existsSync(`${vaultPath}.tmp`)).toBe(false);
    });

    it('refuses save() after an unreadable load', async () => {
        fs.mkdirSync(vaultPath);
        const repository = new FileVaultRepository({ vaultPath });
        await expect(repository.load()).rejects.toBeInstanceOf(VaultFileUnreadableError);

        await expect(repository.save(emptyVault)).rejects.toBeInstanceOf(VaultSaveRefusedError);
        expect(fs.statSync(vaultPath).isDirectory()).toBe(true);
    });

    it('refuses save() after a missing-file load with no bootstrap', async () => {
        const repository = new FileVaultRepository({ vaultPath });
        await expect(repository.load()).rejects.toBeInstanceOf(VaultFileMissingError);

        await expect(repository.save(emptyVault)).rejects.toBeInstanceOf(VaultSaveRefusedError);
        expect(fs.existsSync(vaultPath)).toBe(false);
    });

    it('keeps refusing save() after a vault that loaded fine is later corrupted and re-loaded', async () => {
        const entries = [{ field: 'A' }];
        fs.writeFileSync(vaultPath, JSON.stringify({ version: VAULT_ENTRY_VERSION_V1, entries }), 'utf8');
        const repository = new FileVaultRepository({ vaultPath });
        const loaded = await repository.load();
        await repository.save(loaded);

        fs.writeFileSync(vaultPath, '{corrupt', 'utf8');
        await expect(repository.load()).rejects.toBeInstanceOf(VaultFileMalformedError);

        await expect(repository.save(loaded)).rejects.toBeInstanceOf(VaultSaveRefusedError);
        expect(fs.readFileSync(vaultPath, 'utf8')).toBe('{corrupt');
    });

    it('allows save() again once a later load succeeds', async () => {
        fs.writeFileSync(vaultPath, '{corrupt', 'utf8');
        const repository = new FileVaultRepository({ vaultPath });
        await expect(repository.load()).rejects.toBeInstanceOf(VaultFileMalformedError);

        fs.writeFileSync(vaultPath, JSON.stringify(emptyVault), 'utf8');
        const vault = await repository.load();

        await expect(repository.save(vault)).resolves.toBeUndefined();
    });

    it('still saves normally after a successful load', async () => {
        fs.writeFileSync(vaultPath, JSON.stringify(emptyVault), 'utf8');
        const repository = new FileVaultRepository({ vaultPath });
        const vault = await repository.load();

        await expect(repository.save(vault)).resolves.toBeUndefined();
    });

    it('verify() re-reads the file on every call without touching cached status', async () => {
        fs.writeFileSync(vaultPath, JSON.stringify({ version: VAULT_ENTRY_VERSION_V1, entries: [{}, {}] }), 'utf8');
        const repository = new FileVaultRepository({ vaultPath });
        await repository.load();
        const statusBefore = repository.getStatus();

        await expect(repository.verify()).resolves.toBe(2);

        fs.writeFileSync(vaultPath, JSON.stringify({ version: VAULT_ENTRY_VERSION_V1, entries: [{}] }), 'utf8');
        await expect(repository.verify()).resolves.toBe(1);
        expect(repository.getStatus()).toEqual(statusBefore);

        fs.writeFileSync(vaultPath, '{corrupt', 'utf8');
        await expect(repository.verify()).rejects.toBeInstanceOf(VaultFileMalformedError);

        fs.rmSync(vaultPath);
        await expect(repository.verify()).rejects.toBeInstanceOf(VaultFileMissingError);
    });

    it('verify() does not clear the save guard or create the file or directory', async () => {
        fs.writeFileSync(vaultPath, '{corrupt', 'utf8');
        const repository = new FileVaultRepository({ vaultPath });
        await expect(repository.load()).rejects.toBeInstanceOf(VaultFileMalformedError);

        fs.writeFileSync(vaultPath, JSON.stringify(emptyVault), 'utf8');
        await expect(repository.verify()).resolves.toBe(0);

        await expect(repository.save(emptyVault)).rejects.toBeInstanceOf(VaultSaveRefusedError);
    });
});
