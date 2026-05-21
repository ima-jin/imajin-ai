export {
    VAULT_ENTRY_VERSION_V1,
    type VaultEntryVersion,
    type VaultBlob,
    type VaultEntry,
    type VaultEntryV1,
    type VaultSignedPayload,
    type VaultSignedPayloadV1,
    type VaultFile,
    type UpsertVaultEntryInput
} from './models.js';
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
    VaultEntryService
} from './service.js';
