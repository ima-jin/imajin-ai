import { computeCid, verifyCid } from '@imajin/cid';
import { type VaultBlob } from './models.js';

/**
 * Compute a CID for a vault blob ({ encrypted, nonce }).
 */
export async function computeVaultCid(blob: VaultBlob): Promise<string> {
    return computeCid({ encrypted: blob.encrypted, nonce: blob.nonce });
}

/**
 * Verify that a vault blob matches an expected CID.
 */
export async function verifyVaultCid(blob: VaultBlob, expectedCid: string): Promise<boolean> {
    return verifyCid({ encrypted: blob.encrypted, nonce: blob.nonce }, expectedCid);
}
