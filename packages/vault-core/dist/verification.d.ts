import { VaultIntegrityError } from './errors.js';
import { type VaultEntry, type VaultSignedPayload } from './models.js';
interface VaultIntegrityAdapters {
    computeCid(blob: {
        encrypted: string;
        nonce: string;
    }): Promise<string>;
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
export declare function verifyEntryIntegrity(entry: VaultEntry, adapters: VaultIntegrityAdapters, options?: VerifyEntryIntegrityOptions): Promise<VerifyEntryIntegrityResult>;
export declare function assertEntryIntegrity(entry: VaultEntry, adapters: VaultIntegrityAdapters, options?: VerifyEntryIntegrityOptions): Promise<VaultSignedPayload>;
//# sourceMappingURL=verification.d.ts.map