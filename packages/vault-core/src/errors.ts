export enum IntegrityErrorCode {
    UNSUPPORTED_VERSION = 'UNSUPPORTED_VERSION',
    MISSING_REQUIRED_FIELD = 'MISSING_REQUIRED_FIELD',
    INVALID_TIMESTAMP = 'INVALID_TIMESTAMP',
    DID_KEY_BINDING_INVALID = 'DID_KEY_BINDING_INVALID',
    KEY_ID_MISMATCH = 'KEY_ID_MISMATCH',
    CID_MISMATCH = 'CID_MISMATCH',
    SIGNATURE_INVALID = 'SIGNATURE_INVALID'
}

export class VaultIntegrityError extends Error {
    public readonly code: IntegrityErrorCode;
    public readonly entryField: string | undefined;
    public readonly details: Record<string, unknown> | undefined;

    constructor(
        code: IntegrityErrorCode,
        message: string,
        options: {
            entryField?: string;
            details?: Record<string, unknown>;
        } = {}
    ) {
        super(message);
        this.name = 'VaultIntegrityError';
        this.code = code;
        this.entryField = options.entryField;
        this.details = options.details;
    }
}

/**
 * A vault file was explicitly configured but does not exist (#2412).
 *
 * Silently treating this as an empty store made every sealed secret resolve to
 * undefined while health reported green. Callers must fail loud; first-run
 * bootstrap has to be an explicit opt-in (`allowBootstrap`).
 */
export class VaultFileMissingError extends Error {
    public readonly code = 'VAULT_FILE_MISSING';
    public readonly vaultPath: string;

    constructor(vaultPath: string) {
        super(
            `Configured vault file not found at ${vaultPath} — refusing to continue with an empty vault. ` +
            'Restore the file, correct the configured path, or explicitly opt in to first-run bootstrap.'
        );
        this.name = 'VaultFileMissingError';
        this.vaultPath = vaultPath;
    }
}

/**
 * A vault file exists at the configured path but could not be read (EACCES,
 * EISDIR, EIO, ...) (#2440).
 *
 * Treating this as an empty store meant the next `save()` replaced the real
 * file and every entry in it was lost. Callers must fail loud.
 */
export class VaultFileUnreadableError extends Error {
    public readonly code = 'VAULT_FILE_UNREADABLE';
    public readonly vaultPath: string;
    /** errno code of the underlying failure (e.g. `EACCES`), when known. */
    public readonly errno: string | undefined;

    constructor(vaultPath: string, errno?: string) {
        const detail = errno ? ` (${errno})` : '';
        super(
            `Vault file at ${vaultPath} exists but could not be read${detail} — ` +
            'refusing to continue with an empty vault. Fix the file permissions or path; the file has not been modified.'
        );
        this.name = 'VaultFileUnreadableError';
        this.vaultPath = vaultPath;
        this.errno = errno;
    }
}

export type VaultFileMalformedReason = 'INVALID_JSON' | 'INVALID_SHAPE';

/**
 * A vault file exists and was read, but does not hold a valid vault (broken
 * JSON, or JSON without an `entries` array) (#2440).
 *
 * The message deliberately carries no parser output or file content: JSON
 * parser errors can quote fragments of the input, which is vault data.
 */
export class VaultFileMalformedError extends Error {
    public readonly code = 'VAULT_FILE_MALFORMED';
    public readonly vaultPath: string;
    public readonly reason: VaultFileMalformedReason;

    constructor(vaultPath: string, reason: VaultFileMalformedReason) {
        super(
            `Vault file at ${vaultPath} is malformed (${reason}) — refusing to continue with an empty vault. ` +
            'Restore the file from backup or repair it by hand; the file has not been modified.'
        );
        this.name = 'VaultFileMalformedError';
        this.vaultPath = vaultPath;
        this.reason = reason;
    }
}

/**
 * `save()` was called after the most recent `load()` failed (#2440).
 *
 * Whatever the caller holds is not derived from the file on disk, so writing
 * it would clobber the real vault. A later successful `load()` clears this.
 */
export class VaultSaveRefusedError extends Error {
    public readonly code = 'VAULT_SAVE_REFUSED';
    public readonly vaultPath: string;

    constructor(vaultPath: string) {
        super(
            `Refusing to save vault to ${vaultPath}: the last load of that file failed, ` +
            'so saving would overwrite data that was never read. Resolve the load failure first.'
        );
        this.name = 'VaultSaveRefusedError';
        this.vaultPath = vaultPath;
    }
}
