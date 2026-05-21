import { describe, it, expect } from 'vitest';
import { deriveKeyId, verifyDidKeyBinding } from '../src/identity.js';
import { generateKeypair } from '@imajin/auth';

describe('deriveKeyId', () => {
    it('returns a 16-character hex string', () => {
        const keypair = generateKeypair();
        const kid = deriveKeyId(keypair.publicKey);
        expect(kid).toHaveLength(16);
        expect(/^[0-9a-f]{16}$/i.test(kid)).toBe(true);
    });

    it('is deterministic for the same public key', () => {
        const keypair = generateKeypair();
        const a = deriveKeyId(keypair.publicKey);
        const b = deriveKeyId(keypair.publicKey);
        expect(a).toBe(b);
    });

    it('produces different keyIds for different public keys', () => {
        const kp1 = generateKeypair();
        const kp2 = generateKeypair();
        expect(deriveKeyId(kp1.publicKey)).not.toBe(deriveKeyId(kp2.publicKey));
    });
});

describe('verifyDidKeyBinding', () => {
    it('returns true for a matching did:imajin DID', () => {
        const keypair = generateKeypair();
        const did = `did:imajin:${keypair.publicKey.slice(0, 16)}`;
        expect(verifyDidKeyBinding(did, keypair.publicKey)).toBe(true);
    });

    it('returns false for a mismatched pubkey', () => {
        const kp1 = generateKeypair();
        const kp2 = generateKeypair();
        const did = `did:imajin:${kp1.publicKey.slice(0, 16)}`;
        expect(verifyDidKeyBinding(did, kp2.publicKey)).toBe(false);
    });

    it('returns false for non-did:imajin DIDs', () => {
        const keypair = generateKeypair();
        expect(verifyDidKeyBinding('did:key:zABC', keypair.publicKey)).toBe(false);
    });

    it('returns false for invalid public keys', () => {
        expect(verifyDidKeyBinding('did:imajin:abc123', 'not-a-key')).toBe(false);
    });
});
