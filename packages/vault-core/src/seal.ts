import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { type VaultBlob } from './models.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Seal a plaintext string using AES-256-GCM.
 *
 * Returns a VaultBlob where:
 *   nonce     = base64-encoded 12-byte random IV
 *   encrypted = base64-encoded authTag (16 bytes) || ciphertext
 *
 * The authTag is prepended so the blob layout is self-contained:
 * a caller splitting on nonce + encrypted has everything needed to unseal.
 *
 * No plaintext is logged or exposed at any point.
 */
export function sealSecret(plaintext: string, keyBytes: Uint8Array): VaultBlob {
    if (keyBytes.length !== 32) {
        throw new Error(`Seal key must be 32 bytes; got ${keyBytes.length}`);
    }
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, keyBytes, iv);
    const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    const payload = Buffer.concat([authTag, ciphertext]);
    return {
        encrypted: payload.toString('base64'),
        nonce: iv.toString('base64'),
    };
}

/**
 * Unseal a VaultBlob produced by sealSecret.
 *
 * Throws if the key is wrong or the ciphertext has been tampered with
 * (AES-GCM authentication failure). This is the fail-closed gate: any
 * integrity violation surfaces as an error, never as silently wrong plaintext.
 *
 * No plaintext is logged or exposed at any point in this function.
 */
export function unsealSecret(blob: VaultBlob, keyBytes: Uint8Array): string {
    if (keyBytes.length !== 32) {
        throw new Error(`Seal key must be 32 bytes; got ${keyBytes.length}`);
    }
    const iv = Buffer.from(blob.nonce, 'base64');
    if (iv.length !== IV_LENGTH) {
        throw new Error(`Invalid nonce length: expected ${IV_LENGTH}, got ${iv.length}`);
    }
    const payload = Buffer.from(blob.encrypted, 'base64');
    if (payload.length < AUTH_TAG_LENGTH) {
        throw new Error('Encrypted payload too short to contain authTag');
    }
    const authTag = payload.subarray(0, AUTH_TAG_LENGTH);
    const ciphertext = payload.subarray(AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, keyBytes, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
