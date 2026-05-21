import { IntegrityErrorCode, VaultIntegrityError } from './errors.js';
import { VAULT_ENTRY_VERSION_V1 } from './models.js';
const REQUIRED_STRING_FIELDS = [
    'field',
    'cid',
    'encrypted',
    'nonce',
    'senderDid',
    'senderPubkey',
    'keyId',
    'signature',
    'timestamp'
];
export async function verifyEntryIntegrity(entry, adapters, options = {}) {
    try {
        const payload = await assertEntryIntegrity(entry, adapters, options);
        return {
            ok: true,
            payload
        };
    }
    catch (error) {
        if (error instanceof VaultIntegrityError) {
            return {
                ok: false,
                error
            };
        }
        throw error;
    }
}
export async function assertEntryIntegrity(entry, adapters, options = {}) {
    const entryField = entry.field;
    if (entry.version !== VAULT_ENTRY_VERSION_V1) {
        throw new VaultIntegrityError(IntegrityErrorCode.UNSUPPORTED_VERSION, `Unsupported vault entry version: ${String(entry.version)}`, {
            entryField,
            details: {
                expected: VAULT_ENTRY_VERSION_V1,
                actual: entry.version
            }
        });
    }
    for (const field of REQUIRED_STRING_FIELDS) {
        const value = entry[field];
        if (typeof value !== 'string' || value.trim().length === 0) {
            throw new VaultIntegrityError(IntegrityErrorCode.MISSING_REQUIRED_FIELD, `Vault entry is missing required field '${String(field)}'`, {
                entryField,
                details: { field }
            });
        }
    }
    if (options.requireIsoTimestamp !== false) {
        const parsed = new Date(entry.timestamp);
        if (Number.isNaN(parsed.getTime())) {
            throw new VaultIntegrityError(IntegrityErrorCode.INVALID_TIMESTAMP, `Vault entry '${entryField}' has invalid timestamp`, {
                entryField
            });
        }
    }
    const didBindingOk = adapters.verifyDidKeyBinding(entry.senderDid, entry.senderPubkey);
    if (!didBindingOk) {
        throw new VaultIntegrityError(IntegrityErrorCode.DID_KEY_BINDING_INVALID, `Vault entry '${entryField}' has unverified DID-to-key binding`, {
            entryField
        });
    }
    const derivedKeyId = adapters.deriveKeyId(entry.senderPubkey);
    if (entry.keyId !== derivedKeyId) {
        throw new VaultIntegrityError(IntegrityErrorCode.KEY_ID_MISMATCH, `Vault entry '${entryField}' keyId mismatch`, {
            entryField,
            details: {
                expected: derivedKeyId,
                actual: entry.keyId
            }
        });
    }
    const expectedCid = await adapters.computeCid({
        encrypted: entry.encrypted,
        nonce: entry.nonce
    });
    if (entry.cid !== expectedCid) {
        throw new VaultIntegrityError(IntegrityErrorCode.CID_MISMATCH, `Vault entry '${entryField}' CID mismatch`, {
            entryField,
            details: {
                expected: expectedCid,
                actual: entry.cid
            }
        });
    }
    const payload = {
        version: entry.version,
        field: entry.field,
        cid: entry.cid,
        encrypted: entry.encrypted,
        nonce: entry.nonce,
        senderDid: entry.senderDid,
        senderPubkey: entry.senderPubkey,
        keyId: entry.keyId,
        timestamp: entry.timestamp,
        ...(entry.previousCid !== undefined ? { previousCid: entry.previousCid } : {}),
        ...(entry.deleted !== undefined ? { deleted: entry.deleted } : {})
    };
    const signatureOk = adapters.verifySignature(payload, entry.signature, entry.senderPubkey);
    if (!signatureOk) {
        throw new VaultIntegrityError(IntegrityErrorCode.SIGNATURE_INVALID, `Vault entry '${entryField}' signature verification failed`, {
            entryField
        });
    }
    return payload;
}
//# sourceMappingURL=verification.js.map