export {
    VAULT_ENTRY_VERSION_V1,
    VAULT_ENTRY_VERSION_V2,
    type VaultEntryVersion,
    type VaultCustodyScheme,
    type VaultBlob,
    type VaultEntry,
    type VaultEntryV1,
    type VaultEntryV2,
    type VaultSignedPayload,
    type VaultSignedPayloadV1,
    type VaultSignedPayloadV2,
    type VaultFile,
    type UpsertVaultEntryInput
} from './models.js';
export {
    wrapFieldKey,
    unwrapFieldKey,
    deriveXKeypairFromEd25519,
    type DelegationWrappedKey,
} from './delegation.js';
export {
    IntegrityErrorCode,
    VaultIntegrityError
} from './errors.js';
export {
    assertEntryIntegrity,
    verifyEntryIntegrity,
    type VerifyEntryIntegrityResult,
    type VerifyEntryIntegrityOptions
} from './verification.js';
export type {
    VaultIntegrityAdapters
} from './verification.js';
export {
    FileVaultRepository,
    type VaultRepository,
    type FileVaultRepositoryOptions
} from './repository.js';
export {
    VaultEntryService,
    type VaultEntryServiceOptions
} from './service.js';
export {
    canonicalizePayload
} from './canonical.js';
export {
    computeVaultCid,
    verifyVaultCid
} from './cid.js';
export {
    deriveKeyId,
    verifyDidKeyBinding
} from './identity.js';
export {
    signVaultPayload,
    verifyVaultSignature
} from './signature.js';
export {
    type VaultLock,
    type VaultLockRelease,
    InMemoryFieldLock,
    type FileLock
} from './lock.js';
export {
    prepareRotationEntry,
    prepareRotationEntryFromSignedInput,
    type SignedRotationInput
} from './rotation.js';
export {
    createDefaultAdapters
} from './adapters.js';
export {
    sealSecret,
    unsealSecret,
    deriveSealKey
} from './seal.js';
export {
    extractPrivateKeySeed
} from './signature.js';
