/**
 * Regression tests for signed-entry handling in VaultEntryService (#1522).
 *
 * The service used to re-derive `previousCid` from the raw latest entry and
 * overwrite whatever the caller supplied. Because every entry arrives already
 * signed, and the signature covers `previousCid`, that write-time mutation
 * produced entries whose persisted payload differed from the signed one — they
 * failed signature verification on every subsequent read.
 *
 * The real-world trigger was a re-seal over a tombstoned field: the writer
 * signed with no `previousCid` (because `get` hides tombstones) and the service
 * then injected the tombstone's cid after signing.
 *
 * These tests use real Ed25519 signing so they fail on the actual symptom
 * (SIGNATURE_INVALID) rather than on an equality check of a stub value.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as ed25519 from '@noble/ed25519';
import { FileVaultRepository } from '../src/repository.js';
import { VAULT_ENTRY_VERSION_V1, type VaultEntry } from '../src/models.js';
import { VaultEntryService } from '../src/service.js';
import { InMemoryFieldLock } from '../src/lock.js';
import { createDefaultAdapters } from '../src/adapters.js';
import { assertEntryIntegrity } from '../src/verification.js';
import { signVaultPayload } from '../src/signature.js';
import { computeVaultCid } from '../src/cid.js';
import { deriveKeyId } from '../src/identity.js';
import { sealSecret } from '../src/seal.js';

const adapters = createDefaultAdapters();

// vault-core does not depend on @imajin/auth, so derive the identity with the
// noble primitives the package already ships. Importing ../src/signature.js
// above installs ed25519.etc.sha512Sync, which the sync getPublicKey needs.
const privateKeyHex = randomBytes(32).toString('hex');
const senderPubkey = Buffer.from(ed25519.getPublicKey(privateKeyHex)).toString('hex');
const senderDid = `did:imajin:${senderPubkey.slice(0, 16)}`;

let sealKey: Buffer;

/**
 * Build a fully signed entry the way a real writer does: chain from the raw
 * latest entry (tombstones included), sign, then hand it to the service.
 */
async function buildSignedEntry(params: {
    field: string;
    plaintext: string;
    previousCid?: string;
    deleted?: boolean;
}): Promise<VaultEntry> {
    const { field, plaintext, previousCid, deleted } = params;
    const blob = sealSecret(plaintext, sealKey);
    const cid = await computeVaultCid(blob);

    const payload = {
        version: VAULT_ENTRY_VERSION_V1 as typeof VAULT_ENTRY_VERSION_V1,
        field,
        cid,
        encrypted: blob.encrypted,
        nonce: blob.nonce,
        senderDid,
        senderPubkey,
        keyId: deriveKeyId(senderPubkey),
        timestamp: new Date().toISOString(),
        ...(previousCid === undefined ? {} : { previousCid }),
        ...(deleted === undefined ? {} : { deleted }),
    };

    const signature = signVaultPayload(payload, privateKeyHex);
    return { ...payload, signature } as VaultEntry;
}

