import { verifySync, crypto as authCrypto } from '@imajin/auth';
import { type VaultSignedPayload } from './models.js';
import { canonicalizePayload } from './canonical.js';

/**
 * Sign a vault payload using Ed25519.
 *
 * The payload is canonicalized before signing to ensure determinism.
 */
export function signVaultPayload(payload: VaultSignedPayload, privateKeyHex: string): string {
    const canonical = canonicalizePayload(payload);
    return authCrypto.signSync(canonical, privateKeyHex);
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
    const canonical = canonicalizePayload(payload);
    return verifySync(signature, canonical, senderPubkeyHex);
}
