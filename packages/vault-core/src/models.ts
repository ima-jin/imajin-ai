export const VAULT_ENTRY_VERSION_V1 = 1 as const;

export type VaultEntryVersion = typeof VAULT_ENTRY_VERSION_V1;

export interface VaultBlob {
    encrypted: string;
    nonce: string;
}

export interface VaultEntryV1 extends VaultBlob {
    version: VaultEntryVersion;
    field: string;
    cid: string;
    senderDid: string;
    senderPubkey: string;
    keyId: string;
    signature: string;
    timestamp: string;
    previousCid?: string;
    deleted?: boolean;
}

export interface VaultSignedPayloadV1 extends VaultBlob {
    version: VaultEntryVersion;
    field: string;
    cid: string;
    senderDid: string;
    senderPubkey: string;
    keyId: string;
    timestamp: string;
    previousCid?: string;
    deleted?: boolean;
}

export type VaultEntry = VaultEntryV1;
export type VaultSignedPayload = VaultSignedPayloadV1;

export interface VaultFile {
    version: VaultEntryVersion;
    entries: VaultEntry[];
}

export type UpsertVaultEntryInput = Omit<VaultEntry, 'previousCid'> & {
    previousCid?: string;
};
