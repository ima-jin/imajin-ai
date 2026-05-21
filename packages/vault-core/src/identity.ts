import { createHash } from 'node:crypto';
import * as ed25519 from '@noble/ed25519';

function isValidPublicKeyHex(hex: string): boolean {
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
        return false;
    }
    try {
        ed25519.Point.fromHex(hex);
        return true;
    } catch {
        return false;
    }
}

/**
 * Derive a deterministic key ID from a public key hex string.
 *
 * Returns the first 16 characters of the hex-encoded SHA-256 hash
 * of the raw public key bytes.
 */
export function deriveKeyId(senderPubkeyHex: string): string {
    if (!isValidPublicKeyHex(senderPubkeyHex)) {
        throw new Error('Invalid sender public key');
    }
    const bytes = Buffer.from(senderPubkeyHex, 'hex');
    const hash = createHash('sha256').update(bytes).digest('hex');
    return hash.slice(0, 16);
}

/**
 * Verify that a did:imajin DID is bound to the given public key.
 *
 * did:imajin:<first-16-chars-of-pubkey>
 */
export function verifyDidKeyBinding(did: string, senderPubkeyHex: string): boolean {
    if (!did.startsWith('did:imajin:')) {
        return false;
    }
    if (!isValidPublicKeyHex(senderPubkeyHex)) {
        return false;
    }
    const expectedSuffix = did.slice('did:imajin:'.length);
    const actualPrefix = senderPubkeyHex.slice(0, 16);
    return expectedSuffix === actualPrefix;
}
