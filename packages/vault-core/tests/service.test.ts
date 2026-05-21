import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileVaultRepository } from '../src/repository.js';
import { VAULT_ENTRY_VERSION_V1, type UpsertVaultEntryInput } from '../src/models.js';
import { VaultEntryService } from '../src/service.js';

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
});
