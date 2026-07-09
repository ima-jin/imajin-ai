import { IntegrityErrorCode, VaultIntegrityError } from './errors.js';
import {
    VAULT_ENTRY_VERSION_V1,
    VAULT_ENTRY_VERSION_V2,
    type VaultEntry,
    type VaultSignedPayload
} from './models.js';

interface VaultIntegrityAdapters {
    computeCid(blob: { encrypted: string; nonce: string }): Promise<string>;
    deriveKeyId(senderPubkey: string): string;
    verifyDidKeyBinding(did: string, senderPubkey: string): boolean;
    verifySignature(payload: VaultSignedPayload, signature: string, senderPubkey: string): boolean;
}

interface VerifyEntryIntegrityOptions {
    requireIsoTimestamp?: boolean;
}

interface VerifyEntryIntegritySuccess {
    ok: true;
    payload: VaultSignedPayload;
}

interface VerifyEntryIntegrityFailure {
    ok: false;
    error: VaultIntegrityError;
}

export type VerifyEntryIntegrityResult = VerifyEntryIntegritySuccess | VerifyEntryIntegrityFailure;
export type { VaultIntegrityAdapters, VerifyEntryIntegrityOptions };

const REQUIRED_STRING_FIELDS: Array<keyof VaultEntry> = [
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

export async function verifyEntryIntegrity(
    entry: VaultEntry,
    adapters: VaultIntegrityAdapters,
    options: VerifyEntryIntegrityOptions = {}
): Promise<VerifyEntryIntegrityResult> {
    try {
        const payload = await assertEntryIntegrity(entry, adapters, options);
        return {
            ok: true,
            payload
        };
    } catch (error) {
        if (error instanceof VaultIntegrityError) {
            return {
                ok: false,
                error
            };
        }
        throw error;
    }
}

export async function assertEntryIntegrity(
    entry: VaultEntry,
    adapters: VaultIntegrityAdapters,
    options: VerifyEntryIntegrityOptions = {}
): Promise<VaultSignedPayload> {
    const entryField = entry.field;

    // Defensive runtime guard against malformed/deserialized entries whose
    // version is outside the supported set. Read through a widened local so the
    // static union (1 | 2) does not narrow the block to `never`.
    const entryVersion: number = entry.version;
    if (entryVersion !== VAULT_ENTRY_VERSION_V1 && entryVersion !== VAULT_ENTRY_VERSION_V2) {
        throw new VaultIntegrityError(
            IntegrityErrorCode.UNSUPPORTED_VERSION,
            `Unsupported vault entry version: ${String(entryVersion)}`,
            {
                entryField,
                details: {
                    supported: [VAULT_ENTRY_VERSION_V1, VAULT_ENTRY_VERSION_V2],
                    actual: entryVersion
                }
            }
        );
    }

    for (const field of REQUIRED_STRING_FIELDS) {
        const value = entry[field];
        if (typeof value !== 'string' || value.trim().length === 0) {
            throw new VaultIntegrityError(
                IntegrityErrorCode.MISSING_REQUIRED_FIELD,
                `Vault entry is missing required field '${String(field)}'`,
                {
                    entryField,
                    details: { field }
                }
            );
        }
    }

    if (options.requireIsoTimestamp !== false) {
        const parsed = new Date(entry.timestamp);
        if (Number.isNaN(parsed.getTime())) {
            throw new VaultIntegrityError(
                IntegrityErrorCode.INVALID_TIMESTAMP,
                `Vault entry '${entryField}' has invalid timestamp`,
                {
                    entryField
                }
            );
        }
    }

    const didBindingOk = adapters.verifyDidKeyBinding(entry.senderDid, entry.senderPubkey);
    if (!didBindingOk) {
        throw new VaultIntegrityError(
            IntegrityErrorCode.DID_KEY_BINDING_INVALID,
            `Vault entry '${entryField}' has unverified DID-to-key binding`,
            {
                entryField
            }
        );
    }

    const derivedKeyId = adapters.deriveKeyId(entry.senderPubkey);
    if (entry.keyId !== derivedKeyId) {
        throw new VaultIntegrityError(
            IntegrityErrorCode.KEY_ID_MISMATCH,
            `Vault entry '${entryField}' keyId mismatch`,
            {
                entryField,
                details: {
                    expected: derivedKeyId,
                    actual: entry.keyId
                }
            }
        );
    }

    const expectedCid = await adapters.computeCid({
        encrypted: entry.encrypted,
        nonce: entry.nonce
    });
    if (entry.cid !== expectedCid) {
        throw new VaultIntegrityError(
            IntegrityErrorCode.CID_MISMATCH,
            `Vault entry '${entryField}' CID mismatch`,
            {
                entryField,
                details: {
                    expected: expectedCid,
                    actual: entry.cid
                }
            }
        );
    }

    const payload: VaultSignedPayload = {
        version: entry.version,
        field: entry.field,
        cid: entry.cid,
        encrypted: entry.encrypted,
        nonce: entry.nonce,
        senderDid: entry.senderDid,
        senderPubkey: entry.senderPubkey,
        keyId: entry.keyId,
        timestamp: entry.timestamp,
        // custodyScheme is included when defined so the canonical form matches
        // what was signed — undefined values are stripped by canonicalizePayload.
        ...(entry.custodyScheme === undefined ? {} : { custodyScheme: entry.custodyScheme }),
        ...(entry.previousCid === undefined  ? {} : { previousCid: entry.previousCid }),
        ...(entry.deleted === undefined  ? {} : { deleted: entry.deleted })
    } as VaultSignedPayload;
    const signatureOk = adapters.verifySignature(payload, entry.signature, entry.senderPubkey);
    if (!signatureOk) {
        throw new VaultIntegrityError(
            IntegrityErrorCode.SIGNATURE_INVALID,
            `Vault entry '${entryField}' signature verification failed`,
            {
                entryField
            }
        );
    }

    return payload;
}
