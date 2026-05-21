import { type VaultFile } from './models.js';
export interface VaultRepository {
    load(): Promise<VaultFile>;
    save(vault: VaultFile): Promise<void>;
}
export interface FileVaultRepositoryOptions {
    vaultPath?: string;
}
export declare class FileVaultRepository implements VaultRepository {
    private readonly vaultPath;
    constructor(options?: FileVaultRepositoryOptions);
    load(): Promise<VaultFile>;
    save(vault: VaultFile): Promise<void>;
    private createEmptyVault;
    private ensureDirectory;
    private safeChmodFile;
}
//# sourceMappingURL=repository.d.ts.map