export declare enum IntegrityErrorCode {
    UNSUPPORTED_VERSION = "UNSUPPORTED_VERSION",
    MISSING_REQUIRED_FIELD = "MISSING_REQUIRED_FIELD",
    INVALID_TIMESTAMP = "INVALID_TIMESTAMP",
    DID_KEY_BINDING_INVALID = "DID_KEY_BINDING_INVALID",
    KEY_ID_MISMATCH = "KEY_ID_MISMATCH",
    CID_MISMATCH = "CID_MISMATCH",
    SIGNATURE_INVALID = "SIGNATURE_INVALID"
}
export declare class VaultIntegrityError extends Error {
    readonly code: IntegrityErrorCode;
    readonly entryField: string | undefined;
    readonly details: Record<string, unknown> | undefined;
    constructor(code: IntegrityErrorCode, message: string, options?: {
        entryField?: string;
        details?: Record<string, unknown>;
    });
}
//# sourceMappingURL=errors.d.ts.map