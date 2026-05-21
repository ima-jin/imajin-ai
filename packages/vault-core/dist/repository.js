import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { VAULT_ENTRY_VERSION_V1 } from './models.js';
export class FileVaultRepository {
    vaultPath;
    constructor(options = {}) {
        this.vaultPath = options.vaultPath ?? path.join(os.homedir(), '.imajin', 'vault.json');
    }
    async load() {
        await this.ensureDirectory();
        try {
            const raw = await fs.readFile(this.vaultPath, 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed || !Array.isArray(parsed.entries)) {
                return this.createEmptyVault();
            }
            return {
                version: parsed.version === VAULT_ENTRY_VERSION_V1 ? parsed.version : VAULT_ENTRY_VERSION_V1,
                entries: parsed.entries
            };
        }
        catch (error) {
            if (error?.code === 'ENOENT') {
                return this.createEmptyVault();
            }
            return this.createEmptyVault();
        }
    }
    async save(vault) {
        await this.ensureDirectory();
        const tempPath = `${this.vaultPath}.tmp`;
        await fs.writeFile(tempPath, JSON.stringify(vault, null, 2), {
            encoding: 'utf8',
            mode: 0o600
        });
        await fs.rename(tempPath, this.vaultPath);
        await this.safeChmodFile(this.vaultPath, 0o600);
    }
    createEmptyVault() {
        return {
            version: VAULT_ENTRY_VERSION_V1,
            entries: []
        };
    }
    async ensureDirectory() {
        const directory = path.dirname(this.vaultPath);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await this.safeChmodFile(directory, 0o700);
    }
    async safeChmodFile(targetPath, mode) {
        try {
            await fs.chmod(targetPath, mode);
        }
        catch {
            // Best effort hardening.
        }
    }
}
//# sourceMappingURL=repository.js.map