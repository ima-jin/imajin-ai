import { randomBytes, createCipheriv, createDecipheriv, hkdfSync, createHash } from 'node:crypto';
import { type VaultBlob } from './models.js';
import { extractPrivateKeySeed } from './signature.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// Seal-key derivation constants. HKDF domain-separates the sealing key from the
// raw signing key so the same seed never serves two purposes directly.
const SEAL_KEY_HKDF_SALT = Buffer.from('imajin-vault', 'utf8');
const SEAL_KEY_HKDF_INFO = Buffer.from('seal-v1', 'utf8');
const DEV_SEAL_KEY_SEED = 'dev-vault-seal-imajin';

/**
 * Derive the 32-byte AES-256-GCM vault seal key from an Ed25519 private key.
 *
 * HKDF-SHA256 over the key seed with a fixed salt/info. This is the single
 * source of truth for seal-key derivation, shared by the kernel vault
 * (`sealing.ts`) and any headless caller — do not reimplement it elsewhere.
 *
 * When `authPrivateKey` is absent, returns a deterministic dev-fallback key so
 * sign/verify is self-consistent in development. NEVER use the fallback with
 * real secrets.
 */
export function deriveSealKey(authPrivateKey?: string): Buffer {
    if (authPrivateKey) {
        const seed = Buffer.from(extractPrivateKeySeed(authPrivateKey), 'hex');
        return Buffer.from(hkdfSync('sha256', seed, SEAL_KEY_HKDF_SALT, SEAL_KEY_HKDF_INFO, 32));
    }
    return createHash('sha256').update(DEV_SEAL_KEY_SEED).digest();
}

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
