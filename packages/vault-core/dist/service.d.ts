import { type UpsertVaultEntryInput, type VaultEntry, type VaultFile } from './models.js';
import { type VaultRepository } from './repository.js';
export declare class VaultEntryService {
    private readonly repository;
    private writeBarrier;
    constructor(repository: VaultRepository);
    set(entry: UpsertVaultEntryInput): Promise<VaultEntry>;
    get(field: string): Promise<VaultEntry | undefined>;
    list(): Promise<VaultEntry[]>;
    getHistory(field: string): Promise<VaultEntry[]>;
    loadVault(): Promise<VaultFile>;
    private getLatestEntry;
    private runExclusiveWrite;
}
//# sourceMappingURL=service.d.ts.map