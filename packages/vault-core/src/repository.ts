import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { VAULT_ENTRY_VERSION_V1, type VaultFile } from './models.js';
import {
    VaultFileMalformedError,
    VaultFileMissingError,
    VaultFileUnreadableError,
    VaultSaveRefusedError
} from './errors.js';

export interface VaultRepository {
    load(): Promise<VaultFile>;
    save(vault: VaultFile): Promise<void>;
}

export interface FileVaultRepositoryOptions {
    /**
     * Explicitly configured vault file. When supplied, the file is expected to
     * exist: a missing file makes `load()` throw {@link VaultFileMissingError}
     * instead of silently yielding an empty store (#2412).
     */
    vaultPath?: string;
    /**
     * First-run bootstrap: when true, a missing configured file is treated as an
     * empty store (the file is created by the first `save()`). Must be an
     * explicit, deliberate opt-in — never a default fallthrough.
     * Irrelevant when `vaultPath` is not supplied (the built-in default path
     * always bootstraps).
     */
    allowBootstrap?: boolean;
}

/** Non-secret snapshot of what the repository last read — safe to expose via health checks. */
export interface VaultRepositoryStatus {
    path: string;
    /** Entries in the file as of the last load/save; null before the first load. */
    entryCount: number | null;
    /** ISO time of the last successful load; null before the first load. */
    lastLoadedAt: string | null;
    /** True when the last load found no file and an explicit bootstrap allowed an empty store. */
    bootstrapped: boolean;
}

export class FileVaultRepository implements VaultRepository {
    private readonly vaultPath: string;
    private readonly allowBootstrap: boolean;
    private entryCount: number | null = null;
    private lastLoadedAt: string | null = null;
    private bootstrapped = false;
    /** True while the most recent load() failed; save() is refused until a load succeeds (#2440). */
    private lastLoadFailed = false;

    constructor(options: FileVaultRepositoryOptions = {}) {
        const configured = options.vaultPath !== undefined;
        this.allowBootstrap = options.allowBootstrap === true || !configured;
        this.vaultPath = options.vaultPath ?? path.join(os.homedir(), '.imajin', 'vault.json');
    }

    public getStatus(): VaultRepositoryStatus {
        return {
            path: this.vaultPath,
            entryCount: this.entryCount,
            lastLoadedAt: this.lastLoadedAt,
            bootstrapped: this.bootstrapped
        };
    }

    public async load(): Promise<VaultFile> {
        await this.ensureDirectory();
        try {
            const { vault, bootstrapped } = await this.readVault();
            this.lastLoadFailed = false;
            return this.recordLoad(vault, bootstrapped);
        } catch (error) {
            this.lastLoadFailed = true;
            throw error;
        }
    }

    /**
     * Re-read and re-validate the file on disk without touching any cached
     * state (status, save guard) or creating anything. Throws the same typed
     * errors as {@link load}; resolves with the current entry count.
     *
     * For health checks, which must reflect the file as it is now, not as it
     * was at boot (#2440).
     */
    public async verify(): Promise<number> {
        const { vault } = await this.readVault();
        return vault.entries.length;
    }

    private async readVault(): Promise<{ vault: VaultFile; bootstrapped: boolean }> {
        let raw: string;
        try {
            raw = await fs.readFile(this.vaultPath, 'utf8');
        } catch (error) {
            const errno = (error as NodeJS.ErrnoException).code;
            if (errno === 'ENOENT') {
                return this.handleMissingFile();
            }
            throw new VaultFileUnreadableError(this.vaultPath, errno);
        }
        return { vault: this.parseVault(raw), bootstrapped: false };
    }

    private handleMissingFile(): { vault: VaultFile; bootstrapped: boolean } {
        if (this.allowBootstrap) {
            return { vault: this.createEmptyVault(), bootstrapped: true };
        }
        throw new VaultFileMissingError(this.vaultPath);
    }

    private parseVault(raw: string): VaultFile {
        let parsed: Partial<VaultFile> | null;
        try {
            parsed = JSON.parse(raw) as Partial<VaultFile> | null;
        } catch {
            // Deliberately drop the parser error: it can quote vault content.
            throw new VaultFileMalformedError(this.vaultPath, 'INVALID_JSON');
        }
        if (!parsed || !Array.isArray(parsed.entries)) {
            throw new VaultFileMalformedError(this.vaultPath, 'INVALID_SHAPE');
        }
        return {
            version: parsed.version === VAULT_ENTRY_VERSION_V1 ? parsed.version : VAULT_ENTRY_VERSION_V1,
            entries: parsed.entries
        };
    }

    private recordLoad(vault: VaultFile, bootstrapped: boolean): VaultFile {
        this.entryCount = vault.entries.length;
        this.lastLoadedAt = new Date().toISOString();
        this.bootstrapped = bootstrapped;
        return vault;
    }

    public async save(vault: VaultFile): Promise<void> {
        if (this.lastLoadFailed) {
            throw new VaultSaveRefusedError(this.vaultPath);
        }
        await this.ensureDirectory();
        const tempPath = `${this.vaultPath}.tmp`;
        await fs.writeFile(tempPath, JSON.stringify(vault, null, 2), {
            encoding: 'utf8',
            mode: 0o600
        });
        await fs.rename(tempPath, this.vaultPath);
        await this.safeChmodFile(this.vaultPath, 0o600);
        this.entryCount = vault.entries.length;
        this.bootstrapped = false;
    }

    private createEmptyVault(): VaultFile {
        return {
            version: VAULT_ENTRY_VERSION_V1,
            entries: []
        };
    }

    private async ensureDirectory(): Promise<void> {
        const directory = path.dirname(this.vaultPath);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await this.safeChmodFile(directory, 0o700);
    }

    private async safeChmodFile(targetPath: string, mode: number): Promise<void> {
        try {
            await fs.chmod(targetPath, mode);
        } catch {
            // Best effort hardening.
        }
    }
}
