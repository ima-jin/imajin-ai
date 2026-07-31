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

    /**
     * Return the raw latest entry for a field, exactly as persisted.
     *
     * Unlike {@link get}, this does NOT hide tombstones and does NOT assert
     * integrity. It exists for two jobs that must work on entries `get` refuses
     * to return:
     *
     *   1. Chaining `previousCid` — a writer must chain from the true latest
     *      entry (tombstones included), otherwise the chain it signs disagrees
     *      with what is actually on disk.
     *   2. Recovery — tombstoning or inspecting an entry whose signature no
     *      longer verifies. Without a non-asserting read, a single bad entry
     *      would be permanently unfixable.
     *
     * Never unseal a peeked entry without verifying it first: the caller takes
     * responsibility for integrity because this method deliberately skips it.
     */
    public async peek(field: string): Promise<VaultEntry | undefined> {
        const vault = await this.repository.load();
        return this.getLatestEntry(vault.entries, field);
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
        const entries = Array.from(latestByField.values()).filter(entry => entry.deleted !== true);
        if (this.adapters) {
            const adapters = this.adapters;
            await Promise.all(entries.map(async entry => {
                await assertEntryIntegrity(entry, adapters);
            }));
        }
        return entries;
    }

    public async getHistory(field: string): Promise<VaultEntry[]> {
        const vault = await this.repository.load();
        const history: VaultEntry[] = [];
        let current = this.getLatestEntry(vault.entries, field);
        while (current) {
            if (this.adapters) {
                await assertEntryIntegrity(current, this.adapters);
            }
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

    /**
     * Persist an entry, appending it to the vault file.
     *
     * The caller's `previousCid` is authoritative and is NEVER overwritten:
     * every entry arrives already signed, and the signature covers `previousCid`.
     * Replacing it here would persist a payload that differs from the one that
     * was signed, making the entry fail signature verification on the next read.
     * That is exactly the bug this preserves against — a re-seal over a
     * tombstoned field signed without `previousCid` (because `get` hides
     * tombstones) then had the tombstone's cid injected after signing.
     *
     * `previousCid` is still auto-filled when the caller omitted it entirely,
     * which keeps the convenience contract for callers that do not chain
     * themselves. When that fill mutates the entry and integrity adapters are
     * configured, the result is verified BEFORE it is written, so a
     * signature-invalidating fill fails loudly at write time instead of
     * silently corrupting the field for every later read.
     */
    private async setInternal(entry: UpsertVaultEntryInput): Promise<VaultEntry> {
        const vault = await this.repository.load();
        let persistedEntry = entry as VaultEntry;

        if (entry.previousCid === undefined) {
            const inferredPreviousCid = this.getLatestEntry(vault.entries, entry.field)?.cid;
            if (inferredPreviousCid !== undefined) {
                persistedEntry = { ...entry, previousCid: inferredPreviousCid } as VaultEntry;
                if (this.adapters) {
                    await assertEntryIntegrity(persistedEntry, this.adapters);
                }
            }
        }

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
