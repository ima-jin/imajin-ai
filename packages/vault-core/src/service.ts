import {
    type UpsertVaultEntryInput,
    type VaultEntry,
    type VaultFile
} from './models.js';
import { type VaultRepository } from './repository.js';
import { type VaultLock } from './lock.js';
import { type VaultIntegrityAdapters } from './verification.js';
import { assertEntryIntegrity } from './verification.js';

export interface VaultEntryServiceOptions {
    lock?: VaultLock;
    adapters?: VaultIntegrityAdapters;
}

export class VaultEntryService {
    private writeBarrier: Promise<void> = Promise.resolve();
    private readonly lock?: VaultLock;
    private readonly adapters?: VaultIntegrityAdapters;

    constructor(
        private readonly repository: VaultRepository,
        options: VaultEntryServiceOptions = {}
    ) {
        this.lock = options.lock;
        this.adapters = options.adapters;
    }

    public async set(entry: UpsertVaultEntryInput): Promise<VaultEntry> {
        if (this.lock) {
            const release = await this.lock.acquire(entry.field);
            try {
                return await this.runExclusiveWrite(() => this.setInternal(entry));
            } finally {
                await release();
            }
        }
        return this.runExclusiveWrite(() => this.setInternal(entry));
    }

    public async get(field: string): Promise<VaultEntry | undefined> {
        const vault = await this.repository.load();
        const latest = this.getLatestEntry(vault.entries, field);
        if (!latest || latest.deleted === true) {
            return undefined;
        }
        if (this.adapters) {
            await assertEntryIntegrity(latest, this.adapters);
        }
        return latest;
    }

    public async list(): Promise<VaultEntry[]> {
        const vault = await this.repository.load();
        const latestByField = new Map<string, VaultEntry>();
        for (let index = vault.entries.length - 1; index >= 0; index -= 1) {
            const entry = vault.entries[index];
            if (!entry) {
                continue;
            }
            if (!latestByField.has(entry.field)) {
                latestByField.set(entry.field, entry);
            }
        }
        return Array.from(latestByField.values()).filter(entry => entry.deleted !== true);
    }

    public async getHistory(field: string): Promise<VaultEntry[]> {
        const vault = await this.repository.load();
        const history: VaultEntry[] = [];
        let current = this.getLatestEntry(vault.entries, field);
        while (current) {
            history.push(current);
            if (!current.previousCid) {
                break;
            }
            current = vault.entries.find(entry => entry.cid === current!.previousCid);
        }
        return history;
    }

    public async loadVault(): Promise<VaultFile> {
        return this.repository.load();
    }

    private async setInternal(entry: UpsertVaultEntryInput): Promise<VaultEntry> {
        const vault = await this.repository.load();
        const previousCid = this.getLatestEntry(vault.entries, entry.field)?.cid ?? entry.previousCid;
        const persistedEntry: VaultEntry = {
            ...entry,
            ...(previousCid !== undefined ? { previousCid } : {})
        };
        vault.entries.push(persistedEntry);
        await this.repository.save(vault);
        return persistedEntry;
    }

    private getLatestEntry(entries: VaultEntry[], field: string): VaultEntry | undefined {
        for (let index = entries.length - 1; index >= 0; index -= 1) {
            const entry = entries[index];
            if (!entry) {
                continue;
            }
            if (entry.field === field) {
                return entry;
            }
        }
        return undefined;
    }

    private async runExclusiveWrite<T>(operation: () => Promise<T>): Promise<T> {
        const runPromise = this.writeBarrier.then(operation);
        this.writeBarrier = runPromise.then(
            () => undefined,
            () => undefined
        );
        return runPromise;
    }
}