describe('VaultEntryService signed-entry handling', () => {
    let tempDirectory: string;
    let vaultPath: string;
    let service: VaultEntryService;

    beforeEach(() => {
        sealKey = randomBytes(32);

        tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-core-signed-'));
        vaultPath = path.join(tempDirectory, 'vault.json');
        service = new VaultEntryService(new FileVaultRepository({ vaultPath }), {
            lock: new InMemoryFieldLock(),
            adapters,
        });
    });

    afterEach(() => {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    });

    it('persists a signed entry byte-for-byte', async () => {
        const first = await buildSignedEntry({ field: 'TOKEN', plaintext: 'v1' });
        await service.set(first);

        const second = await buildSignedEntry({
            field: 'TOKEN',
            plaintext: 'v2',
            previousCid: first.cid,
        });
        const persisted = await service.set(second);

        expect(persisted).toEqual(second);

        const onDisk = JSON.parse(fs.readFileSync(vaultPath, 'utf8')) as { entries: VaultEntry[] };
        expect(onDisk.entries.at(-1)).toEqual(second);
    });

    it('does not overwrite a caller-supplied previousCid', async () => {
        const first = await buildSignedEntry({ field: 'PINNED', plaintext: 'v1' });
        await service.set(first);
        const second = await buildSignedEntry({
            field: 'PINNED',
            plaintext: 'v2',
            previousCid: first.cid,
        });
        await service.set(second);

        // Deliberately chains from the FIRST entry, not the latest. The chain is
        // the caller's business; the signature covers it, so the service must
        // preserve it verbatim rather than "correcting" it to second.cid.
        const third = await buildSignedEntry({
            field: 'PINNED',
            plaintext: 'v3',
            previousCid: first.cid,
        });
        const persisted = await service.set(third);

        expect(persisted.previousCid).toBe(first.cid);
        await expect(assertEntryIntegrity(persisted, adapters)).resolves.toBeDefined();
    });

    // The end-to-end #1522 reproduction lives in the kernel suite
    // (apps/kernel/src/lib/vault/__tests__/connector-resilience.test.ts), which
    // owns the writer that chooses previousCid. This test covers the store-level
    // half: given a correctly chained re-seal over a tombstone, persistence must
    // not disturb it.
    it('a chained re-seal over a tombstone stays verifiable on read', async () => {
        const original = await buildSignedEntry({ field: 'github-oauth', plaintext: 'token-1' });
        await service.set(original);

        const tombstone = await buildSignedEntry({
            field: 'github-oauth',
            plaintext: 'DELETED',
            previousCid: original.cid,
            deleted: true,
        });
        await service.set(tombstone);
        await expect(service.get('github-oauth')).resolves.toBeUndefined();

        // Reconnect: chain from the raw latest entry (the tombstone).
        const reconnected = await buildSignedEntry({
            field: 'github-oauth',
            plaintext: 'token-2',
            previousCid: tombstone.cid,
        });
        await service.set(reconnected);

        // Before the fix this threw VaultIntegrityError: SIGNATURE_INVALID.
        const loaded = await service.get('github-oauth');
        expect(loaded?.cid).toBe(reconnected.cid);
        await expect(assertEntryIntegrity(loaded!, adapters)).resolves.toBeDefined();
    });

    it('rejects the write when auto-filling previousCid would invalidate the signature', async () => {
        const first = await buildSignedEntry({ field: 'GUARDED', plaintext: 'v1' });
        await service.set(first);

        // A caller that signs without previousCid while a prior entry exists
        // relies on the service to fill it in — but that fill changes the signed
        // payload. This is the exact shape of the original bug, and it must now
        // fail loudly at write time instead of persisting an entry that can never
        // be read again.
        const unchained = await buildSignedEntry({ field: 'GUARDED', plaintext: 'v2' });

        await expect(service.set(unchained)).rejects.toThrow(/signature/i);

        // Nothing was appended — the field still resolves to the original entry.
        const latest = await service.get('GUARDED');
        expect(latest?.cid).toBe(first.cid);
    });

    it('peek returns the raw latest entry including tombstones', async () => {
        const original = await buildSignedEntry({ field: 'PEEKED', plaintext: 'v1' });
        await service.set(original);

        const tombstone = await buildSignedEntry({
            field: 'PEEKED',
            plaintext: 'DELETED',
            previousCid: original.cid,
            deleted: true,
        });
        await service.set(tombstone);

        await expect(service.get('PEEKED')).resolves.toBeUndefined();
        const peeked = await service.peek('PEEKED');
        expect(peeked?.cid).toBe(tombstone.cid);
        expect(peeked?.deleted).toBe(true);
    });

    it('peek returns an unverifiable entry instead of throwing', async () => {
        const entry = await buildSignedEntry({ field: 'CORRUPT', plaintext: 'v1' });
        await service.set(entry);

        // Corrupt the persisted signature — the recovery path must still be able
        // to read the entry's metadata to chain a tombstone off it.
        const raw = JSON.parse(fs.readFileSync(vaultPath, 'utf8')) as { entries: VaultEntry[] };
        raw.entries[0]!.signature = 'a'.repeat(128);
        fs.writeFileSync(vaultPath, JSON.stringify(raw));

        await expect(service.get('CORRUPT')).rejects.toThrow();
        const peeked = await service.peek('CORRUPT');
        expect(peeked?.field).toBe('CORRUPT');
    });

    it('peek returns undefined for an unknown field', async () => {
        await expect(service.peek('NEVER_WRITTEN')).resolves.toBeUndefined();
    });
});
