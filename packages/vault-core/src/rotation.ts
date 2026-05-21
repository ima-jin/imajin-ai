import { VAULT_ENTRY_VERSION_V1, type VaultEntry, type VaultBlob } from './models.js';
import { deriveKeyId } from './identity.js';
import { signVaultPayload } from './signature.js';
import { computeVaultCid } from './cid.js';

/**
 * Prepare a new vault entry for key rotation.
 *
 * Creates a new entry with the updated blob, a new keyId derived from
 * the recipient's public key, a previousCid chain link to the existing
 * entry, a fresh timestamp, and a signature.
 */
export async function prepareRotationEntry(
    existingEntry: VaultEntry,
    newBlob: VaultBlob,
    newRecipientPubkey: string,
    signerPrivateKey: string
): Promise<VaultEntry> {
    const cid = await computeVaultCid(newBlob);
    const timestamp = new Date().toISOString();
    const keyId = deriveKeyId(newRecipientPubkey);

    const payload = {
        version: VAULT_ENTRY_VERSION_V1,
        field: existingEntry.field,
        cid,
        encrypted: newBlob.encrypted,
        nonce: newBlob.nonce,
        senderDid: existingEntry.senderDid,
        senderPubkey: existingEntry.senderPubkey,
        keyId,
        timestamp,
        previousCid: existingEntry.cid
    };

    const signature = signVaultPayload(payload, signerPrivateKey);

    return {
        ...payload,
        signature
    };
}
