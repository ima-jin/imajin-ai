import { describe, it, expect } from 'vitest';
import { createDefaultAdapters } from '../src/adapters.js';
import { computeVaultCid, verifyVaultCid } from '../src/cid.js';
import { deriveKeyId, verifyDidKeyBinding } from '../src/identity.js';
import { verifyVaultSignature } from '../src/signature.js';

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
        expect(adapters.deriveKeyId('abcd1234')).toBe(deriveKeyId('abcd1234'));
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
