import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sealSecret, unsealSecret } from '../src/seal.js';

function makeKey(): Uint8Array {
    return new Uint8Array(randomBytes(32));
}

describe('sealSecret / unsealSecret', () => {
    it('round-trips plaintext correctly', () => {
        const key = makeKey();
        const plaintext = 'ghp_supersecrettoken1234';
        const blob = sealSecret(plaintext, key);
        expect(unsealSecret(blob, key)).toBe(plaintext);
    });

    it('round-trips an empty string', () => {
        const key = makeKey();
        const blob = sealSecret('', key);
        expect(unsealSecret(blob, key)).toBe('');
    });

    it('round-trips unicode plaintext', () => {
        const key = makeKey();
        const plaintext = 'secret: 🔐 café naïve';
        const blob = sealSecret(plaintext, key);
        expect(unsealSecret(blob, key)).toBe(plaintext);
    });

    it('produces different ciphertext for the same plaintext (random IV)', () => {
        const key = makeKey();
        const plaintext = 'same-value';
        const blob1 = sealSecret(plaintext, key);
        const blob2 = sealSecret(plaintext, key);
        expect(blob1.nonce).not.toBe(blob2.nonce);
        expect(blob1.encrypted).not.toBe(blob2.encrypted);
    });

    it('encrypted field does not contain the plaintext', () => {
        const key = makeKey();
        const plaintext = 'do-not-store-me';
        const blob = sealSecret(plaintext, key);
        // The raw base64 of the encrypted field must not decode to anything containing the plaintext
        const decoded = Buffer.from(blob.encrypted, 'base64').toString('utf8');
        expect(decoded).not.toContain(plaintext);
    });

    it('throws on wrong key (fail-closed)', () => {
        const key = makeKey();
        const wrongKey = makeKey();
        const blob = sealSecret('secret', key);
        expect(() => unsealSecret(blob, wrongKey)).toThrow();
    });

    it('throws on tampered encrypted field', () => {
        const key = makeKey();
        const blob = sealSecret('secret', key);
        // Flip a byte deep in the ciphertext (after the 16-byte authTag)
        const payload = Buffer.from(blob.encrypted, 'base64');
        if (payload.length > 17) {
            payload[17] ^= 0xff;
        }
        const tampered = { ...blob, encrypted: payload.toString('base64') };
        expect(() => unsealSecret(tampered, key)).toThrow();
    });

    it('throws on tampered nonce', () => {
        const key = makeKey();
        const blob = sealSecret('secret', key);
        const iv = Buffer.from(blob.nonce, 'base64');
        iv[0] ^= 0x01;
        const tampered = { ...blob, nonce: iv.toString('base64') };
        expect(() => unsealSecret(tampered, key)).toThrow();
    });

    it('throws if key is wrong length', () => {
        const shortKey = new Uint8Array(16);
        expect(() => sealSecret('x', shortKey)).toThrow(/32 bytes/);
        const blob = sealSecret('x', makeKey());
        expect(() => unsealSecret(blob, shortKey)).toThrow(/32 bytes/);
    });
});
