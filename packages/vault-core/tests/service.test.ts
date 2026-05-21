import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FileVaultRepository, type VaultRepository } from '../src/repository.js';
import { VAULT_ENTRY_VERSION_V1, type UpsertVaultEntryInput } from '../src/models.js';
import { VaultEntryService } from '../src/service.js';
import { InMemoryFieldLock } from '../src/lock.js';
import { type VaultIntegrityAdapters } from '../src/verification.js';

const createEntry = (field: string, cid: string, overrides: Partial<UpsertVaultEntryInput> = {}): UpsertVaultEntryInput => ({
    version: VAULT_ENTRY_VERSION_V1,
    field,
    cid,
    encrypted: `enc:${cid}`,
    nonce: `nonce:${cid}`,
    senderDid: 'did:key:zsender',
    senderPubkey: 'sender-pubkey',
    keyId: 'kid:sender-pubkey',
    signature: `sig:${cid}`,
    timestamp: new Date().toISOString(),
    ...overrides
});

describe('VaultEntryService', () => {
    let tempDirectory: string;
    let vaultPath: string;

    beforeEach(() => {
        tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-core-service-'));
        vaultPath = path.join(tempDirectory, 'vault.json');
    });

    afterEach(() => {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    });

    it('persists entries and retrieves latest value', async () => {
        const repository = new FileVaultRepository({ vaultPath });
        const service = new VaultEntryService(repository);

        const first = await service.set(createEntry('API_KEY', 'cid:1'));
        const second = await service.set(createEntry('API_KEY', 'cid:2'));

        expect(first.previousCid).toBeUndefined();
        expect(second.previousCid).toBe('cid:1');

        const latest = await service.get('API_KEY');
        expect(latest?.cid).toBe('cid:2');
    });

    it('lists latest entry per field and excludes deleted entries', async () => {
        const repository = new FileVaultRepository({ vaultPath });
        const service = new VaultEntryService(repository);

        await service.set(createEntry('ONE', 'cid:one-1'));
        await service.set(createEntry('ONE', 'cid:one-2'));
        await service.set(createEntry('TWO', 'cid:two-1'));
        await service.set(createEntry('TWO', 'cid:two-del', { deleted: true }));

        const entries = await service.list();
        expect(entries).toHaveLength(1);
        expect(entries[0]?.field).toBe('ONE');
        expect(entries[0]?.cid).toBe('cid:one-2');
    });

    it('returns undefined from get when latest entry is tombstoned', async () => {
        const repository = new FileVaultRepository({ vaultPath });
        const service = new VaultEntryService(repository);

        await service.set(createEntry('TOKEN', 'cid:token-1'));
        await service.set(createEntry('TOKEN', 'cid:token-del', { deleted: true }));

        await expect(service.get('TOKEN')).resolves.toBeUndefined();
    });

    it('returns newest-to-oldest chain in history', async () => {
        const repository = new FileVaultRepository({ vaultPath });
        const service = new VaultEntryService(repository);

        await service.set(createEntry('SECRET', 'cid:s1'));
        await service.set(createEntry('SECRET', 'cid:s2'));
        await service.set(createEntry('SECRET', 'cid:s3'));

        const history = await service.getHistory('SECRET');
        expect(history.map(entry => entry.cid)).toEqual(['cid:s3', 'cid:s2', 'cid:s1']);
    });

    it('reads persisted values from a new service instance', async () => {
        const repository1 = new FileVaultRepository({ vaultPath });
        const service1 = new VaultEntryService(repository1);
        await service1.set(createEntry('PERSIST', 'cid:persist-1'));

        const repository2 = new FileVaultRepository({ vaultPath });
        const service2 = new VaultEntryService(repository2);
        const loaded = await service2.get('PERSIST');

        expect(loaded?.cid).toBe('cid:persist-1');
    });

    it('uses per-field locking when a lock is provided', async () => {
        const repository = new FileVaultRepository({ vaultPath });
        const lock = new InMemoryFieldLock();
        const service = new VaultEntryService(repository, { lock });

        const order: string[] = [];

        async function write(field: string, cid: string) {
            await service.set(createEntry(field, cid));
            order.push(cid);
        }

        // Concurrent writes to the same field should be serialized
        const p1 = write('A', 'cid:a1');
        const p2 = write('A', 'cid:a2');

        await Promise.all([p1, p2]);

        const aIndices = [order.indexOf('cid:a1'), order.indexOf('cid:a2')];
        expect(aIndices[0]).toBeLessThan(aIndices[1]);
    });

    it('does not lose writes across different fields when lock is provided', async () => {
        const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
        let currentVault = {
            version: VAULT_ENTRY_VERSION_V1,
            entries: [] as ReturnType<typeof createEntry>[]
        };
        const repository: VaultRepository = {
            load: async () => {
                await pause(15);
                return {
                    version: currentVault.version,
                    entries: [...currentVault.entries]
                };
            },
            save: async (vault) => {
                await pause(15);
                currentVault = {
                    version: vault.version,
                    entries: [...vault.entries]
                };
            }
        };
        const lock = new InMemoryFieldLock();
        const service = new VaultEntryService(repository, { lock });

        await Promise.all([
            service.set(createEntry('FIELD_A', 'cid:a')),
            service.set(createEntry('FIELD_B', 'cid:b'))
        ]);

        const vault = await service.loadVault();
        const fields = new Set(vault.entries.map(entry => entry.field));
        expect(fields).toEqual(new Set(['FIELD_A', 'FIELD_B']));
        expect(vault.entries).toHaveLength(2);
    });

    it('runs integrity verification on get when adapters are provided', async () => {
        const repository = new FileVaultRepository({ vaultPath });
        const adapters: VaultIntegrityAdapters = {
            computeCid: vi.fn(async ({ encrypted, nonce }) => `cid:${encrypted}:${nonce}`),
            deriveKeyId: vi.fn((senderPubkey: string) => `kid:${senderPubkey}`),
            verifyDidKeyBinding: vi.fn((_did: string, _senderPubkey: string) => true),
            verifySignature: vi.fn((_payload, _signature: string, _senderPubkey: string) => true)
        };
        const service = new VaultEntryService(repository, { adapters });

        const encrypted = 'enc-verify';
        const nonce = 'nonce-verify';
        const entry = createEntry('VERIFY', `cid:${encrypted}:${nonce}`, { encrypted, nonce });
        await service.set(entry);

        const loaded = await service.get('VERIFY');
        expect(loaded).toBeDefined();
        expect(adapters.verifySignature).toHaveBeenCalled();
    });

    it('throws on get when integrity verification fails', async () => {
        const repository = new FileVaultRepository({ vaultPath });
        const adapters: VaultIntegrityAdapters = {
            computeCid: vi.fn(async () => 'wrong-cid'),
            deriveKeyId: vi.fn(() => 'kid'),
            verifyDidKeyBinding: vi.fn(() => true),
            verifySignature: vi.fn(() => true)
        };
        const service = new VaultEntryService(repository, { adapters });

        const entry = createEntry('BAD', 'cid:bad');
        await service.set(entry);

        await expect(service.get('BAD')).rejects.toThrow();
    });

    it('runs integrity verification on list when adapters are provided', async () => {
        const repository = new FileVaultRepository({ vaultPath });
        const adapters: VaultIntegrityAdapters = {
            computeCid: vi.fn(async ({ encrypted, nonce }) => `cid:${encrypted}:${nonce}`),
            deriveKeyId: vi.fn((senderPubkey: string) => `kid:${senderPubkey}`),
            verifyDidKeyBinding: vi.fn(() => true),
            verifySignature: vi.fn(() => true)
        };
        const service = new VaultEntryService(repository, { adapters });

        await service.set(createEntry('LIST_VERIFY', 'cid:enc-list:nonce-list', {
            encrypted: 'enc-list',
            nonce: 'nonce-list'
        }));

        const entries = await service.list();
        expect(entries).toHaveLength(1);
        expect(adapters.verifySignature).toHaveBeenCalled();
    });

    it('throws on history read when integrity verification fails', async () => {
        const repository = new FileVaultRepository({ vaultPath });
        const adapters: VaultIntegrityAdapters = {
            computeCid: vi.fn(async () => 'wrong-cid'),
            deriveKeyId: vi.fn(() => 'kid'),
            verifyDidKeyBinding: vi.fn(() => true),
            verifySignature: vi.fn(() => true)
        };
        const service = new VaultEntryService(repository, { adapters });

        await service.set(createEntry('HISTORY_BAD', 'cid:history-bad'));

        await expect(service.getHistory('HISTORY_BAD')).rejects.toThrow();
    });
});
