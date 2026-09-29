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
