import { computeCid, verifyCid } from '@imajin/cid';
import { type VaultBlob } from './models.js';

/**
 * Compute a CID for a vault blob ({ encrypted, nonce }).
 */
export function computeVaultCid(blob: VaultBlob): Promise<string> {
    // Keep the Promise contract: a synchronous throw (e.g. a missing blob) becomes a rejection.
    try {
        return Promise.resolve(computeCid({ encrypted: blob.encrypted, nonce: blob.nonce }));
    } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
}

/**
 * Verify that a vault blob matches an expected CID.
 */
export function verifyVaultCid(blob: VaultBlob, expectedCid: string): Promise<boolean> {
    // Keep the Promise contract: a synchronous throw (e.g. a missing blob) becomes a rejection.
    try {
        return Promise.resolve(verifyCid({ encrypted: blob.encrypted, nonce: blob.nonce }, expectedCid));
    } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
}
