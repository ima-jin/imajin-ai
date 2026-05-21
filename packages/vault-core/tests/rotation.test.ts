import { describe, it, expect } from 'vitest';
import { prepareRotationEntry } from '../src/rotation.js';
import { deriveKeyId, verifyDidKeyBinding } from '../src/identity.js';
import { verifyVaultSignature } from '../src/signature.js';
import { computeVaultCid } from '../src/cid.js';
import { generateKeypair } from '@imajin/auth';
import { VAULT_ENTRY_VERSION_V1, type VaultEntry } from '../src/models.js';

const createEntry = (overrides: Partial<VaultEntry> = {}): VaultEntry => ({
    version: VAULT_ENTRY_VERSION_V1,
    field: 'SECRET',
    cid: 'old-cid',
    encrypted: 'old-enc',
    nonce: 'old-nonce',
    senderDid: 'did:imajin:abc123',
    senderPubkey: 'old-pubkey',
    keyId: 'old-kid',
    signature: 'old-sig',
    timestamp: '2026-05-20T20:00:00.000Z',
    ...overrides
});

describe('prepareRotationEntry', () => {
    it('creates a new entry with updated blob and keyId', async () => {
        const signer = generateKeypair();
        const newRecipient = generateKeypair();
        const existing = createEntry({
            senderPubkey: signer.publicKey,
            senderDid: `did:imajin:${signer.publicKey.slice(0, 16)}`
        });

        const newBlob = { encrypted: 'new-enc', nonce: 'new-nonce' };
        const rotated = await prepareRotationEntry(existing, newBlob, newRecipient.publicKey, signer.privateKey);

        expect(rotated.field).toBe(existing.field);
        expect(rotated.encrypted).toBe(newBlob.encrypted);
        expect(rotated.nonce).toBe(newBlob.nonce);
        expect(rotated.keyId).toBe(deriveKeyId(newRecipient.publicKey));
        expect(rotated.previousCid).toBe(existing.cid);
        expect(rotated.timestamp).not.toBe(existing.timestamp);
    });

    it('computes the CID over the new blob', async () => {
        const signer = generateKeypair();
        const newRecipient = generateKeypair();
        const existing = createEntry({ senderPubkey: signer.publicKey });
        const newBlob = { encrypted: 'new-enc', nonce: 'new-nonce' };

        const rotated = await prepareRotationEntry(existing, newBlob, newRecipient.publicKey, signer.privateKey);
        const expectedCid = await computeVaultCid(newBlob);
        expect(rotated.cid).toBe(expectedCid);
    });

    it('preserves senderDid and senderPubkey', async () => {
        const signer = generateKeypair();
        const newRecipient = generateKeypair();
        const existing = createEntry({
            senderPubkey: signer.publicKey,
            senderDid: `did:imajin:${signer.publicKey.slice(0, 16)}`
        });

        const rotated = await prepareRotationEntry(
            existing,
            { encrypted: 'x', nonce: 'y' },
            newRecipient.publicKey,
            signer.privateKey
        );

        expect(rotated.senderDid).toBe(existing.senderDid);
        expect(rotated.senderPubkey).toBe(existing.senderPubkey);
    });

    it('produces a valid signature', async () => {
        const signer = generateKeypair();
        const newRecipient = generateKeypair();
        const existing = createEntry({
            senderPubkey: signer.publicKey,
            senderDid: `did:imajin:${signer.publicKey.slice(0, 16)}`
        });

        const rotated = await prepareRotationEntry(
            existing,
            { encrypted: 'x', nonce: 'y' },
            newRecipient.publicKey,
            signer.privateKey
        );

        const signatureValid = verifyVaultSignature(
            {
                version: rotated.version,
                field: rotated.field,
                cid: rotated.cid,
                encrypted: rotated.encrypted,
                nonce: rotated.nonce,
                senderDid: rotated.senderDid,
                senderPubkey: rotated.senderPubkey,
                keyId: rotated.keyId,
                timestamp: rotated.timestamp,
                previousCid: rotated.previousCid
            },
            rotated.signature,
            signer.publicKey
        );

        expect(signatureValid).toBe(true);
    });
});
