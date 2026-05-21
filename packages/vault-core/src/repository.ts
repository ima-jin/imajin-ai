import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { VAULT_ENTRY_VERSION_V1, type VaultFile } from './models.js';

export interface VaultRepository {
    load(): Promise<VaultFile>;
    save(vault: VaultFile): Promise<void>;
}

export interface FileVaultRepositoryOptions {
    vaultPath?: string;
}

export class FileVaultRepository implements VaultRepository {
    private readonly vaultPath: string;

    constructor(options: FileVaultRepositoryOptions = {}) {
        this.vaultPath = options.vaultPath ?? path.join(os.homedir(), '.imajin', 'vault.json');
    }

    public async load(): Promise<VaultFile> {
        await this.ensureDirectory();
        try {
            const raw = await fs.readFile(this.vaultPath, 'utf8');
            const parsed = JSON.parse(raw) as Partial<VaultFile>;
            if (!parsed || !Array.isArray(parsed.entries)) {
                return this.createEmptyVault();
            }
            return {
                version: parsed.version === VAULT_ENTRY_VERSION_V1 ? parsed.version : VAULT_ENTRY_VERSION_V1,
                entries: parsed.entries
            };
        } catch (error: any) {
            if (error?.code === 'ENOENT') {
                return this.createEmptyVault();
            }
            return this.createEmptyVault();
        }
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
