import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { wrapFieldKey, unwrapFieldKey, deriveXKeypairFromEd25519 } from '../src/delegation.js';
import { x25519 } from '@noble/curves/ed25519';

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateX25519Keypair(): { privateKey: string; publicKey: string } {
    const privBytes = randomBytes(32);
    const pubBytes = x25519.getPublicKey(privBytes);
    return {
        privateKey: privBytes.toString('hex'),
        publicKey: Buffer.from(pubBytes).toString('hex'),
    };
}

// ── wrapFieldKey / unwrapFieldKey ─────────────────────────────────────────────

describe('wrapFieldKey / unwrapFieldKey', () => {
    it('roundtrips a field key between owner and node', () => {
        const ownerKeypair = generateX25519Keypair();
        const nodeKeypair = generateX25519Keypair();
        const fieldKey = randomBytes(32);

        const wrapped = wrapFieldKey(fieldKey, nodeKeypair.publicKey, ownerKeypair.privateKey);

        expect(wrapped.encryptedKey).toBeTypeOf('string');
        expect(wrapped.nonce).toBeTypeOf('string');

        const unwrapped = unwrapFieldKey(wrapped, ownerKeypair.publicKey, nodeKeypair.privateKey);

        expect(unwrapped).toEqual(fieldKey);
    });

    it('produces a different ciphertext for the same inputs (random nonce)', () => {
        const ownerKeypair = generateX25519Keypair();
        const nodeKeypair = generateX25519Keypair();
        const fieldKey = randomBytes(32);

        const a = wrapFieldKey(fieldKey, nodeKeypair.publicKey, ownerKeypair.privateKey);
        const b = wrapFieldKey(fieldKey, nodeKeypair.publicKey, ownerKeypair.privateKey);

        // Different nonces → different ciphertexts
        expect(a.nonce).not.toBe(b.nonce);
        expect(a.encryptedKey).not.toBe(b.encryptedKey);

        // Both still unwrap to the same key
        const ua = unwrapFieldKey(a, ownerKeypair.publicKey, nodeKeypair.privateKey);
        const ub = unwrapFieldKey(b, ownerKeypair.publicKey, nodeKeypair.privateKey);
        expect(ua).toEqual(fieldKey);
        expect(ub).toEqual(fieldKey);
    });

    it('throws when unwrapping with the wrong node private key', () => {
        const ownerKeypair = generateX25519Keypair();
        const nodeKeypair = generateX25519Keypair();
        const wrongNodeKeypair = generateX25519Keypair();
        const fieldKey = randomBytes(32);

        const wrapped = wrapFieldKey(fieldKey, nodeKeypair.publicKey, ownerKeypair.privateKey);

        expect(() =>
            unwrapFieldKey(wrapped, ownerKeypair.publicKey, wrongNodeKeypair.privateKey),
        ).toThrow();
    });

    it('throws when the wrapped payload is tampered with', () => {
        const ownerKeypair = generateX25519Keypair();
        const nodeKeypair = generateX25519Keypair();
        const fieldKey = randomBytes(32);

        const wrapped = wrapFieldKey(fieldKey, nodeKeypair.publicKey, ownerKeypair.privateKey);
        const tampered = {
            ...wrapped,
            encryptedKey: Buffer.from(
                Buffer.from(wrapped.encryptedKey, 'base64').map((b, i) => (i === 0 ? b ^ 0xff : b)),
            ).toString('base64'),
        };

        expect(() =>
            unwrapFieldKey(tampered, ownerKeypair.publicKey, nodeKeypair.privateKey),
        ).toThrow();
    });

    it('throws for a field key that is not 32 bytes', () => {
        const ownerKeypair = generateX25519Keypair();
        const nodeKeypair = generateX25519Keypair();

        expect(() =>
            wrapFieldKey(randomBytes(16), nodeKeypair.publicKey, ownerKeypair.privateKey),
        ).toThrow('Field key must be 32 bytes');
    });

    it('throws for a malformed recipient public key', () => {
        const ownerKeypair = generateX25519Keypair();
        const fieldKey = randomBytes(32);

        expect(() =>
            wrapFieldKey(fieldKey, 'not-hex', ownerKeypair.privateKey),
        ).toThrow('recipientXPub');
    });
});

// ── deriveXKeypairFromEd25519 ─────────────────────────────────────────────────

describe('deriveXKeypairFromEd25519', () => {
    const ED25519_SEED = 'a'.repeat(64); // 32 bytes of 0xaa as hex

    it('returns a 32-byte hex private key and public key', () => {
        const kp = deriveXKeypairFromEd25519(ED25519_SEED, 'vault-node-x25519-v1');
        expect(kp.privateKey).toMatch(/^[0-9a-f]{64}$/);
        expect(kp.publicKey).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic for the same input', () => {
        const a = deriveXKeypairFromEd25519(ED25519_SEED, 'vault-node-x25519-v1');
        const b = deriveXKeypairFromEd25519(ED25519_SEED, 'vault-node-x25519-v1');
        expect(a.privateKey).toBe(b.privateKey);
        expect(a.publicKey).toBe(b.publicKey);
    });

    it('produces different keypairs for different info strings', () => {
        const node = deriveXKeypairFromEd25519(ED25519_SEED, 'vault-node-x25519-v1');
        const owner = deriveXKeypairFromEd25519(ED25519_SEED, 'vault-owner-x25519-v1');
        expect(node.privateKey).not.toBe(owner.privateKey);
        expect(node.publicKey).not.toBe(owner.publicKey);
    });

    it('produces X25519 keypairs that can successfully wrap/unwrap', () => {
        const ownerKp = deriveXKeypairFromEd25519(ED25519_SEED, 'vault-owner-x25519-v1');
        const nodeKp = deriveXKeypairFromEd25519(ED25519_SEED, 'vault-node-x25519-v1');
        const fieldKey = randomBytes(32);

        const wrapped = wrapFieldKey(fieldKey, nodeKp.publicKey, ownerKp.privateKey);
        const unwrapped = unwrapFieldKey(wrapped, ownerKp.publicKey, nodeKp.privateKey);

        expect(unwrapped).toEqual(fieldKey);
    });
});
