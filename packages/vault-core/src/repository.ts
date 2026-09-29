import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { VAULT_ENTRY_VERSION_V1, type VaultFile } from './models.js';
import { VaultFileMissingError } from './errors.js';

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
        let raw: string;
        try {
            raw = await fs.readFile(this.vaultPath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return this.handleMissingFile();
            }
            return this.recordLoad(this.createEmptyVault(), false);
        }
        return this.recordLoad(this.parseVault(raw), false);
    }

    private handleMissingFile(): VaultFile {
        if (this.allowBootstrap) {
            return this.recordLoad(this.createEmptyVault(), true);
        }
        throw new VaultFileMissingError(this.vaultPath);
    }

    private parseVault(raw: string): VaultFile {
        try {
            const parsed = JSON.parse(raw) as Partial<VaultFile>;
            if (!parsed || !Array.isArray(parsed.entries)) {
                return this.createEmptyVault();
            }
            return {
                version: parsed.version === VAULT_ENTRY_VERSION_V1 ? parsed.version : VAULT_ENTRY_VERSION_V1,
                entries: parsed.entries
            };
        } catch {
            return this.createEmptyVault();
        }
    }

    private recordLoad(vault: VaultFile, bootstrapped: boolean): VaultFile {
        this.entryCount = vault.entries.length;
        this.lastLoadedAt = new Date().toISOString();
        this.bootstrapped = bootstrapped;
        return vault;
    }

    public async save(vault: VaultFile): Promise<void> {
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
