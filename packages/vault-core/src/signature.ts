import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { type VaultSignedPayload } from './models.js';
import { canonicalizePayload } from './canonical.js';
ed25519.etc.sha512Sync = (...messages) => sha512(ed25519.etc.concatBytes(...messages));

const PKCS8_ED25519_PREFIX = '302e020100300506032b657004220420';

export function extractPrivateKeySeed(privateKeyHex: string): string {
    const cleaned = privateKeyHex.toLowerCase().trim();
    if (cleaned.length === 64) {
        return cleaned;
    }
    if (cleaned.length === 96 && cleaned.startsWith(PKCS8_ED25519_PREFIX)) {
        return cleaned.slice(32);
    }
    throw new Error(
        `Invalid Ed25519 private key: expected 64 hex chars (raw) or 96 hex chars (PKCS#8), got ${cleaned.length}`
    );
}

/**
 * Sign a vault payload using Ed25519.
 *
 * The payload is canonicalized before signing to ensure determinism.
 */
export function signVaultPayload(payload: VaultSignedPayload, privateKeyHex: string): string {
    const canonical = canonicalizePayload(payload);
    const seed = extractPrivateKeySeed(privateKeyHex);
    const signature = ed25519.sign(
        new TextEncoder().encode(canonical),
        seed
    );
    return Buffer.from(signature).toString('hex');
}

/**
 * Verify a vault payload signature using Ed25519.
 *
 * The payload is canonicalized before verification to match the signing path.
 */
export function verifyVaultSignature(
    payload: VaultSignedPayload,
    signature: string,
    senderPubkeyHex: string
): boolean {
    if (!/^[0-9a-f]{128}$/i.test(signature)) {
        return false;
    }
    if (!/^[0-9a-f]{64}$/i.test(senderPubkeyHex)) {
        return false;
    }
    try {
        const canonical = canonicalizePayload(payload);
        return ed25519.verify(
            Buffer.from(signature, 'hex'),
            new TextEncoder().encode(canonical),
            senderPubkeyHex
        );
    } catch {
        return false;
    }
}
