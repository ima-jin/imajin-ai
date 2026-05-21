export var IntegrityErrorCode;
(function (IntegrityErrorCode) {
    IntegrityErrorCode["UNSUPPORTED_VERSION"] = "UNSUPPORTED_VERSION";
    IntegrityErrorCode["MISSING_REQUIRED_FIELD"] = "MISSING_REQUIRED_FIELD";
    IntegrityErrorCode["INVALID_TIMESTAMP"] = "INVALID_TIMESTAMP";
    IntegrityErrorCode["DID_KEY_BINDING_INVALID"] = "DID_KEY_BINDING_INVALID";
    IntegrityErrorCode["KEY_ID_MISMATCH"] = "KEY_ID_MISMATCH";
    IntegrityErrorCode["CID_MISMATCH"] = "CID_MISMATCH";
    IntegrityErrorCode["SIGNATURE_INVALID"] = "SIGNATURE_INVALID";
})(IntegrityErrorCode || (IntegrityErrorCode = {}));
export class VaultIntegrityError extends Error {
    code;
    entryField;
    details;
    constructor(code, message, options = {}) {
        super(message);
        this.name = 'VaultIntegrityError';
        this.code = code;
        this.entryField = options.entryField;
        this.details = options.details;
    }
}
//# sourceMappingURL=errors.js.map