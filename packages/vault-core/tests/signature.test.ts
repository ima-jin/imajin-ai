import { describe, it, expect } from 'vitest';
import { signVaultPayload, verifyVaultSignature } from '../src/signature.js';
import { generateKeypair, getPublicKey } from '@imajin/auth';
import { VAULT_ENTRY_VERSION_V1, type VaultSignedPayload } from '../src/models.js';

const createPayload = (overrides: Partial<VaultSignedPayload> = {}): VaultSignedPayload => ({
    version: VAULT_ENTRY_VERSION_V1,
    field: 'API_KEY',
    cid: 'cid-1',
    encrypted: 'enc',
    nonce: 'nonce',
    senderDid: 'did:imajin:abc',
    senderPubkey: 'pubkey',
    keyId: 'kid',
    timestamp: '2026-05-20T22:00:00.000Z',
    ...overrides
});

describe('signVaultPayload + verifyVaultSignature', () => {
    it('round-trips a valid signature', () => {
        const keypair = generateKeypair();
        const payload = createPayload({ senderPubkey: keypair.publicKey });
        const signature = signVaultPayload(payload, keypair.privateKey);
        expect(signature).toHaveLength(128); // 64-byte hex

        const valid = verifyVaultSignature(payload, signature, keypair.publicKey);
        expect(valid).toBe(true);
    });

    it('fails verification when the payload is tampered', () => {
        const keypair = generateKeypair();
        const payload = createPayload({ senderPubkey: keypair.publicKey });
        const signature = signVaultPayload(payload, keypair.privateKey);

        const tampered = { ...payload, encrypted: 'tampered' };
        const valid = verifyVaultSignature(tampered, signature, keypair.publicKey);
        expect(valid).toBe(false);
    });

    it('fails verification with a wrong public key', () => {
        const kp1 = generateKeypair();
        const kp2 = generateKeypair();
        const payload = createPayload({ senderPubkey: kp1.publicKey });
        const signature = signVaultPayload(payload, kp1.privateKey);

        const valid = verifyVaultSignature(payload, signature, kp2.publicKey);
        expect(valid).toBe(false);
    });

    it('produces the same signature for identical payloads', () => {
        const keypair = generateKeypair();
        const payload = createPayload({ senderPubkey: keypair.publicKey });
        const sig1 = signVaultPayload(payload, keypair.privateKey);
        const sig2 = signVaultPayload(payload, keypair.privateKey);
        expect(sig1).toBe(sig2);
    });
});
