export interface VaultLock {
    acquire(field: string): Promise<VaultLockRelease>;
}

export type VaultLockRelease = () => Promise<void>;

/**
 * In-memory per-field lock with FIFO queuing.
 *
 * Suitable for single-process use. Different fields may be locked
 * concurrently, but writes to the same field are serialized.
 */
export class InMemoryFieldLock implements VaultLock {
    private readonly queues = new Map<string, Array<(release: VaultLockRelease) => void>>();
    private readonly held = new Set<string>();

    public async acquire(field: string): Promise<VaultLockRelease> {
        if (!this.held.has(field)) {
            this.held.add(field);
            return () => this.release(field);
        }

        return new Promise((resolve) => {
            const queue = this.queues.get(field) ?? [];
            queue.push(resolve);
            this.queues.set(field, queue);
        });
    }

    private async release(field: string): Promise<void> {
        const queue = this.queues.get(field);
        if (queue && queue.length > 0) {
            const next = queue.shift()!;
            next(() => this.release(field));
        } else {
            this.held.delete(field);
        }
    }
}

/**
 * Stub interface for filesystem-level locking.
 *
 * TODO: Implement cross-process file locking (e.g. using flock or lockfile).
 */
export interface FileLock {
    // Reserved for future filesystem-level locking implementation
}
