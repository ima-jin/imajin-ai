export class VaultEntryService {
    repository;
    writeBarrier = Promise.resolve();
    constructor(repository) {
        this.repository = repository;
    }
    async set(entry) {
        return this.runExclusiveWrite(async () => {
            const vault = await this.repository.load();
            const previousCid = this.getLatestEntry(vault.entries, entry.field)?.cid ?? entry.previousCid;
            const persistedEntry = {
                ...entry,
                ...(previousCid !== undefined ? { previousCid } : {})
            };
            vault.entries.push(persistedEntry);
            await this.repository.save(vault);
            return persistedEntry;
        });
    }
    async get(field) {
        const vault = await this.repository.load();
        const latest = this.getLatestEntry(vault.entries, field);
        if (!latest || latest.deleted === true) {
            return undefined;
        }
        return latest;
    }
    async list() {
        const vault = await this.repository.load();
        const latestByField = new Map();
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
    async getHistory(field) {
        const vault = await this.repository.load();
        const history = [];
        let current = this.getLatestEntry(vault.entries, field);
        while (current) {
            history.push(current);
            if (!current.previousCid) {
                break;
            }
            current = vault.entries.find(entry => entry.cid === current.previousCid);
        }
        return history;
    }
    async loadVault() {
        return this.repository.load();
    }
    getLatestEntry(entries, field) {
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
    async runExclusiveWrite(operation) {
        const runPromise = this.writeBarrier.then(operation);
        this.writeBarrier = runPromise.then(() => undefined, () => undefined);
        return runPromise;
    }
}
//# sourceMappingURL=service.js.map