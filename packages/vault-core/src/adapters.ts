import { type VaultIntegrityAdapters } from './verification.js';
import { computeVaultCid, verifyVaultCid } from './cid.js';
import { deriveKeyId, verifyDidKeyBinding } from './identity.js';
import { verifyVaultSignature } from './signature.js';

/**
 * Create a default set of vault integrity adapters wired to real
 * implementations from @imajin/auth and @imajin/cid.
 */
export function createDefaultAdapters(): VaultIntegrityAdapters {
    return {
        computeCid: computeVaultCid,
        deriveKeyId,
        verifyDidKeyBinding,
        verifySignature: verifyVaultSignature
    };
}
