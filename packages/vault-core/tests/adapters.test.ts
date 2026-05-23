import { describe, it, expect } from 'vitest';
import { createDefaultAdapters } from '../src/adapters.js';
import { computeVaultCid } from '../src/cid.js';
import { deriveKeyId, verifyDidKeyBinding } from '../src/identity.js';
import { verifyVaultSignature } from '../src/signature.js';
import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
ed25519.etc.sha512Sync = (...messages) => sha512(ed25519.etc.concatBytes(...messages));

function generatePublicKey(): string {
    const privateKey = ed25519.utils.randomPrivateKey();
    const publicKey = ed25519.getPublicKey(privateKey);
    return Buffer.from(publicKey).toString('hex');
}

describe('createDefaultAdapters', () => {
    it('returns an adapter object with all required functions', () => {
        const adapters = createDefaultAdapters();
        expect(typeof adapters.computeCid).toBe('function');
        expect(typeof adapters.deriveKeyId).toBe('function');
        expect(typeof adapters.verifyDidKeyBinding).toBe('function');
        expect(typeof adapters.verifySignature).toBe('function');
    });

    it('wires computeCid to computeVaultCid', async () => {
        const adapters = createDefaultAdapters();
        const blob = { encrypted: 'a', nonce: 'b' };
        const cid = await adapters.computeCid(blob);
        expect(cid).toBe(await computeVaultCid(blob));
    });

    it('wires deriveKeyId correctly', () => {
        const adapters = createDefaultAdapters();
        const publicKey = generatePublicKey();
        expect(adapters.deriveKeyId(publicKey)).toBe(deriveKeyId(publicKey));
    });

    it('wires verifyDidKeyBinding correctly', () => {
        const adapters = createDefaultAdapters();
        expect(adapters.verifyDidKeyBinding('did:imajin:abc', 'abc')).toBe(verifyDidKeyBinding('did:imajin:abc', 'abc'));
    });

    it('wires verifySignature to verifyVaultSignature', () => {
        const adapters = createDefaultAdapters();
        expect(adapters.verifySignature).toBe(verifyVaultSignature);
    });
});
