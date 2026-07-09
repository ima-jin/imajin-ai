export const VAULT_ENTRY_VERSION_V1 = 1 as const;
export const VAULT_ENTRY_VERSION_V2 = 2 as const;

export type VaultEntryVersion = typeof VAULT_ENTRY_VERSION_V1 | typeof VAULT_ENTRY_VERSION_V2;
export type VaultCustodyScheme = 'node-sealed' | 'delegation-grant';

export interface VaultBlob {
    encrypted: string;
    nonce: string;
}

export interface VaultEntryV1 extends VaultBlob {
    version: typeof VAULT_ENTRY_VERSION_V1;
    field: string;
    cid: string;
    senderDid: string;
    senderPubkey: string;
    keyId: string;
    signature: string;
    timestamp: string;
    custodyScheme?: VaultCustodyScheme; // optional; absent or 'node-sealed' = v1 node-sealed
    previousCid?: string;
    deleted?: boolean;
}

/**
 * VaultEntryV2 — delegation-grant-sealed entry (owner-sealed secrets, #1242).
 *
 * The ciphertext is sealed with a per-field random AES key that was ECDH-wrapped
 * by the owner agent and stored as a vault_delegation_grants row. The node
 * unwraps the field key using its own X25519 private key at unseal time.
 */
export interface VaultEntryV2 extends VaultBlob {
    version: typeof VAULT_ENTRY_VERSION_V2;
    field: string;
    cid: string;
    senderDid: string;       // ownerDid who sealed this entry
    senderPubkey: string;    // owner Ed25519 pubkey (for signature verification)
    keyId: string;
    signature: string;
    timestamp: string;
    custodyScheme: 'delegation-grant';
    previousCid?: string;
    deleted?: boolean;
}

export interface VaultSignedPayloadV1 extends VaultBlob {
    version: typeof VAULT_ENTRY_VERSION_V1;
    field: string;
    cid: string;
    senderDid: string;
    senderPubkey: string;
    keyId: string;
    timestamp: string;
    custodyScheme?: VaultCustodyScheme;
    previousCid?: string;
    deleted?: boolean;
}

export interface VaultSignedPayloadV2 extends VaultBlob {
    version: typeof VAULT_ENTRY_VERSION_V2;
    field: string;
    cid: string;
    senderDid: string;
    senderPubkey: string;
    keyId: string;
    timestamp: string;
    custodyScheme: 'delegation-grant';
    previousCid?: string;
    deleted?: boolean;
}

export type VaultEntry = VaultEntryV1 | VaultEntryV2;
export type VaultSignedPayload = VaultSignedPayloadV1 | VaultSignedPayloadV2;

export interface VaultFile {
    version: VaultEntryVersion;
    entries: VaultEntry[];
}

/**
 * Distributive Omit — applies Omit to each member of a union separately so the
 * discriminated union (VaultEntryV1 | VaultEntryV2) is preserved rather than
 * collapsed into a single object type with `version: 1 | 2`.
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export type UpsertVaultEntryInput = DistributiveOmit<VaultEntry, 'previousCid'> & {
    previousCid?: string;
};
